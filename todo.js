(function () {
  "use strict";

  // 核心逻辑(纯函数)独立在 todo-core.js,便于单元测试
  var core = typeof TodoCore !== "undefined" ? TodoCore : require("./todo-core.js");
  var FILTERS = core.FILTERS;

  /** localStorage 存储键 */
  var STORAGE_KEY = "todo-app.items";

  /** 当前筛选,默认显示全部 */
  var currentFilter = FILTERS.ALL;

  /** 待办数组,每项形如 { id, text, completed, createdAt } */
  var todos = loadTodos();

  var form = document.getElementById("todo-form");
  var input = document.getElementById("todo-input");
  var list = document.getElementById("todo-list");
  var statsCompleted = document.getElementById("stats-completed");
  var statsTotal = document.getElementById("stats-total");
  var emptyState = document.getElementById("empty-state");
  var filterButtons = document.querySelectorAll(".filter-btn");

  /* ---------- 持久化 ---------- */

  function loadTodos() {
    try {
      var items = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return core.sanitizeItems(items);
    } catch (err) {
      // 数据损坏时回退为空列表,避免整个应用不可用
      console.error("读取待办数据失败:", err);
      return [];
    }
  }

  function saveTodos() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
  }

  /* ---------- 渲染 ---------- */

  function getVisibleTodos() {
    return core.getVisibleTodos(todos, currentFilter);
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

      var del = document.createElement("button");
      del.type = "button";
      del.className = "todo-delete-btn";
      del.textContent = "删除";
      del.setAttribute("aria-label", "删除:「" + todo.text + "」");

      li.appendChild(checkbox);
      li.appendChild(text);
      li.appendChild(del);
      list.appendChild(li);
    });

    renderSummary();
  }

  function renderSummary() {
    var completedCount = todos.filter(function (t) { return t.completed; }).length;
    statsCompleted.textContent = completedCount;
    statsTotal.textContent = todos.length;
    emptyState.hidden = todos.length !== 0;
  }

  /* ---------- 交互 ---------- */

  function addTodo(text) {
    todos = core.addTodo(todos, text);
    // 空文本/纯空白时不新增,与表单校验保持一致的幂等语义
    if (todos.length === 0) {
      input.focus();
      return;
    }
    saveTodos();
    render();
  }

  function toggleTodo(id) {
    var before = todos;
    todos = core.toggleTodo(todos, id);
    if (todos === before) return; // id 不存在,无变化
    saveTodos();
    render();
  }

  function removeTodo(id) {
    var before = todos;
    todos = core.removeTodo(todos, id);
    if (todos === before) return; // id 不存在,无变化
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

  /* ---------- 事件绑定 ---------- */

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) {
      input.focus();
      return;
    }
    addTodo(text);
    input.value = "";
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
