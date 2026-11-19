"use strict";

/**
 * 前端端到端测试(无浏览器环境下使用极简 DOM 桩)
 *
 * 在 Node 中加载真实的 api.js / todo.js,驱动页面交互:
 * 注册 -> 添加/切换/删除待办 -> 登出 -> 重新登录数据仍在 -> 用户隔离。
 * 所有 HTTP 请求打到真实运行的后端服务器(独立临时 SQLite)。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { startServer } = require("../server.js");

const tmpDb = path.join(os.tmpdir(), `todo-frontend-${process.pid}-${Date.now()}.db`);
let server;
let base;

// ---------- 极简 DOM 桩 ----------
function createElement(tag) {
  const cls = new Set();
  const el = {
    tagName: (tag || "div").toUpperCase(),
    children: [],
    handlers: {},
    dataset: {},
    _attrs: {},
    hidden: false,
    _html: "",
    _text: "",
    value: "",
    checked: false,
    parentNode: null,
    appendChild(child) {
      el.children.push(child);
      child.parentNode = el;
      return child;
    },
    insertBefore(node, ref) {
      if (!ref) return el.appendChild(node);
      const index = el.children.indexOf(ref);
      if (index < 0) return el.appendChild(node);
      el.children.splice(index, 0, node);
      node.parentNode = el;
      return node;
    },
    removeChild(node) {
      const index = el.children.indexOf(node);
      if (index >= 0) el.children.splice(index, 1);
      node.parentNode = null;
      return node;
    },
    setAttribute(name, val) {
      if (name === "class") el.className = val;
      else el._attrs[name] = val;
    },
    getAttribute(name) {
      return el._attrs[name];
    },
    addEventListener(type, fn) {
      (el.handlers[type] = el.handlers[type] || []).push(fn);
    },
    focus() {},
    select() {},
    closest() {
      return null;
    },
    remove() {
      // no-op: children 数组与挂载视图独立
    },
    querySelector(sel) {
      const idMatch = /^\[data-id="(.+)"\]$/.exec(sel);
      if (idMatch) {
        return el.children.find((c) => c.dataset.id === idMatch[1]) || null;
      }
      if (sel.startsWith(".")) {
        // 支持 ".class" 与 ".a.b" 形式的简单类选择器(深度优先)
        const classes = sel.slice(1).split(".").filter(Boolean);
        const queue = el.children.slice();
        while (queue.length) {
          const node = queue.shift();
          if (classes.every((c) => node.classList.contains(c))) return node;
          if (node.children) queue.push(...node.children);
        }
      }
      return null;
    },
  };
  Object.defineProperty(el, "classList", {
    get() {
      return {
        add(...c) {
          c.forEach((x) => x && cls.add(x));
        },
        remove(...c) {
          c.forEach((x) => cls.delete(x));
        },
        toggle(x, force) {
          if (force === true) cls.add(x);
          else if (force === false) cls.delete(x);
          else if (cls.has(x)) cls.delete(x);
          else cls.add(x);
          return cls.has(x);
        },
        contains(x) {
          return cls.has(x);
        },
      };
    },
  });
  Object.defineProperty(el, "className", {
    get() {
      return [...cls].join(" ");
    },
    set(v) {
      cls.clear();
      String(v).split(/\s+/).forEach((x) => x && cls.add(x));
    },
  });
  Object.defineProperty(el, "innerHTML", {
    get() {
      return el._html;
    },
    set(v) {
      el._html = String(v);
      if (el._html === "") {
        el.children.forEach((child) => {
          if (child) child.parentNode = null;
        });
        el.children.length = 0;
      }
    },
  });
  Object.defineProperty(el, "nextSibling", {
    get() {
      if (!el.parentNode) return null;
      const siblings = el.parentNode.children;
      const index = siblings.indexOf(el);
      return index >= 0 ? siblings[index + 1] || null : null;
    },
  });
  Object.defineProperty(el, "textContent", {
    get() {
      return el._text === "" && el.children.length
        ? el.children.map((c) => c.textContent).join("")
        : el._text;
    },
    set(v) {
      el._text = String(v);
    },
  });
  return el;
}

const INITIAL_HIDDEN = {
  "auth-view": true,
  "app-view": true,
  "register-form": true,
  "auth-error": true,
  "empty-state": true,
  "clear-status": true,
};

const elements = {};
function getElement(id) {
  if (!elements[id]) {
    elements[id] = createElement(id);
    if (id in INITIAL_HIDDEN) elements[id].hidden = INITIAL_HIDDEN[id];
  }
  return elements[id];
}

const authTabs = [
  Object.assign(createElement("button"), { dataset: { authTab: "login" } }),
  Object.assign(createElement("button"), { dataset: { authTab: "register" } }),
];
const filterBtns = ["all", "active", "completed"].map((f) => {
  const b = createElement("button");
  b.dataset.filter = f;
  return b;
});

const documentStub = {
  documentElement: (() => {
    const e = createElement("html");
    e.dataset = {};
    return e;
  })(),
  getElementById: getElement,
  createElement,
  querySelectorAll(sel) {
    if (sel === ".auth-tab") return authTabs;
    if (sel === ".filter-btn") return filterBtns;
    return [];
  }
};

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

/**
 * 极简 cookie jar:Node 的 fetch 不实现 cookie,而会话现在由 HttpOnly cookie
 * (todo_sid)承载。这里模拟浏览器行为——保存 Set-Cookie 并在后续请求中回传,
 * 使加载的真实 api.js / todo.js 能以 credentials:"same-origin" 正常工作。
 */
const cookieJar = new Map();

function applySetCookie(header) {
  const parts = String(header).split(";");
  const pair = parts.shift();
  const eq = pair.indexOf("=");
  if (eq < 0) return;
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  let maxAge;
  for (const attr of parts) {
    const i = attr.indexOf("=");
    const key = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
    if (key === "max-age") maxAge = Number(attr.slice(i + 1).trim());
  }
  if ((maxAge !== undefined && maxAge <= 0) || !value) cookieJar.delete(name);
  else cookieJar.set(name, value);
}

