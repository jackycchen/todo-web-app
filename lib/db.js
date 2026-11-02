"use strict";

/**
 * SQLite 持久化层(使用 Node 内置 node:sqlite,无第三方原生依赖)。
 *
 * 表结构:
 *  - users   : 用户账号,password_hash 存储 scrypt 派生密钥
 *  - sessions: 登录会话 token -> userId,含 created_at / expires_at
 *  - todos   : 待办项,按 (user_id, id) 唯一,天然实现多用户数据隔离
 *
 * 会话有效期:
 *  - 每个会话固定 TTL(默认 7 天,可用 TODO_SESSION_TTL_MS 或 openDb 的
 *    sessionTtlMs 覆盖)。created_at 与 expires_at 双重校验,任一时间戳
 *    到期即视为失效,避免只改其中一个字段就能绕过过期判断。
 *  - 过期会话记录由 deleteExpiredSessions() 删除,服务端也会定期调用,
 *    避免 sessions 表无限增长。
 *
 * 多端同步相关字段:
 *  - updated_at: 最近一次写入的服务端毫秒时间戳,用于增量拉取(?since=)与冲突比较
 *  - deleted   : 软删除标记(tombstone),让删除也能通过增量接口同步给其他端
 *
 * 优先级:
 *  - priority: 0 低 / 1 普通(默认)/ 2 高。列表按 priority DESC, created_at ASC
 *    排序;修改优先级同样刷新 updated_at,因此能通过增量接口同步到其他端。
 */
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

/** 会话默认有效期:30 天。 */
const DEFAULT_SESSION_TTL_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = DEFAULT_SESSION_TTL_DAYS * MS_PER_DAY;
const MAX_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000; // 上限 1 年,防止误配置成永不过期

/**
 * 解析会话 TTL:必须是正整数毫秒且不超过上限,否则回退默认值。
 */
function resolveSessionTtlMs(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_SESSION_TTL_MS) {
    return DEFAULT_SESSION_TTL_MS;
  }
  return n;
}

/** 会话默认有效期(毫秒)。可用环境变量 SESSION_TTL_DAYS(天数)覆盖。 */
function getSessionTtlMs() {
  const raw = process.env.SESSION_TTL_DAYS;
  const days = raw === undefined || raw === "" ? DEFAULT_SESSION_TTL_DAYS : Number(raw);
  const safeDays = Number.isFinite(days) && days > 0 ? days : DEFAULT_SESSION_TTL_DAYS;
  return Math.round(safeDays * MS_PER_DAY);
}

/**
 * openDb 未显式指定 TTL 时的默认值:
 * 优先 TODO_SESSION_TTL_MS(毫秒),其次 SESSION_TTL_DAYS(天数)。
 */
function defaultSessionTtlMs() {
  const rawMs = process.env.TODO_SESSION_TTL_MS;
  if (rawMs !== undefined && rawMs !== "") return resolveSessionTtlMs(rawMs);
  return getSessionTtlMs();
}

/**
 * 优先级:数值越大越靠前,0 低 / 1 普通 / 2 高。
 * 默认「普通」(1),旧库迁移后也回填为 1,因此未设置过优先级的条目
 * 仍严格按 created_at 升序排列,列表观感不变。
 */
const DEFAULT_TODO_PRIORITY = 1;
const TODO_PRIORITIES = new Set([0, 1, 2]);

function normalizeTodoPriority(value) {
  return TODO_PRIORITIES.has(value) ? value : DEFAULT_TODO_PRIORITY;
}

