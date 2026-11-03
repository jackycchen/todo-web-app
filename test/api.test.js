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

test("待办内容超过 200 字符返回 400", async () => {
  const { data } = await login("alice", "secret123");
  const res = await post("/api/todos", { text: "a".repeat(201) }, data.token);
  assert.equal(res.status, 400);
});

test("待办内容恰好 200 字符可以创建(忽略首尾空白)", async () => {
  const { data } = await login("alice", "secret123");
  const res = await post("/api/todos", { text: "  " + "a".repeat(200) + "  " }, data.token);
  assert.equal(res.status, 201);
  assert.equal((await res.json()).text.length, 200);
});

test("修改待办内容超过 200 字符返回 400 且不生效", async () => {
  const { data } = await login("alice", "secret123");
  const created = await createTodo(data.token, "长度校验目标");

  const res = await patch(
    "/api/todos/" + created.data.id,
    { text: "b".repeat(201) },
    data.token
  );
  assert.equal(res.status, 400);

  const list = await (await get("/api/todos", data.token)).json();
  assert.equal(list.find((t) => t.id === created.data.id).text, "长度校验目标");
});

test("客户端传入的 id 与 createdAt 会被忽略", async () => {
  const { data } = await login("alice", "secret123");
  const forgedId = "forged-id";
  const forgedCreatedAt = 1;

  const res = await post(
    "/api/todos",
    { id: forgedId, createdAt: forgedCreatedAt, text: "服务端生成标识" },
    data.token
  );
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.notEqual(created.id, forgedId, "id 必须由服务端生成");
  assert.ok(created.createdAt > forgedCreatedAt, "createdAt 必须是服务端时间");
  assert.ok(Math.abs(created.createdAt - Date.now()) < 60000);
});

