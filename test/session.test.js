"use strict";

/**
 * 会话生命周期测试(合并两套用例):
 *  - 未过期会话可正常鉴权;过期会话返回 401,且鉴权路径会删除该行(惰性清理)
 *  - cleanupExpiredSessions / deleteExpiredSessions 只删除过期行,不动有效行
 *  - TTL 解析与 created_at / expires_at 双重校验
 *  - 旧 schema(无 expires_at)迁移后按 created_at + TTL 回填
 *  - HTTP 层返回 expiresAt,过期清理任务可删除未被访问的会话
 * 使用独立临时 SQLite,不依赖网络。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const {
  openDb,
  getSessionTtlMs,
  DEFAULT_SESSION_TTL_MS,
  resolveSessionTtlMs
} = require("../lib/db.js");
const { startServer } = require("../server.js");

const DAY = 24 * 60 * 60 * 1000;

function makeDbPath(tag) {
  return path.join(os.tmpdir(), `todo-session-${tag}-${process.pid}-${Date.now()}.db`);
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

function insertUser(db, username, createdAt) {
  return Number(
    db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)")
      .run(username, "x", createdAt).lastInsertRowid
  );
}

function readSession(dbPath, token) {
  const db = new DatabaseSync(dbPath);
  try {
    return db.prepare("SELECT token, created_at, expires_at FROM sessions WHERE token = ?").get(token);
  } finally {
    db.close();
  }
}

/* ---------- ① 未过期会话可正常鉴权 ---------- */

test("未过期会话可以正常鉴权", () => {
  const dbPath = makeDbPath("valid");
  cleanupFiles(dbPath);
  const store = openDb(dbPath);
  try {
    const now = Date.now();
    const userId = store.createUser("validuser", "x", now);
    store.createSession(userId, "valid-token", now, now + DAY);

    const user = store.getUserByToken("valid-token", now);
    assert.ok(user, "未过期会话应能查到用户");
    assert.equal(user.id, userId);
    assert.equal(user.username, "validuser");
  } finally {
    store.close();
    cleanupFiles(dbPath);
  }
});

/* ---------- ② 过期会话返回 401 且该行被删除 ---------- */

test("过期会话返回 401,且鉴权时惰性删除该行;重复登出保持幂等", async () => {
  const dbPath = makeDbPath("expired");
  cleanupFiles(dbPath);
  const started = await startServer({
    dbPath,
    port: 0,
    staticDir: path.join(__dirname, "..")
  });
  const base = `http://127.0.0.1:${started.port}`;

  try {
    const reg = await fetch(base + "/api/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "expireduser", password: "secret123" })
    });
    assert.equal(reg.status, 201);
    const { token } = await reg.json();

    // 登录/注册签发时 expires_at = created_at + SESSION_TTL_DAYS
    const issued = readSession(dbPath, token);
    assert.equal(issued.expires_at - issued.created_at, getSessionTtlMs());

    // 未过期时正常鉴权
    const ok = await fetch(base + "/api/me", {
      headers: { Authorization: "Bearer " + token }
    });
    assert.equal(ok.status, 200);

    // 手动把会话改成已过期(模拟时间流逝)
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE sessions SET expires_at = ? WHERE token = ?").run(Date.now() - 1000, token);
    raw.close();

    const denied = await fetch(base + "/api/me", {
      headers: { Authorization: "Bearer " + token }
    });
    assert.equal(denied.status, 401, "过期会话应按未登录处理");

    assert.equal(readSession(dbPath, token), undefined, "过期行应被惰性删除");

    // 重复登出:即使会话已不存在也返回 204,不报错
    const logout1 = await fetch(base + "/api/logout", {
      method: "POST",
      headers: { Authorization: "Bearer " + token }
    });
    const logout2 = await fetch(base + "/api/logout", {
      method: "POST",
      headers: { Authorization: "Bearer " + token }
    });
    assert.equal(logout1.status, 204);
    assert.equal(logout2.status, 204);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    started.store.close();
    cleanupFiles(dbPath);
  }
});

/* ---------- ③ cleanupExpiredSessions 只删过期 ---------- */

test("cleanupExpiredSessions 只删除过期会话,不动有效行", () => {
  const dbPath = makeDbPath("cleanup");
  cleanupFiles(dbPath);
  const store = openDb(dbPath);
  try {
    const now = Date.now();
    const userId = store.createUser("cleanupuser", "x", now - 10 * DAY);

    store.createSession(userId, "expired-token", now - 2 * DAY, now - DAY);
    store.createSession(userId, "boundary-token", now - DAY, now); // expires_at === now 视为过期
    store.createSession(userId, "valid-token", now, now + DAY);

    const deleted = store.cleanupExpiredSessions(now);
    assert.equal(deleted, 2, "只应删除两条过期会话");
    assert.equal(readSession(dbPath, "expired-token"), undefined);
    assert.equal(readSession(dbPath, "boundary-token"), undefined);
    assert.ok(readSession(dbPath, "valid-token"), "有效会话不应被删除");
    assert.ok(store.getUserByToken("valid-token", now));

    // 再次清理没有过期行,返回 0
    assert.equal(store.cleanupExpiredSessions(now), 0);
  } finally {
    store.close();
    cleanupFiles(dbPath);
  }
});

