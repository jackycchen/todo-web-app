"use strict";

/**
 * 写接口限流测试:按已鉴权用户计数,POST/PATCH/DELETE /api/todos 共用同一个桶。
 *
 * 全部使用注入的假时钟推进窗口,不真实等待;每个服务器使用独立临时 SQLite。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { startServer } = require("../server.js");

const rootDir = path.join(__dirname, "..");
const PASSWORD = "secret1234567";
const WINDOW_MS = 60_000;
const MAIN_LIMIT = 3; // 主服务器用较小的阈值,便于快速触发 429

function makeDbPath(tag) {
  return path.join(os.tmpdir(), `todo-write-rl-${tag}-${process.pid}-${Date.now()}.db`);
}

function cleanupFiles(dbPath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch (_) {
      /* 忽略清理失败 */
    }
  }
}

function jsonRequest(base, method, pathname, body, token) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  return fetch(base + pathname, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

/** 注册一个用户并返回其 token(注册本身不接入写限流) */
async function registerUser(base, username) {
  const res = await jsonRequest(base, "POST", "/api/register", {
    username,
    password: PASSWORD
  });
  assert.equal(res.status, 201, `注册 ${username} 应返回 201`);
  return (await res.json()).token;
}

function postTodo(base, token, text = "写限流待办") {
  return jsonRequest(base, "POST", "/api/todos", { text }, token);
}

/** 断言响应是统一的 429 形状,并校验 Retry-After 与 retryAfterMs 一致 */
async function assertRateLimited(res) {
  assert.equal(res.status, 429);
  const body = await res.json();
  assert.equal(body.code, "RATE_LIMITED");
  assert.equal(typeof body.error, "string");
  assert.ok(body.error.length > 0);
  assert.ok(Number.isInteger(body.retryAfterMs) && body.retryAfterMs > 0);
  assert.ok(body.retryAfterMs <= WINDOW_MS);
  const retryAfter = Number(res.headers.get("retry-after"));
  assert.ok(Number.isInteger(retryAfter), "Retry-After 应为整数秒");
  assert.equal(retryAfter, Math.max(1, Math.ceil(body.retryAfterMs / 1000)));
  return body;
}

let clock = 1_000_000;
let mainDb;
let mainServer;
let mainBase;

before(async () => {
  mainDb = makeDbPath("main");
  const started = await startServer({
    dbPath: mainDb,
    port: 0,
    staticDir: rootDir,
    now: () => clock,
    rateLimit: { enabled: true, windowMs: WINDOW_MS, maxWritesPerMinute: MAIN_LIMIT }
  });
  mainServer = started.server;
  mainBase = `http://127.0.0.1:${started.port}`;
});

after(async () => {
  await new Promise((resolve) => mainServer.close(resolve));
  cleanupFiles(mainDb);
});

/** 用独立服务器跑需要临时改写 env 或其它配置的用例 */
async function withServer(serverOptions, fn) {
  const dbPath = makeDbPath("tmp");
  const started = await startServer({
    dbPath,
    port: 0,
    staticDir: rootDir,
    now: () => clock,
    ...serverOptions
  });
  const base = `http://127.0.0.1:${started.port}`;
  try {
    await fn({ base, app: started.app });
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupFiles(dbPath);
  }
}

test("同一用户连续写超限:第 N+1 次返回 429,body 含三字段并带 Retry-After", async () => {
  const token = await registerUser(mainBase, "wr_limited");

  for (let i = 0; i < MAIN_LIMIT; i++) {
    assert.equal((await postTodo(mainBase, token)).status, 201, `第 ${i + 1} 次写应成功`);
  }

  const body = await assertRateLimited(await postTodo(mainBase, token));
  // 假时钟不推进,最早一次写仍在窗口内,retryAfterMs 应接近整个窗口
  assert.equal(body.retryAfterMs, WINDOW_MS);
});

test("按用户隔离:用户 A 超限不影响用户 B", async () => {
  const tokenA = await registerUser(mainBase, "wr_iso_a");
  const tokenB = await registerUser(mainBase, "wr_iso_b");

  for (let i = 0; i < MAIN_LIMIT; i++) {
    assert.equal((await postTodo(mainBase, tokenA)).status, 201);
  }
  await assertRateLimited(await postTodo(mainBase, tokenA));

  for (let i = 0; i < MAIN_LIMIT; i++) {
    assert.equal((await postTodo(mainBase, tokenB)).status, 201, "用户 B 的桶应仍然可用");
  }
});

test("POST / PATCH / DELETE 共用同一个桶", async () => {
  const token = await registerUser(mainBase, "wr_mixed");

  // 1 次 POST 取得 id,已是第 1 次计数
  const created = await postTodo(mainBase, token);
  assert.equal(created.status, 201);
  const { id } = await created.json();

  // 第 2 次: PATCH 成功
  const patched = await jsonRequest(mainBase, "PATCH", `/api/todos/${id}`, { text: "改过" }, token);
  assert.equal(patched.status, 200);

  // 第 3 次: DELETE 成功
  assert.equal((await jsonRequest(mainBase, "DELETE", `/api/todos/${id}`, undefined, token)).status, 204);

  // 第 4 次已被共用桶拦住,且 PATCH/DELETE 也一并受限
  await assertRateLimited(await postTodo(mainBase, token));
  await assertRateLimited(await jsonRequest(mainBase, "PATCH", `/api/todos/${id}`, { text: "x" }, token));
  await assertRateLimited(await jsonRequest(mainBase, "DELETE", `/api/todos/${id}`, undefined, token));
});

test("失败写请求(400/404)同样计数,不能靠非法请求绕过限流", async () => {
  const token = await registerUser(mainBase, "wr_fail");

  assert.equal((await jsonRequest(mainBase, "POST", "/api/todos", { text: "   " }, token)).status, 400);
  assert.equal((await jsonRequest(mainBase, "PATCH", "/api/todos/nope", { text: "x" }, token)).status, 404);
  assert.equal((await jsonRequest(mainBase, "DELETE", "/api/todos/nope", undefined, token)).status, 404);

  await assertRateLimited(await postTodo(mainBase, token));
});

test("推进时钟滑出窗口后写操作恢复", async () => {
  const token = await registerUser(mainBase, "wr_recover");

  for (let i = 0; i < MAIN_LIMIT; i++) {
    assert.equal((await postTodo(mainBase, token)).status, 201);
  }
  await assertRateLimited(await postTodo(mainBase, token));

  clock += WINDOW_MS + 1;
  assert.equal((await postTodo(mainBase, token)).status, 201, "窗口滑过后应恢复写入");
});

test("GET 不计数,且写桶超限期间 GET 仍返回 200", async () => {
  const token = await registerUser(mainBase, "wr_get");

  // 大量 GET 不占用写额度:之后依然能写满 MAIN_LIMIT 次
  for (let i = 0; i < 10; i++) {
    assert.equal((await jsonRequest(mainBase, "GET", "/api/todos", undefined, token)).status, 200);
  }
  for (let i = 0; i < MAIN_LIMIT; i++) {
    assert.equal((await postTodo(mainBase, token)).status, 201, "GET 不应计入写桶");
  }
  await assertRateLimited(await postTodo(mainBase, token));

  // 写桶超限不影响读接口
  assert.equal((await jsonRequest(mainBase, "GET", "/api/todos", undefined, token)).status, 200);
  assert.equal((await jsonRequest(mainBase, "GET", "/api/me", undefined, token)).status, 200);
});

test("未鉴权写请求先返回 401(限流中间件在 auth 之后)", async () => {
  assert.equal((await jsonRequest(mainBase, "POST", "/api/todos", { text: "x" })).status, 401);
  assert.equal((await jsonRequest(mainBase, "PATCH", "/api/todos/x", { text: "x" })).status, 401);
  assert.equal((await jsonRequest(mainBase, "DELETE", "/api/todos/x")).status, 401);

  // 未鉴权请求不会写进任何用户的桶:新用户第一次写仍然成功
  const token = await registerUser(mainBase, "wr_401");
  assert.equal((await postTodo(mainBase, token)).status, 201);
});

test("RATE_LIMIT_WRITE_PER_MIN 生效,显式 options 优先于 env", async () => {
  const saved = process.env.RATE_LIMIT_WRITE_PER_MIN;
  process.env.RATE_LIMIT_WRITE_PER_MIN = "2";
  try {
    await withServer({ rateLimit: { windowMs: WINDOW_MS } }, async ({ base, app }) => {
      assert.equal(app.locals.rateLimit.maxWritesPerMinute, 2);
      const token = await registerUser(base, "wr_env");
      assert.equal((await postTodo(base, token)).status, 201);
      assert.equal((await postTodo(base, token)).status, 201);
      await assertRateLimited(await postTodo(base, token));
    });

    // 显式 options 覆盖 env
    await withServer(
      { rateLimit: { windowMs: WINDOW_MS, maxWritesPerMinute: 5 } },
      async ({ base, app }) => {
        assert.equal(app.locals.rateLimit.maxWritesPerMinute, 5);
        const token = await registerUser(base, "wr_env_explicit");
        for (let i = 0; i < 5; i++) {
          assert.equal((await postTodo(base, token)).status, 201);
        }
        await assertRateLimited(await postTodo(base, token));
      }
    );
  } finally {
    if (saved === undefined) delete process.env.RATE_LIMIT_WRITE_PER_MIN;
    else process.env.RATE_LIMIT_WRITE_PER_MIN = saved;
  }
});

test("RATE_LIMIT_WRITE_PER_MIN 缺失或非法时回退默认 60", async () => {
  const saved = process.env.RATE_LIMIT_WRITE_PER_MIN;
  try {
    for (const bad of ["abc", "0", "-5", "2.5", "", "1e999"]) {
      process.env.RATE_LIMIT_WRITE_PER_MIN = bad;
      await withServer({}, async ({ app }) => {
        assert.equal(
          app.locals.rateLimit.maxWritesPerMinute,
          60,
          `非法值 ${JSON.stringify(bad)} 应回退默认 60`
        );
      });
    }

    delete process.env.RATE_LIMIT_WRITE_PER_MIN;
    await withServer({}, async ({ app }) => {
      assert.equal(app.locals.rateLimit.maxWritesPerMinute, 60);
    });
  } finally {
    if (saved === undefined) delete process.env.RATE_LIMIT_WRITE_PER_MIN;
    else process.env.RATE_LIMIT_WRITE_PER_MIN = saved;
  }
});

test("默认阈值 60:同一用户第 61 次写返回 429", async () => {
  await withServer({}, async ({ base }) => {
    const token = await registerUser(base, "wr_default");
    for (let i = 0; i < 60; i++) {
      assert.equal((await postTodo(base, token, `t${i}`)).status, 201, `第 ${i + 1} 次写应成功`);
    }
    await assertRateLimited(await postTodo(base, token));
  });
});