test("伪造已存在待办的 id 不会覆盖原数据", async () => {
  const { data } = await login("alice", "secret123");
  const original = (await createTodo(data.token, "原始内容")).data;

  const res = await post(
    "/api/todos",
    { id: original.id, createdAt: original.createdAt, text: "被覆盖的内容" },
    data.token
  );
  assert.equal(res.status, 201);
  const created = await res.json();
  assert.notEqual(created.id, original.id, "不得复用客户端提供的 id");

  const list = await (await get("/api/todos", data.token)).json();
  assert.equal(list.find((t) => t.id === original.id).text, "原始内容");
  assert.ok(list.some((t) => t.id === created.id && t.text === "被覆盖的内容"));
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

/* ---------- 优先级 ---------- */

test("全量列表按优先级排序:高在前,同级按创建时间升序", async () => {
  const token = await ensureUser("priority_order", "secret123");

  const normal1 = (await createTodo(token, "普通一")).data;
  await new Promise((r) => setTimeout(r, 2));
  const normal2 = (await createTodo(token, "普通二")).data;
  await new Promise((r) => setTimeout(r, 2));
  const high = (await createTodo(token, "高优先级")).data;
  await new Promise((r) => setTimeout(r, 2));
  const low = (await createTodo(token, "低优先级")).data;

  assert.equal(normal1.priority, 1, "新待办默认「普通」");
  assert.equal(high.priority, 1);

  const highRes = await patch(`/api/todos/${high.id}`, { priority: 2 }, token);
  assert.equal(highRes.status, 200);
  const lowRes = await patch(`/api/todos/${low.id}`, { priority: 0 }, token);
  assert.equal(lowRes.status, 200);

  const list = await (await get("/api/todos", token)).json();
  assert.deepEqual(
    list.map((t) => t.text),
    ["高优先级", "普通一", "普通二", "低优先级"],
    "先按优先级降序,同级按 createdAt 升序"
  );
  assert.deepEqual(list.map((t) => t.priority), [2, 1, 1, 0]);
  assert.ok(normal1.createdAt <= normal2.createdAt);
});

test("修改优先级会刷新 updatedAt,并能通过 since 增量拉到", async () => {
  const token = await ensureUser("priority_since", "secret123");
  const item = (await createTodo(token, "优先级同步")).data;
  assert.equal(item.priority, 1);

  const patchedRes = await patch(`/api/todos/${item.id}`, { priority: 2 }, token);
  assert.equal(patchedRes.status, 200);
  const patched = await patchedRes.json();
  assert.equal(patched.priority, 2);
  assert.ok(patched.updatedAt > item.updatedAt, "修改优先级必须刷新 updatedAt");

  const changes = await (
    await get(`/api/todos?since=${item.updatedAt}`, token)
  ).json();
  const found = changes.find((t) => t.id === item.id);
  assert.ok(found, "修改优先级后应出现在增量结果中");
  assert.equal(found.priority, 2);
  assert.equal(found.updatedAt, patched.updatedAt);
});

test("非法 priority 返回 400 且不改变数据", async () => {
  const token = await ensureUser("priority_invalid", "secret123");
  const item = (await createTodo(token, "优先级校验")).data;

  for (const bad of [-1, 3, 1.5, "2", null, true]) {
    const res = await patch(`/api/todos/${item.id}`, { priority: bad }, token);
    assert.equal(res.status, 400, `priority=${JSON.stringify(bad)} 应被拒绝`);
  }

  const createBad = await post("/api/todos", { text: "非法优先级", priority: 9 }, token);
  assert.equal(createBad.status, 400);

  const list = await (await get("/api/todos", token)).json();
  assert.equal(list.find((t) => t.id === item.id).priority, 1, "非法请求不应改变原值");
  assert.ok(!list.some((t) => t.text === "非法优先级"));
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

/* ---------- 请求体载荷上限 ---------- */

test("超过请求体上限返回 413 JSON 错误", async () => {
  const token = await ensureUser("payload_limit", "secret123");
  // 20KB,超过显式的 16KB 上限(默认 100KB 会放行)
  const res = await post("/api/todos", { text: "x".repeat(20 * 1024) }, token);
  assert.equal(res.status, 413);
  const body = await res.json();
  assert.equal(body.code, "PAYLOAD_TOO_LARGE");
});

test("非法 JSON 请求体返回 400 JSON 错误", async () => {
  const res = await fetch(base + "/api/todos", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{ this is not json",
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.equal(body.code, "INVALID_JSON");
});

/* ---------- 单用户待办配额 ---------- */

test("单用户待办达到配额返回 409,删除后释放额度且配额按用户隔离", async () => {
  const quotaDb = path.join(os.tmpdir(), `todo-quota-${process.pid}-${Date.now()}.db`);
  const started = await startServer({
    dbPath: quotaDb,
    port: 0,
    staticDir: path.join(__dirname, ".."),
    maxTodosPerUser: 3,
  });
  const qbase = `http://127.0.0.1:${started.port}`;
  const call = (method, pathname, body, token) => {
    const headers = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = "Bearer " + token;
    return fetch(qbase + pathname, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  };

  try {
    const reg = await call("POST", "/api/register", {
      username: "quota",
      password: "secret123",
    });
    const { token } = await reg.json();

    const created = [];
    for (let i = 0; i < 3; i++) {
      const res = await call("POST", "/api/todos", { text: `配额任务 ${i}` }, token);
      assert.equal(res.status, 201);
      created.push((await res.json()).id);
    }

    // 第 4 条被配额拒绝,并返回可编程判断的 code 与上限
    const over = await call("POST", "/api/todos", { text: "超出配额" }, token);
    assert.equal(over.status, 409);
    const overBody = await over.json();
    assert.equal(overBody.code, "TODO_QUOTA_EXCEEDED");
    assert.equal(overBody.limit, 3);

    // 配额只限制新建:更新已有条目仍然成功
    const update = await call(
      "PATCH",
      "/api/todos/" + created[0],
      { text: "配额内改名" },
      token
    );
    assert.equal(update.status, 200);
    assert.equal((await update.json()).text, "配额内改名");

    // 配额按用户隔离:另一个用户仍可创建
    const otherReg = await call("POST", "/api/register", {
      username: "quota_other",
      password: "secret123",
    });
    const otherToken = (await otherReg.json()).token;
    const otherCreate = await call(
      "POST",
      "/api/todos",
      { text: "他人配额独立" },
      otherToken
    );
    assert.equal(otherCreate.status, 201);

    // 删除一条释放额度,可以继续创建;墓碑本身不占配额
    const delRes = await call("DELETE", "/api/todos/" + created[1], undefined, token);
    assert.equal(delRes.status, 204);
    const afterDelete = await call("POST", "/api/todos", { text: "删除后新建" }, token);
    assert.equal(afterDelete.status, 201);

    // 释放出来的额度已被新条目占回,再次新建仍被拒绝
    const fullAgain = await call("POST", "/api/todos", { text: "再次超出" }, token);
    assert.equal(fullAgain.status, 409);
    assert.equal((await fullAgain.json()).code, "TODO_QUOTA_EXCEEDED");

    // 列表中的数量始终不超过配额(已删除项不出现在全量列表)
    const list = await (await call("GET", "/api/todos", undefined, token)).json();
    assert.equal(list.length, 3);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.unlinkSync(quotaDb + suffix);
      } catch (_) {
        /* 忽略清理失败 */
      }
    }
  }
});
