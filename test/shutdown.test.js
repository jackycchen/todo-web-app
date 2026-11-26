"use strict";

/**
 * 优雅关闭测试。
 *
 *  1. 正常排空:在途请求在收到信号后完整返回;关闭期间 /healthz 返回 503;
 *     进程以退出码 0 结束并打印一行结构化日志。
 *  2. 排空超时:超过 SHUTDOWN_TIMEOUT_MS 后强制退出(退出码 1)。
 *  3. 重复信号:第二次信号立即强制退出,不重复进入关闭流程、不抛未捕获异常。
 *
 * 大量场景用子进程 spawn 真实的 node server.js 并发真实信号,避免污染测试主进程;
 * 健康检查状态与超时解析则用进程内单测确定性覆盖。
 */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");

const {
  createApp,
  createShutdownState,
  readShutdownTimeoutMs,
  resolveShutdownTimeoutMs,
  startServer,
  DEFAULT_SHUTDOWN_TIMEOUT_MS
} = require("../server.js");
const { openDb } = require("../lib/db.js");

const rootDir = path.join(__dirname, "..");
const serverEntry = path.join(rootDir, "server.js");

function tmpDbPath(tag) {
  return path.join(os.tmpdir(), `todo-shutdown-${tag}-${process.pid}-${Date.now()}.db`);
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  const srv = net.createServer();
  await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", resolve);
  });
  const port = srv.address().port;
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/** 轮询等待条件成立,超时抛错并带上诊断信息。 */
async function waitFor(predicate, { timeout = 10000, interval = 20, description = "条件" } = {}) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (predicate()) return;
    await delay(interval);
  }
  throw new Error(`等待${description}超时(${timeout}ms)`);
}

function withTimeout(promise, timeout, description) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`等待${description}超时(${timeout}ms)`)), timeout);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

/** 启动真实 server.js 子进程并跟踪输出/退出。 */
function spawnServer({ port, dbPath, shutdownTimeoutMs }) {
  const child = spawn(process.execPath, [serverEntry], {
    cwd: rootDir,
    env: {
      ...process.env,
      PORT: String(port),
      TODO_DB_PATH: dbPath,
      SHUTDOWN_TIMEOUT_MS: String(shutdownTimeoutMs)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const tracked = { stdout: "", stderr: "", exit: null };
  child.stdout.on("data", (chunk) => {
    tracked.stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    tracked.stderr += chunk.toString();
  });
  const exitPromise = new Promise((resolve) => {
    child.once("exit", (code, signal) => {
      tracked.exit = { code, signal };
      resolve(tracked.exit);
    });
  });

  return { child, tracked, exitPromise };
}

function openSocket(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => resolve(socket));
    socket.once("error", reject);
  });
}

function parseLogLines(stdout) {
  const lines = [];
  for (const raw of stdout.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      lines.push(JSON.parse(trimmed));
    } catch (_) {
      /* 非 JSON 行(如启动提示)忽略 */
    }
  }
  return lines;
}

function findLogLine(stdout, event) {
  return parseLogLines(stdout).find((line) => line && line.event === event);
}

function countLogLines(stdout, event) {
  return parseLogLines(stdout).filter((line) => line && line.event === event).length;
}

/** 请求头 + 部分请求体:让请求停留在「在途」状态(等待剩余 body)。 */
function partialLogoutRequest() {
  return (
    "POST /api/logout HTTP/1.1\r\n" +
    "Host: 127.0.0.1\r\n" +
    "Content-Type: application/json\r\n" +
    "Content-Length: 7\r\n" +
    "Connection: keep-alive\r\n" +
    "\r\n" +
    '{"a":'
  );
}

/* ---------- 1. 正常排空 ---------- */