/** 当前 jar 的 Cookie 请求头(供测试显式验证旧凭据失效) */
function cookieHeader() {
  return [...cookieJar].map(([k, v]) => `${k}=${v}`).join("; ");
}

function installCookieAwareFetch() {
  const realFetch = global.fetch;
  global.fetch = async (input, init = {}) => {
    const headers = new Headers(init.headers || {});
    if (!headers.has("cookie")) {
      const cookie = cookieHeader();
      if (cookie) headers.set("cookie", cookie);
    }
    const res = await realFetch(input, { ...init, headers });
    for (const setCookie of res.headers.getSetCookie()) applySetCookie(setCookie);
    return res;
  };
}

before(async () => {
  const started = await startServer({
    dbPath: tmpDb,
    port: 0,
    staticDir: path.join(__dirname, ".."),
  });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;

  // 装配浏览器全局环境
  const localStorageShim = makeLocalStorage();
  global.window = global;
  global.document = documentStub;
  global.localStorage = localStorageShim;
  global.window.TODO_API_BASE = base;
  global.window.TODO_POLL_INTERVAL_MS = 150; // 测试中缩短轮询间隔
  global.window.localStorage = localStorageShim;
  global.window.matchMedia = () => ({ matches: false });
  installCookieAwareFetch();

  // 加载页面脚本(与 index.html 的顺序一致)
  require("../todo-core.js");
  require("../api.js");
  require("../todo.js");

  // 启动时会用 getMe() 向服务端确认会话;空 jar -> 401 -> 显示登录页
  await flush();
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(tmpDb + suffix);
    } catch (_) {
      /* 忽略清理失败 */
    }
  }
});

const flush = () => new Promise((r) => setTimeout(r, 250));

/** 轮询等待某个条件成立,避免依赖固定延时导致用例在繁忙环境下偶发失败 */
async function waitFor(predicate, message = "等待条件超时", timeoutMs = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.fail(message);
}

// ---------- 页面交互辅助 ----------
function fillInput(id, value) {
  getElement(id).value = value;
}

function submitForm(id) {
  getElement(id).handlers.submit[0]({ preventDefault() {} });
}

function clickTab(index) {
  authTabs[index].handlers.click[0]();
}

function clickCheckbox(index) {
  const list = getElement("todo-list");
  const li = list.children[index];
  const cb = li.children[0];
  cb.closest = () => li;
  list.handlers.click[0]({ target: cb });
}

function clickDelete(index) {
  const list = getElement("todo-list");
  const li = list.children[index];
  const del = li.children[2];
  del.closest = () => li;
  list.handlers.click[0]({ target: del });
}

function changePriority(index, priority) {
  const list = getElement("todo-list");
  const li = list.children[index];
  const select = li.children[3]; // checkbox / text / delete / priority
  select.value = String(priority);
  select.closest = () => li;
  list.handlers.change[0]({ target: select });
}

function renderedItems() {
  return getElement("todo-list").children.map((li) => ({
    text: li.children[1].textContent,
    completed: li.children[0].checked,
  }));
}

/** 注册独立用户并添加若干待办,避免用例之间互相影响 */
async function registerAndSeed(username, texts) {
  clickTab(1);
  fillInput("register-username", username);
  fillInput("register-password", "secret1234567");
  submitForm("register-form");
  await flush();
  for (const text of texts) {
    fillInput("todo-input", text);
    submitForm("todo-form");
    await flush();
  }
}

/** 在搜索框输入并触发 input 事件(等价于真实浏览器逐字输入/粘贴) */
function typeSearch(value) {
  const input = getElement("todo-search");
  input.value = value;
  input.handlers.input[0]({});
}

/** 在搜索框按回车;返回是否被 preventDefault(应吞掉回车避免提交外层表单) */
function pressSearchEnter() {
  let prevented = false;
  getElement("todo-search").handlers.keydown[0]({
    key: "Enter",
    preventDefault() {
      prevented = true;
    },
  });
  return prevented;
}

/** 等待超过默认 250ms 搜索防抖 */
const waitSearch = (ms = 400) => new Promise((r) => setTimeout(r, ms));

/**
 * 通过 API 创建独立用户与种子数据,再经页面登录一次性加载。
 * 相比「注册后逐条通过表单新增」,少了一次 loadTodos 与本地新增的竞态,
 * 让搜索用例只依赖可观测的渲染结果。
 */
async function seedUser(username, texts) {
  const password = "secret1234567";
  const reg = await fetch(`${base}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  assert.equal(reg.status, 201, `API 注册 ${username} 应成功`);

  for (const text of texts) {
    const res = await fetch(`${base}/api/todos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    assert.equal(res.status, 201);
  }

  clickTab(0);
  fillInput("login-username", username);
  fillInput("login-password", password);
  submitForm("login-form");

  const expectedPage = texts.slice(0, Math.min(20, texts.length));
  await waitFor(() => {
    if (getElement("current-user").textContent !== username) return false;
    const shown = renderedItems().map((i) => i.text);
    return (
      shown.length === expectedPage.length &&
      shown.every((text, i) => text === expectedPage[i])
    );
  }, `用户 ${username} 的待办应在登录后渲染`);
}

/** 记录所有请求 URL,用于验证 q / since 互斥与"清空不发请求" */
function recordFetchUrls() {
  const realFetch = global.fetch;
  const urls = [];
  global.fetch = function (url, opts) {
    urls.push(String(url));
    return realFetch(url, opts);
  };
  return {
    urls,
    restore() {
      global.fetch = realFetch;
    },
    qRequests() {
      return urls.filter((u) => u.includes("/api/todos?") && u.includes("q="));
    },
  };
}