/* ---------- ④ 旧 schema 迁移回填 expires_at ---------- */

test("旧 sessions 表迁移后回填 expires_at = created_at + TTL", () => {
  const dbPath = makeDbPath("migrate");
  cleanupFiles(dbPath);

  const now = Date.now();
  const recentCreated = now - DAY;
  const ancientCreated = now - 60 * DAY;

  const old = new DatabaseSync(dbPath);
  old.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );
  `);
  const userId = insertUser(old, "olduser", ancientCreated);
  old.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(
    "recent-token",
    userId,
    recentCreated
  );
  old.prepare("INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)").run(
    "ancient-token",
    userId,
    ancientCreated
  );
  old.close();

  const store = openDb(dbPath);
  try {
    const ttl = getSessionTtlMs();
    const recent = readSession(dbPath, "recent-token");
    const ancient = readSession(dbPath, "ancient-token");

    assert.equal(recent.expires_at, recentCreated + ttl, "应按 created_at + TTL 回填");
    assert.equal(ancient.expires_at, ancientCreated + ttl);

    // 不是「一律永久有效」:很久以前签发的会话迁移后已过期
    assert.equal(store.getUserByToken("ancient-token", now), undefined);
    // 也不是「一律失效」:仍在 TTL 内的老会话继续可用
    assert.ok(store.getUserByToken("recent-token", now), "TTL 内的老会话迁移后应仍有效");
  } finally {
    store.close();
    cleanupFiles(dbPath);
  }
});

function tmpPath(prefix) {
  return path.join(os.tmpdir(), `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
}

function cleanup(dbPath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch (_) {
      /* 忽略清理失败 */
    }
  }
}

function sessionCount(dbPath) {
  const db = new DatabaseSync(dbPath);
  try {
    return Number(db.prepare("SELECT COUNT(*) AS n FROM sessions").get().n);
  } finally {
    db.close();
  }
}

/* ---------- TTL 解析 ---------- */

test("TTL 解析:非法值回退默认,合法正整数生效", () => {
  assert.equal(resolveSessionTtlMs(undefined), DEFAULT_SESSION_TTL_MS);
  assert.equal(resolveSessionTtlMs(null), DEFAULT_SESSION_TTL_MS);
  assert.equal(resolveSessionTtlMs(0), DEFAULT_SESSION_TTL_MS);
  assert.equal(resolveSessionTtlMs(-1), DEFAULT_SESSION_TTL_MS);
  assert.equal(resolveSessionTtlMs(1.5), DEFAULT_SESSION_TTL_MS);
  assert.equal(resolveSessionTtlMs("abc"), DEFAULT_SESSION_TTL_MS);
  assert.equal(resolveSessionTtlMs(60_000), 60_000);
});

/* ---------- 持久化层 ---------- */

test("有效期内可鉴权,到达 TTL 后 getUserByToken 返回 undefined", () => {
  const store = openDb(":memory:", { sessionTtlMs: 1000 });
  try {
    const userId = store.createUser("expiry_user", "scrypt$x$y", 1000);
    const session = store.createSession(userId, "tok-expiry", 1000);
    assert.equal(session.createdAt, 1000);
    assert.equal(session.expiresAt, 2000, "expiresAt 应为 created_at + TTL");

    const before = store.getUserByToken("tok-expiry", 1999);
    assert.ok(before, "TTL 内应能解析出用户");
    assert.equal(before.username, "expiry_user");

    assert.equal(store.getUserByToken("tok-expiry", 2000), undefined, "恰好到期应失效");
    assert.equal(store.getUserByToken("tok-expiry", 9999), undefined);
    assert.equal(store.getUserByToken("no-such-token", 1500), undefined);
  } finally {
    store.close();
  }
});

test("deleteExpiredSessions 只删除过期会话,并返回删除条数", () => {
  const store = openDb(":memory:", { sessionTtlMs: 1000 });
  try {
    const userId = store.createUser("cleanup_user", "scrypt$x$y", 0);
    store.createSession(userId, "tok-old", 1000); // 2000 到期
    store.createSession(userId, "tok-live", 2500); // 3500 到期

    assert.equal(store.deleteExpiredSessions(3000), 1);
    assert.equal(store.getUserByToken("tok-old", 3000), undefined);
    assert.ok(store.getUserByToken("tok-live", 3000), "未过期会话应保留");

    // 语义化别名应指向同一实现
    assert.equal(store.cleanupExpiredSessions(4000), 1);
    assert.equal(store.deleteExpiredSessions(4000), 0, "重复清理应为 0");
  } finally {
    store.close();
  }
});

