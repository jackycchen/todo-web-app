"use strict";

/**
 * 优先级(priority)数据库层测试:
 *  - 旧库(没有 priority 列)迁移后默认「普通」,既有条目仍按 created_at 升序
 *  - 全量列表按 priority DESC, created_at ASC 排序
 *  - 修改优先级会刷新 updated_at,并出现在增量查询结果中
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

test("旧库升级:新增 priority 列默认普通,既有条目顺序不变", () => {
  const dbPath = path.join(os.tmpdir(), `todo-priority-migrate-${process.pid}-${Date.now()}.db`);
  cleanup(dbPath);

  // 模拟上一次发布时的库结构(已有 updated_at / deleted,但没有 priority)
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
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, id)
    );
    INSERT INTO users (username, password_hash, created_at) VALUES ('legacy', 'x', 1);
    INSERT INTO todos (id, user_id, text, completed, created_at, updated_at, deleted) VALUES
      ('b', 1, '第二条', 0, 200, 200, 0),
      ('a', 1, '第一条', 0, 100, 100, 0),
      ('c', 1, '第三条', 0, 300, 300, 0);
  `);
  old.close();

  const store = openDb(dbPath);
  try {
    const items = store.getTodos(1);
    assert.deepEqual(
      items.map((item) => item.id),
      ["a", "b", "c"],
      "全部为默认优先级时仍按 created_at 升序,旧列表观感不变"
    );
    items.forEach((item) => assert.equal(item.priority, 1, "迁移后默认「普通」"));

    // 旧数据也能通过增量接口拿到,并带有默认优先级
    const changes = store.getChangedTodos(1, 0);
    assert.equal(changes.length, 3);
    changes.forEach((item) => assert.equal(item.priority, 1));
  } finally {
    store.close();
    cleanup(dbPath);
  }
});

test("列表排序:优先级从高到低,同级按 createdAt 升序", () => {
  const store = openDb(":memory:");
  try {
    const userId = store.createUser("sorter", "hash", 1);
    const base = 1_000_000;

    // 插入顺序故意打乱,确保排序由 SQL 而不是插入顺序决定
    store.insertTodo(userId, { id: "low", text: "低", completed: false, priority: 0, createdAt: base + 400 });
    store.insertTodo(userId, { id: "normal-late", text: "普通-晚", completed: false, priority: 1, createdAt: base + 300 });
    store.insertTodo(userId, { id: "high", text: "高", completed: false, priority: 2, createdAt: base + 200 });
    store.insertTodo(userId, { id: "normal-early", text: "普通-早", completed: false, priority: 1, createdAt: base + 100 });

    const items = store.getTodos(userId);
    assert.deepEqual(items.map((item) => item.id), [
      "high",
      "normal-early",
      "normal-late",
      "low"
    ]);
    assert.deepEqual(items.map((item) => item.priority), [2, 1, 1, 0]);
  } finally {
    store.close();
  }
});

test("修改优先级刷新 updatedAt,并可被增量查询拉到", () => {
  const store = openDb(":memory:");
  try {
    const userId = store.createUser("priority", "hash", 1);
    const created = store.insertTodo(userId, {
      id: "p1",
      text: "改优先级",
      completed: false,
      createdAt: 5000
    });
    assert.equal(created.priority, 1, "默认普通");

    const updated = store.updateTodo(userId, "p1", { priority: 2 });
    assert.equal(updated.priority, 2);
    assert.ok(updated.updatedAt > created.updatedAt, "改优先级必须刷新 updatedAt");

    const changes = store.getChangedTodos(userId, created.updatedAt);
    const found = changes.find((item) => item.id === "p1");
    assert.ok(found, "修改后的条目应出现在增量结果中");
    assert.equal(found.priority, 2);
    assert.equal(found.updatedAt, updated.updatedAt);

    // 全量列表也反映新优先级
    assert.equal(store.getTodos(userId)[0].priority, 2);

    // 非法优先级在数据库层回落到「普通」,不会写入异常值
    const fallback = store.updateTodo(userId, "p1", { priority: 99 });
    assert.equal(fallback.priority, 1);
  } finally {
    store.close();
  }
});
