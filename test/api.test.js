"use strict";

/**
 * 后端 API 集成测试
 *
 * 覆盖: 注册/登录/登出、会话鉴权、待办 CRUD、多用户数据隔离、
 *       同一用户跨会话数据一致、密码非明文存储。
 * 使用独立临时 SQLite 数据库,不污染仓库数据。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const { startServer } = require("../server.js");

const tmpDb = path.join(os.tmpdir(), `todo-test-${process.pid}-${Date.now()}.db`);
let server;
let base;

before(async () => {
  const started = await startServer({
    dbPath: tmpDb,
    port: 0,
    staticDir: path.join(__dirname, ".."),
  });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
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

function post(pathname, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  return fetch(base + pathname, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function patch(pathname, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  return fetch(base + pathname, { method: "PATCH", headers, body: JSON.stringify(body) });
}

function del(pathname, token) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  return fetch(base + pathname, { method: "DELETE", headers });
}

function get(pathname, token) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  return fetch(base + pathname, { headers });
}

async function register(username, password) {
  const res = await post("/api/register", { username, password });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function login(username, password) {
  const res = await post("/api/login", { username, password });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

async function createTodo(token, text) {
  const res = await post("/api/todos", { text }, token);
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

/* ---------- 健康检查 ---------- */

test("GET /api/health 返回 ok", async () => {
  const res = await get("/api/health");
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
});

test("GET / 返回前端页面", async () => {
  const res = await get("/");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /todo-core/);
  assert.match(text, /api\.js/);
});

test("GET /data 被阻止", async () => {
  const res = await get("/data/todo.db");
  assert.equal(res.status, 404);
});

/* ---------- 注册 ---------- */

test("注册成功返回 token 与用户名", async () => {
  const { status, data } = await register("alice", "secret123");
  assert.equal(status, 201);
  assert.equal(data.username, "alice");
  assert.ok(typeof data.token === "string" && data.token.length >= 32);
});

test("重复用户名注册返回 409", async () => {
  const { status } = await register("alice", "secret123");
  assert.equal(status, 409);
});

test("密码过短注册返回 400", async () => {
  const { status } = await register("short", "123");
  assert.equal(status, 400);
});

test("空用户名注册返回 400", async () => {
  const { status } = await register("  ", "secret123");
  assert.equal(status, 400);
});

test("密码不以明文存储", async () => {
  const db = new DatabaseSync(tmpDb);
  const row = db.prepare("SELECT password_hash FROM users WHERE username = ?").get("alice");
  db.close();
  assert.ok(row, "应存在 alice 用户");
  assert.match(row.password_hash, /^scrypt\$/);
  assert.notEqual(row.password_hash, "secret123");
  assert.ok(!row.password_hash.includes("secret123"));
});

/* ---------- 登录 / 会话 ---------- */

test("登录成功返回新 token", async () => {
  const { status, data } = await login("alice", "secret123");
  assert.equal(status, 200);
  assert.equal(data.username, "alice");
  assert.ok(typeof data.token === "string" && data.token.length >= 32);
});

test("密码错误登录返回 401", async () => {
  const { status } = await login("alice", "wrong-password");
  assert.equal(status, 401);
});

test("未登录访问 /api/me 返回 401", async () => {
  const res = await get("/api/me");
  assert.equal(res.status, 401);
});

test("带 token 访问 /api/me 返回用户名", async () => {
  const { data } = await login("alice", "secret123");
  const res = await get("/api/me", data.token);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).username, "alice");
});

test("登出后 token 失效", async () => {
  const { data } = await login("alice", "secret123");
  const res = await post("/api/logout", {}, data.token);
  assert.equal(res.status, 204);
  const me = await get("/api/me", data.token);
  assert.equal(me.status, 401);
});

/* ---------- 待办 CRUD ---------- */

