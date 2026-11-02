"use strict";

/**
 * todo-web-app 多用户后端
 *
 * 技术栈: Node.js + Express + SQLite(内置 node:sqlite)
 *  - 账号: 用户名 + 密码(scrypt 加盐哈希,不存明文)
 *  - 会话: 登录/注册成功后返回不透明 token,Bearer 头鉴权
 *  - 数据: 待办项按 userId 隔离; 数据结构与 todo-core.js 保持一致
 */

const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");
const { openDb, getSessionTtlMs } = require("./lib/db.js");
const core = require("./todo-core.js");

const DEFAULT_PORT = 3000;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 每小时

const PASSWORD_MIN_LENGTH = 6;
const USERNAME_MAX_LENGTH = 50;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64);
  return "scrypt$" + salt.toString("hex") + "$" + derived.toString("hex");
}

function verifyPassword(password, stored) {
  if (typeof stored !== "string") return false;
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = crypto.scryptSync(String(password), salt, expected.length);
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function sanitizeUsername(username) {
  if (typeof username !== "string") return null;
  const u = username.trim();
  if (!u || u.length > USERNAME_MAX_LENGTH) return null;
  // 过滤控制字符,避免干扰响应与存储
  for (let i = 0; i < u.length; i++) {
    const code = u.charCodeAt(i);
    if (code < 32 || code === 127) return null;
  }
  return u;
}

function isValidPassword(password) {
  return typeof password === "string" && password.length >= PASSWORD_MIN_LENGTH && password.length <= 128;
}

function bearerToken(req) {
  const header = req.headers.authorization || "";
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}

function createApp(options = {}) {
  const dbPath =
    options.dbPath || process.env.TODO_DB_PATH || path.join(__dirname, "data", "todo.db");
  const store = options.store || openDb(dbPath);
  const staticDir = options.staticDir || __dirname;

  const app = express();
  app.use(express.json());

  // 从 Bearer token 解析当前用户
  function auth(req, res, next) {
    const token = bearerToken(req);
    const user = token ? store.getUserByToken(token) : undefined;
    if (!user) {
      // 惰性清理:过期(或已失效)的 token 顺手删除,避免过期行长期堆积
      if (token) store.deleteSession(token);
      return res.status(401).json({ error: "未登录或登录已过期" });
    }
    req.userId = user.id;
    req.username = user.username;
    req.token = token;
    next();
  }

  app.get("/api/health", (req, res) => {
    res.json({ ok: true });
  });

  // ---------- 账号与会话 ----------

  app.post("/api/register", (req, res) => {
    const body = req.body || {};
    const username = sanitizeUsername(body.username);
    if (!username) {
      return res.status(400).json({ error: "用户名不合法(1-" + USERNAME_MAX_LENGTH + " 个字符,且不含控制字符)" });
    }
    if (!isValidPassword(body.password)) {
      return res.status(400).json({ error: "密码长度至少 " + PASSWORD_MIN_LENGTH + " 位" });
    }
    if (store.getUserByUsername(username)) {
      return res.status(409).json({ error: "用户名已存在" });
    }
    const now = Date.now();
    const userId = store.createUser(username, hashPassword(body.password), now);
    const token = crypto.randomBytes(32).toString("hex");
    store.createSession(userId, token, now, now + getSessionTtlMs());
    res.status(201).json({ token, username });
  });

  app.post("/api/login", (req, res) => {
    const body = req.body || {};
    const username = sanitizeUsername(body.username);
    if (!username || typeof body.password !== "string") {
      return res.status(400).json({ error: "用户名或密码不能为空" });
    }
    const user = store.getUserByUsername(username);
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      return res.status(401).json({ error: "用户名或密码错误" });
    }
    const now = Date.now();
    const token = crypto.randomBytes(32).toString("hex");
    store.createSession(user.id, token, now, now + getSessionTtlMs());
    res.json({ token, username: user.username });
  });

  // 登出幂等:无论会话是否仍有效,都删除(不存在的删除是 no-op)并返回 204,
  // 重复登出不会因为 token 已失效而报 401。
  app.post("/api/logout", (req, res) => {
    const token = bearerToken(req);
    if (token) store.deleteSession(token);
    res.status(204).end();
  });

  app.get("/api/me", auth, (req, res) => {
    res.json({ username: req.username });
  });

  // ---------- 待办 CRUD(按当前用户隔离) ----------

  /**
   * 列出待办。
   *  - 不带 since: 返回全部未删除待办(初始加载)
   *  - 带 since  : 返回 updatedAt 严格大于 since 的变更(含删除墓碑 deleted:true)
   * since 必须是毫秒时间戳(非负安全整数)。
   */
  app.get("/api/todos", auth, (req, res) => {
    const rawSince = req.query.since;
    if (rawSince === undefined) {
      return res.json(store.getTodos(req.userId));
    }
    if (typeof rawSince !== "string" || !/^\d+$/.test(rawSince)) {
      return res.status(400).json({ error: "since 必须是毫秒时间戳(非负整数)" });
    }
    const since = Number(rawSince);
    if (!Number.isSafeInteger(since)) {
      return res.status(400).json({ error: "since 必须是毫秒时间戳(非负整数)" });
    }
    res.json(store.getChangedTodos(req.userId, since));
  });

  app.post("/api/todos", auth, (req, res) => {
    const body = req.body || {};
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return res.status(400).json({ error: "待办内容不能为空" });
    }
    const item = {
      id: typeof body.id === "string" && body.id.trim() ? body.id : core.generateId(),
      text,
      completed: !!body.completed,
      createdAt: Number.isFinite(body.createdAt) ? body.createdAt : Date.now()
    };
    res.status(201).json(store.insertTodo(req.userId, item));
  });

  app.patch("/api/todos/:id", auth, (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (body.text !== undefined) {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) return res.status(400).json({ error: "待办内容不能为空" });
      patch.text = text;
    }
    if (body.completed !== undefined) patch.completed = !!body.completed;
    const updated = store.updateTodo(req.userId, req.params.id, patch);
    if (!updated) return res.status(404).json({ error: "待办不存在" });
    res.json(updated);
  });

  app.delete("/api/todos/:id", auth, (req, res) => {
    const removed = store.deleteTodo(req.userId, req.params.id);
    if (!removed) return res.status(404).json({ error: "待办不存在" });
    res.status(204).end();
  });

  // ---------- 静态文件(阻止访问服务端数据目录) ----------
  app.use((req, res, next) => {
    if (req.path === "/data" || req.path.startsWith("/data/")) {
      return res.status(404).end();
    }
    next();
  });
  app.use(express.static(staticDir));

  return app;
}