test("SIGTERM:在途请求完整返回,关闭期 /healthz 返回 503,退出码 0 并打印结构化日志", async (t) => {
  const port = await getFreePort();
  const dbPath = tmpDbPath("drain");
  const { child, tracked, exitPromise } = spawnServer({
    port,
    dbPath,
    shutdownTimeoutMs: 5000
  });
  let socket;
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch (_) {
      /* 已退出 */
    }
    if (socket) socket.destroy();
    cleanupFiles(dbPath);
  });

  await waitFor(() => tracked.stdout.includes("server running at"), {
    description: "服务启动",
    timeout: 10000
  });

  socket = await openSocket(port);
  let response = "";
  socket.on("data", (chunk) => {
    response += chunk.toString();
  });
  socket.on("error", () => {
    /* 关闭期间对端断开属预期 */
  });

  // 建立一条在途请求(请求体尚未发完)
  socket.write(partialLogoutRequest());
  await delay(100);
  child.kill("SIGTERM");
  await waitFor(() => findLogLine(tracked.stdout, "server_shutdown_started"), {
    description: "关闭流程启动",
    timeout: 5000
  });
  await delay(150);

  // 补完请求体,并在同一连接上流水线发起健康检查。
  // 此时监听 socket 已关闭,新连接会被拒绝,只有已建立的连接可用。
  socket.write('1}GET /healthz HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n');

  await waitFor(() => response.includes("503 Service Unavailable"), {
    description: "关闭期间健康检查 503",
    timeout: 5000
  });

  const exit = await withTimeout(exitPromise, 5000, "进程退出");
  assert.equal(exit.code, 0, `预期退出码 0,实际 ${exit.code};stderr: ${tracked.stderr}`);
  assert.equal(exit.signal, null);

  // 在途写请求必须完整返回(而非被信号打断)
  assert.match(response, /HTTP\/1\.1 204 No Content/);
  assert.match(response, /HTTP\/1\.1 503 Service Unavailable/);
  assert.match(response, /"ok":false/);
  assert.match(response, /shutting-down/);

  const complete = findLogLine(tracked.stdout, "server_shutdown_complete");
  assert.ok(complete, `缺少关闭完成日志,stdout: ${tracked.stdout}`);
  assert.equal(complete.exitCode, 0);
  assert.equal(complete.forced, false);
  assert.equal(complete.signal, "SIGTERM");
  assert.ok(complete.drainedRequests >= 1, `drainedRequests 应 ≥ 1,实际 ${complete.drainedRequests}`);
  assert.ok(typeof complete.elapsedMs === "number" && complete.elapsedMs >= 0);
  assert.equal(countLogLines(tracked.stdout, "server_shutdown_complete"), 1);
});

/* ---------- 2. 排空超时 ---------- */

test("排空超时:超过 SHUTDOWN_TIMEOUT_MS 后强制退出(退出码 1)并输出 forced 日志", async (t) => {
  const port = await getFreePort();
  const dbPath = tmpDbPath("timeout");
  const shutdownTimeoutMs = 200;
  const { child, tracked, exitPromise } = spawnServer({
    port,
    dbPath,
    shutdownTimeoutMs
  });
  let socket;
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch (_) {
      /* 已退出 */
    }
    if (socket) socket.destroy();
    cleanupFiles(dbPath);
  });

  await waitFor(() => tracked.stdout.includes("server running at"), {
    description: "服务启动",
    timeout: 10000
  });

  // 永远不补完请求体:连接始终「在途」,排空无法自然结束
  socket = await openSocket(port);
  socket.on("error", () => {
    /* 预期:超时后进程退出会断开连接 */
  });
  socket.write(partialLogoutRequest());
  await delay(100);

  const startedAt = Date.now();
  child.kill("SIGTERM");
  const exit = await withTimeout(exitPromise, 8000, "超时强制退出");
  const elapsed = Date.now() - startedAt;
  // 定时器精度允许 ±25ms 抖动
  const tolerance = 25;

  assert.equal(exit.code, 1, `预期超时退出码 1,实际 ${exit.code};stderr: ${tracked.stderr}`);
  assert.ok(
    elapsed >= shutdownTimeoutMs - tolerance,
    `应至少等待约 ${shutdownTimeoutMs}ms,实际 ${elapsed}ms`
  );

  const forced = findLogLine(tracked.stdout, "server_shutdown_forced");
  assert.ok(forced, `缺少超时强制退出日志,stdout: ${tracked.stdout}`);
  assert.equal(forced.reason, "timeout");
  assert.equal(forced.forced, true);
  assert.equal(forced.exitCode, 1);
  assert.ok(forced.elapsedMs >= shutdownTimeoutMs - tolerance);
});

/* ---------- 3. 重复信号 ---------- */

