"use strict";

/**
 * todo-web-app 多用户后端
 *
 * 技术栈: Node.js + Express + SQLite(内置 node:sqlite)
 *  - 账号: 用户名 + 密码(scrypt 加盐哈希,不存明文)
 *  - 会话: 登录/注册成功后签发不透明 token,通过 HttpOnly cookie(todo_sid)
 *          下发;同时保留 Bearer 头鉴权以兼容 API 客户端
 *  - 数据: 待办项按 userId 隔离; 数据结构与 todo-core.js 保持一致
 */

const path = require("node:path");
const crypto = require("node:crypto");
const express = require("express");
const {
  openDb,
  TodoQuotaExceededError,
  getSessionTtlMs,
  resolveSessionTtlMs,
  DEFAULT_SESSION_TTL_MS,
  MAX_SESSION_TTL_MS
} = require("./lib/db.js");
const core = require("./todo-core.js");

const DEFAULT_PORT = 3000;
const SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000; // 每小时

/**
 * 请求体上限:本应用最大合法载荷是很短的待办文本/凭据,
 * 显式收紧到 16KB,不再沿用 express.json() 默认的 100KB。
 */
const JSON_BODY_LIMIT = "16kb";

const PASSWORD_MIN_LENGTH = 12;
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
 * 校验优先级:只接受 0(低)/1(普通)/2(高)的整数。
 * 不接受字符串或 null,避免 "2" 与 2 混用导致排序/同步语义不一致。
 */
function parsePriority(value) {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    (value !== core.PRIORITIES.LOW &&
      value !== core.PRIORITIES.NORMAL &&
      value !== core.PRIORITIES.HIGH)
  ) {
    return { error: "priority 必须是 0(低)、1(普通)或 2(高)" };
  }
  return { priority: value };
}

/**
 * 允许匿名访问的静态资源(白名单)。
 * 只列出前端页面直接引用的文件;未列出的路径一律 404,不会落到磁盘读取,
 * 因此 server.js、lib/**、test/**、package.json、data/** 等不会被暴露。
 * 新增前端资源时必须显式加入此集合。
 */
const STATIC_ASSETS = new Set([
  "index.html",
  "theme-init.js",
  "style.css",
  "todo-core.js",
  "api.js",
  "todo.js",
]);

/**
 * 全局安全响应头。CSP 采用严格的同源策略:
 *  - script-src/style-src 不含 'unsafe-inline',因此内联脚本/样式必须外提
 *  - frame-ancestors / X-Frame-Options 同时禁止被 iframe 嵌入,防点击劫持
 *  - no-referrer 避免把带查询参数的 URL 泄露给外部站点
 */
const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer"
});

const SESSION_COOKIE_NAME = "todo_sid";

/** 限流默认值:窗口 60s,登录同 IP+用户名 5 次失败,注册同 IP 10 次失败。 */
const RATE_LIMIT_DEFAULTS = Object.freeze({
  enabled: true,
  windowMs: 60 * 1000,
  maxLoginFailures: 5,
  maxRegistrations: 10
});

// 过期会话的定期清理间隔:默认 1 小时
const DEFAULT_SESSION_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** 优雅关闭:等待在途请求排空的最长时间,超时后强制退出。 */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10 * 1000;

/**
 * 排空期间主动回收空闲 keep-alive 连接。
 * Node 的 server.close() 只回收「调用那一刻」空闲的连接;在途请求结束后
 * 变成空闲的连接不会被自动回收,导致 close 回调可能永远不触发。
 * 因此关闭期间定期调用 closeIdleConnections(),保证回调在有限时间内触发。
 */
const DRAIN_SWEEP_INTERVAL_MS = 50;

const SHUTDOWN_SIGNALS = Object.freeze(["SIGTERM", "SIGINT"]);

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

/**
 * 极简 Cookie 解析(不引入 cookie-parser 依赖)。
 * 同名 Cookie 只取第一个;解码失败时保留原始值(视为无效 token 即可)。
 */
