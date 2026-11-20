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
   * 优先级取值:数值越大越靠前。
   *  - 0 低
   *  - 1 普通(默认,保证旧数据/未设置时列表观感不变)
   *  - 2 高
   * 使用小整数而非字符串:排序可在 SQL 直接完成(ORDER BY priority DESC),
   * 也便于后续插入中间档位。
   */
  var PRIORITIES = { LOW: 0, NORMAL: 1, HIGH: 2 };
  var DEFAULT_PRIORITY = PRIORITIES.NORMAL;
  var PRIORITY_LABELS = { 0: "低", 1: "普通", 2: "高" };

  /** 长列表分页:每页默认条数 */
  var DEFAULT_PAGE_SIZE = 20;

  /**
   * 列表排序方向(仅前端视图偏好,不参与持久化):
   *  - desc 优先级高→低(默认,与服务端 ORDER BY priority DESC 一致)
   *  - asc  优先级低→高
   * 两个方向内部同优先级一律按 createdAt 升序,保证顺序稳定。
   */
  var SORT_ORDERS = { DESC: "desc", ASC: "asc" };
  var DEFAULT_SORT_ORDER = SORT_ORDERS.DESC;

  /** 把任意输入归一化为合法优先级;非法/缺失一律视为「普通」 */
  function normalizePriority(value) {
    return value === PRIORITIES.LOW ||
      value === PRIORITIES.NORMAL ||
      value === PRIORITIES.HIGH
      ? value
      : DEFAULT_PRIORITY;
  }

  /**
   * 生成新待办的 id。
   * 时间戳基数 + 随机后缀,保证同毫秒内多次创建也不冲突。
   */
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /** 创建一条新待办(不改动传入的 todos,交由 addTodo 处理) */
  function createTodo(text, priority) {
    return {
      id: generateId(),
      text: text,
      completed: false,
      priority: normalizePriority(priority),
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
        return {
          id: t.id,
          text: t.text,
          completed: !t.completed,
          priority: normalizePriority(t.priority),
          createdAt: t.createdAt,
          updatedAt: t.updatedAt
        };
      }
      return t;
    });
    return found ? next : todos;
  }

  /**
   * 修改指定 id 的待办文本,返回新数组(不修改入参)。
   * 文本去除首尾空白后为空,或 id 不存在时,原样返回(同一引用)。
   */
  function editTodo(todos, id, text) {
    var normalized = text == null ? "" : String(text).trim();
    if (!normalized) return todos;

    var found = false;
    var next = todos.map(function (t) {
      if (t.id === id) {
        found = true;
        return {
          id: t.id,
          text: normalized,
          completed: t.completed,
          priority: normalizePriority(t.priority),
          createdAt: t.createdAt,
          updatedAt: t.updatedAt
        };
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

  /**
   * 修改指定 id 的优先级,返回新数组。
   * 优先级非法时归一化为「普通」;id 不存在或优先级未变化时原样返回(同一引用)。
   */
  function setPriority(todos, id, priority) {
    var normalized = normalizePriority(priority);
    var found = false;
    var changed = false;
    var next = todos.map(function (t) {
      if (t.id !== id) return t;
      found = true;
      if (normalizePriority(t.priority) === normalized) return t;
      changed = true;
      return {
        id: t.id,
        text: t.text,
        completed: t.completed,
        priority: normalized,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt
      };
    });
    return found && changed ? next : todos;
  }

  /**
   * 与服务端 SELECT 一致的排序:优先级从高到低,同级按 createdAt 升序。
   * 返回新数组(稳定排序),不改动入参;用于本地写入后立即保持列表顺序。
   */
  function compareTodos(a, b) {
    var pa = normalizePriority(a && a.priority);
    var pb = normalizePriority(b && b.priority);
    if (pa !== pb) return pb - pa;
    var ca = a && typeof a.createdAt === "number" ? a.createdAt : 0;
    var cb = b && typeof b.createdAt === "number" ? b.createdAt : 0;
    return ca - cb;
  }

  /** 优先级从低到高,同级仍按 createdAt 升序(前端 asc 视图排序) */
  function compareTodosAsc(a, b) {
    var pa = normalizePriority(a && a.priority);
    var pb = normalizePriority(b && b.priority);
    if (pa !== pb) return pa - pb;
    var ca = a && typeof a.createdAt === "number" ? a.createdAt : 0;
    var cb = b && typeof b.createdAt === "number" ? b.createdAt : 0;
    return ca - cb;
  }

  /** 把任意输入归一化为合法排序方向;非法/缺失一律回落到默认的 desc */
  function normalizeSortOrder(order) {
    return order === SORT_ORDERS.ASC ? SORT_ORDERS.ASC : SORT_ORDERS.DESC;
  }

  /**
   * 按指定方向排序(视图用,返回新数组,不改动入参)。
   * order 缺省或非法时等价于原有 DESC 行为,保持向后兼容。
   */
  function sortTodos(todos, order) {
    var compare =
      normalizeSortOrder(order) === SORT_ORDERS.ASC ? compareTodosAsc : compareTodos;
    return (Array.isArray(todos) ? todos.slice() : []).sort(compare);
  }

  /**
   * 统计待办数量,供「还剩 N 项未完成」等实时计数使用。
   * 非数组入参按空列表处理;返回新对象,不修改入参。
   */
  function getStats(todos) {
    var list = Array.isArray(todos) ? todos : [];
    var completed = list.filter(function (t) {
      return !!t && t.completed;
    }).length;
    return {
      total: list.length,
      completed: completed,
      remaining: list.length - completed
    };
  }

  /**
   * 移除所有已完成项,返回新数组(不修改入参)。
   * 非数组入参按空列表处理;没有任何已完成项时原样返回入参,
   * 便于调用方用引用相等判断"无需写入"。
   */
  function clearCompleted(todos) {
    if (!Array.isArray(todos)) return [];
    var next = todos.filter(function (t) {
      return !(t && t.completed);
    });
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
   * 非数组、含非法项时丢弃非法项;合法项补齐默认优先级,
   * 保证后续逻辑只面对结构一致的数据(旧数据/旧服务端缺 priority 时按普通处理)。
   */
  function sanitizeItems(items) {
    if (!Array.isArray(items)) return [];
    return items
      .filter(function (item) {
        return item && typeof item === "object" && typeof item.text === "string";
      })
      .map(function (item) {
        return {
          id: item.id,
          text: item.text,
          completed: !!item.completed,
          priority: normalizePriority(item.priority),
          createdAt: item.createdAt,
          updatedAt: item.updatedAt
        };
      });
  }

  /**
   * 计算空状态提示文案。
   * 视图(即筛后的可见列表)非空时返回 null(不显示空状态);
   * 否则据数据与筛选返回对应提示,区分"完全无待办"与"筛选无匹配"。
   */
  function getEmptyStateText(todos, filter) {
    if (!Array.isArray(todos)) return "暂无待办,添加一条开始吧 ✨";
    if (getVisibleTodos(todos, filter).length > 0) return null;
    if (todos.length === 0) return "暂无待办,添加一条开始吧 ✨";
    if (filter === FILTERS.ACTIVE) return "没有未完成的待办 🎉";
    if (filter === FILTERS.COMPLETED) return "还没有已完成的待办 💪";
    return "暂无符合条件的待办";
  }

  /**
   * 归一化每页条数。
   * 非数字、NaN、小于 1 时回落到 DEFAULT_PAGE_SIZE,避免调用方误传导致一次渲染全部条目。
   */
  function normalizePageSize(limit) {
    var n = Number(limit);
    if (!Number.isFinite(n) || n < 1) return DEFAULT_PAGE_SIZE;
    return Math.max(1, Math.floor(n));
  }

  /**
   * 取可见列表的前 limit 项(返回新数组,不修改入参)。
   * 列表不超过一页时返回完整副本。
   */
  function getVisiblePage(items, limit) {
    var list = Array.isArray(items) ? items : [];
    var size = normalizePageSize(limit);
    return list.length > size ? list.slice(0, size) : list.slice();
  }

  /**
   * 计算分页状态。
   * @param {number} total 当前筛选下的可见总数
   * @param {number} limit 已加载条数上限
   * @returns {{total:number, shown:number, remaining:number, hasMore:boolean, pageSize:number}}
   */
  function getPaginationState(total, limit) {
    var count = Number(total);
    if (!Number.isFinite(count) || count < 0) count = 0;
    count = Math.floor(count);
    var size = normalizePageSize(limit);
    var shown = Math.min(count, size);
    return {
      total: count,
      shown: shown,
      remaining: count - shown,
      hasMore: shown < count,
      pageSize: size
    };
  }

  return {
    FILTERS: FILTERS,
    PRIORITIES: PRIORITIES,
    DEFAULT_PRIORITY: DEFAULT_PRIORITY,
    PRIORITY_LABELS: PRIORITY_LABELS,
    DEFAULT_PAGE_SIZE: DEFAULT_PAGE_SIZE,
    SORT_ORDERS: SORT_ORDERS,
    DEFAULT_SORT_ORDER: DEFAULT_SORT_ORDER,
    normalizePriority: normalizePriority,
    generateId: generateId,
    createTodo: createTodo,
    addTodo: addTodo,
    toggleTodo: toggleTodo,
    editTodo: editTodo,
    removeTodo: removeTodo,
    setPriority: setPriority,
    compareTodos: compareTodos,
    compareTodosAsc: compareTodosAsc,
    normalizeSortOrder: normalizeSortOrder,
    sortTodos: sortTodos,
    getStats: getStats,
    clearCompleted: clearCompleted,
    getVisibleTodos: getVisibleTodos,
    getVisiblePage: getVisiblePage,
    getPaginationState: getPaginationState,
    sanitizeItems: sanitizeItems,
    getEmptyStateText: getEmptyStateText
  };
});