function rowToItem(row) {
  return {
    id: row.id,
    text: row.text,
    completed: !!row.completed,
    priority: normalizeTodoPriority(row.priority),
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
 * options.sessionTtlMs 可覆盖默认会话有效期(毫秒)。
 */
function openDb(dbPath, options = {}) {
  if (dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const sessionTtlMs = resolveSessionTtlMs(
    options.sessionTtlMs !== undefined ? options.sessionTtlMs : defaultSessionTtlMs()
  );
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
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS todos (
      id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      priority INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      deleted INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, id)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_todos_user ON todos(user_id);
  `);

  // 兼容旧数据库:新增列必须用 ALTER TABLE,并把 updated_at 回填为 created_at。
  // priority 用 NOT NULL DEFAULT 1 添加,SQLite 会为既有行自动回填「普通」,
  // 因此旧条目的相对顺序仍由 created_at 决定,列表观感不变。
  const todoColumns = new Set(
    db.prepare("PRAGMA table_info(todos)").all().map((col) => col.name)
  );
  if (!todoColumns.has("updated_at")) {
    db.exec("ALTER TABLE todos ADD COLUMN updated_at INTEGER");
  }
  if (!todoColumns.has("deleted")) {
    db.exec("ALTER TABLE todos ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0");
  }
  if (!todoColumns.has("priority")) {
    db.exec("ALTER TABLE todos ADD COLUMN priority INTEGER NOT NULL DEFAULT 1");
  }
  db.exec(`
    UPDATE todos SET updated_at = created_at WHERE updated_at IS NULL;
    UPDATE todos SET priority = 1 WHERE priority IS NULL;
    CREATE INDEX IF NOT EXISTS idx_todos_user_updated ON todos(user_id, updated_at);
    CREATE INDEX IF NOT EXISTS idx_todos_user_priority
      ON todos(user_id, priority DESC, created_at ASC);
  `);

  // 兼容没有 expires_at 的旧 sessions 表:补列后按 created_at + TTL 回填,
  // 让老会话既不会全部失效,也不会全部变成永久有效。
  const sessionColumns = new Set(
    db.prepare("PRAGMA table_info(sessions)").all().map((col) => col.name)
  );
  if (!sessionColumns.has("expires_at")) {
    db.exec("ALTER TABLE sessions ADD COLUMN expires_at INTEGER");
  }
  db.prepare(
    "UPDATE sessions SET expires_at = created_at + ? WHERE expires_at IS NULL"
  ).run(sessionTtlMs);
  db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);");

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
      "INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
    ),
    // 有效期校验:created_at 与 expires_at 双重判断,任一到期即失效。
    // 参数: (token, now - ttl, now)
    selectUserByToken: db.prepare(
      "SELECT u.id, u.username FROM sessions s JOIN users u ON u.id = s.user_id " +
        "WHERE s.token = ? AND s.created_at > ? " +
        "AND (s.expires_at IS NULL OR s.expires_at > ?)"
    ),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
    deleteExpiredSessions: db.prepare(
      "DELETE FROM sessions WHERE created_at <= ? " +
        "OR (expires_at IS NOT NULL AND expires_at <= ?)"
    ),
    // 展示顺序由 SQL 决定:优先级从高到低,同级按创建时间升序。
    // 旧数据全部为默认优先级 1,因此仍与原先的 created_at ASC 观感一致。
    selectTodos: db.prepare(
      "SELECT id, text, completed, priority, created_at, updated_at, deleted FROM todos " +
        "WHERE user_id = ? AND deleted = 0 ORDER BY priority DESC, created_at ASC"
    ),
    // 增量同步只关心「哪些变了」,仍按 updated_at 升序,语义保持不变。
    selectChangedTodos: db.prepare(
      "SELECT id, text, completed, priority, created_at, updated_at, deleted FROM todos " +
        "WHERE user_id = ? AND updated_at > ? ORDER BY updated_at ASC"
    ),
    selectTodo: db.prepare(
      "SELECT id, text, completed, priority, created_at, updated_at, deleted FROM todos " +
        "WHERE user_id = ? AND id = ? AND deleted = 0"
    ),
    insertTodo: db.prepare(
      "INSERT INTO todos (id, user_id, text, completed, priority, created_at, updated_at, deleted) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, 0) " +
        "ON CONFLICT(user_id, id) DO UPDATE SET text = excluded.text, " +
        "completed = excluded.completed, priority = excluded.priority, " +
        "updated_at = excluded.updated_at, deleted = 0"
    ),
    updateTodo: db.prepare(
      "UPDATE todos SET text = ?, completed = ?, priority = ?, updated_at = ? " +
        "WHERE user_id = ? AND id = ? AND deleted = 0"
    ),
    deleteTodo: db.prepare(
      "UPDATE todos SET deleted = 1, updated_at = ? WHERE user_id = ? AND id = ? AND deleted = 0"
    )
  };

  /**
   * 删除已过期会话,返回删除条数。
   * created_at 或 expires_at 任一到期即删除。
   */
  function deleteExpiredSessions(now = Date.now()) {
    const current = Number.isFinite(now) ? now : Date.now();
    const info = stmts.deleteExpiredSessions.run(current - sessionTtlMs, current);
    return Number(info.changes || 0);
  }

  return {
    // 当前会话有效期(毫秒),供上层展示/测试使用
    sessionTtlMs,

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

    /**
     * 创建会话。createdAt 默认取当前时间,expiresAt 默认 = createdAt + TTL。
     * 返回 { token, createdAt, expiresAt }。
     */
    createSession(userId, token, createdAt = Date.now(), expiresAt) {
      const created = Number.isFinite(createdAt) ? createdAt : Date.now();
      const expires = Number.isFinite(expiresAt) ? expiresAt : created + sessionTtlMs;
      stmts.insertSession.run(token, userId, created, expires);
      return { token, createdAt: created, expiresAt: expires };
    },

    /**
     * 按 token 取用户;会话不存在,或 created_at / expires_at 任一过期时
     * 返回 undefined。now 可注入以便测试,默认取当前时间。
     */
    getUserByToken(token, now = Date.now()) {
      const current = Number.isFinite(now) ? now : Date.now();
      return stmts.selectUserByToken.get(token, current - sessionTtlMs, current) || undefined;
    },

    deleteSession(token) {
      stmts.deleteSession.run(token);
    },

    /** 删除过期会话,返回删除条数。now 显式传入便于测试。 */
    deleteExpiredSessions: deleteExpiredSessions,

    /** deleteExpiredSessions 的语义化别名 */
    cleanupExpiredSessions: deleteExpiredSessions,

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
      const priority = normalizeTodoPriority(item.priority);
      stmts.insertTodo.run(
        item.id,
        userId,
        item.text,
        item.completed ? 1 : 0,
        priority,
        item.createdAt,
        updatedAt
      );
      return { ...rowToItem(stmts.selectTodo.get(userId, item.id)) };
    },

    /** 局部更新,返回更新后的条目;不存在或已删除时返回 undefined */
    updateTodo(userId, id, patch) {
      const current = stmts.selectTodo.get(userId, id);
      if (!current) return undefined;
      const text = patch.text !== undefined ? patch.text : current.text;
      const completed = patch.completed !== undefined ? !!patch.completed : !!current.completed;
      const priority =
        patch.priority !== undefined
          ? normalizeTodoPriority(patch.priority)
          : normalizeTodoPriority(current.priority);
      const updatedAt = nextTimestamp();
      stmts.updateTodo.run(text, completed ? 1 : 0, priority, updatedAt, userId, id);
      return rowToItem(stmts.selectTodo.get(userId, id));
    },

    /** 软删除(写墓碑),返回是否发生了删除 */
    deleteTodo(userId, id) {
      return stmts.deleteTodo.run(nextTimestamp(), userId, id).changes > 0;
    }
  };
}

module.exports = {
  openDb,
  DEFAULT_TODO_PRIORITY,
  normalizeTodoPriority,
  getSessionTtlMs,
  DEFAULT_SESSION_TTL_DAYS,
  DEFAULT_SESSION_TTL_MS,
  MAX_SESSION_TTL_MS,
  resolveSessionTtlMs
};