test("创建待办并列出", async () => {
  const { data: loginData } = await login("alice", "secret123");
  const created = await createTodo(loginData.token, "写代码");
  assert.equal(created.status, 201);
  assert.equal(created.data.text, "写代码");
  assert.equal(created.data.completed, false);
  assert.ok(typeof created.data.id === "string" && created.data.id.length > 0);

  const res = await get("/api/todos", loginData.token);
  const list = await res.json();
  assert.ok(Array.isArray(list));
  assert.ok(list.some((t) => t.id === created.data.id && t.text === "写代码"));
});

test("空白内容创建返回 400", async () => {
  const { data } = await login("alice", "secret123");
  const res = await post("/api/todos", { text: "   " }, data.token);
  assert.equal(res.status, 400);
});

test("切换完成状态并改名", async () => {
  const { data } = await login("alice", "secret123");
  const created = await createTodo(data.token, "待切换");
  const toggled = await patch("/api/todos/" + created.data.id, { completed: true }, data.token);
  assert.equal(toggled.status, 200);
  assert.equal((await toggled.json()).completed, true);

  const renamed = await patch(
    "/api/todos/" + created.data.id,
    { text: "已改名" },
    data.token
  );
  assert.equal((await renamed.json()).text, "已改名");
});

test("删除待办后清单为空", async () => {
  const { data } = await login("alice", "secret123");
  const created = await createTodo(data.token, "待删除");
  const res = await del("/api/todos/" + created.data.id, data.token);
  assert.equal(res.status, 204);
  const list = (await (await get("/api/todos", data.token)).json());
  assert.ok(!list.some((t) => t.id === created.data.id));
});

test("操作不存在的待办返回 404", async () => {
  const { data } = await login("alice", "secret123");
  const patchRes = await patch("/api/todos/no-such-id", { completed: true }, data.token);
  assert.equal(patchRes.status, 404);
  const delRes = await del("/api/todos/no-such-id", data.token);
  assert.equal(delRes.status, 404);
});

/* ---------- 多用户隔离 ---------- */

test("两个用户数据相互隔离", async () => {
  const aliceLogin = await login("alice", "secret123");
  const bobReg = await register("bob", "secret456");
  const bobLogin = await login("bob", "secret456");

  await createTodo(aliceLogin.data.token, "alice 的私密待办");
  await createTodo(bobLogin.data.token, "bob 的私密待办");

  const aliceList = (await (await get("/api/todos", aliceLogin.data.token)).json());
  const bobList = (await (await get("/api/todos", bobLogin.data.token)).json());

  assert.ok(aliceList.some((t) => t.text === "alice 的私密待办"));
  assert.ok(!aliceList.some((t) => t.text === "bob 的私密待办"));
  assert.ok(bobList.some((t) => t.text === "bob 的私密待办"));
  assert.ok(!bobList.some((t) => t.text === "alice 的私密待办"));
  assert.equal(bobReg.status, 201);
});

test("用户不能修改或删除他人待办", async () => {
  const aliceLogin = await login("alice", "secret123");
  const bobLogin = await login("bob", "secret456");
  const aliceItem = (await createTodo(aliceLogin.data.token, "alice 专属")).data;

  const patchRes = await patch(`/api/todos/${aliceItem.id}`, { completed: true }, bobLogin.data.token);
  assert.equal(patchRes.status, 404);
  const delRes = await del(`/api/todos/${aliceItem.id}`, bobLogin.data.token);
  assert.equal(delRes.status, 404);

  const aliceList = (await (await get("/api/todos", aliceLogin.data.token)).json());
  assert.ok(aliceList.some((t) => t.id === aliceItem.id));
});

/* ---------- 同一用户跨会话 ---------- */

test("同一用户在不同浏览器/会话中看到相同数据", async () => {
  // 会话 A:浏览器 1 登录
  const sessionA = await login("alice", "secret123");
  await createTodo(sessionA.data.token, "跨会话任务");

  // 会话 B:浏览器 2 重新登录,应能看到会话 A 添加的数据
  const sessionB = await login("alice", "secret123");
  assert.notEqual(sessionA.data.token, sessionB.data.token);

  const listB = (await (await get("/api/todos", sessionB.data.token)).json());
  assert.ok(listB.some((t) => t.text === "跨会话任务"));
});
