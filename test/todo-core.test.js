/**
 * todo 应用核心逻辑单元测试
 *
 * 运行方式:
 *   node --test test/
 *   npm test
 *
 * 只依赖 Node 内置的 node:test 与 assert,无需安装第三方依赖。
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const core = require("../todo-core.js");

// 固定 id 生成器,让测试能精确控制数据
function makeTodos(fixtures) {
  return fixtures.map((f, i) => ({
    id: f.id != null ? f.id : `id-${i}`,
    text: f.text,
    completed: !!f.completed,
    createdAt: f.createdAt != null ? f.createdAt : 1000 + i
  }));
}

/* ---------- addTodo ---------- */

test("addTodo 追加一条未完成待办", () => {
  const todos = makeTodos([{ id: "a", text: "写代码" }]);
  const next = core.addTodo(todos, "写测试");

  assert.equal(next.length, 2);
  assert.equal(next[1].text, "写测试");
  assert.equal(next[1].completed, false);
  assert.ok(typeof next[1].id === "string" && next[1].id.length > 0);
  assert.ok(Number.isFinite(next[1].createdAt));
});

test("addTodo 返回新数组,不修改原数组", () => {
  const todos = makeTodos([{ id: "a", text: "写代码" }]);
  const snapshot = JSON.stringify(todos);

  const next = core.addTodo(todos, "写测试");

  assert.notStrictEqual(next, todos);
  assert.equal(JSON.stringify(todos), snapshot, "入参不应被修改");
});

test("addTodo 自动去除首尾空白", () => {
  const todos = makeTodos([]);
  const next = core.addTodo(todos, "  去空白  ");

  assert.equal(next.length, 1);
  assert.equal(next[0].text, "去空白");
});

test("addTodo 拒绝空文本与纯空白文本", () => {
  const todos = makeTodos([{ id: "a", text: "写代码" }]);

  assert.deepEqual(core.addTodo(todos, ""), todos);
  assert.deepEqual(core.addTodo(todos, "   "), todos);
  assert.equal(core.addTodo(todos, "").length, 1);
});

test("addTodo 空数组时也能追加", () => {
  const next = core.addTodo([], "第一条");
  assert.equal(next.length, 1);
  assert.equal(next[0].text, "第一条");
});

test("addTodo 连续多次追加 id 不重复", () => {
  let todos = [];
  for (let i = 0; i < 100; i++) {
    todos = core.addTodo(todos, `任务 ${i}`);
  }
  const ids = new Set(todos.map((t) => t.id));
  assert.equal(ids.size, 100, "生成的 id 应互不相同");
});

/* ---------- toggleTodo ---------- */

test("toggleTodo 将未完成切换为已完成", () => {
  const todos = makeTodos([{ id: "a", text: "写代码", completed: false }]);
  const next = core.toggleTodo(todos, "a");

  assert.equal(next[0].completed, true);
  assert.equal(next[0].text, "写代码");
});

test("toggleTodo 将已完成切换为未完成", () => {
  const todos = makeTodos([{ id: "a", text: "写代码", completed: true }]);
  const next = core.toggleTodo(todos, "a");

  assert.equal(next[0].completed, false);
});

test("toggleTodo 只影响目标项,不影响其他项", () => {
  const todos = makeTodos([
    { id: "a", text: "写代码", completed: false },
    { id: "b", text: "写测试", completed: true }
  ]);

  const next = core.toggleTodo(todos, "a");

  assert.equal(next[0].completed, true);
  assert.equal(next[1].completed, true, "其他项不应被改变");
  assert.equal(next.length, 2);
});

test("toggleTodo 返回新数组,不修改原数组;目标项为新对象", () => {
  const todos = makeTodos([{ id: "a", text: "写代码", completed: false }]);

  const next = core.toggleTodo(todos, "a");

  assert.notStrictEqual(next, todos);
  assert.notStrictEqual(next[0], todos[0]);
  assert.equal(todos[0].completed, false, "原数组项不应被修改");
});