function parseCookies(header) {
  const cookies = Object.create(null);
  if (typeof header !== "string" || !header) return cookies;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || name in cookies) continue;
    let value = part.slice(eq + 1).trim();
    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
      value = value.slice(1, -1);
    }
    try {
      value = decodeURIComponent(value);
    } catch (_) {
      // 非法百分号编码:cookie 已是无效 token,保持原样交给鉴权判断
    }
    cookies[name] = value;
  }
  return cookies;
}

function cookieToken(req) {
  const value = parseCookies(req.headers.cookie)[SESSION_COOKIE_NAME];
  return value || null;
}

/** 只信任 TCP 对端地址,不解析 X-Forwarded-For(该头可被客户端伪造)。 */
function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || "unknown";
}

/** 仅在直连 TLS 或代理明确声明 https 时追加 Secure,避免明文部署下 cookie 失效。 */
function isSecureRequest(req) {
  return req.secure === true || req.headers["x-forwarded-proto"] === "https";
}

function serializeSessionCookie(req, value, maxAgeSeconds) {
  let cookie =
    SESSION_COOKIE_NAME +
    "=" +
    value +
    "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" +
    maxAgeSeconds;
  if (isSecureRequest(req)) cookie += "; Secure";
  return cookie;
}

function normalizePositiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function resolveRateLimitConfig(overrides) {
  const src = overrides && typeof overrides === "object" ? overrides : {};
  return {
    enabled: src.enabled === undefined ? RATE_LIMIT_DEFAULTS.enabled : src.enabled !== false,
    windowMs: normalizePositiveInt(src.windowMs, RATE_LIMIT_DEFAULTS.windowMs),
    maxLoginFailures: normalizePositiveInt(
      src.maxLoginFailures,
      RATE_LIMIT_DEFAULTS.maxLoginFailures
    ),
    maxRegistrations: normalizePositiveInt(
      src.maxRegistrations,
      RATE_LIMIT_DEFAULTS.maxRegistrations
    )
  };
}

/**
 * 只记录失败尝试的内存滑动窗口计数器。
 * 每个键保存失败时间戳与过期时间;任何命中都会清理过期键,
 * 因此 Map 的大小受「窗口内的活跃键」限制,不会无限增长。
 */
function createFailureWindow({ windowMs, now }) {
  const buckets = new Map();

  function liveBucket(key) {
    const bucket = buckets.get(key);
    if (!bucket) return undefined;
    const current = now();
    if (bucket.expiresAt <= current) {
      buckets.delete(key);
      return undefined;
    }
    bucket.times = bucket.times.filter((t) => t > current - windowMs);
    if (bucket.times.length === 0) {
      buckets.delete(key);
      return undefined;
    }
    return bucket;
  }

  return {
    /** 返回 { limited, retryAfterMs };达到阈值后到最早一次失败滑出窗口才恢复 */
    check(key, threshold) {
      const bucket = liveBucket(key);
      if (!bucket || bucket.times.length < threshold) {
        return { limited: false, retryAfterMs: 0 };
      }
      return {
        limited: true,
        retryAfterMs: Math.max(0, bucket.times[0] + windowMs - now())
      };
    },
    record(key) {
      const current = now();
      let bucket = liveBucket(key);
      if (!bucket) {
        bucket = { times: [], expiresAt: 0 };
        buckets.set(key, bucket);
      }
      bucket.times.push(current);
      bucket.expiresAt = current + windowMs;
      // 顺带清理其他键的过期项,避免大量一次性键长期占用内存
      if (buckets.size > 1024) {
        for (const [otherKey, other] of buckets) {
          if (other.expiresAt <= current) buckets.delete(otherKey);
        }
      }
    },
    reset(key) {
      buckets.delete(key);
    }
  };
}

function sendRateLimited(res, retryAfterMs) {
  // Retry-After 以秒为单位并向上取整,最少 1 秒
  res.set("Retry-After", String(Math.max(1, Math.ceil(retryAfterMs / 1000))));
  return res.status(429).json({
    error: "操作过于频繁,请稍后再试",
    code: "RATE_LIMITED",
    retryAfterMs
  });
}