/** 双击第 index 条待办的文本,返回列表项与编辑输入框 */
function startEditing(index) {
  const list = getElement("todo-list");
  const li = list.children[index];
  const textEl = li.children[1];
  textEl.closest = () => li;
  list.handlers.dblclick[0]({ target: textEl });
  const editor = li.children.find((c) => c.classList.contains("todo-edit-input"));
  return { li, editor };
}

/** 取当前第 index 条待办的编辑输入框(重绘后需重新查询) */
function editingEditor(index) {
  const li = getElement("todo-list").children[index];
  if (!li) return null;
  return li.children.find((c) => c.classList.contains("todo-edit-input")) || null;
}

test("前端端到端:注册/增删改/登出/重新登录/用户隔离", async () => {
  // 初始未登录:显示登录视图
  assert.equal(getElement("auth-view").hidden, false);
  assert.equal(getElement("app-view").hidden, true);
  assert.equal(window.TodoApi.hasSession(), false);

  // ---------- 注册 carol ----------
  clickTab(1);
  assert.equal(getElement("register-form").hidden, false);
  fillInput("register-username", "carol");
  fillInput("register-password", "secret1234567");
  submitForm("register-form");
  await flush();

  assert.equal(getElement("app-view").hidden, false);
  assert.equal(getElement("current-user").textContent, "carol");
  assert.equal(window.TodoApi.hasSession(), true);
  // 会话只存在于 HttpOnly cookie 中,前端不再持久化 token
  assert.equal(window.localStorage.getItem("todo-app.token"), null);

  // ---------- 添加两条待办 ----------
  fillInput("todo-input", "给前端接入后端 API");
  submitForm("todo-form");
  await flush();

  fillInput("todo-input", "验证多用户隔离");
  submitForm("todo-form");
  await flush();

  let items = renderedItems();
  assert.equal(items.length, 2);
  assert.equal(items[0].text, "给前端接入后端 API");
  assert.equal(items[1].text, "验证多用户隔离");
  assert.equal(getElement("stats-total").textContent, "2");
  assert.equal(getElement("stats-completed").textContent, "0");
  assert.equal(getElement("remaining-count-number").textContent, "2");

  // 服务端确实收到了这两条(cookie jar 自动携带会话 cookie)
  const serverList = await (await fetch(`${base}/api/todos`)).json();
  assert.equal(serverList.length, 2);

  // ---------- 切换完成状态 ----------
  clickCheckbox(0);
  await flush();
  items = renderedItems();
  assert.equal(items[0].completed, true);
  assert.equal(getElement("stats-completed").textContent, "1");
  assert.equal(getElement("remaining-count-number").textContent, "1");

  // ---------- 删除第二条 ----------
  clickDelete(1);
  await flush();
  items = renderedItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].text, "给前端接入后端 API");
  assert.equal(getElement("stats-total").textContent, "1");
  assert.equal(getElement("remaining-count-number").textContent, "0");

  // ---------- 登出 ----------
  const oldCookie = cookieHeader();
  assert.match(oldCookie, /todo_sid=/);
  getElement("logout-btn").handlers.click[0]();
  await flush();
  assert.equal(getElement("auth-view").hidden, false);
  assert.equal(getElement("app-view").hidden, true);
  assert.equal(window.TodoApi.hasSession(), false);
  assert.equal(window.localStorage.getItem("todo-app.token"), null);

  // 旧 cookie 已在服务端失效:即使手动带上旧凭据也应被拒绝
  const meAfterLogout = await fetch(`${base}/api/me`, {
    headers: { Cookie: oldCookie },
  });
  assert.equal(meAfterLogout.status, 401);

  // ---------- 重新登录,数据仍在 ----------
  clickTab(0);
  fillInput("login-username", "carol");
  fillInput("login-password", "secret1234567");
  submitForm("login-form");
  await flush();
  assert.equal(getElement("app-view").hidden, false);
  items = renderedItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].text, "给前端接入后端 API");
  assert.equal(items[0].completed, true);

  // ---------- 注册 dave,数据互相隔离 ----------
  clickTab(1);
  fillInput("register-username", "dave");
  fillInput("register-password", "secret7890123");
  submitForm("register-form");
  await flush();

  assert.equal(getElement("app-view").hidden, false);
  assert.equal(getElement("current-user").textContent, "dave");
  items = renderedItems();
  assert.equal(items.length, 0, "dave 不应看到 carol 的任何待办");

  fillInput("todo-input", "dave 的任务");
  submitForm("todo-form");
  await flush();
  items = renderedItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].text, "dave 的任务");
});

test("会话过期:API 返回 401 时清除会话标志并回登录页", async () => {
  // 前序场景结束时为 dave 登录态
  assert.equal(getElement("app-view").hidden, false);
  assert.equal(getElement("current-user").textContent, "dave");

  // 服务端使当前会话失效(模拟登录过期/服务端重启)。
  // 手动带上旧 cookie 登出,只让服务端删会话,不影响页面内存中的 hasSession。
  const staleCookie = cookieHeader();
  await fetch(`${base}/api/logout`, {
    method: "POST",
    headers: { Cookie: staleCookie },
  });

  // 客户端仍认为自己已登录:触发任意 API 调用(新增待办 -> createTodo)
  fillInput("todo-input", "会话过期后新增");
  submitForm("todo-form");
  await flush();

  // 401 统一处理:清除会话标志并回到登录页
  assert.equal(window.TodoApi.hasSession(), false);
  assert.equal(window.localStorage.getItem("todo-app.token"), null);
  assert.equal(getElement("app-view").hidden, true);
  assert.equal(getElement("auth-view").hidden, false);
});