test("toggleTodo 重复切换会回到原状态", () => {
  const todos = makeTodos([{ id: "a", text: "写代码", completed: false }]);
  const once = core.toggleTodo(todos, "a");
  const twice = core.toggleTodo(once, "a");

  assert.equal(twice[0].completed, false);
  assert.deepEqual(twice[0].text, "写代码");
});

test("toggleTodo id 不存在时返回原数组", () => {
  const todos = makeTodos([{ id: "a", text: "写代码" }]);
  assert.strictEqual(core.toggleTodo(todos, "no-such-id"), todos);
});

/* ---------- removeTodo ---------- */

test("removeTodo 删除指定 id 的待办", () => {
  const todos = makeTodos([
    { id: "a", text: "写代码" },
    { id: "b", text: "写测试" }
  ]);

  const next = core.removeTodo(todos, "a");

  assert.equal(next.length, 1);
  assert.equal(next[0].id, "b");
});

test("removeTodo 返回新数组,不修改原数组", () => {
  const todos = makeTodos([
    { id: "a", text: "写代码" },
    { id: "b", text: "写测试" }
  ]);
  const snapshot = JSON.stringify(todos);

  const next = core.removeTodo(todos, "a");

  assert.notStrictEqual(next, todos);
  assert.equal(JSON.stringify(todos), snapshot);
});

test("removeTodo 删除最后一项后得到空数组", () => {
  const todos = makeTodos([{ id: "a", text: "写代码" }]);
  const next = core.removeTodo(todos, "a");
  assert.deepEqual(next, []);
});

test("removeTodo id 不存在时返回原数组", () => {
  const todos = makeTodos([{ id: "a", text: "写代码" }]);
  assert.strictEqual(core.removeTodo(todos, "no-such-id"), todos);
});

/* ---------- getVisibleTodos(联动筛选) ---------- */

test("getVisibleTodos 按 active 只返回未完成项", () => {
  const todos = makeTodos([
    { id: "a", text: "写代码", completed: false },
    { id: "b", text: "写测试", completed: true }
  ]);

  assert.deepEqual(core.getVisibleTodos(todos, core.FILTERS.ACTIVE), [todos[0]]);
});

test("getVisibleTodos 按 completed 只返回已完成项", () => {
  const todos = makeTodos([
    { id: "a", text: "写代码", completed: false },
    { id: "b", text: "写测试", completed: true }
  ]);

  assert.deepEqual(core.getVisibleTodos(todos, core.FILTERS.COMPLETED), [todos[1]]);
});

test("getVisibleTodos 默认/非法筛选返回全部导航副本", () => {
  const todos = makeTodos([
    { id: "a", text: "写代码", completed: false },
    { id: "b", text: "写测试", completed: true }
  ]);

  assert.deepEqual(core.getVisibleTodos(todos, core.FILTERS.ALL), todos);
  assert.deepEqual(core.getVisibleTodos(todos, "bogus"), todos);
  assert.notStrictEqual(core.getVisibleTodos(todos, core.FILTERS.ALL), todos, "应返回副本");
});

/* ---------- sanitizeItems(数据清洗) ---------- */

test("sanitizeItems 过滤非法项,保留合法项", () => {
  const raw = [
    { id: "a", text: "合法" },
    { id: "b", text: 123 },
    null,
    "字符串",
    { id: "c", text: "合法2", completed: true }
  ];

  const clean = core.sanitizeItems(raw);

  assert.equal(clean.length, 2);
  assert.equal(clean[0].text, "合法");
  assert.equal(clean[1].text, "合法2");
});

test("sanitizeItems 非数组入参返回空数组", () => {
  assert.deepEqual(core.sanitizeItems("oops"), []);
  assert.deepEqual(core.sanitizeItems(null), []);
  assert.deepEqual(core.sanitizeItems(undefined), []);
});