test("重复信号:第二次信号立即强制退出,不重复进入关闭流程且无未捕获异常", async (t) => {
  const port = await getFreePort();
  const dbPath = tmpDbPath("repeat");
  const { child, tracked, exitPromise } = spawnServer({
    port,
    dbPath,
    shutdownTimeoutMs: 10000
  });
  let socket;
  t.after(() => {
    try {
      child.kill("SIGKILL");
    } catch (_) {
      /* 已退出 */
    }
    if (socket) socket.destroy();
    cleanupFiles(dbPath);
  });

  await waitFor(() => tracked.stdout.includes("server running at"), {
    description: "服务启动",
    timeout: 10000
  });

  socket = await openSocket(port);
  socket.on("error", () => {
    /* 预期:强制退出会断开连接 */
  });
  socket.write(partialLogoutRequest());
  await delay(100);

  // 第一次信号(SIGINT)进入正常关闭流程;在途请求未完成,排空会一直挂起
  child.kill("SIGINT");
  await waitFor(() => findLogLine(tracked.stdout, "server_shutdown_started"), {
    description: "关闭流程启动",
    timeout: 5000
  });
  await delay(200);

  const forcedAt = Date.now();
  // 第二次信号(SIGTERM)必须立即强制退出,而不是再等 10s 超时
  child.kill("SIGTERM");
  const exit = await withTimeout(exitPromise, 5000, "第二次信号强制退出");
  const elapsed = Date.now() - forcedAt;

  assert.equal(exit.code, 1, `预期强制退出码 1,实际 ${exit.code};stderr: ${tracked.stderr}`);
  assert.equal(exit.signal, null, "应通过 process.exit 退出,而不是被信号杀死");
  assert.ok(elapsed < 3000, `第二次信号后应立即退出,实际耗时 ${elapsed}ms`);

  // 关闭流程只启动一次(证明重复信号没有重复进入)
  assert.equal(countLogLines(tracked.stdout, "server_shutdown_started"), 1);

  const forced = findLogLine(tracked.stdout, "server_shutdown_forced");
  assert.ok(forced, `缺少强制退出日志,stdout: ${tracked.stdout}`);
  assert.equal(forced.reason, "second_signal");
  assert.equal(forced.exitCode, 1);

  // 不得抛未捕获异常 / 不得有监听器泄漏告警
  assert.doesNotMatch(tracked.stderr, /Uncaught|uncaughtException|ERR_UNHANDLED/);
  assert.doesNotMatch(tracked.stderr, /MaxListenersExceededWarning/);
});

/* ---------- 单元:关闭期间健康检查 ---------- */

test("关闭状态下 /healthz 与 /api/health 返回 503 { ok:false, db:'shutting-down' }", async (t) => {
  const dbPath = tmpDbPath("health");
  const store = openDb(dbPath);
  const shutdownState = createShutdownState();
  const app = createApp({ store, staticDir: rootDir, shutdownState });
  const server = app.listen(0, "127.0.0.1");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    try {
      store.close();
    } catch (_) {
      /* 可能已被关闭 */
    }
    cleanupFiles(dbPath);
  });
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 正常状态:200
  const before = await fetch(base + "/healthz");
  assert.equal(before.status, 200);
  assert.equal((await before.json()).ok, true);

  // 关闭流程开始后:两个健康检查端点都返回 503
  shutdownState.shuttingDown = true;
  for (const route of ["/healthz", "/api/health"]) {
    const res = await fetch(base + route);
    assert.equal(res.status, 503, `${route} 应返回 503`);
    assert.deepEqual(await res.json(), { ok: false, db: "shutting-down" });
  }
});

/* ---------- 单元:startServer().close() ---------- */

test("startServer().close() 幂等,排空后关闭数据库连接并清理定时器", async () => {
  const dbPath = tmpDbPath("close");
  const silentLogger = { log() {}, error() {} };
  const started = await startServer({
    dbPath,
    port: 0,
    staticDir: rootDir,
    logger: silentLogger
  });
  try {
    const first = started.close();
    const second = started.close();
    assert.equal(first, second, "重复调用 close() 应返回同一个 Promise");

    const summary = await first;
    assert.equal(summary.forced, false);
    assert.equal(summary.exitCode, 0);
    assert.equal(started.shutdownState.shuttingDown, true);
    // close() 已关闭 SQLite 连接,后续探活必须失败
    assert.throws(() => started.store.ping());
  } finally {
    cleanupFiles(dbPath);
  }
});

/* ---------- 单元:SHUTDOWN_TIMEOUT_MS 解析 ---------- */

test("SHUTDOWN_TIMEOUT_MS:接受正整数,非法值一律回退默认 10000", () => {
  assert.equal(DEFAULT_SHUTDOWN_TIMEOUT_MS, 10000);
  assert.equal(resolveShutdownTimeoutMs(undefined), 10000);
  assert.equal(resolveShutdownTimeoutMs(""), 10000);
  assert.equal(resolveShutdownTimeoutMs("abc"), 10000);
  assert.equal(resolveShutdownTimeoutMs(0), 10000);
  assert.equal(resolveShutdownTimeoutMs(-5), 10000);
  assert.equal(resolveShutdownTimeoutMs(1.5), 10000);
  assert.equal(resolveShutdownTimeoutMs(Number.NaN), 10000);
  assert.equal(resolveShutdownTimeoutMs("250"), 250);
  assert.equal(resolveShutdownTimeoutMs(250), 250);

  assert.equal(readShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: "300" }), 300);
  assert.equal(readShutdownTimeoutMs({ SHUTDOWN_TIMEOUT_MS: "oops" }), 10000);
  assert.equal(readShutdownTimeoutMs({}), 10000);
});