test("多端同步:另一会话修改后,本端轮询自动同步并提示", async () => {
  // 上一个用例已回到登录页;注册新用户 erin
  clickTab(1);
  fillInput("register-username", "erin");
  fillInput("register-password", "secret1234567");
  submitForm("register-form");
  await flush();
  assert.equal(getElement("app-view").hidden, false);

  fillInput("todo-input", "多端同步任务");
  submitForm("todo-form");
  await flush();

  let items = renderedItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].completed, false);

  // 模拟第二个浏览器:同一账号另开会话,勾选完成
  const loginRes = await fetch(`${base}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "erin", password: "secret1234567" }),
  });
  const { token } = await loginRes.json();
  const serverList = await (
    await fetch(`${base}/api/todos`, { headers: { Authorization: "Bearer " + token } })
  ).json();
  const target = serverList.find((t) => t.text === "多端同步任务");
  const patchRes = await fetch(`${base}/api/todos/${encodeURIComponent(target.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
    body: JSON.stringify({ completed: true }),
  });
  assert.equal(patchRes.status, 200);

  // 轮询间隔 150ms:等待若干轮
  await new Promise((r) => setTimeout(r, 500));

  items = renderedItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].completed, true, "另一端的勾选应自动同步到本端");
  assert.equal(getElement("stats-completed").textContent, "1");
  assert.equal(getElement("remaining-count-number").textContent, "0", "多端同步后计数同步更新");
  assert.equal(getElement("sync-notice").hidden, false);
  assert.equal(getElement("sync-notice").textContent, "已在其他设备更新");
});

test("空状态:无待办时展示插画、引导文案与添加入口", async () => {
  // 注册新用户 frank,待办为空
  clickTab(1);
  fillInput("register-username", "frank");
  fillInput("register-password", "secret1234567");
  submitForm("register-form");
  await flush();

  const list = getElement("todo-list");
  assert.equal(list.children.length, 0);
  assert.equal(getElement("empty-state").hidden, false);
  assert.equal(getElement("empty-state-title").textContent, "还没有待办事项");
  assert.match(getElement("empty-state-text").textContent, /添加你的第一条待办/);
  assert.equal(getElement("empty-state-action").hidden, false);
  assert.equal(getElement("list-pagination").hidden, true);

  // 「添加第一个待办」不会抛错(真实浏览器中聚焦输入框)
  getElement("empty-state-action").handlers.click[0]();

  // 添加一条后空状态消失
  fillInput("todo-input", "第一条待办");
  submitForm("todo-form");
  await flush();
  assert.equal(getElement("todo-list").children.length, 1);
  assert.equal(getElement("empty-state").hidden, true);
});

