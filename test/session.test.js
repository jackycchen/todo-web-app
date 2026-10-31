"use strict";

/**
 * 会话生命周期测试:
 *  - 未过期会话可正常鉴权
 *  - 过期会话返回 401,且鉴权路径会删除该行(惰性清理)
 *  - cleanupExpiredSessions 只删除过期行,不动有效行
 *  - 旧 schema(无 expires_at)迁移后按 created_at + TTL 回填
 * 使用独立临时 SQLite,不依赖网络。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const { openDb, getSessionTtlMs } = require("../lib/db.js");
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
