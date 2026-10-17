"use strict";

/**
 * SQLite 持久化层(使用 Node 内置 node:sqlite,无第三方原生依赖)。
 *
 * 表结构:
 *  - users   : 用户账号,password_hash 存储 scrypt 派生密钥
 *  - sessions: 登录会话 token -> userId
 *  - todos   : 待办项,按 (user_id, id) 唯一,天然实现多用户数据隔离
 */
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function rowToItem(row) {
  return {
    id: row.id,
    text: row.text,
    completed: !!row.completed,
    createdAt: row.created_at
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
      PRIMARY KEY (user_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id);
  `);

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
      "SELECT id, text, completed, created_at FROM todos WHERE user_id = ? ORDER BY created_at ASC"
    ),
    selectTodo: db.prepare(
      "SELECT id, text, completed, created_at FROM todos WHERE user_id = ? AND id = ?"
    ),
    insertTodo: db.prepare(
      "INSERT OR IGNORE INTO todos (id, user_id, text, completed, created_at) VALUES (?, ?, ?, ?, ?)"
    ),
    updateTodo: db.prepare(
      "UPDATE todos SET text = ?, completed = ? WHERE user_id = ? AND id = ?"
    ),
    deleteTodo: db.prepare("DELETE FROM todos WHERE user_id = ? AND id = ?")
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

    getTodos(userId) {
      return stmts.selectTodos.all(userId).map(rowToItem);
    },

    getTodo(userId, id) {
      const row = stmts.selectTodo.get(userId, id);
      return row ? rowToItem(row) : undefined;
    },

    insertTodo(userId, item) {
      stmts.insertTodo.run(item.id, userId, item.text, item.completed ? 1 : 0, item.createdAt);
    },

    updateTodo(userId, id, patch) {
      const current = stmts.selectTodo.get(userId, id);
      if (!current) return undefined;
      const next = {
        id: current.id,
        text: patch.text !== undefined ? patch.text : current.text,
        completed: patch.completed !== undefined ? !!patch.completed : !!current.completed,
        createdAt: current.created_at
      };
      stmts.updateTodo.run(next.text, next.completed ? 1 : 0, userId, id);
      return next;
    },

    deleteTodo(userId, id) {
      return stmts.deleteTodo.run(userId, id).changes > 0;
    }
  };
}

module.exports = { openDb };
