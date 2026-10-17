"use strict";

/**
 * 前端 API 客户端(api.js)单元测试:注入假 fetch,不启动服务器。
 *
 * 覆盖: Authorization 请求头、token 的 localStorage 持久化、
 * 401 统一处理(清除本地 token 并触发 onUnauthorized 回调)。
 */
const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

let fetchCalls = [];

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body == null ? "" : JSON.stringify(body))
  };
}

function makeLocalStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear()
  };
}

beforeEach(() => {
  fetchCalls = [];
  global.window = global;
  global.localStorage = makeLocalStorage();
  global.window.localStorage = global.localStorage;
  global.window.TODO_API_BASE = "http://test";
  global.__response = null;
  global.fetch = (url, init) => {
    fetchCalls.push({ url, init });
    return Promise.resolve(global.__response || jsonResponse(200, {}));
  };
  // 重新加载 api.js,隔离每个用例的状态
  delete require.cache[require.resolve("../api.js")];
  require("../api.js");
  global.TodoApi.onUnauthorized = null;
});

test("登录成功后将 token 写入 localStorage", async () => {
  global.__response = jsonResponse(201, { token: "tok-abc", username: "alice" });
  const data = await TodoApi.login("alice", "secret123");
  assert.equal(data.username, "alice");
  assert.equal(localStorage.getItem("todo-app.token"), "tok-abc");
  assert.equal(fetchCalls[0].init.method, "POST");
  assert.equal(fetchCalls[0].url, "http://test/api/login");
});

test("请求自动携带 Authorization: Bearer <token>", async () => {
  localStorage.setItem("todo-app.token", "tok-secret");
  global.__response = jsonResponse(200, []);
  await TodoApi.getTodos();
  const call = fetchCalls[0];
  assert.equal(call.url, "http://test/api/todos");
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.headers.Authorization, "Bearer tok-secret");
});

test("无 token 时请求不带 Authorization 头", async () => {
  global.__response = jsonResponse(200, []);
  await TodoApi.getTodos();
  assert.equal(fetchCalls[0].init.headers.Authorization, undefined);
});

test("API 返回 401 时清除 token 并触发 onUnauthorized", async () => {
  localStorage.setItem("todo-app.token", "tok-expired");
  let unauthorized = 0;
  TodoApi.onUnauthorized = function () {
    unauthorized += 1;
  };

  global.__response = jsonResponse(401, { error: "未登录或登录已过期" });
  await assert.rejects(TodoApi.getTodos(), /未登录或登录已过期/);

  assert.equal(localStorage.getItem("todo-app.token"), null);
  assert.equal(unauthorized, 1);
});

test("非 401 的正常响应不会清除 token 或触发 onUnauthorized", async () => {
  localStorage.setItem("todo-app.token", "tok-ok");
  let unauthorized = 0;
  TodoApi.onUnauthorized = function () {
    unauthorized += 1;
  };

  global.__response = jsonResponse(200, []);
  const data = await TodoApi.getTodos();

  assert.deepEqual(data, []);
  assert.equal(unauthorized, 0);
  assert.equal(localStorage.getItem("todo-app.token"), "tok-ok");
});

test("请求体自动带 JSON Content-Type", async () => {
  localStorage.setItem("todo-app.token", "tok-a");
  global.__response = jsonResponse(201, { id: "1", text: "写写", completed: false, createdAt: 1 });
  await TodoApi.createTodo({ text: "写写" });
  const call = fetchCalls[0];
  assert.equal(call.init.headers["Content-Type"], "application/json");
  assert.equal(JSON.parse(call.init.body).text, "写写");
});

test("登出时即使服务端失败也会清除本地 token", async () => {
  localStorage.setItem("todo-app.token", "tok-logout");
  global.__response = jsonResponse(500, { error: "服务器错误" });
  await TodoApi.logout();
  assert.equal(localStorage.getItem("todo-app.token"), null);
});