/**
 * 启动会话清理:立即执行一次,之后按 intervalMs 周期执行。
 * 定时器调用 unref(),不阻止进程退出。
 */
function startSessionCleanup(store, intervalMs = SESSION_CLEANUP_INTERVAL_MS) {
  if (!store || typeof store.cleanupExpiredSessions !== "function") return null;
  const run = () => {
    try {
      store.cleanupExpiredSessions(Date.now());
    } catch (err) {
      // 清理失败不应影响服务本身,记录后等待下一轮
      console.error("清理过期会话失败:", err);
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return timer;
}

/**
 * 启动服务器。返回 Promise<{ server, app, port }>。
 * options.port 为 0 时监听随机可用端口(便于测试)。
 */
function startServer(options = {}) {
  // 只打开一个数据库连接:先建 store,再交给 createApp 复用
  const store =
    options.store ||
    openDb(options.dbPath || process.env.TODO_DB_PATH || path.join(__dirname, "data", "todo.db"));
  const app = createApp({ ...options, store });
  const cleanupTimer = startSessionCleanup(store);
  let port;
  if (options.port !== undefined) {
    port = options.port;
  } else {
    const envPort = Number(process.env.PORT);
    port = Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_PORT;
  }
  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      resolve({ server, app, port: server.address().port, store, cleanupTimer });
    });
    server.on("error", reject);
  });
}

// 直接执行时启动服务器;被 require 时仅暴露工厂(便于测试)
if (require.main === module) {
  startServer()
    .then(({ port }) => {
      console.log(`todo-web-app server running at http://localhost:${port}`);
    })
    .catch((err) => {
      console.error("启动服务器失败:", err);
      process.exit(1);
    });
}

module.exports = {
  createApp,
  startServer,
  startSessionCleanup,
  hashPassword,
  verifyPassword
};
