/**
 * todo 应用核心逻辑(纯函数,无 DOM/localStorage 依赖)
 *
 * 为了让 addTodo / toggleTodo / removeTodo 等核心逻辑可以被单元测试,
 * 将其与 DOM 渲染和 localStorage 持久化解耦。
 * 同时兼容两种加载方式:
 *  - 浏览器:<script> 加载,暴露全局 TodoCore
 *  - Node  :require() 加载,module.exports 导出
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.TodoCore = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /** 筛选状态 */
  var FILTERS = { ALL: "all", ACTIVE: "active", COMPLETED: "completed" };

  /**
   * 生成新待办的 id。
   * 时间戳基数 + 随机后缀,保证同毫秒内多次创建也不冲突。
   */
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** 创建一条新待办(不改动传入的 todos,交由 addTodo 处理) */
  function createTodo(text) {
    return {
      id: generateId(),
      text: text,
      completed: false,
      createdAt: Date.now()
    };
  }

  /** 追加一条待办,返回新数组(不修改入参) */
  function addTodo(todos, text) {
    var normalized = text == null ? "" : String(text).trim();
    if (!normalized) return todos.slice();
    return todos.concat([createTodo(normalized)]);
  }

  /**
   * 切换某条待办的完成状态。
   * 返回新数组(id 命中时对应项 completed 取反);id 不存在时原样返回。
   */
  function toggleTodo(todos, id) {
    var found = false;
    var next = todos.map(function (t) {
      if (t.id === id) {
        found = true;
        return { id: t.id, text: t.text, completed: !t.completed, createdAt: t.createdAt };
      }
      return t;
    });
    return found ? next : todos;
  }

  /** 删除指定 id 的待办,返回新数组;id 不存在时原样返回 */
  function removeTodo(todos, id) {
    var next = todos.filter(function (t) { return t.id !== id; });
    return next.length === todos.length ? todos : next;
  }

  /** 按筛选状态过滤 */
  function getVisibleTodos(todos, filter) {
    switch (filter) {
      case FILTERS.ACTIVE:
        return todos.filter(function (t) { return !t.completed; });
      case FILTERS.COMPLETED:
        return todos.filter(function (t) { return t.completed; });
      default:
        return todos.slice();
    }
  }

  /**
   * 校验并清洗从存储读到的数据。
   * 非数组、含非法项时丢弃非法项,保证后续逻辑只面对合法结构。
   */
  function sanitizeItems(items) {
    if (!Array.isArray(items)) return [];
    return items.filter(function (item) {
      return item && typeof item === "object" && typeof item.text === "string";
    });
  }

  return {
    FILTERS: FILTERS,
    generateId: generateId,
    createTodo: createTodo,
    addTodo: addTodo,
    toggleTodo: toggleTodo,
    removeTodo: removeTodo,
    getVisibleTodos: getVisibleTodos,
    sanitizeItems: sanitizeItems
  };
});
