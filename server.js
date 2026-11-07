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
const {
  openDb,
  getSessionTtlMs,
  resolveSessionTtlMs,
  DEFAULT_SESSION_TTL_MS,
  MAX_SESSION_TTL_MS
} = require("./lib/db.js");
const core = require("./todo-core.js");

const DEFAULT_PORT = 3000;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 每小时

const PASSWORD_MIN_LENGTH = 6;
const USERNAME_MAX_LENGTH = 50;
// 与前端输入框的 maxlength 保持一致;服务端必须独立校验,不能依赖前端限制
const TODO_TEXT_MAX_LENGTH = 200;

/**
 * 校验并清洗待办文本。
 * 返回 { text } 或 { error }。长度按 trim 后的 UTF-16 码元计算,
 * 与浏览器 maxlength 的计量方式一致。
 */
function parseTodoText(value) {
  if (typeof value !== "string") {
    return { error: "待办内容不能为空" };
  }
  const text = value.trim();
  if (!text) {
    return { error: "待办内容不能为空" };
  }
  if (text.length > TODO_TEXT_MAX_LENGTH) {
    return { error: "待办内容最多 " + TODO_TEXT_MAX_LENGTH + " 个字符" };
  }
  return { text };
}

/**
 * 允许匿名访问的静态资源(白名单)。
 * 只列出前端页面直接引用的文件;未列出的路径一律 404,不会落到磁盘读取,
 * 因此 server.js、lib/**、test/**、package.json、data/** 等不会被暴露。
 * 新增前端资源时必须显式加入此集合。
 */
const STATIC_ASSETS = new Set([
  "index.html",
  "style.css",
  "todo-core.js",
  "api.js",
  "todo.js",
]);

// 过期会话的定期清理间隔:默认 1 小时
const DEFAULT_SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

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
  // 显式传入时使用之,否则交给 openDb 按环境变量/defaultSessionTtlMs 决定
  const sessionTtlMs =
    options.sessionTtlMs !== undefined ? resolveSessionTtlMs(options.sessionTtlMs) : undefined;
  const store = options.store || openDb(dbPath, sessionTtlMs === undefined ? {} : { sessionTtlMs });
  const staticDir = options.staticDir || __dirname;
  // 可注入时钟,便于测试会话过期而无需真实等待
  const now = typeof options.now === "function" ? options.now : Date.now;

  const app = express();
  app.locals.store = store;
  app.locals.sessionTtlMs = store.sessionTtlMs || sessionTtlMs;
  app.use(express.json());

  // 从 Bearer token 解析当前用户;过期/无效 token 一并清理
  function auth(req, res, next) {
    const token = bearerToken(req);
    const user = token ? store.getUserByToken(token, now()) : undefined;
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
    const createdAt = now();
    const userId = store.createUser(username, hashPassword(body.password), createdAt);
    const token = crypto.randomBytes(32).toString("hex");
    const session = store.createSession(userId, token, createdAt);
    res.status(201).json({ token, username, expiresAt: session.expiresAt });
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
    const createdAt = now();
    const token = crypto.randomBytes(32).toString("hex");
    const session = store.createSession(user.id, token, createdAt);
    res.json({ token, username: user.username, expiresAt: session.expiresAt });
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
    const parsed = parseTodoText(body.text);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }
    // id 与 createdAt 完全由服务端生成:客户端传入的同名字段一律忽略,
    // 避免伪造 id 覆盖已有数据或伪造创建时间。
    const item = {
      id: crypto.randomUUID(),
      text: parsed.text,
      completed: !!body.completed,
      createdAt: now()
    };
    res.status(201).json(store.insertTodo(req.userId, item));
  });

  app.patch("/api/todos/:id", auth, (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (body.text !== undefined) {
      const parsed = parseTodoText(body.text);
      if (parsed.error) return res.status(400).json({ error: parsed.error });
      patch.text = parsed.text;
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

  // ---------- 静态文件(仅托管白名单内的前端资源) ----------
  // 采用白名单而非排除法: 不在 STATIC_ASSETS 中的路径直接 404,
  // express.static 永远看不到它们,后续新增的源码/测试/配置文件默认不暴露。
  // 不能直接 express.static(__dirname),否则 server.js、lib/、test/、
  // package.json、.git/、data/ 等敏感文件都可被直接下载。
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let pathname;
    try {
      pathname = decodeURIComponent(req.path);
    } catch (_) {
      return res.status(400).end();
    }
    // 只允许根级白名单文件; "/" 由 express.static 映射到 index.html。
    // 子目录、隐藏文件及任何编码/路径穿越变体一律 404。
    if (pathname !== "/" && !STATIC_ASSETS.has(pathname.slice(1))) {
      return res.status(404).end();
    }
    next();
  });
  app.use(express.static(staticDir, { index: "index.html", dotfiles: "deny", redirect: false }));

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
 * options.cleanupIntervalMs 可覆盖过期会话清理间隔(测试或运维调优用)。
 */
function startServer(options = {}) {
  // 只打开一个数据库连接:先建 store,再交给 createApp 复用
  const store =
    options.store ||
    openDb(
      options.dbPath || process.env.TODO_DB_PATH || path.join(__dirname, "data", "todo.db"),
      options.sessionTtlMs !== undefined ? { sessionTtlMs: options.sessionTtlMs } : {}
    );
  const app = createApp({ ...options, store });
  // 可注入时钟,便于测试会话过期而无需真实等待
  const clock = typeof options.now === "function" ? options.now : Date.now;
  let port;
  if (options.port !== undefined) {
    port = options.port;
  } else {
    const envPort = Number(process.env.PORT);
    port = Number.isFinite(envPort) && envPort > 0 ? envPort : DEFAULT_PORT;
  }

  const cleanupIntervalMs =
    Number.isSafeInteger(options.cleanupIntervalMs) && options.cleanupIntervalMs > 0
      ? options.cleanupIntervalMs
      : DEFAULT_SESSION_CLEANUP_INTERVAL_MS;

  // 启动时先清理一次历史过期会话,之后定期清理,避免 sessions 表无限增长
  const supportsCleanup = typeof store.deleteExpiredSessions === "function";
  const cleanup = () => {
    if (!supportsCleanup) return;
    try {
      store.deleteExpiredSessions(clock());
    } catch (err) {
      console.error("清理过期会话失败:", err);
    }
  };
  cleanup();
  const cleanupTimer = setInterval(cleanup, cleanupIntervalMs);
  // 不阻止进程退出(测试里尤其重要)
  if (typeof cleanupTimer.unref === "function") cleanupTimer.unref();

  return new Promise((resolve, reject) => {
    const server = app.listen(port, () => {
      const clearCleanup = () => clearInterval(cleanupTimer);
      server.once("close", clearCleanup);
      resolve({ server, app, port: server.address().port, store, cleanupTimer });
    });
    server.on("error", (err) => {
      clearInterval(cleanupTimer);
      reject(err);
    });
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
  verifyPassword,
  DEFAULT_SESSION_TTL_MS,
  MAX_SESSION_TTL_MS,
  resolveSessionTtlMs
};
