"use strict";

/**
 * 安全专项测试(P0-1 认证限流/密码强度,P0-2 cookie 会话/安全响应头)。
 *
 * 限流用注入的假时钟推进窗口,不真实等待;所有服务器使用独立临时 SQLite。
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { startServer, createApp } = require("../server.js");

const rootDir = path.join(__dirname, "..");
const PASSWORD = "secret1234567";
const WINDOW_MS = 60_000;

function makeDbPath(tag) {
  return path.join(os.tmpdir(), `todo-security-${tag}-${process.pid}-${Date.now()}.db`);
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

function postJson(base, pathname, body, headers = {}) {
  return fetch(base + pathname, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

function registerAt(base, username, password = PASSWORD, headers = {}) {
  return postJson(base, "/api/register", { username, password }, headers);
}

function loginAt(base, username, password = PASSWORD, headers = {}) {
  return postJson(base, "/api/login", { username, password }, headers);
}

/** 取出响应里 todo_sid 的值 */
function sessionCookieValue(res) {
  const cookie = (res.headers.getSetCookie() || []).find((c) => c.startsWith("todo_sid="));
  assert.ok(cookie, "响应应下发 todo_sid cookie");
  return cookie.split(";")[0].slice("todo_sid=".length);
}

let clock = 1_000_000;
let rlDb;
let rlServer;
let rlBase;

let secDb;
let secServer;
let secBase;

before(async () => {
  rlDb = makeDbPath("ratelimit");
  const rl = await startServer({
    dbPath: rlDb,
    port: 0,
    staticDir: rootDir,
    now: () => clock,
    // 显式覆盖,证明 createApp 支持 rateLimit 配置;数值与默认一致
    rateLimit: {
      enabled: true,
      windowMs: WINDOW_MS,
      maxLoginFailures: 5,
      maxRegistrations: 10
    }
  });
  rlServer = rl.server;
  rlBase = `http://127.0.0.1:${rl.port}`;

  secDb = makeDbPath("headers");
  const sec = await startServer({ dbPath: secDb, port: 0, staticDir: rootDir });
  secServer = sec.server;
  secBase = `http://127.0.0.1:${sec.port}`;
});

after(async () => {
  await new Promise((resolve) => rlServer.close(resolve));
  await new Promise((resolve) => secServer.close(resolve));
  cleanupFiles(rlDb);
  cleanupFiles(secDb);
});

/* ---------- P0-1:登录失败限流 ---------- */

test("连续 5 次错误密码后,第 6 次登录返回 429 且带 Retry-After", async () => {
  const reg = await registerAt(rlBase, "rl_a");
  assert.equal(reg.status, 201);

  for (let i = 0; i < 5; i++) {
    const res = await loginAt(rlBase, "rl_a", "wrong-password-1");
    assert.equal(res.status, 401, `第 ${i + 1} 次失败应为 401`);
  }

  const limited = await loginAt(rlBase, "rl_a", "wrong-password-1");
  assert.equal(limited.status, 429);
  const body = await limited.json();
  assert.equal(body.code, "RATE_LIMITED");
  assert.ok(body.retryAfterMs > 0 && body.retryAfterMs <= WINDOW_MS);
  const retryAfter = Number(limited.headers.get("retry-after"));
  assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, "Retry-After 应为正整数秒");

  // 窗口内即使密码正确也拒绝,避免绕过计数继续爆破
  const correct = await loginAt(rlBase, "rl_a");
  assert.equal(correct.status, 429);
});

test("假时钟推进窗口后限流解除", async () => {
  clock += WINDOW_MS + 1;
  const res = await loginAt(rlBase, "rl_a");
  assert.equal(res.status, 200, "窗口滑过后应恢复正常登录");
});

test("成功登录会清零失败计数", async () => {
  assert.equal((await registerAt(rlBase, "rl_b")).status, 201);

  for (let i = 0; i < 4; i++) {
    assert.equal((await loginAt(rlBase, "rl_b", "wrong-password-1")).status, 401);
  }
  assert.equal((await loginAt(rlBase, "rl_b")).status, 200, "第 5 次用正确密码应成功");

  // 成功登录已清零:再失败 2 次仍未达到阈值,应是 401 而不是 429
  for (let i = 0; i < 2; i++) {
    assert.equal((await loginAt(rlBase, "rl_b", "wrong-password-1")).status, 401);
  }
  assert.equal((await loginAt(rlBase, "rl_b", "wrong-password-1")).status, 401);
});

test("注册失败按同 IP 计数,达到阈值后返回 429", async () => {
  assert.equal((await registerAt(rlBase, "dup_user")).status, 201);

  for (let i = 0; i < 10; i++) {
    const res = await registerAt(rlBase, "dup_user");
    assert.equal(res.status, 409, `第 ${i + 1} 次重复注册应为 409`);
  }
  const limited = await registerAt(rlBase, "dup_user");
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, "RATE_LIMITED");
});

test("密码强度:6 位 / 11 位注册返回 400,12 位通过", async () => {
  assert.equal((await registerAt(secBase, "pw6", "123456")).status, 400);
  assert.equal((await registerAt(secBase, "pw11", "12345678901")).status, 400);
  assert.equal((await registerAt(secBase, "pw12", "123456789012")).status, 201);
});

