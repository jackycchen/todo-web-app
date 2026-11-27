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
const sortBtns = ["desc", "asc"].map((s) => {
  const b = createElement("button");
  b.dataset.sort = s;
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
    if (sel === ".filter-btn") return filterBtns.concat(sortBtns);
    if (sel === "[data-sort]") return sortBtns;
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
  global.window.TODO_SEARCH_DEBOUNCE_MS = 0; // 关闭搜索防抖:输入即检索,断言更确定
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

const flush = () => new Promise((r) => setTimeout(r, 120));

// ---------- 页面交互辅助 ----------
function fillInput(id, value) {
  getElement(id).value = value;
}

function submitForm(id) {
  getElement(id).handlers.submit[0]({ preventDefault() {} });
}

/** 在搜索框输入关键字并触发 input 事件(防抖已关闭:输入即检索) */
function typeSearch(value) {
  const search = getElement("todo-search");
  search.value = value;
  search.handlers.input[0]({});
}

/** 在搜索框上按键:Enter 立即检索,Escape 清空 */
function pressSearchKey(key) {
  getElement("todo-search").handlers.keydown[0]({ key, preventDefault() {} });
}

/**
 * 在 fn 执行期间记录所有 fetch 请求的 URL,结束后恢复原 fetch。
 * 用于断言「请求是否带 q / 带 since / 二者是否同时出现」。
 */
async function recordFetch(fn) {
  const calls = [];
  const prevFetch = global.fetch;
  global.fetch = function (input, init) {
    calls.push(String(input));
    return prevFetch(input, init);
  };
  try {
    await fn(calls);
  } finally {
    global.fetch = prevFetch;
  }
  return calls;
}

/** 搜索涉及「保存 -> 重新检索」的串行请求,等待时间放宽一些 */
const flushLong = () => new Promise((r) => setTimeout(r, 300));

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

  // 切换排序同样把加载深度重置回第一页(本用例条目同优先级,顺序不变)
  sortBtns[1].handlers.click[0](); // 低→高
  assert.equal(getElement("todo-list").children.length, 20, "切换排序后回到第一页");
  sortBtns[0].handlers.click[0](); // 高→低
  assert.equal(getElement("todo-list").children.length, 20);

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

test("排序切换:高→低 / 低→高 只改变渲染顺序,不写入服务端", async () => {
  // 承接上一个用例的登录态 ivan,登出后注册独立用户 ken
  getElement("logout-btn").handlers.click[0]();
  await flush();
  clickTab(1);
  fillInput("register-username", "ken");
  fillInput("register-password", "secret1234567");
  submitForm("register-form");
  await flush();

  for (const text of ["甲", "乙", "丙"]) {
    fillInput("todo-input", text);
    submitForm("todo-form");
    await flush();
  }

  // 丙 -> 低(0),甲 -> 高(2);乙保持普通(1)
  changePriority(2, 0);
  await new Promise((r) => setTimeout(r, 300));
  changePriority(0, 2);
  await new Promise((r) => setTimeout(r, 300));

  assert.deepEqual(renderedItems().map((i) => i.text), ["甲", "乙", "丙"], "默认高→低");

  // 排序按钮不属于筛选标签集合:不会被写入 aria-selected / tabindex
  assert.equal(sortBtns[0].getAttribute("aria-selected"), undefined);
  assert.equal(sortBtns[0].getAttribute("tabindex"), undefined);
  assert.equal(sortBtns[0].getAttribute("aria-pressed"), "true");
  assert.equal(sortBtns[1].getAttribute("aria-pressed"), "false");

  // 切到低→高:视图顺序反转,同优先级内仍保持 createdAt 升序
  sortBtns[1].handlers.click[0]();
  assert.deepEqual(renderedItems().map((i) => i.text), ["丙", "乙", "甲"]);
  assert.equal(sortBtns[1].getAttribute("aria-pressed"), "true");
  assert.equal(sortBtns[0].getAttribute("aria-pressed"), "false");
  assert.equal(sortBtns[1].classList.contains("is-active"), true);
  assert.equal(sortBtns[0].classList.contains("is-active"), false);

  // 排序只是渲染期变换:服务端顺序仍是 DESC
  const serverList = await (await fetch(`${base}/api/todos`)).json();
  assert.deepEqual(
    serverList.map((t) => t.text),
    ["甲", "乙", "丙"],
    "前端排序不得回写服务端顺序"
  );

  // 筛选与排序组合:勾选「乙」后,已完成 / 进行中各自仍按 asc 排列
  clickCheckbox(1);
  await flush();
  filterBtns[2].handlers.click[0](); // 已完成
  assert.deepEqual(renderedItems().map((i) => i.text), ["乙"]);
  filterBtns[1].handlers.click[0](); // 进行中
  assert.deepEqual(renderedItems().map((i) => i.text), ["丙", "甲"]);
  filterBtns[0].handlers.click[0](); // 全部
  assert.deepEqual(renderedItems().map((i) => i.text), ["丙", "乙", "甲"]);

  // 排序触发的整表重绘保留编辑态与未提交输入:
  // asc 视图第一行是「丙」,切回 desc 后它落到第三行,编辑框应随之恢复
  const { editor } = startEditing(0);
  assert.ok(editor, "应进入编辑态");
  editor.value = "丙 - 草稿";
  editor.handlers.input[0]();
  sortBtns[0].handlers.click[0](); // 切回高→低
  const restored = editingEditor(2);
  assert.ok(restored, "重绘后应恢复编辑框");
  assert.equal(restored.value, "丙 - 草稿", "未提交输入不得丢失");
  restored.handlers.keydown[0]({ key: "Escape", preventDefault() {} });

  assert.deepEqual(renderedItems().map((i) => i.text), ["甲", "乙", "丙"]);
  assert.equal(sortBtns[0].getAttribute("aria-pressed"), "true");
  assert.equal(sortBtns[1].getAttribute("aria-pressed"), "false");
});

/* ---------- 关键字搜索 ---------- */

test("搜索:静态结构 + 输入关键字触发带 q 的请求并渲染匹配结果", async () => {
  // DOM 桩不解析 index.html,搜索框的语义属性只能静态断言
  const indexHtml = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
  const searchTag = /<input[^>]*id="todo-search"[^>]*>/.exec(indexHtml);
  assert.ok(searchTag, "index.html 应包含 #todo-search 输入框");
  assert.match(searchTag[0], /type="search"/);
  assert.match(searchTag[0], /maxlength="200"/);
  assert.match(searchTag[0], /aria-label="搜索待办"/);
  assert.match(indexHtml, /<label[^>]*for="todo-search"/, "搜索框应有对应的 label");
  assert.ok(
    indexHtml.indexOf("filter-toolbar") < indexHtml.indexOf('id="todo-search"') &&
      indexHtml.indexOf('id="todo-search"') < indexHtml.indexOf('id="todo-panel"'),
    "搜索框应位于筛选工具栏内"
  );

  await registerAndSeed("kate", ["买牛奶", "写周报", "买面包"]);
  assert.deepEqual(
    renderedItems().map((i) => i.text),
    ["买牛奶", "写周报", "买面包"]
  );

  const query = "/api/todos?q=" + encodeURIComponent("买");
  const calls = await recordFetch(async () => {
    typeSearch("买");
    await flushLong();
  });

  assert.ok(
    calls.some((u) => u.includes(query)),
    "输入关键字应发出带 q 的检索请求"
  );
  assert.ok(
    !calls.some((u) => u.includes("since=")),
    "搜索请求不得与 since 增量参数混用"
  );
  assert.deepEqual(
    renderedItems().map((i) => i.text),
    ["买牛奶", "买面包"],
    "应只渲染命中关键字的待办"
  );
  assert.equal(getElement("empty-state").hidden, true);
});

test("搜索:清空或纯空白关键字恢复不带 q 的普通列表", async () => {
  // 承接上一用例:kate 已登录且正在搜索「买」
  assert.equal(getElement("todo-search").value, "买");

  const calls = await recordFetch(async () => {
    typeSearch("   "); // 纯空白等价于清空
    await flushLong();
  });

  assert.ok(
    calls.some((u) => /\/api\/todos$/.test(u)),
    "退出搜索应重新拉取不带 q 的普通列表"
  );
  assert.ok(
    !calls.some((u) => u.includes("?q=")),
    "恢复普通列表后不应再带 q"
  );
  assert.equal(getElement("todo-search").value, "", "纯空白输入应被清空");
  assert.deepEqual(
    renderedItems().map((i) => i.text),
    ["买牛奶", "写周报", "买面包"],
    "恢复普通列表应展示全部待办"
  );
});

test("搜索:与三态筛选组合生效,切换筛选不丢关键字", async () => {
  // 承接上一用例:已回到普通列表,筛选为「全部」
  const query = "/api/todos?q=" + encodeURIComponent("买");
  await recordFetch(async () => {
    typeSearch("买");
    await flushLong();
  });

  // 把「买牛奶」标记为已完成(搜索态下写操作会校准结果集)
  clickCheckbox(0);
  await flushLong();
  assert.deepEqual(renderedItems().map((i) => i.text), ["买牛奶", "买面包"]);
  assert.equal(getElement("todo-search").value, "买", "切换完成状态不应丢失关键字");

  // 切换三态筛选:纯客户端过滤,不应退化成不带 q 的普通列表请求
  const filterCalls = await recordFetch(async () => {
    filterBtns[2].handlers.click[0](); // 已完成
    await flush();
  });
  assert.deepEqual(
    renderedItems().map((i) => i.text),
    ["买牛奶"],
    "搜索 + 已完成筛选应同时生效"
  );
  assert.ok(
    !filterCalls.some((u) => u.includes("/api/todos")),
    "切换筛选不应重新发起列表请求(关键字与结果保持)"
  );

  filterBtns[1].handlers.click[0](); // 进行中
  assert.deepEqual(
    renderedItems().map((i) => i.text),
    ["买面包"],
    "搜索 + 进行中筛选应同时生效"
  );

  filterBtns[0].handlers.click[0](); // 全部
  assert.deepEqual(renderedItems().map((i) => i.text), ["买牛奶", "买面包"]);
  assert.equal(getElement("todo-search").value, "买", "筛选切换后关键字仍在");

  // 回车立即检索:请求仍带 q,说明关键字未被筛选覆盖
  const enterCalls = await recordFetch(async () => {
    pressSearchKey("Enter");
    await flushLong();
  });
  assert.ok(
    enterCalls.some((u) => u.includes(query)),
    "搜索态下的再次检索仍应带 q"
  );
  assert.deepEqual(renderedItems().map((i) => i.text), ["买牛奶", "买面包"]);
});

test("搜索:与 since 轮询互斥,退出搜索后全量刷新并恢复轮询", async () => {
  // 承接上一用例:kate 仍处于搜索「买」的状态,筛选为「全部」
  assert.equal(getElement("todo-search").value, "买");

  // 搜索期间即使超过轮询间隔,也不得发出 since 增量请求
  const pollingCalls = await recordFetch(async () => {
    await new Promise((r) => setTimeout(r, 400));
  });
  assert.equal(
    pollingCalls.filter((u) => u.includes("since=")).length,
    0,
    "搜索期间不应轮询 since 增量"
  );
  assert.equal(
    pollingCalls.filter((u) => u.includes("q=") && u.includes("since=")).length,
    0,
    "q 与 since 永不同时出现"
  );

  // 清空搜索:先全量刷新(不带 q/since),随后恢复 since 轮询
  const exitCalls = await recordFetch(async () => {
    typeSearch("");
    await flushLong();
    await new Promise((r) => setTimeout(r, 400)); // 等待至少一轮轮询
  });

  assert.ok(
    exitCalls.some((u) => /\/api\/todos$/.test(u)),
    "退出搜索应先发出不带 q/since 的全量列表请求"
  );
  assert.ok(
    exitCalls.some((u) => u.includes("since=")),
    "退出搜索后应恢复 since 增量轮询"
  );
  assert.ok(
    !exitCalls.some((u) => u.includes("?q=")),
    "退出搜索后不应再带 q"
  );
  for (const url of pollingCalls.concat(exitCalls)) {
    assert.ok(
      !(url.includes("q=") && url.includes("since=")),
      `任何请求都不得同时带 q 与 since: ${url}`
    );
  }
});

test("搜索 × 排序组合:搜索结果同样跟随排序方向,且切排序不再发请求", async () => {
  // 承接上一用例:kate 已登录、搜索已清空、筛选为「全部」
  getElement("logout-btn").handlers.click[0]();
  await flush();

  await registerAndSeed("leo", ["买牛奶", "买面包", "买豆浆"]);

  // 三个条目给成互不相同的优先级,排序结果不再依赖 createdAt:
  // 买牛奶=高(2) / 买面包=普通(1) / 买豆浆=低(0)
  const indexOf = (text) => renderedItems().findIndex((i) => i.text === text);
  changePriority(indexOf("买牛奶"), 2);
  await flushLong();
  changePriority(indexOf("买面包"), 1);
  await flushLong();
  changePriority(indexOf("买豆浆"), 0);
  await flushLong();
  assert.deepEqual(
    renderedItems().map((i) => i.text),
    ["买牛奶", "买面包", "买豆浆"],
    "普通列表默认高→低"
  );

  await recordFetch(async () => {
    typeSearch("买");
    await flushLong();
  });
  assert.deepEqual(
    renderedItems().map((i) => i.text),
    ["买牛奶", "买面包", "买豆浆"],
    "搜索结果应沿用当前排序方向(高→低)"
  );

  // 搜索态切排序:纯客户端重排,不得重新发请求,避免引入 q 与 since 混用的可能
  const sortCalls = await recordFetch(async () => {
    sortBtns[1].handlers.click[0](); // 低→高
    await flush();
  });
  assert.deepEqual(
    renderedItems().map((i) => i.text),
    ["买豆浆", "买面包", "买牛奶"],
    "搜索结果应跟随排序切换(低→高)"
  );
  assert.equal(
    sortCalls.filter((u) => u.includes("/api/todos")).length,
    0,
    "搜索态切排序不应触发任何列表/检索请求"
  );
  assert.equal(getElement("todo-search").value, "买", "切排序不应丢失关键字");

  // 搜索 × 排序 × 三态筛选三者叠加:已完成筛选下仍保持 asc
  clickCheckbox(0); // 勾选 asc 下首行「买豆浆」
  await flushLong();
  filterBtns[2].handlers.click[0](); // 已完成
  assert.deepEqual(renderedItems().map((i) => i.text), ["买豆浆"]);
  filterBtns[1].handlers.click[0](); // 进行中
  assert.deepEqual(renderedItems().map((i) => i.text), ["买面包", "买牛奶"]);
  filterBtns[0].handlers.click[0](); // 全部

  // 退出搜索后普通列表同样沿用 asc,说明排序是视图级偏好而非搜索专属
  await recordFetch(async () => {
    typeSearch("");
    await flushLong();
  });
  assert.deepEqual(
    renderedItems().map((i) => i.text),
    ["买豆浆", "买面包", "买牛奶"],
    "退出搜索后普通列表应保持当前排序方向"
  );

  // 复原为默认 desc,避免影响后续用例
  sortBtns[0].handlers.click[0]();
  assert.equal(sortBtns[0].getAttribute("aria-pressed"), "true");
});

/* ---------- 删除撤销 ---------- */

test("撤销删除:删除后显示提示,点击撤销在当前筛选/排序下恢复条目", async () => {
  await registerAndSeed("undo_flow", ["撤销甲", "撤销乙", "撤销丙"]);
  filterBtns[0].handlers.click[0](); // 全部
  sortBtns[0].handlers.click[0](); // 高→低(默认)

  assert.equal(getElement("undo-toast").hidden, true, "初始不显示撤销提示");

  clickDelete(1); // 删除「撤销乙」
  await flush();

  assert.deepEqual(renderedItems().map((i) => i.text), ["撤销甲", "撤销丙"]);
  assert.equal(getElement("undo-toast").hidden, false, "删除后应显示撤销提示");
  assert.match(getElement("undo-toast-text").textContent, /已删除/);
  assert.match(
    getElement("undo-toast-text").textContent,
    /已删除\s*·/,
    "提示文案应为「已删除 · 撤销」"
  );

  // 点击撤销:条目回到列表,当前筛选/排序不被重置
  getElement("undo-btn").handlers.click[0]();
  await flushLong();

  assert.deepEqual(
    renderedItems().map((i) => i.text),
    ["撤销甲", "撤销乙", "撤销丙"],
    "撤销后条目应按当前排序回到列表"
  );
  assert.equal(getElement("undo-toast").hidden, true, "撤销后提示应消失");
  assert.equal(filterBtns[0].getAttribute("aria-selected"), "true", "筛选未被重置");
  assert.equal(sortBtns[0].getAttribute("aria-pressed"), "true", "排序未被重置");
  assert.equal(getElement("stats-total").textContent, "3");

  // 服务端是「恢复」而不是重复新建:同一条待办只有一份
  const serverList = await (await fetch(`${base}/api/todos`)).json();
  assert.equal(serverList.length, 3);
  assert.equal(serverList.filter((t) => t.text === "撤销乙").length, 1);

  // 跨过多轮 5 秒轮询(测试间隔已缩短):增量同步不得把恢复项再次移除
  await new Promise((r) => setTimeout(r, 450));
  assert.deepEqual(
    renderedItems().map((i) => i.text),
    ["撤销甲", "撤销乙", "撤销丙"],
    "恢复后的条目不应被轮询带回的旧墓碑移除"
  );
});

test("撤销删除:窗口超时后提示自动消失,之后点击不再发起恢复", async () => {
  await registerAndSeed("undo_timeout", ["超时任务"]);
  filterBtns[0].handlers.click[0]();

  window.TODO_UNDO_WINDOW_MS = 80;
  try {
    clickDelete(0);
    // 提示在删除时同步出现(窗口很短,这里不等 flush 以免已经超时)
    assert.equal(getElement("undo-toast").hidden, false);
    assert.match(getElement("undo-toast-text").textContent, /已删除/);

    await new Promise((r) => setTimeout(r, 260));
    assert.equal(getElement("undo-toast").hidden, true, "窗口到期后提示应自动消失");

    // 超时后点击不再发起恢复:列表与server端都保持删除状态
    getElement("undo-btn").handlers.click[0]();
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(getElement("todo-list").children.length, 0);
    const serverList = await (await fetch(`${base}/api/todos`)).json();
    assert.equal(serverList.length, 0, "超时后的点击不应恢复任何条目");
  } finally {
    window.TODO_UNDO_WINDOW_MS = 5000;
  }
});

test("撤销删除:连续删除只保留一条提示,撤销仅恢复最近一条", async () => {
  await registerAndSeed("undo_stack", ["连续一", "连续二", "连续三"]);
  filterBtns[0].handlers.click[0]();
  sortBtns[0].handlers.click[0]();

  // 不等待中间结果,连续删除两条:第二次删除应复用同一个提示节点
  clickDelete(0); // 连续一
  clickDelete(0); // 连续二
  await flush();

  assert.deepEqual(renderedItems().map((i) => i.text), ["连续三"]);
  assert.equal(getElement("undo-toast").hidden, false, "连续删除后只保留一个提示");
  assert.match(getElement("undo-toast-text").textContent, /已删除/);

  getElement("undo-btn").handlers.click[0]();
  await flushLong();

  // 只恢复最近删除的「连续二」,更早删除的「连续一」保持墓碑
  assert.deepEqual(renderedItems().map((i) => i.text), ["连续二", "连续三"]);
  const serverList = await (await fetch(`${base}/api/todos`)).json();
  assert.deepEqual(
    serverList.map((t) => t.text).sort(),
    ["连续二", "连续三"].sort(),
    "撤销只作用于最近一次删除"
  );
  assert.ok(!serverList.some((t) => t.text === "连续一"));
  assert.equal(getElement("undo-toast").hidden, true);
});

test("撤销删除:登出后清理撤销入口,点击不再发起恢复请求", async () => {
  await registerAndSeed("undo_logout", ["登出前删除"]);
  filterBtns[0].handlers.click[0]();

  clickDelete(0);
  await flush();
  assert.equal(getElement("undo-toast").hidden, false);

  getElement("logout-btn").handlers.click[0]();
  await flush();
  assert.equal(getElement("undo-toast").hidden, true, "登出后应清理撤销入口");

  const calls = await recordFetch(async () => {
    getElement("undo-btn").handlers.click[0]();
    await new Promise((r) => setTimeout(r, 150));
  });
  assert.equal(
    calls.filter((url) => url.includes("/restore")).length,
    0,
    "登出后的撤销点击不应发起恢复请求"
  );
});
