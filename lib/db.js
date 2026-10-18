"use strict";

/**
 * SQLite 持久化层(使用 Node 内置 node:sqlite,无第三方原生依赖)。
 *
 * 表结构:
 *  - users   : 用户账号,password_hash 存储 scrypt 派生密钥
 *  - sessions: 登录会话 token -> userId
 *  - todos   : 待办项,按 (user_id, id) 唯一,天然实现多用户数据隔离
 *
 * 多端同步相关字段:
 *  - updated_at: 最近一次写入的服务端毫秒时间戳,用于增量拉取(?since=)与冲突比较
 *  - deleted   : 软删除标记(tombstone),让删除也能通过增量接口同步给其他端
 */
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function rowToItem(row) {
  return {
    id: row.id,
    text: row.text,
    completed: !!row.completed,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deleted: !!row.deleted
  };
}

/**
 * 单调递增的毫秒时间戳。
 * 同一毫秒内的多次写入会得到严格递增的值,避免增量同步 (?since= 使用 >)
 * 漏掉同毫秒发生的后续变更。
 */
function createClock(initial) {
  let last = initial || 0;
  return function nextTimestamp() {
    const now = Date.now();
    last = now > last ? now : last + 1;
    return last;
  };
}

/**
 * 打开(必要时创建)数据库并初始化表结构。
 * dbPath 为 ":memory:" 时使用内存库(便于测试)。
 */
function openDb(dbPath) {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new DatabaseSync(dbPath);

  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS todos (
      id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id);
  `);

  // 兼容 M1 旧数据库:新增列必须用 ALTER TABLE,并把 updated_at 回填为 created_at
  const todoColumns = new Set(
    db.prepare("PRAGMA table_info(todos)").all().map((col) => col.name)
  );
  if (!todoColumns.has("updated_at")) {
    db.exec("ALTER TABLE todos ADD COLUMN updated_at INTEGER");
  }
  if (!todoColumns.has("deleted")) {
    db.exec("ALTER TABLE todos ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
  }
  db.exec(`
    UPDATE todos SET updated_at = created_at WHERE updated_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_todos_user_updated ON todos(user_id, updated_at);
  `);

  // 以库中最大 updated_at 为起点,保证重启后新写入仍严格大于旧游标
  const maxUpdated = db.prepare("SELECT MAX(updated_at) AS max_ts FROM todos").get();
  const nextTimestamp = createClock(maxUpdated && maxUpdated.max_ts);

  const stmts = {
    insertUser: db.prepare(
      "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)"
    ),
    selectUserByUsername: db.prepare(
      "SELECT id, username, password_hash FROM users WHERE username = ?"
    ),
    insertSession: db.prepare(
      "INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)"
    ),
    selectUserByToken: db.prepare(
      "SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?"
    ),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
    selectTodos: db.prepare(
      "SELECT id, text, completed, created_at, updated_at, deleted FROM todos " +
        "WHERE user_id = ? AND deleted = 0 ORDER BY created_at ASC"
    ),
    selectChangedTodos: db.prepare(
      "SELECT id, text, completed, created_at, updated_at, deleted FROM todos " +
        "WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC"
    ),
    selectTodo: db.prepare(
      "SELECT id, text, completed, created_at, updated_at, deleted FROM todos " +
        "WHERE user_id = ? AND id = ? AND deleted = 0"
    ),
    insertTodo: db.prepare(
      "INSERT INTO todos (id, user_id, text, completed, created_at, updated_at, deleted) " +
        "VALUES (?, ?, ?, ?, ?, ?, 0) " +
        "ON CONFLICT(user_id, id) DO UPDATE SET text = excluded.text, " +
        "completed = excluded.completed, updated_at = excluded.updated_at, deleted = 0"
    ),
    updateTodo: db.prepare(
      "UPDATE todos SET text = ?, completed = ?, updated_at = ? " +
        "WHERE user_id = ? AND id = ? AND deleted = 0"
    ),
    deleteTodo: db.prepare(
      "UPDATE todos SET deleted = 1, updated_at = ? WHERE user_id = ? AND id = ? AND deleted = 0"
    )
  };

  return {
    close() {
      db.close();
    },

    createUser(username, passwordHash, createdAt) {
      const info = stmts.insertUser.run(username, passwordHash, createdAt);
      return Number(info.lastInsertRowid);
    },

    getUserByUsername(username) {
      return stmts.selectUserByUsername.get(username) || undefined;
    },

    createSession(userId, token, createdAt) {
      stmts.insertSession.run(token, userId, createdAt);
    },

    getUserByToken(token) {
      return stmts.selectUserByToken.get(token) || undefined;
    },

    deleteSession(token) {
      stmts.deleteSession.run(token);
    },

    /** 全量列出(不含已删除项) */
    getTodos(userId) {
      return stmts.selectTodos.all(userId).map(rowToItem);
    },

    /** 增量列出:updatedAt 严格大于 since 的所有变更,包含删除墓碑 */
    getChangedTodos(userId, since) {
      return stmts.selectChangedTodos.all(userId, since).map(rowToItem);
    },

    getTodo(userId, id) {
      const row = stmts.selectTodo.get(userId, id);
      return row ? rowToItem(row) : undefined;
    },

    /** 新增(或复活同 id 的墓碑),返回实际写入的完整条目(含服务端 updatedAt) */
    insertTodo(userId, item) {
      const updatedAt = nextTimestamp();
      stmts.insertTodo.run(item.id, userId, item.text, item.completed ? 1 : 0, item.createdAt, updatedAt);
      return { ...rowToItem(stmts.selectTodo.get(userId, item.id)) };
    },

    /** 局部更新,返回更新后的条目;不存在或已删除时返回 undefined */
    updateTodo(userId, id, patch) {
      const current = stmts.selectTodo.get(userId, id);
      if (!current) return undefined;
      const text = patch.text !== undefined ? patch.text : current.text;
      const completed = patch.completed !== undefined ? !!patch.completed : !!current.completed;
      const updatedAt = nextTimestamp();
      stmts.updateTodo.run(text, completed ? 1 : 0, updatedAt, userId, id);
      return rowToItem(stmts.selectTodo.get(userId, id));
    },

    /** 软删除(写墓碑),返回是否发生了删除 */
    deleteTodo(userId, id) {
      return stmts.deleteTodo.run(nextTimestamp(), userId, id).changes > 0;
    }
  };
}

module.exports = { openDb };
