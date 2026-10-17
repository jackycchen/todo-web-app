(function () {
  "use strict";

  // 核心逻辑(纯函数)独立在 todo-core.js,便于单元测试
  var core = typeof TodoCore !== "undefined" ? TodoCore : require("./todo-core.js");
  var api = typeof TodoApi !== "undefined" ? TodoApi : null;
  var FILTERS = core.FILTERS;

  /** 当前筛选,默认显示全部 */
  var currentFilter = FILTERS.ALL;

  /** 完成/淡出过渡时长(ms),需与 style.css 中的过渡时长保持一致 */
  var TRANSITION_MS = 350;

  /** 待办数组,每项形如 { id, text, completed, createdAt } */
  var todos = [];

  /** 上次成功同步到服务端的快照,用于计算增量 */
  var lastSynced = [];

  /* ---------- DOM 引用 ---------- */

  var authView = document.getElementById("auth-view");
  var appView = document.getElementById("app-view");
  var currentUser = document.getElementById("current-user");
  var logoutBtn = document.getElementById("logout-btn");
  var authError = document.getElementById("auth-error");
  var authTabs = document.querySelectorAll(".auth-tab");
  var loginForm = document.getElementById("login-form");
  var registerForm = document.getElementById("register-form");

  var form = document.getElementById("todo-form");
  var input = document.getElementById("todo-input");
  var list = document.getElementById("todo-list");
  var statsCompleted = document.getElementById("stats-completed");
  var statsTotal = document.getElementById("stats-total");
  var emptyState = document.getElementById("empty-state");
  var filterButtons = document.querySelectorAll(".filter-btn");

  /* ---------- 认证 ---------- */

  function showError(msg) {
    authError.textContent = msg;
    authError.hidden = false;
  }

  function clearError() {
    authError.hidden = true;
    authError.textContent = "";
  }

  function showAuth() {
    authView.hidden = false;
    appView.hidden = true;
  }

  function showApp(username) {
    authView.hidden = true;
    appView.hidden = false;
    if (currentUser) currentUser.textContent = username || "";
    return loadTodos();
  }

  function switchAuthTab(tab) {
    authTabs.forEach(function (btn) {
      var active = btn.dataset.authTab === tab;
      btn.classList.toggle("is-active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    });
    loginForm.hidden = tab !== "login";
    registerForm.hidden = tab !== "register";
    clearError();
  }

  /* ---------- 持久化(通过服务端 API) ---------- */

  function cloneItem(t) {
    return { id: t.id, text: t.text, completed: t.completed, createdAt: t.createdAt };
  }

  function loadTodos() {
    return api.getTodos().then(function (items) {
      todos = core.sanitizeItems(items);
      lastSynced = todos.map(cloneItem);
      render();
      return todos;
    }).catch(function (err) {
      // 加载失败时回退为空列表,避免整个应用不可用
      console.error("加载待办数据失败:", err);
      todos = [];
      lastSynced = [];
      render();
      return [];
    });
  }

  function saveTodos() {
    // 计算本地状态与上次已同步快照的差异,逐项调用 CRUD 接口同步
    var prevById = {};
    lastSynced.forEach(function (t) {
      prevById[t.id] = t;
    });
    var currById = {};
    todos.forEach(function (t) {
      currById[t.id] = t;
    });

    var ops = [];
    todos.forEach(function (t) {
      var prev = prevById[t.id];
      if (!prev) {
        ops.push(api.createTodo(t));
      } else if (prev.text !== t.text || prev.completed !== t.completed) {
        ops.push(api.updateTodo(t.id, { text: t.text, completed: t.completed }));
      }
    });
    lastSynced.forEach(function (t) {
      if (!currById[t.id]) {
        ops.push(api.deleteTodo(t.id));
      }
    });

    return Promise.all(ops).then(function () {
      lastSynced = todos.map(cloneItem);
    }).catch(function (err) {
      console.error("保存待办数据失败:", err);
    });
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
    updateEmptyState(visible.length);
  }

  function renderSummary() {
    var completedCount = todos.filter(function (t) { return t.completed; }).length;
    statsCompleted.textContent = completedCount;
    statsTotal.textContent = todos.length;
  }

  function updateEmptyState(visibleCount) {
    if (visibleCount === 0) {
      emptyState.textContent = core.getEmptyStateText(todos, currentFilter);
      emptyState.hidden = false;
    } else {
      emptyState.hidden = true;
    }
  }

  /* ---------- 交互 ---------- */

  function addTodo(text) {
    var next = core.addTodo(todos, text);
    // 空文本/纯空白时不新增,与表单校验保持一致的幂等语义
    if (next.length === todos.length) {
      input.focus();
      return;
    }
    todos = next;
    saveTodos();
    render();
  }

  function toggleTodo(id) {
    var next = core.toggleTodo(todos, id);
    if (next === todos) return; // id 不存在,无变化
    todos = next;
    saveTodos();
    renderSummary();

    // 原地切换该条的完成状态,让 CSS 的划线 + 淡出过渡动画生效(而非整表重绘)
    var li = list.querySelector('[data-id="' + id + '"]');
    if (!li) return;

    var toggled = null;
    for (var i = 0; i < todos.length; i++) {
      if (todos[i].id === id) {
        toggled = todos[i];
        break;
      }
    }
    if (!toggled) return;

    li.classList.toggle("is-completed", toggled.completed);
    var checkbox = li.querySelector(".todo-checkbox");
    if (checkbox) {
      checkbox.checked = toggled.completed;
      checkbox.setAttribute("aria-label", toggled.completed ? "标记为未完成" : "标记为已完成");
    }

    // 切换后不再匹配当前筛选(如"未完成"下勾选)时,过渡结束后移出视图
    var staysInView = core.getVisibleTodos(todos, currentFilter).some(function (t) {
      return t.id === toggled.id;
    });
    if (!staysInView) {
      li.classList.add("is-leaving");
      window.setTimeout(function () {
        li.remove();
        updateEmptyState(getVisibleTodos().length);
      }, TRANSITION_MS);
    }
  }

  function removeTodo(id) {
    var next = core.removeTodo(todos, id);
    if (next.length === todos.length) return; // id 不存在,无变化
    todos = next;
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

  loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    clearError();
    var username = document.getElementById("login-username").value.trim();
    var password = document.getElementById("login-password").value;
    if (!username || !password) {
      showError("请输入用户名和密码");
      return;
    }
    api.login(username, password).then(function (data) {
      input.value = "";
      return showApp(data.username);
    }).catch(function (err) {
      showError(err.message);
    });
  });

  registerForm.addEventListener("submit", function (e) {
    e.preventDefault();
    clearError();
    var username = document.getElementById("register-username").value.trim();
    var password = document.getElementById("register-password").value;
    if (!username) {
      showError("请输入用户名");
      return;
    }
    if (!password || password.length < 6) {
      showError("密码长度至少 6 位");
      return;
    }
    api.register(username, password).then(function (data) {
      input.value = "";
      return showApp(data.username);
    }).catch(function (err) {
      showError(err.message);
    });
  });

  authTabs.forEach(function (btn) {
    btn.addEventListener("click", function () {
      switchAuthTab(btn.dataset.authTab);
    });
  });

  logoutBtn.addEventListener("click", function () {
    api.logout().catch(function () {
      // 即使服务端失败也退出登录
    }).then(function () {
      todos = [];
      lastSynced = [];
      render();
      showAuth();
    });
  });

  /* ---------- 会话失效:统一 401 处理,清 token 回登录页 ---------- */
  if (api) {
    api.onUnauthorized = function () {
      todos = [];
      lastSynced = [];
      render();
      showAuth();
    };
  }

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

  /* ---------- 启动 ---------- */
  // 已有 token 时尝试恢复会话,否则展示登录页
  if (api && api.getToken()) {
    api.getMe().then(function (data) {
      input.value = "";
      return showApp(data.username);
    }).catch(function () {
      api.clearToken();
      showAuth();
    });
  } else {
    showAuth();
  }
})();