test("created_at 被回拨到 TTL 之外时,即使 expires_at 未到也失效", () => {
  const dbPath = tmpPath("todo-session-backdate");
  try {
    const store = openDb(dbPath, { sessionTtlMs: 10_000 });
    const userId = store.createUser("backdate_user", "scrypt$x$y", 100_000);
    store.createSession(userId, "tok-backdate", 100_000); // expires_at = 110000
    store.close();

    // 模拟只篡改 created_at(例如旧逻辑写入/人为回拨)
    const raw = new DatabaseSync(dbPath);
    raw.prepare("UPDATE sessions SET created_at = ? WHERE token = ?").run(1, "tok-backdate");
    raw.close();

    const reopened = openDb(dbPath, { sessionTtlMs: 10_000 });
    try {
      assert.equal(
        reopened.getUserByToken("tok-backdate", 100_000),
        undefined,
        "created_at 超过 TTL 后不应再通过鉴权"
      );
    } finally {
      reopened.close();
    }
  } finally {
    cleanup(dbPath);
  }
});

/* ---------- 旧库迁移 ---------- */

test("旧库迁移:旧 sessions 表补 expires_at 并按 created_at + TTL 回填", () => {
  const dbPath = tmpPath("todo-session-migrate");
  cleanup(dbPath);
  try {
    const old = new DatabaseSync(dbPath);
    old.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE sessions (
        token TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL
      );
      INSERT INTO users (username, password_hash, created_at) VALUES ('legacy', 'x', 100);
      INSERT INTO sessions (token, user_id, created_at) VALUES ('tok-legacy', 1, 1000);
    `);
    old.close();

    const store = openDb(dbPath, { sessionTtlMs: 5000 });
    try {
      // 旧 token 在 1000 + 5000 = 6000 到期
      assert.ok(store.getUserByToken("tok-legacy", 5999), "旧会话未过期时应可用");
      assert.equal(store.getUserByToken("tok-legacy", 6000), undefined, "旧会话到期后失效");

      const raw = new DatabaseSync(dbPath);
      const row = raw.prepare("SELECT expires_at FROM sessions WHERE token = ?").get("tok-legacy");
      raw.close();
      assert.equal(row.expires_at, 6000, "迁移应回填 expires_at");
    } finally {
      store.close();
    }
  } finally {
    cleanup(dbPath);
  }
});

/* ---------- HTTP 层 ---------- */

let server;
let app;
let base;
let dbPath;
let currentTime;

before(async () => {
  dbPath = tmpPath("todo-session-api");
  currentTime = 1_000_000;
  const started = await startServer({
    dbPath,
    port: 0,
    staticDir: path.join(__dirname, ".."),
    sessionTtlMs: 60_000,
    now: () => currentTime,
    cleanupIntervalMs: 60_000
  });
  server = started.server;
  app = started.app;
  base = `http://127.0.0.1:${started.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanup(dbPath);
});

function post(pathname, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  return fetch(base + pathname, { method: "POST", headers, body: JSON.stringify(body) });
}

function get(pathname, token) {
  const headers = {};
  if (token) headers.Authorization = "Bearer " + token;
  return fetch(base + pathname, { headers });
}

test("HTTP:新会话返回 expiresAt,TTL 内可访问", async () => {
  const res = await post("/api/register", { username: "exp_api", password: "secret123" });
  assert.equal(res.status, 201);
  const data = await res.json();
  assert.ok(data.token);
  assert.equal(data.expiresAt, currentTime + 60_000);

  const me = await get("/api/me", data.token);
  assert.equal(me.status, 200);
  assert.equal((await me.json()).username, "exp_api");
});

test("HTTP:会话到期后返回 401 且该会话被清除", async () => {
  currentTime = 5_000_000;
  const res = await post("/api/register", { username: "exp_http", password: "secret123" });
  const { token, expiresAt } = await res.json();
  currentTime = expiresAt - 1;

  const live = await get("/api/me", token);
  assert.equal(live.status, 200, "到期前一刻仍可用");

  currentTime = expiresAt;
  const expired = await get("/api/me", token);
  assert.equal(expired.status, 401, "到期后必须拒绝");

  const raw = new DatabaseSync(dbPath);
  try {
    const row = raw.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token = ?").get(token);
    assert.equal(Number(row.n), 0, "被拒绝的过期会话应已从 sessions 表删除");
  } finally {
    raw.close();
  }
});

test("HTTP:未被访问的过期会话也会被定期清理任务删除", async () => {
  currentTime = 6_000_000;
  const res = await post("/api/register", { username: "exp_sweep", password: "secret123" });
  const { token, expiresAt } = await res.json();
  assert.equal(sessionCount(dbPath) > 0, true);

  currentTime = expiresAt;
  const db = new DatabaseSync(dbPath);
  const before = Number(
    db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token = ?").get(token).n
  );
  db.close();
  assert.equal(before, 1, "未被访问的过期会话在清理前仍存在");

  // 直接触发定期任务使用的同一清理逻辑
  const removed = app.locals.store.deleteExpiredSessions(currentTime);
  assert.ok(removed >= 1);

  const db2 = new DatabaseSync(dbPath);
  const after = Number(
    db2.prepare("SELECT COUNT(*) AS n FROM sessions WHERE token = ?").get(token).n
  );
  db2.close();
  assert.equal(after, 0, "清理后过期会话应被删除");
});
