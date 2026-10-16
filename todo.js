(function () {
  "use strict";

  /** localStorage 存储键 */
  var STORAGE_KEY = "todo-app.items";

  /** 筛选状态 */
  var FILTERS = { ALL: "all", ACTIVE: "active", COMPLETED: "completed" };

  /** 排序状态 */
  var SORTS = {
    CREATED_DESC: "created-desc",
    CREATED_ASC: "created-asc",
    PRIORITY_DESC: "priority-desc",
    PRIORITY_ASC: "priority-asc"
  };

  /** 优先级 */
  var PRIORITIES = { HIGH: "high", MEDIUM: "medium", LOW: "low" };

  /** 优先级权重,数值越小越靠前(用于排序) */
  var PRIORITY_WEIGHT = {
    high: 0,
    medium: 1,
    low: 2
  };

  var PRIORITY_LABELS = {
    high: "高",
    medium: "中",
    low: "低"
  };

  /** 未知优先级兜底为中 */
  function priorityWeight(p) {
    var w = PRIORITY_WEIGHT[p];
    return typeof w === "number" ? w : 1;
  }

  /** 当前筛选,默认显示全部 */
  var currentFilter = FILTERS.ALL;

  /** 当前排序,默认按创建时间新→旧 */
  var currentSort = SORTS.CREATED_DESC;

  /** 待办数组,每项形如 { id, text, completed, createdAt, priority } */
  var todos = loadTodos();

  var form = document.getElementById("todo-form");
  var input = document.getElementById("todo-input");
  var list = document.getElementById("todo-list");
  var statsCompleted = document.getElementById("stats-completed");
  var statsTotal = document.getElementById("stats-total");
  var emptyState = document.getElementById("empty-state");
  var filterButtons = document.querySelectorAll(".filter-btn");
  var prioritySelect = document.getElementById("todo-priority");
  var sortSelect = document.getElementById("sort-select");

  /* ---------- 持久化 ---------- */

  function loadTodos() {
    try {
      var items = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      if (!Array.isArray(items)) return [];
      return items
        .filter(function (item) {
          return item && typeof item.text === "string";
        })
        .map(function (item) {
          // 旧数据迁移:早期版本没有 priority 字段,创建时间也可能缺失
          var priority = item.priority;
          if (priority !== PRIORITIES.HIGH &&
              priority !== PRIORITIES.MEDIUM &&
              priority !== PRIORITIES.LOW) {
            priority = PRIORITIES.MEDIUM;
          }
          return {
            id: item.id,
            text: item.text,
            completed: !!item.completed,
            createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
            priority: priority
          };
        });
    } catch (err) {
      // 数据损坏时回退为空列表,避免整个应用不可用
      console.error("读取待办数据失败:", err);
      return [];
    }
  }

  function saveTodos() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
    } catch (err) {
      // 存储不可用或配额超限时,仅记录错误;不中断后续 render,保证界面可操作
      console.error("保存待办数据失败:", err);
    }
  }

  /* ---------- 渲染 ---------- */

  function getVisibleTodos() {
    var visible;
    switch (currentFilter) {
      case FILTERS.ACTIVE:
        visible = todos.filter(function (t) { return !t.completed; });
        break;
      case FILTERS.COMPLETED:
        visible = todos.filter(function (t) { return t.completed; });
        break;
      default:
        visible = todos.slice();
    }
    return sortTodos(visible);
  }

  function sortTodos(items) {
    return items.slice().sort(function (a, b) {
      var diff;
      switch (currentSort) {
        case SORTS.CREATED_ASC:
          diff = a.createdAt - b.createdAt;
          break;
        case SORTS.PRIORITY_DESC:
          diff = priorityWeight(a.priority) - priorityWeight(b.priority);
          break;
        case SORTS.PRIORITY_ASC:
          diff = priorityWeight(b.priority) - priorityWeight(a.priority);
          break;
        case SORTS.CREATED_DESC:
        default:
          diff = b.createdAt - a.createdAt;
      }
      // 排序值相同时按创建时间兜底,保证次序稳定不跳动
      return diff !== 0 ? diff : a.createdAt - b.createdAt;
    });
  }

  function render() {
    var visible = getVisibleTodos();

    list.innerHTML = "";
    visible.forEach(function (todo) {
      var li = document.createElement("li");
      li.className = "todo-item" + (todo.completed ? " is-completed" : "");
      li.dataset.id = todo.id;

      var checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "todo-checkbox";
      checkbox.checked = todo.completed;
      checkbox.setAttribute("aria-label", todo.completed ? "标记为未完成" : "标记为已完成");

      var text = document.createElement("span");
      text.className = "todo-text";
      text.textContent = todo.text;

      var badge = document.createElement("span");
      badge.className = "priority-badge is-" + todo.priority;
      badge.textContent = PRIORITY_LABELS[todo.priority] || "中";
      badge.setAttribute("title", "优先级:" + (PRIORITY_LABELS[todo.priority] || "中"));

      var del = document.createElement("button");
      del.type = "button";
      del.className = "todo-delete-btn";
      del.textContent = "删除";
      del.setAttribute("aria-label", "删除:「" + todo.text + "」");

      li.appendChild(checkbox);
      li.appendChild(text);
      li.appendChild(badge);
      li.appendChild(del);
      list.appendChild(li);
    });

    renderSummary();

    // 空状态提示:区分「一项都没有」和「筛选结果为空」
    if (visible.length === 0) {
      emptyState.hidden = false;
      emptyState.textContent =
        todos.length === 0
          ? "暂无待办,添加一条开始吧 ✨"
          : "没有符合条件的待办,换个筛选或排序试试 👀";
    } else {
      emptyState.hidden = true;
    }
  }

  function renderSummary() {
    var completedCount = todos.filter(function (t) { return t.completed; }).length;
    statsCompleted.textContent = completedCount;
    statsTotal.textContent = todos.length;
  }

  /* ---------- 交互 ---------- */

  function addTodo(text, priority) {
    todos.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      text: text,
      completed: false,
      createdAt: Date.now(),
      priority: priority
    });
    saveTodos();
    render();
  }

  function toggleTodo(id) {
    var todo = todos.find(function (t) { return t.id === id; });
    if (!todo) return;
    todo.completed = !todo.completed;
    saveTodos();
    render();
  }

  function removeTodo(id) {
    todos = todos.filter(function (t) { return t.id !== id; });
    saveTodos();
    render();
  }

  function setFilter(filter) {
    currentFilter = filter;
    filterButtons.forEach(function (btn) {
      btn.classList.toggle("is-active", btn.dataset.filter === filter);
    });
    render();
  }

  function setSort(sort) {
    currentSort = sort;
    render();
  }

  /* ---------- 事件绑定 ---------- */

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    addTodo(text, prioritySelect.value);
    input.value = "";
    prioritySelect.value = PRIORITIES.MEDIUM;
    input.focus();
  });

  list.addEventListener("click", function (e) {
    var li = e.target.closest(".todo-item");
    if (!li) return;
    var id = li.dataset.id;

    if (e.target.classList.contains("todo-delete-btn")) {
      removeTodo(id);
    } else if (e.target.classList.contains("todo-checkbox")) {
      toggleTodo(id);
    }
  });

  filterButtons.forEach(function (btn) {
    btn.addEventListener("click", function () {
      setFilter(btn.dataset.filter);
    });
  });

  sortSelect.addEventListener("change", function () {
    setSort(sortSelect.value);
  });

  /* ---------- 深色模式 ---------- */

  var THEME_KEY = "todo-app.theme";
  var themeToggle = document.getElementById("theme-toggle");

  // 手动选择优先,否则取系统 prefers-color-scheme
  function resolveTheme() {
    var current = document.documentElement.dataset.theme;
    if (current === "dark" || current === "light") return current;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  themeToggle.addEventListener("click", function () {
    var next = resolveTheme() === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    themeToggle.classList.toggle("is-dark", next === "dark");
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (err) {
      console.error("保存主题偏好失败:", err);
    }
  });

  /* 初始图标:跟随当前生效的主题(含系统默认) */
  themeToggle.classList.toggle("is-dark", resolveTheme() === "dark");

  /* 初始渲染 */
  render();
})();