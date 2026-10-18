"use strict";

/**
 * 数据库迁移测试:模拟 M1 旧库(没有 updated_at / deleted 列),
 * 验证 openDb 使用 ALTER TABLE 补列并把 updated_at 回填为 created_at。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");

const { openDb } = require("../lib/db.js");

function cleanup(dbPath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch (_) {
      /* 忽略清理失败 */
    }
  }
}

test("旧库迁移:新增 updated_at/deleted 列并回填 updatedAt", () => {
  const dbPath = path.join(os.tmpdir(), `todo-migrate-${process.pid}-${Date.now()}.db`);
  cleanup(dbPath);

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
    CREATE TABLE todos (
      id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, id)
    );
    INSERT INTO users (username, password_hash, created_at) VALUES ('olduser', 'x', 100);
    INSERT INTO todos (id, user_id, text, completed, created_at)
      VALUES ('old-todo', 1, '旧数据', 1, 1234567890123);
  `);
  old.close();

  const store = openDb(dbPath);
  try {
    const items = store.getTodos(1);
    assert.equal(items.length, 1);
    assert.equal(items[0].id, "old-todo");
    assert.equal(items[0].createdAt, 1234567890123);
    assert.equal(items[0].updatedAt, 1234567890123, "updatedAt 应回填为 created_at");
    assert.equal(items[0].deleted, false);

    // 旧数据也要能被增量接口拉到
    const changes = store.getChangedTodos(1, 0);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].id, "old-todo");

    // 迁移后写入正常,且 updatedAt 使用服务端毫秒时间戳
    const inserted = store.insertTodo(1, {
      id: "new-todo",
      text: "新数据",
      completed: false,
      createdAt: 1234567890124
    });
    assert.ok(Number.isSafeInteger(inserted.updatedAt));
    assert.ok(inserted.updatedAt > inserted.createdAt);
  } finally {
    store.close();
    cleanup(dbPath);
  }
});
