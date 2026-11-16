"use strict";

/**
 * 写路径事务与数据库运行参数(P0-3 / P0-4)。
 *
 *  - 配额判断(count)与插入(insert)在同一事务内,并发写入不会超卖
 *  - withTx 内抛错会整体回滚,不留下半条记录
 *  - PRAGMA busy_timeout 已设置为 5000ms
 */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");

const { openDb } = require("../lib/db.js");
const { startServer } = require("../server.js");

const rootDir = path.join(__dirname, "..");
const PASSWORD = "secret1234567";

function cleanupFiles(dbPath) {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      fs.unlinkSync(dbPath + suffix);
    } catch (_) {
      /* 忽略清理失败 */
    }
  }
}

/* ---------- P0-3:并发写入不会突破配额 ---------- */

let server;
let base;
const tmpDb = path.join(os.tmpdir(), `todo-write-${process.pid}-${Date.now()}.db`);

before(async () => {
  const started = await startServer({
    dbPath: tmpDb,
    port: 0,
    staticDir: rootDir,
    maxTodosPerUser: 10
  });
  server = started.server;
  base = `http://127.0.0.1:${started.port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  cleanupFiles(tmpDb);
});

test("并发 20 个创建请求最终不超过配额 10,超出返回 409 与 TODO_QUOTA_EXCEEDED", async () => {
  const reg = await fetch(base + "/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "quota_racer", password: PASSWORD })
  });
  assert.equal(reg.status, 201);
  const { token } = await reg.json();

  const requests = [];
  for (let i = 0; i < 20; i++) {
    requests.push(
      fetch(base + "/api/todos", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify({ text: `并发任务 ${i}` })
      })
    );
  }
  const responses = await Promise.all(requests);
  const bodies = await Promise.all(responses.map((res) => res.json()));

  const created = responses.filter((res) => res.status === 201);
  const rejected = responses.filter((res) => res.status === 409);
  assert.ok(created.length <= 10, `成功创建数不应超过配额,实际 ${created.length}`);
  assert.equal(created.length + rejected.length, 20, "每个请求都应有明确结果");
  for (const [index, res] of responses.entries()) {
    if (res.status === 409) {
      assert.equal(bodies[index].code, "TODO_QUOTA_EXCEEDED");
    }
  }

  const list = await (await fetch(base + "/api/todos", {
    headers: { Authorization: "Bearer " + token }
  })).json();
  assert.ok(list.length <= 10, `最终条数不应超过 10,实际 ${list.length}`);
});

/* ---------- P0-3:withTx 回滚 ---------- */

test("withTx 内抛错会回滚:条数不变且无半条记录", () => {
  const store = openDb(":memory:");
  try {
    const userId = store.createUser("rollback_user", "x", 1000);
    const item = {
      id: "tx-item",
      text: "不应落库",
      completed: false,
      priority: 1,
      createdAt: 1000
    };

    assert.throws(
      () =>
        store.withTx(() => {
          store.insertTodo(userId, item);
          throw new Error("boom");
        }),
      /boom/
    );

    assert.equal(store.getTodos(userId).length, 0, "回滚后不应留下记录");
    assert.equal(store.getTodo(userId, item.id), undefined);

    // withTx 返回 fn 的返回值;嵌套调用复用外层事务
    const result = store.withTx(() => {
      store.insertTodo(userId, item);
      return store.withTx(() => "inner-result");
    });
    assert.equal(result, "inner-result");
    assert.equal(store.getTodos(userId).length, 1, "提交后应正常落库");
  } finally {
    store.close();
  }
});

test("updateTodo / deleteTodo 的读改写也在事务内,抛错时整体回滚", () => {
  const store = openDb(":memory:");
  try {
    const userId = store.createUser("tx_update_user", "x", 1000);
    store.insertTodo(userId, {
      id: "keep",
      text: "原文本",
      completed: false,
      priority: 1,
      createdAt: 1000
    });

    assert.throws(
      () =>
        store.withTx(() => {
          store.updateTodo(userId, "keep", { text: "改到一半" });
          store.deleteTodo(userId, "keep");
          throw new Error("rollback please");
        }),
      /rollback please/
    );

    const item = store.getTodo(userId, "keep");
    assert.ok(item, "回滚后条目仍应存在");
    assert.equal(item.text, "原文本", "回滚后文本应保持原值");
  } finally {
    store.close();
  }
});

/* ---------- P0-4:busy_timeout ---------- */

test("数据库连接设置 busy_timeout = 5000ms", () => {
  const store = openDb(":memory:");
  try {
    assert.equal(store.getBusyTimeout(), 5000);
  } finally {
    store.close();
  }
});