function createApp(options = {}) {
  const dbPath =
    options.dbPath || process.env.TODO_DB_PATH || path.join(__dirname, "data", "todo.db");
  // 显式传入时使用之,否则交给 openDb 按环境变量/defaultSessionTtlMs 决定
  const sessionTtlMs =
    options.sessionTtlMs !== undefined ? resolveSessionTtlMs(options.sessionTtlMs) : undefined;
  const store =
    options.store ||
    openDb(dbPath, {
      ...(sessionTtlMs === undefined ? {} : { sessionTtlMs }),
      ...(options.maxTodosPerUser === undefined
        ? {}
        : { maxTodosPerUser: options.maxTodosPerUser })
    });
  const staticDir = options.staticDir || __dirname;
  // 可注入时钟,便于测试会话过期/限流窗口推进而无需真实等待
  const now = typeof options.now === "function" ? options.now : Date.now;
  const rateLimit = resolveRateLimitConfig(options.rateLimit);
  // 登录失败按「IP|用户名」计数,注册失败按 IP 计数
  const loginFailures = createFailureWindow({ windowMs: rateLimit.windowMs, now });
  const registrationFailures = createFailureWindow({ windowMs: rateLimit.windowMs, now });
  // 关闭状态由 startServer/setupGracefulShutdown 注入并共享,
  // 健康检查据此在排空期间返回 503,在途请求计数用于关闭日志。
  const shutdownState =
    options.shutdownState && typeof options.shutdownState === "object"
      ? options.shutdownState
      : createShutdownState();

  const app = express();
  app.locals.store = store;
  app.locals.sessionTtlMs = store.sessionTtlMs || sessionTtlMs;
  app.locals.rateLimit = rateLimit;
  app.locals.shutdownState = shutdownState;

  // 安全响应头必须覆盖 API 与静态资源,因此放在最前面(早于 express.json)。
  app.use((req, res, next) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
      res.setHeader(name, value);
    }
    next();
  });

  // 统计在途请求:finish 与 close 事件只会让计数减一次。
  app.use((req, res, next) => {
    shutdownState.inFlight += 1;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      shutdownState.inFlight = Math.max(0, shutdownState.inFlight - 1);
    };
    res.on("finish", settle);
    res.on("close", settle);
    next();
  });

  app.use(express.json({ limit: JSON_BODY_LIMIT }));

  const sessionTtlSeconds = Math.max(
    1,
    Math.floor((app.locals.sessionTtlMs || DEFAULT_SESSION_TTL_MS) / 1000)
  );

  function issueSessionCookie(req, res, token) {
    res.append("Set-Cookie", serializeSessionCookie(req, token, sessionTtlSeconds));
  }

  // 会话来源:Bearer 头优先(API 客户端/测试),其次 HttpOnly cookie(浏览器)
  function auth(req, res, next) {
    const token = bearerToken(req) || cookieToken(req);
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

  // /healthz 与 /api/health 复用同一 handler;探活真实执行一条 SQL,
  // 数据库不可用时返回 503,而不是固定回 ok。
  // 关闭流程开始后立即返回 503,避免负载均衡在排空期间继续转发流量。
  function healthHandler(req, res) {
    if (shutdownState.shuttingDown) {
      res.set("Connection", "close");
      return res.status(503).json({ ok: false, db: "shutting-down" });
    }
    try {
      store.ping();
    } catch (err) {
      console.error("健康检查失败:", err);
      return res.status(503).json({ ok: false, db: "error" });
    }
    res.json({ ok: true, db: "ok", uptimeMs: Math.round(process.uptime() * 1000) });
  }

  app.get("/healthz", healthHandler);
  app.get("/api/health", healthHandler);

  // ---------- 账号与会话 ----------

  app.post("/api/register", (req, res) => {
    const body = req.body || {};
    const registrationKey = "reg|" + clientIp(req);
    if (rateLimit.enabled) {
      const verdict = registrationFailures.check(registrationKey, rateLimit.maxRegistrations);
      if (verdict.limited) return sendRateLimited(res, verdict.retryAfterMs);
    }
    // 注册失败按同一 IP 计数,防止批量注册/撞库式探测
    const failRegistration = (status, payload) => {
      if (rateLimit.enabled) registrationFailures.record(registrationKey);
      return res.status(status).json(payload);
    };

    const username = sanitizeUsername(body.username);
    if (!username) {
      return failRegistration(400, {
        error: "用户名不合法(1-" + USERNAME_MAX_LENGTH + " 个字符,且不含控制字符)"
      });
    }
    if (!isValidPassword(body.password)) {
      return failRegistration(400, { error: "密码长度至少 " + PASSWORD_MIN_LENGTH + " 位" });
    }
    if (store.getUserByUsername(username)) {
      return failRegistration(409, { error: "用户名已存在" });
    }
    const createdAt = now();
    const userId = store.createUser(username, hashPassword(body.password), createdAt);
    const token = crypto.randomBytes(32).toString("hex");
    const session = store.createSession(userId, token, createdAt);
    if (rateLimit.enabled) registrationFailures.reset(registrationKey);
    issueSessionCookie(req, res, token);
    res.status(201).json({ token, username, expiresAt: session.expiresAt });
  });

  app.post("/api/login", (req, res) => {
    const body = req.body || {};
    const username = sanitizeUsername(body.username);
    if (!username || typeof body.password !== "string") {
      return res.status(400).json({ error: "用户名或密码不能为空" });
    }
    const failureKey = clientIp(req) + "|" + username;
    if (rateLimit.enabled) {
      const verdict = loginFailures.check(failureKey, rateLimit.maxLoginFailures);
      if (verdict.limited) return sendRateLimited(res, verdict.retryAfterMs);
    }
    const user = store.getUserByUsername(username);
    if (!user || !verifyPassword(body.password, user.password_hash)) {
      // 只有失败尝试计入窗口;成功登录会在下面清零,避免正常用户被误伤
      if (rateLimit.enabled) loginFailures.record(failureKey);
      return res.status(401).json({ error: "用户名或密码错误" });
    }
    if (rateLimit.enabled) loginFailures.reset(failureKey);
    const createdAt = now();
    const token = crypto.randomBytes(32).toString("hex");
    const session = store.createSession(user.id, token, createdAt);
    issueSessionCookie(req, res, token);
    res.json({ token, username: user.username, expiresAt: session.expiresAt });
  });

  // 登出幂等:无论会话是否仍有效,都删除(不存在的删除是 no-op)并返回 204,
  // 重复登出不会因为 token 已失效而报 401。
  app.post("/api/logout", (req, res) => {
    const token = bearerToken(req) || cookieToken(req);
    if (token) store.deleteSession(token);
    // 无论请求是否携带 cookie,都下发清除指令,确保浏览器端会话彻底结束
    res.append("Set-Cookie", serializeSessionCookie(req, "", 0));
    res.status(204).end();
  });

  app.get("/api/me", auth, (req, res) => {
    res.json({ username: req.username });
  });

  // ---------- 待办 CRUD(按当前用户隔离) ----------

  /**
   * 列出待办。
   *  - 不带 q/since: 返回全部未删除待办(初始加载)
   *  - 带 q       : 返回 text 包含关键字的未删除待办(英文大小写不敏感)
   *  - 带 since   : 返回 updatedAt 严格大于 since 的变更(含删除墓碑 deleted:true)
   *
   * q 与 since 互斥,同时出现返回 400:q 用于全量检索,since 用于增量同步。
   * since 模式需要返回墓碑和改名后的变更,叠加关键字过滤会让客户端漏掉
   * 已不再命中关键字的旧结果,破坏同步语义。
   * 空关键字或纯空白等价于不传 q;超过 TODO_TEXT_MAX_LENGTH 的关键字返回 400
   * (不截断,避免截断后产生假命中)。
   * since 必须是毫秒时间戳(非负安全整数)。
   */
  app.get("/api/todos", auth, (req, res) => {
    const rawKeyword = req.query.q;
    let keyword; // undefined 表示不检索
    if (rawKeyword !== undefined) {
      // 重复 q 会被解析成数组;拒绝而非任取一个,避免检索语义歧义
      if (typeof rawKeyword !== "string") {
        return res.status(400).json({ error: "q 必须是单个字符串" });
      }
      const trimmed = rawKeyword.trim();
      if (trimmed.length > TODO_TEXT_MAX_LENGTH) {
        return res.status(400).json({
          error: "搜索关键字最多 " + TODO_TEXT_MAX_LENGTH + " 个字符"
        });
      }
      if (trimmed) keyword = trimmed;
    }

    const rawSince = req.query.since;
    if (rawSince !== undefined) {
      if (keyword !== undefined) {
        return res.status(400).json({
          error: "q 与 since 不能同时使用:q 用于全量检索,since 用于增量同步"
        });
      }
      if (typeof rawSince !== "string" || !/^\d+$/.test(rawSince)) {
        return res.status(400).json({ error: "since 必须是毫秒时间戳(非负整数)" });
      }
      const since = Number(rawSince);
      if (!Number.isSafeInteger(since)) {
        return res.status(400).json({ error: "since 必须是毫秒时间戳(非负整数)" });
      }
      return res.json(store.getChangedTodos(req.userId, since));
    }

    if (keyword !== undefined) {
      return res.json(store.searchTodos(req.userId, keyword));
    }
    res.json(store.getTodos(req.userId));
  });

  app.post("/api/todos", auth, (req, res) => {
    const body = req.body || {};
    const parsed = parseTodoText(body.text);
    if (parsed.error) {
      return res.status(400).json({ error: parsed.error });
    }
    // 未提供 priority 时按「普通」创建(与旧数据迁移默认值一致)。
    let priority = core.DEFAULT_PRIORITY;
    if (body.priority !== undefined) {
      const parsedPriority = parsePriority(body.priority);
      if (parsedPriority.error) {
        return res.status(400).json({ error: parsedPriority.error });
      }
      priority = parsedPriority.priority;
    }
    // id 与 createdAt 完全由服务端生成:客户端传入的同名字段一律忽略,
    // 避免伪造 id 覆盖已有数据或伪造创建时间。
    const item = {
      id: crypto.randomUUID(),
      text: parsed.text,
      completed: !!body.completed,
      priority,
      createdAt: now()
    };
    try {
      res.status(201).json(store.insertTodo(req.userId, item));
    } catch (err) {
      if (err instanceof TodoQuotaExceededError) {
        return res.status(409).json({
          error: err.message,
          code: err.code,
          limit: err.limit
        });
      }
      throw err;
    }
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
    if (body.priority !== undefined) {
      const parsedPriority = parsePriority(body.priority);
      if (parsedPriority.error) {
        return res.status(400).json({ error: parsedPriority.error });
      }
      patch.priority = parsedPriority.priority;
    }
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

  // ---------- 统一 JSON 错误响应 ----------
  // express.json() 在进入路由前解析失败时,默认会返回 HTML 错误页;
  // 前端统一按 JSON 解析响应,这里把解析器的错误也转成 JSON。
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err && err.type === "entity.too.large") {
      return res.status(413).json({
        error: "请求体过大,最大允许 " + JSON_BODY_LIMIT,
        code: "PAYLOAD_TOO_LARGE"
      });
    }
    if (err && err.type === "entity.parse.failed") {
      return res.status(400).json({
        error: "请求体不是合法的 JSON",
        code: "INVALID_JSON"
      });
    }
    console.error("未处理的错误:", err);
    res.status(500).json({ error: "服务器内部错误", code: "INTERNAL_ERROR" });
  });

  return app;
}

