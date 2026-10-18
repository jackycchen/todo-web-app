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

/* ---------- 多端增量同步(updatedAt / since / tombstone / LWW) ---------- */

async function ensureUser(username, password) {
  const reg = await register(username, password);
  if (reg.status === 201) return reg.data.token;
  const res = await login(username, password);
  return res.data.token;
}

test("新增与修改都会刷新 updatedAt(毫秒时间戳)", async () => {
  const token = await ensureUser("sync_updated", "secret123");
  const created = await createTodo(token, "updatedAt 任务");
  assert.ok(Number.isSafeInteger(created.data.updatedAt), "updatedAt 应为毫秒整数");
  assert.ok(created.data.updatedAt >= created.data.createdAt);

  const toggledRes = await patch(`/api/todos/${created.data.id}`, { completed: true }, token);
  const toggled = await toggledRes.json();
  assert.ok(
    toggled.updatedAt > created.data.updatedAt,
    "勾选完成必须产生更新的 updatedAt"
  );

  const renamedRes = await patch(`/api/todos/${created.data.id}`, { text: "改名后" }, token);
  const renamed = await renamedRes.json();
  assert.ok(renamed.updatedAt > toggled.updatedAt, "修改内容必须产生更新的 updatedAt");

  const list = await (await get("/api/todos", token)).json();
  const found = list.find((t) => t.id === created.data.id);
  assert.equal(found.text, "改名后");
  assert.equal(found.completed, true);
  assert.equal(found.updatedAt, renamed.updatedAt);
});

test("GET /api/todos?since= 只返回该时间之后发生变更的待办", async () => {
  const token = await ensureUser("sync_since", "secret123");
  const first = await createTodo(token, "since 第一条");
  const second = await createTodo(token, "since 第二条");

  const changesRes = await get(`/api/todos?since=${first.data.updatedAt}`, token);
  assert.equal(changesRes.status, 200);
  const changes = await changesRes.json();
  const ids = changes.map((t) => t.id);
  assert.ok(ids.includes(second.data.id), "游标之后新建的待办应返回");
  assert.ok(!ids.includes(first.data.id), "游标之前的待办不应返回");
  changes.forEach((t) => assert.ok(t.updatedAt > first.data.updatedAt));

  // 修改第二条后,从第二条旧版本的时间戳增量拉取,应拿到新版本
  const patchedRes = await patch(`/api/todos/${second.data.id}`, { completed: true }, token);
  const patched = await patchedRes.json();
  const afterPatch = await (await get(`/api/todos?since=${second.data.updatedAt}`, token)).json();
  assert.equal(afterPatch.length, 1);
  assert.equal(afterPatch[0].id, second.data.id);
  assert.equal(afterPatch[0].completed, true);
  assert.equal(afterPatch[0].updatedAt, patched.updatedAt);
});

test("since 参数非法时返回 400", async () => {
  const token = await ensureUser("sync_since", "secret123");
  for (const bad of ["-1", "1.5", "abc", "", "1e3"]) {
    const res = await get(`/api/todos?since=${encodeURIComponent(bad)}`, token);
    assert.equal(res.status, 400, `since=${JSON.stringify(bad)} 应被拒绝`);
  }
});

test("删除写入 tombstone:增量接口可感知,全量列表不返回", async () => {
  const token = await ensureUser("sync_delete", "secret123");
  const item = (await createTodo(token, "待删除同步")).data;
  const cursor = item.updatedAt;

  const delRes = await del(`/api/todos/${item.id}`, token);
  assert.equal(delRes.status, 204);

  const changes = await (await get(`/api/todos?since=${cursor}`, token)).json();
  const tombstone = changes.find((t) => t.id === item.id);
  assert.ok(tombstone, "删除后的待办应出现在增量结果中");
  assert.equal(tombstone.deleted, true);
  assert.ok(tombstone.updatedAt > cursor, "删除也要刷新 updatedAt");

  const full = await (await get("/api/todos", token)).json();
  assert.ok(!full.some((t) => t.id === item.id), "全量列表不应包含已删除项");

  // 已删除项再次删除返回 404,避免重复墓碑
  const again = await del(`/api/todos/${item.id}`, token);
  assert.equal(again.status, 404);
});

test("last-write-wins:后写的修改胜出,两端增量同步一致", async () => {
  const tokenA = await ensureUser("sync_lww", "secret123");
  const sessionB = await login("sync_lww", "secret123");
  const tokenB = sessionB.data.token;
  assert.notEqual(tokenA, tokenB, "模拟两个浏览器会话");

  const created = (await createTodo(tokenA, "冲突前")).data;
  const cursorB = created.updatedAt;

  // 设备 A 先写
  const writeA = await (await patch(`/api/todos/${created.id}`, { text: "A 版本" }, tokenA)).json();
  // 设备 B 后写,应胜出
  const writeB = await (await patch(`/api/todos/${created.id}`, { text: "B 版本" }, tokenB)).json();
  assert.ok(writeB.updatedAt > writeA.updatedAt);

  // 设备 A 从自己的写入时间点增量拉取,得到 B 的版本
  const changesA = await (await get(`/api/todos?since=${writeA.updatedAt}`, tokenA)).json();
  const winner = changesA.find((t) => t.id === created.id);
  assert.ok(winner, "设备 A 应能增量看到设备 B 的修改");
  assert.equal(winner.text, "B 版本");
  assert.equal(winner.updatedAt, writeB.updatedAt);

  // 设备 B 从创建时间点拉取,也能看到完整变化序列的最终状态
  const changesB = await (await get(`/api/todos?since=${cursorB}`, tokenB)).json();
  const latestB = changesB.filter((t) => t.id === created.id).pop();
  assert.equal(latestB.text, "B 版本");
  assert.equal(latestB.updatedAt, writeB.updatedAt);

  // 服务端最终状态与最后写入一致
  const full = await (await get("/api/todos", tokenA)).json();
  assert.equal(full.find((t) => t.id === created.id).text, "B 版本");
});

test("增量接口需要鉴权,且只返回当前用户的数据", async () => {
  const noAuth = await get("/api/todos?since=0");
  assert.equal(noAuth.status, 401);

  const aliceToken = await ensureUser("sync_iso_alice", "secret123");
  const bobToken = await ensureUser("sync_iso_bob", "secret123");
  const item = (await createTodo(aliceToken, "alice 的增量数据")).data;

  const bobChanges = await (await get("/api/todos?since=0", bobToken)).json();
  assert.ok(!bobChanges.some((t) => t.id === item.id), "不应看到其他用户的数据");

  const aliceChanges = await (await get("/api/todos?since=0", aliceToken)).json();
  assert.ok(aliceChanges.some((t) => t.id === item.id));
});
