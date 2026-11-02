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
    appendChild(child) {
      el.children.push(child);
      return child;
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
      if (sel === ".todo-checkbox") {
        return el.children.find((c) => c.classList.contains("todo-checkbox")) || null;
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
      if (el._html === "") el.children.length = 0;
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

  // 加载页面脚本(与 index.html 的顺序一致)
  require("../todo-core.js");
  require("../api.js");
  require("../todo.js");
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

function renderedItems() {
  return getElement("todo-list").children.map((li) => ({
    text: li.children[1].textContent,
    completed: li.children[0].checked,
  }));
}

test("前端端到端:注册/增删改/登出/重新登录/用户隔离", async () => {
  // 初始未登录:显示登录视图
  assert.equal(getElement("auth-view").hidden, false);
  assert.equal(getElement("app-view").hidden, true);
  assert.equal(window.localStorage.getItem("todo-app.token"), null);

  // ---------- 注册 carol ----------
  clickTab(1);
  assert.equal(getElement("register-form").hidden, false);
  fillInput("register-username", "carol");
  fillInput("register-password", "secret123");
  submitForm("register-form");
  await flush();

  assert.equal(getElement("app-view").hidden, false);
  assert.equal(getElement("current-user").textContent, "carol");
  assert.notEqual(window.localStorage.getItem("todo-app.token"), null);

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

  // 服务端确实收到了这两条
  const serverList = await (await fetch(`${base}/api/todos`, {
    headers: { Authorization: "Bearer " + window.localStorage.getItem("todo-app.token") },
  })).json();
  assert.equal(serverList.length, 2);

  // ---------- 切换完成状态 ----------
  clickCheckbox(0);
  await flush();
  items = renderedItems();
  assert.equal(items[0].completed, true);
  assert.equal(getElement("stats-completed").textContent, "1");

  // ---------- 删除第二条 ----------
  clickDelete(1);
  await flush();
  items = renderedItems();
  assert.equal(items.length, 1);
  assert.equal(items[0].text, "给前端接入后端 API");
  assert.equal(getElement("stats-total").textContent, "1");

  // ---------- 登出 ----------
  const oldToken = window.localStorage.getItem("todo-app.token");
  getElement("logout-btn").handlers.click[0]();
  await flush();
  assert.equal(getElement("auth-view").hidden, false);
  assert.equal(getElement("app-view").hidden, true);
  assert.equal(window.localStorage.getItem("todo-app.token"), null);

  // 旧 token 已在服务端失效
  const meAfterLogout = await fetch(`${base}/api/me`, {
    headers: { Authorization: "Bearer " + oldToken },
  });
  assert.equal(meAfterLogout.status, 401);

  // ---------- 重新登录,数据仍在 ----------
  clickTab(0);
  fillInput("login-username", "carol");
  fillInput("login-password", "secret123");
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
  fillInput("register-password", "secret789");
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

test("会话过期:API 返回 401 时清除 token 并回登录页", async () => {
  // 前序场景结束时为 dave 登录态
  assert.equal(getElement("app-view").hidden, false);
  assert.equal(getElement("current-user").textContent, "dave");

  // 服务端使当前会话失效(模拟登录过期/服务端重启)
  const token = window.localStorage.getItem("todo-app.token");
  await fetch(`${base}/api/logout`, {
    method: "POST",
    headers: { Authorization: "Bearer " + token },
  });

  // 客户端仍持有旧 token:触发任意 API 调用(新增待办 -> createTodo)
  fillInput("todo-input", "会话过期后新增");
  submitForm("todo-form");
  await flush();

  // 401 统一处理:清除本地 token 并回到登录页
  assert.equal(window.localStorage.getItem("todo-app.token"), null);
  assert.equal(getElement("app-view").hidden, true);
  assert.equal(getElement("auth-view").hidden, false);
});

test("多端同步:另一会话修改后,本端轮询自动同步并提示", async () => {
  // 上一个用例已回到登录页;注册新用户 erin
  clickTab(1);
  fillInput("register-username", "erin");
  fillInput("register-password", "secret123");
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
    body: JSON.stringify({ username: "erin", password: "secret123" }),
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
  assert.equal(getElement("sync-notice").hidden, false);
  assert.equal(getElement("sync-notice").textContent, "已在其他设备更新");
});

test("空状态:无待办时展示插画、引导文案与添加入口", async () => {
  // 注册新用户 frank,待办为空
  clickTab(1);
  fillInput("register-username", "frank");
  fillInput("register-password", "secret123");
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
  const token = window.localStorage.getItem("todo-app.token");
  assert.ok(token, "应处于登录态");

  const posts = [];
  for (let i = 0; i < 25; i++) {
    posts.push(fetch(`${base}/api/todos`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
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