/**
 * 关闭状态。由 createApp 共享给健康检查与在途请求计数:
 *  - shuttingDown: 关闭流程是否已开始(健康检查据此返回 503)
 *  - inFlight:     当前在途请求数(关闭日志据此记录排空情况)
 */
function createShutdownState() {
  return { shuttingDown: false, inFlight: 0 };
}

/** 把任意输入规范化为合法的关闭超时;非法值(非正整数)回退默认 10000ms。 */
function resolveShutdownTimeoutMs(value) {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) return DEFAULT_SHUTDOWN_TIMEOUT_MS;
  return n;
}

/** 从环境变量读取 SHUTDOWN_TIMEOUT_MS,非法值回退默认。 */
function readShutdownTimeoutMs(env = process.env) {
  return resolveShutdownTimeoutMs(env && env.SHUTDOWN_TIMEOUT_MS);
}

/** 单行 JSON 结构化日志;序列化/写入失败不得中断关闭流程。 */
function logShutdownEvent(logger, payload) {
  try {
    logger.log(JSON.stringify(payload));
  } catch (_) {
    /* 日志失败不影响关闭 */
  }
}

/**
 * 优雅关闭控制器(可测试,不直接挂信号)。
 *
 * beginClose() 的顺序:
 *   1. 标记 shuttingDown(健康检查立刻 503),记录起始状态
 *   2. server.close() 停止接收新连接,并由回调等待在途请求结束
 *   3. 排空期间定期回收空闲 keep-alive 连接,保证回调能在有限时间内触发
 *   4. 排空完成(或超时)后:关闭 SQLite 连接 → 清理定时器 → 打印一行结构化日志
 *
 * 幂等:重复调用 beginClose() 返回同一个 Promise;finish() 只执行一次。
 *
 * options:
 *  - server/store/cleanupTimer/shutdownState: 受管资源
 *  - timeoutMs: 排空超时,缺省读 SHUTDOWN_TIMEOUT_MS,再缺省 10000
 *  - logger: 默认 console;exit: 默认 process.exit(仅 forceExit 使用)
 *  - now: 可注入时钟(测试用)
 */