test("rateLimit 配置可覆盖(更小阈值立即生效)", async () => {
  const dbPath = makeDbPath("override");
  let fakeNow = 2_000_000;
  const started = await startServer({
    dbPath,
    port: 0,
    staticDir: rootDir,
    now: () => fakeNow,
    rateLimit: { windowMs: 30_000, maxLoginFailures: 2, maxRegistrations: 3 }
  });
  const base = `http://127.0.0.1:${started.port}`;
  try {
    assert.equal((await registerAt(base, "custom_user")).status, 201);
    assert.equal((await loginAt(base, "custom_user", "wrong-password-1")).status, 401);
    assert.equal((await loginAt(base, "custom_user", "wrong-password-1")).status, 401);
    const limited = await loginAt(base, "custom_user", "wrong-password-1");
    assert.equal(limited.status, 429);
    assert.ok((await limited.json()).retryAfterMs <= 30_000);

    // 独立窗口推进后恢复
    fakeNow += 30_001;
    assert.equal((await loginAt(base, "custom_user")).status, 200);
  } finally {
    await new Promise((resolve) => started.server.close(resolve));
    cleanupFiles(dbPath);
  }
});

/* ---------- P0-2:cookie 会话 ---------- */

test("登录响应下发 HttpOnly / SameSite=Lax 的会话 cookie", async () => {
  assert.equal((await registerAt(secBase, "cookie_user")).status, 201);
  const res = await loginAt(secBase, "cookie_user");
  assert.equal(res.status, 200);

  const cookie = (res.headers.getSetCookie() || []).find((c) => c.startsWith("todo_sid="));
  assert.ok(cookie, "应下发 todo_sid");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=\d+/);
  assert.doesNotMatch(cookie, /Secure/, "明文 HTTP 下不应标记 Secure");
});

test("https 场景(反向代理声明)下会话 cookie 追加 Secure", async () => {
  const res = await loginAt(secBase, "cookie_user", PASSWORD, { "x-forwarded-proto": "https" });
  assert.equal(res.status, 200);
  const cookie = (res.headers.getSetCookie() || []).find((c) => c.startsWith("todo_sid="));
  assert.ok(cookie);
  assert.match(cookie, /; Secure$/);
});

test("只带 cookie、不带 Authorization 也能访问 /api/me 与 /api/todos", async () => {
  const login = await loginAt(secBase, "cookie_user");
  const value = sessionCookieValue(login);
  const headers = { Cookie: `todo_sid=${value}` };

  const me = await fetch(secBase + "/api/me", { headers });
  assert.equal(me.status, 200);
  assert.equal((await me.json()).username, "cookie_user");

  const todos = await fetch(secBase + "/api/todos", { headers });
  assert.equal(todos.status, 200);
  assert.ok(Array.isArray(await todos.json()));
});

test("登出后旧 cookie 访问 /api/me 返回 401", async () => {
  const login = await loginAt(secBase, "cookie_user");
  const value = sessionCookieValue(login);
  const headers = { Cookie: `todo_sid=${value}` };

  const logout = await fetch(secBase + "/api/logout", { method: "POST", headers });
  assert.equal(logout.status, 204);
  const clearCookie = (logout.headers.getSetCookie() || []).find((c) =>
    c.startsWith("todo_sid=")
  );
  assert.ok(clearCookie);
  assert.match(clearCookie, /Max-Age=0/);

  const me = await fetch(secBase + "/api/me", { headers });
  assert.equal(me.status, 401, "登出后旧 cookie 必须失效");
});

/* ---------- P0-2:安全响应头与 CSP ---------- */

test("GET / 返回全局安全响应头", async () => {
  const res = await fetch(secBase + "/");
  assert.equal(res.status, 200);

  const csp = res.headers.get("content-security-policy");
  assert.ok(csp, "应设置 Content-Security-Policy");
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /style-src 'self'/);
  assert.match(csp, /img-src 'self' data:/);
  assert.match(csp, /connect-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.match(csp, /frame-ancestors 'none'/);

  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.equal(res.headers.get("referrer-policy"), "no-referrer");
});

test("API 响应同样带安全响应头", async () => {
  const res = await fetch(secBase + "/api/health");
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.equal(res.headers.get("x-frame-options"), "DENY");
  assert.ok(res.headers.get("content-security-policy"));
});

test("index.html 不含内联脚本与内联事件处理器,主题脚本已外提", async () => {
  const html = fs.readFileSync(path.join(rootDir, "index.html"), "utf8");

  const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
  assert.ok(scriptTags.length > 0);
  for (const tag of scriptTags) {
    assert.match(tag, /\bsrc=/, `内联脚本会被 CSP 拦截: ${tag}`);
  }
  assert.doesNotMatch(html, /\son[a-z]+\s*=/i, "不应存在 onclick= 等内联事件属性");

  assert.match(html, /<script src="theme-init\.js"><\/script>/);
  const themeScript = await fetch(secBase + "/theme-init.js");
  assert.equal(themeScript.status, 200);
  assert.match(await themeScript.text(), /todo-app\.theme/);
});

/* ---------- P0-4:健康检查 ---------- */

test("/healthz 探活成功返回 200 与 db:ok", async () => {
  const res = await fetch(secBase + "/healthz");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.db, "ok");
  assert.ok(Number.isFinite(body.uptimeMs) && body.uptimeMs >= 0);
});

test("/api/health 保留且仍返回 ok:true", async () => {
  const res = await fetch(secBase + "/api/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.db, "ok");
});

test("/healthz 在数据库探活失败时返回 503", async () => {
  const app = createApp({
    staticDir: rootDir,
    store: {
      sessionTtlMs: 1000,
      ping() {
        throw new Error("db unavailable");
      }
    }
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(res.status, 503);
    assert.deepEqual(await res.json(), { ok: false, db: "error" });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
