"use strict";

/**
 * 静态资源暴露范围测试
 *
 * 验证 express.static 采用白名单后:
 *  - 前端页面与资源仍可通过原有路径访问
 *  - 源码 / 测试 / 包配置 / data 目录不能被匿名下载
 *  - 响应体不包含任何源码特征串
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { startServer } = require("../server.js");

const rootDir = path.join(__dirname, "..");
const tmpDb = path.join(os.tmpdir(), `todo-static-test-${process.pid}-${Date.now()}.db`);
let server;
let base;

before(async () => {
  const started = await startServer({ dbPath: tmpDb, port: 0, staticDir: rootDir });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(tmpDb + suffix);
    } catch (_) {
      /* 忽略清理失败 */
    }
  }
});

function get(pathname) {
  return fetch(base + pathname);
}

test("GET / 与前端静态资源仍返回 200", async () => {
  const paths = ["/", "/index.html", "/style.css", "/todo-core.js", "/api.js", "/todo.js"];
  for (const pathname of paths) {
    const res = await get(pathname);
    assert.equal(res.status, 200, `${pathname} 应仍可访问`);
    const body = await res.text();
    assert.ok(body.length > 0, `${pathname} 应返回非空内容`);
  }
});

test("GET / 仍返回前端页面内容", async () => {
  const res = await get("/");
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /todo-core/);
  assert.match(text, /api\.js/);
});

test("源码、测试与包配置返回 404 且不泄露内容", async () => {
  const cases = [
    ["/server.js", /createApp|require\("express"\)|scryptSync/],
    ["/lib/db.js", /DatabaseSync|openDb|CREATE TABLE/],
    ["/test/api.test.js", /node:test|startServer|require\("node:test"\)/],
    ["/package.json", /"dependencies"|"express"/],
  ];
  for (const [pathname, signature] of cases) {
    const res = await get(pathname);
    const body = await res.text();
    assert.equal(res.status, 404, `${pathname} 不应可访问`);
    assert.doesNotMatch(body, signature, `${pathname} 响应体不应包含源码特征`);
  }
});

test("/data 目录仍不可访问", async () => {
  for (const pathname of ["/data", "/data/", "/data/todo.db"]) {
    const res = await get(pathname);
    assert.equal(res.status, 404, `${pathname} 不应可访问`);
  }
});

test("编码/路径穿越变体不能绕过白名单", async () => {
  for (const pathname of ["/%2e%2e/server.js", "/lib/../server.js", "/todo.js/../server.js"]) {
    const res = await get(pathname);
    assert.equal(res.status, 404, `${pathname} 不应可访问`);
  }
});