function createShutdownController(options = {}) {
  const server = options.server;
  const store = options.store;
  const cleanupTimer = options.cleanupTimer;
  const shutdownState =
    options.shutdownState && typeof options.shutdownState === "object"
      ? options.shutdownState
      : createShutdownState();
  const logger = options.logger || console;
  const now = typeof options.now === "function" ? options.now : Date.now;
  const timeoutMs = resolveShutdownTimeoutMs(
    options.timeoutMs !== undefined ? options.timeoutMs : readShutdownTimeoutMs()
  );
  const exit =
    typeof options.exit === "function" ? options.exit : (code) => process.exit(code);

  let started = false;
  let finished = false;
  let storeClosed = false;
  let drainPromise = null;
  let timeoutTimer = null;
  let sweepTimer = null;
  let startedAt = 0;
  let inFlightAtStart = 0;
  let signalName = null;
  let summary = null;

  function clearTimers() {
    if (timeoutTimer) {
      clearTimeout(timeoutTimer);
      timeoutTimer = null;
    }
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
  }

  function closeStore() {
    if (storeClosed) return;
    storeClosed = true;
    if (!store || typeof store.close !== "function") return;
    try {
      store.close();
    } catch (err) {
      // 关闭数据库失败不应阻塞进程退出,记录后继续
      try {
        logger.error("关闭数据库连接失败:", err);
      } catch (_) {
        /* 忽略日志失败 */
      }
    }
  }

  function sweepIdleConnections() {
    if (typeof server.closeIdleConnections !== "function") return;
    try {
      server.closeIdleConnections();
    } catch (_) {
      /* 回收失败交给超时兜底 */
    }
  }

  /** 完成(或超时强制完成)关闭:释放资源并打印一行结构化日志。 */
  function finish(forced) {
    if (finished) return summary;
    finished = true;
    clearTimers();
    if (cleanupTimer) clearInterval(cleanupTimer);
    // 顺序要求:先等待请求结束,再关闭数据库连接,最后清理定时器。
    closeStore();

    const elapsedMs = started ? Math.max(0, now() - startedAt) : 0;
    summary = {
      forced: !!forced,
      exitCode: forced ? 1 : 0,
      signal: signalName,
      inFlightAtStart,
      drainedRequests: Math.max(0, inFlightAtStart - shutdownState.inFlight),
      inFlightRemaining: shutdownState.inFlight,
      elapsedMs
    };
    logShutdownEvent(logger, {
      event: forced ? "server_shutdown_forced" : "server_shutdown_complete",
      reason: forced ? "timeout" : "drained",
      signal: signalName,
      forced: !!forced,
      exitCode: summary.exitCode,
      inFlightAtStart,
      drainedRequests: summary.drainedRequests,
      inFlightRemaining: summary.inFlightRemaining,
      elapsedMs,
      timeoutMs
    });
    return summary;
  }

  /**
   * 开始关闭(幂等)。返回 Promise<summary>,不会调用 process.exit,
   * 便于测试与库调用;进程退出由 setupGracefulShutdown 决定。
   */
  function beginClose(meta = {}) {
    if (drainPromise) return drainPromise;
    started = true;
    signalName = meta.signal || null;
    startedAt = now();
    inFlightAtStart = shutdownState.inFlight;
    shutdownState.shuttingDown = true;

    drainPromise = new Promise((resolve) => {
      const settle = (forced) => resolve(finish(forced));

      timeoutTimer = setTimeout(() => settle(true), timeoutMs);
      // 超时定时器不单独维持事件循环;排空期间由连接保持进程存活
      if (typeof timeoutTimer.unref === "function") timeoutTimer.unref();

      if (!server || server.listening === false) {
        // 未监听或已关闭:没有连接需要排空
        settle(false);
        return;
      }
      try {
        server.close(() => settle(false));
      } catch (_) {
        settle(false);
        return;
      }
      sweepIdleConnections();
      sweepTimer = setInterval(sweepIdleConnections, DRAIN_SWEEP_INTERVAL_MS);
      if (typeof sweepTimer.unref === "function") sweepTimer.unref();
    });
    return drainPromise;
  }

  function isClosing() {
    return started;
  }

  /**
   * 立即强制退出:不等待排空。用于超时兜底与重复信号,
   * 只打印一行结构化日志后调用 exit,不会抛出未捕获异常。
   */
  function forceExit(code, reason) {
    const exitCode = Number.isSafeInteger(code) ? code : 1;
    const elapsedMs = started ? Math.max(0, now() - startedAt) : 0;
    logShutdownEvent(logger, {
      event: "server_shutdown_forced",
      reason: reason || "forced",
      signal: signalName,
      exitCode,
      elapsedMs,
      inFlightRemaining: shutdownState.inFlight
    });
    exit(exitCode);
  }

  return {
    state: shutdownState,
    timeoutMs,
    isClosing,
    beginClose,
    forceExit
  };
}

