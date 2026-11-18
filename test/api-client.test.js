"use strict";

/**
 * 前端 API 客户端(api.js)单元测试:注入假 fetch,不启动服务器。
 *
 * 覆盖:会话由 HttpOnly cookie 承载后不再发送 Authorization 头、
 * 请求带 credentials: "same-origin"、hasSession 内存标志与
 * 401 统一处理(清除标志并触发 onUnauthorized 回调)。
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

beforeEach(() => {
  fetchCalls = [];
  global.window = global;
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

test("登录成功后进入会话状态,且不把 token 写入 localStorage", async () => {
  global.__response = jsonResponse(201, { token: "tok-abc", username: "alice" });
  const data = await TodoApi.login("alice", "secret1234567");
  assert.equal(data.username, "alice");
  assert.equal(TodoApi.hasSession(), true);
  assert.equal(fetchCalls[0].init.method, "POST");
  assert.equal(fetchCalls[0].url, "http://test/api/login");
  assert.equal(fetchCalls[0].init.headers.Authorization, undefined);
});

test("请求以 same-origin cookie 鉴权,不再发送 Authorization 头", async () => {
  global.__response = jsonResponse(200, []);
  await TodoApi.getTodos();
  const call = fetchCalls[0];
  assert.equal(call.url, "http://test/api/todos");
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.credentials, "same-origin");
  assert.equal(call.init.headers.Authorization, undefined);
});

test("searchTodos 对关键字编码并请求 q 参数,不与 since 组合", async () => {
  global.__response = jsonResponse(200, []);
  const keyword = "买 牛奶&100%_中";
  const data = await TodoApi.searchTodos(keyword);

  assert.deepEqual(data, []);
  const call = fetchCalls[0];
  assert.equal(call.url, "http://test/api/todos?q=" + encodeURIComponent(keyword));
  assert.equal(call.init.method, "GET");
  assert.equal(call.init.credentials, "same-origin");
  assert.equal(call.init.headers.Authorization, undefined);
  assert.ok(!call.url.includes("since="), "搜索不应与增量同步参数组合");
});

test("searchTodos 空关键字请求空的 q 参数(由服务端等价于不检索)", async () => {
  global.__response = jsonResponse(200, []);
  await TodoApi.searchTodos(null);
  assert.equal(fetchCalls[0].url, "http://test/api/todos?q=");
});

test("登录后后续请求同样不携带 Authorization 头", async () => {
  global.__response = jsonResponse(200, { username: "alice" });
  await TodoApi.login("alice", "secret1234567");
  global.__response = jsonResponse(200, []);
  await TodoApi.getTodos();
  assert.equal(fetchCalls[1].init.headers.Authorization, undefined);
  assert.equal(fetchCalls[1].init.credentials, "same-origin");
});

test("API 返回 401 时清除会话标志并触发 onUnauthorized", async () => {
  global.__response = jsonResponse(200, { username: "alice" });
  await TodoApi.login("alice", "secret1234567");
  assert.equal(TodoApi.hasSession(), true);

  let unauthorized = 0;
  TodoApi.onUnauthorized = function () {
    unauthorized += 1;
  };

  global.__response = jsonResponse(401, { error: "未登录或登录已过期" });
  await assert.rejects(TodoApi.getTodos(), /未登录或登录已过期/);

  assert.equal(TodoApi.hasSession(), false);
  assert.equal(unauthorized, 1);
});

test("非 401 的正常响应不会清除会话或触发 onUnauthorized", async () => {
  global.__response = jsonResponse(200, { username: "alice" });
  await TodoApi.login("alice", "secret1234567");
  let unauthorized = 0;
  TodoApi.onUnauthorized = function () {
    unauthorized += 1;
  };

  global.__response = jsonResponse(200, []);
  const data = await TodoApi.getTodos();

  assert.deepEqual(data, []);
  assert.equal(unauthorized, 0);
  assert.equal(TodoApi.hasSession(), true);
});

test("请求体自动带 JSON Content-Type", async () => {
  global.__response = jsonResponse(201, { id: "1", text: "写写", completed: false, createdAt: 1 });
  await TodoApi.createTodo({ text: "写写" });
  const call = fetchCalls[0];
  assert.equal(call.init.headers["Content-Type"], "application/json");
  assert.equal(JSON.parse(call.init.body).text, "写写");
});

test("新建待办不把客户端 id / createdAt 提交给服务端", async () => {
  global.__response = jsonResponse(201, { id: "server-id", text: "写写" });
  await TodoApi.createTodo({
    id: "client-id",
    createdAt: 123,
    text: "写写",
    completed: true
  });
  const body = JSON.parse(fetchCalls[0].init.body);
  assert.deepEqual(body, { text: "写写", completed: true });
});

test("登出时即使服务端失败也会清除会话标志", async () => {
  global.__response = jsonResponse(200, { username: "alice" });
  await TodoApi.login("alice", "secret1234567");
  assert.equal(TodoApi.hasSession(), true);

  global.__response = jsonResponse(500, { error: "服务器错误" });
  await TodoApi.logout();
  assert.equal(TodoApi.hasSession(), false);
  assert.equal(fetchCalls[1].url, "http://test/api/logout");
  assert.equal(fetchCalls[1].init.credentials, "same-origin");
});
