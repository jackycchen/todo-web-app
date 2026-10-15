(function () {
  "use strict";

  /** localStorage 存储键 */
  var STORAGE_KEY = "todo-app.items";

  /** 筛选状态 */
  var FILTERS = { ALL: "all", ACTIVE: "active", COMPLETED: "completed" };

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
      if (!Array.isArray(items)) return [];
      return items.filter(
        function (item) {
          return item && typeof item.text === "string";
        }
      );
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
    switch (currentFilter) {
      case FILTERS.ACTIVE:
        return todos.filter(function (t) { return !t.completed; });
      case FILTERS.COMPLETED:
        return todos.filter(function (t) { return t.completed; });
      default:
        return todos;
    }
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
    todos.push({
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      text: text,
      completed: false,
      createdAt: Date.now()
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

  /* 初始渲染 */
  render();
})();