/**
 * 把 SIGTERM/SIGINT 接到同一关闭流程(仅 require.main === module 时挂载):
 *  - 第一个信号:开始排空,完成日志后以退出码 0 退出;超时则以 1 退出
 *  - 第二个信号:立即强制退出(退出码 1),不重复进入关闭流程、不抛异常
 */
function setupGracefulShutdown(options = {}) {
  const proc = options.proc || process;
  const logger = options.logger || console;
  const signals =
    Array.isArray(options.signals) && options.signals.length > 0
      ? options.signals
      : SHUTDOWN_SIGNALS;
  const timeoutMs = resolveShutdownTimeoutMs(
    options.timeoutMs !== undefined ? options.timeoutMs : readShutdownTimeoutMs()
  );
  const exit =
    typeof options.exit === "function" ? options.exit : (code) => proc.exit(code);

  const controller = createShutdownController({
    server: options.server,
    store: options.store,
    cleanupTimer: options.cleanupTimer,
    shutdownState: options.shutdownState,
    timeoutMs,
    logger,
    now: options.now,
    exit
  });

  let exiting = false;
  let signalReceived = false;

  /**
   * 先等 stdout 刷新再退出:管道模式下 console.log 是异步写,
   * 直接 process.exit 可能丢掉最后一行结构化日志。
   */
  function exitWhenFlushed(code) {
    if (exiting) return;
    exiting = true;
    const stdout = proc.stdout;
    if (!stdout || stdout.destroyed || typeof stdout.write !== "function") {
      exit(code);
      return;
    }
    let done = false;
    const finishExit = () => {
      if (done) return;
      done = true;
      exit(code);
    };
    try {
      // 空写排在已有日志之后,回调触发说明之前的输出已刷出
      stdout.write("", finishExit);
    } catch (_) {
      finishExit();
      return;
    }
    // 兜底:回调异常缺失时也不能让进程永远不退出
    const fallback = setTimeout(finishExit, 1000);
    if (typeof fallback.unref === "function") fallback.unref();
  }

  function handleSignal(signal) {
    if (signalReceived) {
      // 第二次信号:立即强制退出,不等待排空、不重复进入关闭流程
      controller.forceExit(1, "second_signal");
      return;
    }
    signalReceived = true;
    logShutdownEvent(logger, {
      event: "server_shutdown_started",
      signal,
      timeoutMs,
      inFlight: controller.state.inFlight
    });
    controller.beginClose({ signal }).then(
      (summary) => exitWhenFlushed(summary.forced ? 1 : 0),
      (err) => {
        try {
          logger.error("优雅关闭失败:", err && err.stack ? err.stack : err);
        } catch (_) {
          /* 忽略日志失败 */
        }
        controller.forceExit(1, "shutdown_error");
      }
    );
  }

  const handlers = new Map();
  for (const signal of signals) {
    const handler = () => handleSignal(signal);
    handlers.set(signal, handler);
    proc.on(signal, handler);
  }

  return {
    controller,
    handleSignal,
    dispose() {
      for (const [signal, handler] of handlers) proc.removeListener(signal, handler);
      handlers.clear();
    }
  };
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
 * 启动服务器。返回 Promise<{ server, app, port, store, cleanupTimer, close }>。
 * options.port 为 0 时监听随机可用端口(便于测试)。
 * options.cleanupIntervalMs 可覆盖过期会话清理间隔(测试或运维调优用)。
 * options.shutdownTimeoutMs 可覆盖优雅关闭的排空超时(默认 SHUTDOWN_TIMEOUT_MS / 10000)。
 *
 * close() 执行与信号触发的同一套关闭流程,但不调用 process.exit:
 * 停止接收新连接 → 等待在途请求 → 关闭 SQLite 连接 → 清理定时器,
 * 返回 Promise<summary>。原有的 server/app/port/store/cleanupTimer 字段保持不变,
 * 因此现有测试里的 server.close(cb) 用法仍然有效。
 */
function startServer(options = {}) {
  // 只打开一个数据库连接:先建 store,再交给 createApp 复用
  const store =
    options.store ||
    openDb(
      options.dbPath || process.env.TODO_DB_PATH || path.join(__dirname, "data", "todo.db"),
      {
        ...(options.sessionTtlMs !== undefined ? { sessionTtlMs: options.sessionTtlMs } : {}),
        ...(options.maxTodosPerUser !== undefined
          ? { maxTodosPerUser: options.maxTodosPerUser }
          : {})
      }
    );
  const shutdownState = createShutdownState();
  const app = createApp({ ...options, store, shutdownState });
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
      const shutdownController = createShutdownController({
        server,
        store,
        cleanupTimer,
        shutdownState,
        logger: options.logger || console,
        timeoutMs:
          options.shutdownTimeoutMs !== undefined
            ? options.shutdownTimeoutMs
            : readShutdownTimeoutMs()
      });
      resolve({
        server,
        app,
        port: server.address().port,
        store,
        cleanupTimer,
        shutdownState,
        shutdownController,
        close: () => shutdownController.beginClose()
      });
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
    .then(({ port, server, store, cleanupTimer, shutdownState }) => {
      console.log(`todo-web-app server running at http://localhost:${port}`);
      // 只有真实进程才挂信号处理,测试里直接 startServer() 不会被信号影响
      setupGracefulShutdown({
        server,
        store,
        cleanupTimer,
        shutdownState,
        timeoutMs: readShutdownTimeoutMs(),
        logger: console
      });
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
  createShutdownState,
  createShutdownController,
  setupGracefulShutdown,
  resolveShutdownTimeoutMs,
  readShutdownTimeoutMs,
  hashPassword,
  verifyPassword,
  JSON_BODY_LIMIT,
  DEFAULT_SESSION_TTL_MS,
  MAX_SESSION_TTL_MS,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  resolveSessionTtlMs
};