test("长列表:默认只渲染一页,加载更多后补齐且切换筛选重置分页", async () => {
  // 前一个用例结束时 frank 已登录,直接通过 API 批量造 25 条数据
  assert.ok(window.TodoApi.hasSession(), "应处于登录态");

  const posts = [];
  for (let i = 0; i < 25; i++) {
    posts.push(fetch(`${base}/api/todos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `批量任务 ${i}` }),
    }));
  }
  const results = await Promise.all(posts);
  results.forEach((res) => assert.equal(res.status, 201));

  // 轮询会在 150ms 间隔内把远端新增合并进来,等它渲染完成
  await new Promise((r) => setTimeout(r, 800));

  const list = getElement("todo-list");
  assert.equal(list.children.length, 20, "默认只渲染第一页(20 条)");
  assert.equal(getElement("stats-total").textContent, "26", "统计仍覆盖全部待办(含先前 1 条)");
  assert.equal(getElement("empty-state").hidden, true);

  const pagination = getElement("list-pagination");
  assert.equal(pagination.hidden, false);
  assert.match(getElement("list-status").textContent, /20 \/ 26/);
  assert.equal(getElement("load-more-btn").hidden, false);

  // 点击加载更多 -> 全部 26 条渲染,按钮隐藏,状态提示已全部加载
  getElement("load-more-btn").handlers.click[0]();
  assert.equal(getElement("todo-list").children.length, 26);
  assert.match(getElement("list-status").textContent, /已全部加载,共 26 项/);
  assert.equal(pagination.hidden, false);
  assert.equal(getElement("load-more-btn").hidden, true);

  // 切换筛选会把加载深度重置回第一页
  filterBtns[1].handlers.click[0](); // 未完成
  assert.equal(getElement("todo-list").children.length, 20);
  assert.match(getElement("list-status").textContent, /20 \/ 26/);

  // 已完成筛选无匹配:展示筛选语境空状态,但不显示"添加"引导
  filterBtns[2].handlers.click[0]();
  assert.equal(getElement("todo-list").children.length, 0);
  assert.equal(getElement("empty-state").hidden, false);
  assert.equal(getElement("empty-state-title").textContent, "还没有已完成的事项");
  assert.equal(getElement("empty-state-action").hidden, true);
  assert.equal(getElement("list-pagination").hidden, true);

  filterBtns[0].handlers.click[0](); // 全部
  assert.equal(getElement("todo-list").children.length, 20);
  assert.equal(getElement("empty-state").hidden, true);
});

test("筛选标签 / 实时计数 / 一键清除已完成", async () => {
  // 注册独立用户 grace,避免受前序用例数据影响
  clickTab(1);
  fillInput("register-username", "grace");
  fillInput("register-password", "secret1234567");
  submitForm("register-form");
  await flush();
  assert.equal(getElement("app-view").hidden, false);
  assert.equal(getElement("current-user").textContent, "grace");

  // 空列表:未完成计数为 0,清除按钮禁用
  assert.equal(getElement("remaining-count-number").textContent, "0");
  assert.equal(getElement("clear-completed-btn").disabled, true);

  // 添加三条进行中的待办
  for (const text of ["任务 A", "任务 B", "任务 C"]) {
    fillInput("todo-input", text);
    submitForm("todo-form");
    await flush();
  }
  assert.equal(getElement("remaining-count-number").textContent, "3");
  assert.equal(
    getElement("clear-completed-btn").disabled,
    true,
    "没有已完成项时清除按钮应保持禁用"
  );

  // 标签初始可访问性:只有「全部」选中,且使用 roving tabindex
  assert.equal(filterBtns[0].getAttribute("aria-selected"), "true");
  assert.equal(filterBtns[1].getAttribute("aria-selected"), "false");
  assert.equal(filterBtns[2].getAttribute("aria-selected"), "false");
  assert.equal(filterBtns[0].getAttribute("tabindex"), "0");
  assert.equal(filterBtns[1].getAttribute("tabindex"), "-1");

  // 方向键在标签间移动焦点并切换(ARIA tabs 键盘模式)
  filterBtns[0].handlers.keydown[0]({ key: "ArrowRight", preventDefault() {} });
  assert.equal(filterBtns[1].getAttribute("aria-selected"), "true");
  assert.equal(filterBtns[0].getAttribute("aria-selected"), "false");
  filterBtns[1].handlers.keydown[0]({ key: "ArrowLeft", preventDefault() {} });
  assert.equal(filterBtns[0].getAttribute("aria-selected"), "true");

  // 完成任务 A(全部视图下第 0 条),计数实时更新
  clickCheckbox(0);
  await flush();
  assert.equal(getElement("remaining-count-number").textContent, "2");
  assert.equal(getElement("stats-completed").textContent, "1");
  assert.equal(getElement("clear-completed-btn").disabled, false);

  // 切到「已完成」:只显示 A,高亮与 aria-selected 同步
  filterBtns[2].handlers.click[0]();
  assert.equal(filterBtns[2].getAttribute("aria-selected"), "true");
  assert.equal(filterBtns[0].getAttribute("aria-selected"), "false");
  assert.equal(filterBtns[2].getAttribute("tabindex"), "0");
  assert.deepEqual(renderedItems().map((i) => i.text), ["任务 A"]);
  assert.equal(getElement("remaining-count-number").textContent, "2", "计数为全局口径,不随筛选收窄");

  // 切到「进行中」:只显示 B、C
  filterBtns[1].handlers.click[0]();
  assert.equal(filterBtns[1].getAttribute("aria-selected"), "true");
  assert.deepEqual(renderedItems().map((i) => i.text), ["任务 B", "任务 C"]);
  assert.equal(getElement("remaining-count-number").textContent, "2");

  filterBtns[0].handlers.click[0](); // 回到「全部」
  assert.equal(getElement("todo-list").children.length, 3);

  // 再完成任务 B(全部视图下第 1 条)
  clickCheckbox(1);
  await flush();
  assert.equal(getElement("remaining-count-number").textContent, "1");

  // 第一次点击只进入二次确认态,不删除任何数据
  const clearBtn = getElement("clear-completed-btn");
  clearBtn.handlers.click[0]();
  assert.match(clearBtn.textContent, /确认清除 2 项/);
  assert.equal(clearBtn.classList.contains("is-confirming"), true);
  assert.equal(getElement("todo-list").children.length, 3, "第一次点击不应删除待办");

  // 第二次点击才真正清除,仅移除已完成项
  clearBtn.handlers.click[0]();
  await flush();
  assert.deepEqual(renderedItems(), [{ text: "任务 C", completed: false }]);
  assert.equal(getElement("stats-completed").textContent, "0");
  assert.equal(getElement("stats-total").textContent, "1");
  assert.equal(getElement("remaining-count-number").textContent, "1");
  assert.equal(clearBtn.disabled, true);
  assert.match(getElement("clear-status").textContent, /已清除 2 项已完成待办/);

  // 服务端同样只剩进行中的任务 C,确认没有误删未完成项
  const serverList = await (await fetch(`${base}/api/todos`)).json();
  assert.deepEqual(
    serverList.map((t) => ({ text: t.text, completed: !!t.completed })),
    [{ text: "任务 C", completed: false }]
  );

  // 已完成筛选下为空:展示筛选空状态,但不显示「添加」引导
  filterBtns[2].handlers.click[0]();
  assert.equal(getElement("todo-list").children.length, 0);
  assert.equal(getElement("empty-state").hidden, false);
  assert.equal(getElement("empty-state-title").textContent, "还没有已完成的事项");
  assert.equal(getElement("empty-state-action").hidden, true);

  filterBtns[0].handlers.click[0](); // 收尾回到「全部」
});

/* ---------- 双击编辑 ---------- */

test("双击编辑:失焦(点击别处)自动保存而不是丢弃", async () => {
  await registerAndSeed("henry", ["失焦前", "保持不变"]);
  assert.deepEqual(renderedItems().map((i) => i.text), ["失焦前", "保持不变"]);

  const { li, editor } = startEditing(0);
  assert.ok(editor, "双击文本后应出现编辑输入框");
  assert.equal(li.classList.contains("is-editing"), true);
  assert.equal(editor.value, "失焦前");

  // 输入新内容后点击别处:blur 应提交保存
  editor.value = "失焦后";
  editor.handlers.input[0]({});
  editor.handlers.blur[0]({});
  await flush();

  assert.deepEqual(renderedItems().map((i) => i.text), ["失焦后", "保持不变"]);
  assert.equal(getElement("todo-list").children[0].classList.contains("is-editing"), false);

  const serverList = await (await fetch(`${base}/api/todos`)).json();
  assert.ok(
    serverList.some((t) => t.text === "失焦后"),
    "失焦保存应通过 PATCH 提交到服务端"
  );
  assert.ok(!serverList.some((t) => t.text === "失焦前"));
});

test("双击编辑:内容未改动或为空白时失焦不产生写入", async () => {
  await registerAndSeed("iris", ["原文本"]);

  const first = startEditing(0);
  first.editor.value = "   ";
  first.editor.handlers.blur[0]({});
  await flush();
  assert.deepEqual(renderedItems().map((i) => i.text), ["原文本"], "空白内容应回退为原文");

  const second = startEditing(0);
  second.editor.value = "原文本";
  second.editor.handlers.blur[0]({});
  await flush();
  assert.deepEqual(renderedItems().map((i) => i.text), ["原文本"]);

  const serverList = await (await fetch(`${base}/api/todos`)).json();
  assert.deepEqual(serverList.map((t) => t.text), ["原文本"]);
});

/* ---------- 双击编辑(输入法与轮询) ---------- */

test("双击编辑:输入法组合期回车不提交,确认候选词后再回车才保存", async () => {
  await registerAndSeed("ivy", ["输入法任务"]);

  const { li, editor } = startEditing(0);
  editor.value = "输入法中";
  editor.handlers.input[0]({});
  editor.handlers.compositionstart[0]({});

  // 组合期的回车(候选词确认)不应触发保存
  let prevented = false;
  editor.handlers.keydown[0]({
    key: "Enter",
    isComposing: true,
    keyCode: 229,
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, false, "组合期回车不应被当作提交处理");
  assert.equal(editingEditor(0), editor, "组合期回车后仍应保持编辑态");
  assert.deepEqual(renderedItems().map((i) => i.text), ["输入法任务"]);

  // 部分浏览器不设置 isComposing,仅以 keyCode 229 标识组合期
  editor.handlers.keydown[0]({ key: "Enter", keyCode: 229, preventDefault() {} });
  assert.equal(editingEditor(0), editor, "keyCode 229 同样应视为组合期");

  // 候选词确认、组合结束后的回车才提交
  editor.value = "输入法完成";
  editor.handlers.compositionend[0]({});
  editor.handlers.keydown[0]({ key: "Enter", preventDefault() {} });
  await flush();

  assert.deepEqual(renderedItems().map((i) => i.text), ["输入法完成"]);
  assert.equal(editingEditor(0), null, "提交后应退出编辑态");

  const serverList = await (await fetch(`${base}/api/todos`)).json();
  assert.deepEqual(serverList.map((t) => t.text), ["输入法完成"]);

  // 组合期间 Escape 只取消候选词,不退出编辑态(此处单独验证)
  const again = startEditing(0);
  again.editor.handlers.compositionstart[0]({});
  let escaped = false;
  again.editor.handlers.keydown[0]({
    key: "Escape",
    isComposing: true,
    preventDefault() {
      escaped = true;
    },
  });
  assert.equal(escaped, false);
  assert.equal(editingEditor(0), again.editor, "组合期 Esc 不应退出编辑态");

  // 收尾:组合结束 + Esc 取消编辑
  again.editor.handlers.compositionend[0]({});
  again.editor.handlers.keydown[0]({ key: "Escape", preventDefault() {} });
  assert.equal(editingEditor(0), null);
  assert.deepEqual(renderedItems().map((i) => i.text), ["输入法完成"]);
});

test("双击编辑:轮询整表重绘后仍保留编辑态与未提交输入", async () => {
  await registerAndSeed("judy", ["编辑中的任务", "远端会变的任务"]);

  const { editor } = startEditing(0);
  editor.value = "尚未提交的输入";
  editor.handlers.input[0]({});

  // 同一账号的另一个会话修改另一条待办,触发本端轮询后的 render()
  const serverList = await (await fetch(`${base}/api/todos`)).json();
  const target = serverList.find((t) => t.text === "远端会变的任务");
  assert.ok(target);
  const patchRes = await fetch(`${base}/api/todos/${encodeURIComponent(target.id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ completed: true }),
  });
  assert.equal(patchRes.status, 200);

  // 轮询间隔 150ms:等待同步与重绘完成
  await new Promise((r) => setTimeout(r, 600));

  const list = getElement("todo-list");
  const editedLi = list.children[0];
  const restored = editingEditor(0);
  assert.ok(restored, "轮询重绘后编辑输入框应被恢复");
  assert.equal(editedLi.classList.contains("is-editing"), true, "应仍处于编辑态");
  assert.equal(restored.value, "尚未提交的输入", "未提交的输入不应丢失");
  assert.equal(list.children[1].children[0].checked, true, "远端变更应已同步并重绘");

  // 失焦保存:轮询期间保留的内容正常提交
  restored.handlers.blur[0]({});
  await flush();
  assert.deepEqual(renderedItems()[0].text, "尚未提交的输入");

  const after = await (await fetch(`${base}/api/todos`)).json();
  assert.ok(after.some((t) => t.text === "尚未提交的输入"), "编辑内容应写入服务端");
  assert.ok(!after.some((t) => t.text === "编辑中的任务"));
});

/* ---------- 优先级与排序 ---------- */

test("优先级:前端修改后立即重排,刷新后仍然生效", async () => {
  // 注册独立用户 henry2,避免与其他用例已注册的用户重名
  clickTab(1);
  fillInput("register-username", "henry2");
  fillInput("register-password", "secret1234567");
  submitForm("register-form");
  await flush();
  assert.equal(getElement("current-user").textContent, "henry2");

  fillInput("todo-input", "普通 A");
  submitForm("todo-form");
  await flush();
  fillInput("todo-input", "普通 B");
  submitForm("todo-form");
  await flush();

  assert.deepEqual(
    renderedItems().map((i) => i.text),
    ["普通 A", "普通 B"],
    "默认同为「普通」时按创建顺序"
  );

  // 把第二条设为「高」:本地立即排到最前
  changePriority(1, 2);
  await new Promise((r) => setTimeout(r, 300));

  assert.deepEqual(
    renderedItems().map((i) => i.text),
    ["普通 B", "普通 A"],
    "高优先级立即排到最前"
  );

  // 服务端已持久化优先级,并按新顺序返回
  const serverList = await (await fetch(`${base}/api/todos`)).json();
  assert.deepEqual(
    serverList.map((t) => ({ text: t.text, priority: t.priority })),
    [
      { text: "普通 B", priority: 2 },
      { text: "普通 A", priority: 1 }
    ]
  );

  // 模拟刷新页面:登出后重新登录,顺序仍由服务端决定
  getElement("logout-btn").handlers.click[0]();
  await flush();
  clickTab(0);
  fillInput("login-username", "henry2");
  fillInput("login-password", "secret1234567");
  submitForm("login-form");
  await flush();

  assert.deepEqual(
    renderedItems().map((i) => i.text),
    ["普通 B", "普通 A"],
    "刷新后优先级排序仍然生效"
  );
});

test("保存后按服务端确认的 createdAt 重排,避免刷新前后顺序跳变", async () => {
  // 上一个用例结束时登录的是 henry2,先登出并注册独立用户
  getElement("logout-btn").handlers.click[0]();
  await flush();
  clickTab(1);
  fillInput("register-username", "ivan");
  fillInput("register-password", "secret1234567");
  submitForm("register-form");
  await flush();

  const realFetch = global.fetch;
  let createIndex = 0;
  // 模拟服务端处理顺序与本地提交顺序相反:先提交的拿到更大的 createdAt。
  // 客户端必须以服务端确认值为准重排,否则刷新后会看到另一种顺序。
  const serverCreatedAt = [2000, 1000];
  global.fetch = function (url, opts) {
    return realFetch(url, opts).then(function (res) {
      const isCreate =
        opts && opts.method === "POST" && /\/api\/todos$/.test(String(url));
      if (!isCreate) return res;
      return res.json().then(function (data) {
        const createdAt = serverCreatedAt[createIndex % serverCreatedAt.length];
        createIndex += 1;
        return new Response(
          JSON.stringify(Object.assign({}, data, { createdAt: createdAt })),
          { status: res.status, headers: { "Content-Type": "application/json" } }
        );
      });
    });
  };

  try {
    fillInput("todo-input", "先创建的");
    submitForm("todo-form");
    await flush();
    fillInput("todo-input", "后创建的");
    submitForm("todo-form");
    await flush();

    assert.deepEqual(
      renderedItems().map((i) => i.text),
      ["后创建的", "先创建的"],
      "本地顺序应与服务端确认的 createdAt 排序一致"
    );
  } finally {
    global.fetch = realFetch;
  }
});

/* ---------- 关键字搜索 ---------- */

test("关键字搜索:输入即检索,与三态筛选组合,清空恢复全量列表", async () => {
  await seedUser("kate", ["买牛奶", "写代码", "买咖啡", "跑步"]);
  assert.deepEqual(renderedItems().map((i) => i.text), ["买牛奶", "写代码", "买咖啡", "跑步"]);

  const recorder = recordFetchUrls();
  try {
    typeSearch("买");

    // 防抖期内(默认 250ms)不应发请求;轮询请求不带 q,不计入
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(recorder.qRequests().length, 0, "防抖期内不应立即发起检索");

    await waitFor(
      () => renderedItems().map((i) => i.text).join("|") === "买牛奶|买咖啡",
      "防抖结束后应渲染命中项"
    );
    assert.equal(recorder.qRequests().length, 1);
    assert.match(recorder.qRequests()[0], new RegExp(`q=${encodeURIComponent("买")}(&|$)`));

    // 全局统计口径不随搜索收窄
    assert.equal(getElement("stats-total").textContent, "4");
    assert.equal(getElement("remaining-count-number").textContent, "4");

    // 搜索 × 「进行中」:命中项均为未完成,组合后仍是两条
    filterBtns[1].handlers.click[0]();
    assert.deepEqual(renderedItems().map((i) => i.text), ["买牛奶", "买咖啡"]);

    // 搜索 × 「已完成」:无命中,展示搜索语境空状态且不显示添加引导
    filterBtns[2].handlers.click[0]();
    assert.equal(getElement("todo-list").children.length, 0);
    assert.equal(getElement("empty-state").hidden, false);
    assert.equal(getElement("empty-state-title").textContent, "当前筛选下没有匹配的待办");
    assert.match(getElement("empty-state-text").textContent, /买/);
    assert.equal(getElement("empty-state-action").hidden, true);

    // 回到「全部」后清空搜索:不发送请求,直接恢复内存中的全量列表
    filterBtns[0].handlers.click[0]();
    const qBeforeClear = recorder.qRequests().length;

    typeSearch("   ");
    assert.deepEqual(
      renderedItems().map((i) => i.text),
      ["买牛奶", "写代码", "买咖啡", "跑步"],
      "纯空白关键字立即恢复普通列表"
    );

    typeSearch("");
    await waitSearch();
    assert.deepEqual(
      renderedItems().map((i) => i.text),
      ["买牛奶", "写代码", "买咖啡", "跑步"]
    );
    assert.equal(recorder.qRequests().length, qBeforeClear, "清空搜索不应发起任何检索请求");
  } finally {
    recorder.restore();
  }
});

test("关键字搜索:回车立即检索,q 与 since 互斥,搜索态写操作不影响未命中项", async () => {
  await seedUser("liam", ["苹果", "香蕉", "苹果派"]);

  const recorder = recordFetchUrls();
  try {
    typeSearch("苹果");
    // 回车不等防抖;150ms < 250ms 防抖,此时已发请求说明是回车触发的
    assert.equal(pressSearchEnter(), true, "回车应被搜索框拦截");
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(recorder.qRequests().length, 1, "回车应立即发起检索,不等防抖");
    await waitFor(
      () => renderedItems().map((i) => i.text).join("|") === "苹果|苹果派",
      "回车检索结果应渲染"
    );

    const qUrls = recorder.qRequests();
    assert.equal(qUrls.length, 1);
    assert.match(qUrls[0], new RegExp(`q=${encodeURIComponent("苹果")}(&|$)`));

    // 任何请求都不得同时携带 q 与 since(检索是全量语义)
    for (const url of recorder.urls) {
      assert.ok(
        !(url.includes("q=") && url.includes("since=")),
        `请求不应同时携带 q 与 since: ${url}`
      );
    }

    // ---------- 搜索态下的写操作 ----------
    // 删除一条命中项:只删这一条,未命中的「香蕉」不受影响
    clickDelete(0); // 苹果
    await flush();
    assert.deepEqual(renderedItems().map((i) => i.text), ["苹果派"]);

    // 新增一条未命中当前关键字的待办:服务端应真实创建,但当前搜索视图不展示它
    fillInput("todo-input", "苹果汁");
    submitForm("todo-form");
    await flush();
    assert.deepEqual(
      renderedItems().map((i) => i.text),
      ["苹果派"],
      "新增未命中项不进入当前搜索视图"
    );

    // 勾选命中项:只改这一条
    clickCheckbox(0); // 苹果派
    await flush();
    assert.equal(renderedItems()[0].completed, true);

    // 编辑命中项:改的是全量数据里的同一条
    const { editor } = startEditing(0);
    editor.value = "苹果派改名";
    editor.handlers.blur[0]({});
    await flush();
    assert.deepEqual(renderedItems().map((i) => i.text), ["苹果派改名"]);

    // 清空搜索:恢复全量列表,未命中项(香蕉/苹果汁)完好且状态正确
    typeSearch("");
    assert.deepEqual(
      renderedItems(),
      [
        { text: "香蕉", completed: false },
        { text: "苹果派改名", completed: true },
        { text: "苹果汁", completed: false },
      ],
      "搜索态写操作不得误删或覆盖未命中项"
    );

    const serverList = await (await fetch(`${base}/api/todos`)).json();
    assert.deepEqual(
      serverList.map((t) => ({ text: t.text, completed: !!t.completed })),
      [
        { text: "香蕉", completed: false },
        { text: "苹果派改名", completed: true },
        { text: "苹果汁", completed: false },
      ]
    );
  } finally {
    recorder.restore();
  }
});

test("关键字搜索:无匹配空状态、迟到响应丢弃与会话重置", async () => {
  await seedUser("mia", ["任务一", "任务二", "杂项"]);

  // ---------- 无匹配:搜索专用空状态,隐藏「添加第一个待办」 ----------
  typeSearch("不存在的关键字");
  await waitFor(
    () => getElement("empty-state").hidden === false && getElement("todo-list").children.length === 0,
    "无匹配时应展示空状态"
  );
  assert.equal(getElement("todo-list").children.length, 0);
  assert.equal(getElement("empty-state").hidden, false);
  assert.equal(getElement("empty-state-title").textContent, "没有匹配的待办");
  assert.match(getElement("empty-state-text").textContent, /不存在的关键字/);
  assert.equal(getElement("empty-state-action").hidden, true);
  assert.equal(getElement("list-pagination").hidden, true);

  // 清空后恢复三条
  typeSearch("");
  assert.equal(getElement("todo-list").children.length, 3);
  assert.equal(getElement("empty-state").hidden, true);

  // ---------- 迟到的搜索响应必须被丢弃 ----------
  const realFetch = global.fetch;
  global.fetch = function (url, opts) {
    if (String(url).includes("/api/todos?") && String(url).includes("q=")) {
      // 模拟慢网络:检索请求比用户清空输入更晚返回
      return new Promise((resolve, reject) => {
        setTimeout(() => {
          realFetch(url, opts).then(resolve, reject);
        }, 250);
      });
    }
    return realFetch(url, opts);
  };
  try {
    typeSearch("任务");
    await new Promise((r) => setTimeout(r, 420)); // 防抖已过,请求在路上
    typeSearch(""); // 响应到达前清空搜索
    await new Promise((r) => setTimeout(r, 700)); // 等迟到响应回来
    assert.equal(getElement("todo-search").value, "");
    assert.deepEqual(
      renderedItems().map((i) => i.text),
      ["任务一", "任务二", "杂项"],
      "迟到的检索响应不应重新收窄列表"
    );
  } finally {
    global.fetch = realFetch;
  }

  // ---------- 登出重置搜索,重新登录后为全量普通列表 ----------
  typeSearch("任务");
  await waitFor(
    () => renderedItems().map((i) => i.text).join("|") === "任务一|任务二",
    "搜索「任务」应只命中两条"
  );

  getElement("logout-btn").handlers.click[0]();
  await flush();
  assert.equal(getElement("auth-view").hidden, false);
  assert.equal(getElement("todo-search").value, "", "登出后搜索关键字应被清空");

  clickTab(0);
  fillInput("login-username", "mia");
  fillInput("login-password", "secret1234567");
  submitForm("login-form");
  await flush();
  assert.equal(getElement("app-view").hidden, false);
  assert.equal(getElement("todo-search").value, "", "重新登录后不应恢复上次搜索");
  assert.deepEqual(
    renderedItems().map((i) => i.text),
    ["任务一", "任务二", "杂项"],
    "重新登录后展示全量列表"
  );
});

test("关键字搜索:命中结果沿用每页 20 条分页与加载更多", async () => {
  const seeds = [];
  for (let i = 0; i < 26; i++) seeds.push(`目标 ${i}`);
  await seedUser("nina", seeds);
  assert.equal(getElement("stats-total").textContent, "26");

  typeSearch("目标");
  await waitFor(
    () => getElement("todo-list").children.length === 20 && getElement("list-pagination").hidden === false,
    "搜索结果应渲染第一页"
  );

  assert.equal(getElement("todo-list").children.length, 20, "搜索结果默认只渲染一页");
  assert.equal(getElement("stats-total").textContent, "26", "统计仍为全量口径");
  assert.equal(getElement("empty-state").hidden, true);
  assert.equal(getElement("list-pagination").hidden, false);
  assert.match(getElement("list-status").textContent, /20 \/ 26/);
  assert.equal(getElement("load-more-btn").hidden, false);

  getElement("load-more-btn").handlers.click[0]();
  assert.equal(getElement("todo-list").children.length, 26);
  assert.match(getElement("list-status").textContent, /已全部加载,共 26 项/);

  // 清空搜索:恢复普通列表并从第一页开始
  typeSearch("");
  assert.equal(getElement("todo-list").children.length, 20);
  assert.equal(getElement("stats-total").textContent, "26");
});
