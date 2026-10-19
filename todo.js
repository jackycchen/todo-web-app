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

  /**
   * 增量同步轮询间隔(ms)。默认 5s,可通过 window.TODO_POLL_INTERVAL_MS 覆盖
   * (测试用),上限 10s(验收要求 10 秒内同步)。
   */
  var configuredPoll = typeof window !== "undefined" ? Number(window.TODO_POLL_INTERVAL_MS) : NaN;
  var POLL_INTERVAL_MS =
    Number.isFinite(configuredPoll) && configuredPoll > 0
      ? Math.min(configuredPoll, 10000)
      : 5000;

  /** 同步提示("已在其他设备更新")的展示时长 */
  var NOTICE_MS = 4000;

  /** 待办数组,每项形如 { id, text, completed, createdAt, updatedAt } */
  var todos = [];

  /** 上次成功同步到服务端的快照,用于计算增量 */
  var lastSynced = [];

  /** 增量拉取游标:已见过的最大 updatedAt(服务端毫秒时间戳) */
  var lastSyncAt = 0;

  var pollTimer = null;
  var pollInFlight = false;
  var saveInFlight = 0;
  var saveQueue = Promise.resolve();
  var noticeTimer = null;

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
  var syncNotice = document.getElementById("sync-notice");
  var filterButtons = document.querySelectorAll(".filter-btn");
  var clearCompletedBtn = document.getElementById("clear-completed");

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
    stopPolling();
    authView.hidden = false;
    appView.hidden = true;
  }

  function showApp(username) {
    authView.hidden = true;
    appView.hidden = false;
    if (currentUser) currentUser.textContent = username || "";
    return loadTodos().then(function (items) {
      startPolling();
      return items;
    });
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
    return {
      id: t.id,
      text: t.text,
      completed: t.completed,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt
    };
  }

  function findTodoIndex(id) {
    for (var i = 0; i < todos.length; i++) {
      if (todos[i].id === id) return i;
    }
    return -1;
  }

  function setLastSyncedItem(item) {
    for (var i = 0; i < lastSynced.length; i++) {
      if (lastSynced[i].id === item.id) {
        lastSynced[i] = cloneItem(item);
        return;
      }
    }
    lastSynced.push(cloneItem(item));
  }

  function removeLastSyncedItem(id) {
    lastSynced = lastSynced.filter(function (t) {
      return t.id !== id;
    });
  }

  /** 本地版本是否还有尚未提交到服务端的改动(本地新建也算) */
  function hasUnsyncedChanges(item) {
    for (var i = 0; i < lastSynced.length; i++) {
      if (lastSynced[i].id === item.id) {
        return lastSynced[i].text !== item.text || lastSynced[i].completed !== item.completed;
      }
    }
    return true;
  }

  function trackUpdatedAt(value) {
    if (typeof value === "number" && value > lastSyncAt) lastSyncAt = value;
  }

  function loadTodos() {
    return api.getTodos().then(function (items) {
      todos = core.sanitizeItems(items);
      lastSynced = todos.map(cloneItem);
      lastSyncAt = 0;
      todos.forEach(function (t) {
        trackUpdatedAt(t.updatedAt);
      });
      render();
      return todos;
    }).catch(function (err) {
      // 加载失败时回退为空列表,避免整个应用不可用
      console.error("加载待办数据失败:", err);
      todos = [];
      lastSynced = [];
      lastSyncAt = 0;
      render();
      return [];
    });
  }

  /**
   * 串行保存:计算本地状态与上次已同步快照的差异,逐项调用 CRUD 接口,
   * 并把服务端返回的 updatedAt 合并回本地。串行化避免并发请求互相覆盖,
   * 也让轮询只在没有写入时进行。
   */
  function saveTodos() {
    saveInFlight += 1;
    saveQueue = saveQueue
      .then(doSaveTodos)
      .catch(function (err) {
        console.error("保存待办数据失败:", err);
      })
      .then(function () {
        saveInFlight -= 1;
      });
    return saveQueue;
  }

  function doSaveTodos() {
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
        ops.push({ type: "create", id: t.id, sent: cloneItem(t), promise: api.createTodo(t) });
      } else if (prev.text !== t.text || prev.completed !== t.completed) {
        ops.push({
          type: "update",
          id: t.id,
          sent: cloneItem(t),
          promise: api.updateTodo(t.id, { text: t.text, completed: t.completed })
        });
      }
    });
    lastSynced.forEach(function (t) {
      if (!currById[t.id]) {
        ops.push({ type: "delete", id: t.id, sent: null, promise: api.deleteTodo(t.id) });
      }
    });

    if (!ops.length) return Promise.resolve();

    return Promise.all(ops.map(function (op) {
      return op.promise.then(function (res) {
        if (op.type === "delete") {
          removeLastSyncedItem(op.id);
          return;
        }
        var serverItem =
          res && typeof res === "object" && typeof res.id === "string"
            ? {
                id: res.id,
                text: res.text,
                completed: !!res.completed,
                createdAt: res.createdAt,
                updatedAt: res.updatedAt
              }
            : cloneItem(op.sent);
        trackUpdatedAt(serverItem.updatedAt);
        // 快照记录"服务端已确认的版本",这样请求期间的新本地改动下次仍会被提交
        setLastSyncedItem(serverItem);

        var idx = findTodoIndex(op.id);
        if (idx >= 0) {
          todos[idx].updatedAt = serverItem.updatedAt;
          todos[idx].createdAt = serverItem.createdAt;
        }
      });
    }));
  }

  /* ---------- 多端增量同步(轮询,页面隐藏时暂停) ---------- */

  function isLoggedIn() {
    return !!api && !!api.getToken() && !appView.hidden;
  }

  function startPolling() {
    stopPolling();
    pollTimer = window.setInterval(pollTodos, POLL_INTERVAL_MS);
    // Node 测试环境下避免定时器阻止进程退出
    if (pollTimer && typeof pollTimer.unref === "function") pollTimer.unref();
  }

  function stopPolling() {
    if (pollTimer != null) {
      window.clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function pollTodos() {
    if (!api || document.hidden || pollInFlight || saveInFlight > 0 || !isLoggedIn()) return;
    pollInFlight = true;
    api.getTodos(lastSyncAt)
      .then(function (changes) {
        // 请求期间可能已登出/切到登录页,避免把数据写回已关闭的视图
        if (!isLoggedIn()) return;
        applyRemoteChanges(changes);
      })
      .catch(function (err) {
        console.error("增量同步失败:", err);
      })
      .then(function () {
        pollInFlight = false;
      });
  }

  /**
   * 合并增量变更,last-write-wins:
   *  - 服务端 updatedAt 较新:采用服务端版本,并提示"已在其他设备更新"
   *  - 本地 updatedAt 较新:保留本地版本并重新提交
   *  - 删除墓碑:服务端删除时间不早于本地版本时从本地移除
   */
  function applyRemoteChanges(changes) {
    if (!Array.isArray(changes)) return;

    var changed = false;
    var conflict = false;
    var needPush = false;

    changes.forEach(function (remote) {
      if (!remote || typeof remote !== "object" || typeof remote.id !== "string") return;

      var remoteUpdatedAt = typeof remote.updatedAt === "number" ? remote.updatedAt : 0;
      trackUpdatedAt(remoteUpdatedAt);

      var idx = findTodoIndex(remote.id);
      var local = idx >= 0 ? todos[idx] : null;

      if (remote.deleted) {
        if (!local) {
          removeLastSyncedItem(remote.id);
          return;
        }
        // 本地有未提交改动时先提交,避免轮询打断正在进行的操作
        if (hasUnsyncedChanges(local)) {
          needPush = true;
          return;
        }
        removeLastSyncedItem(remote.id);
        if (remoteUpdatedAt >= (local.updatedAt || 0)) {
          todos.splice(idx, 1);
          changed = true;
          conflict = true;
        } else {
          needPush = true;
        }
        return;
      }

      var remoteItem = {
        id: remote.id,
        text: typeof remote.text === "string" ? remote.text : "",
        completed: !!remote.completed,
        createdAt: remote.createdAt,
        updatedAt: remoteUpdatedAt
      };

      if (!local) {
        todos.push(remoteItem);
        setLastSyncedItem(remoteItem);
        changed = true;
        return;
      }

      var localUpdatedAt = typeof local.updatedAt === "number" ? local.updatedAt : 0;
      if (hasUnsyncedChanges(local)) {
        // 本地改动尚未提交:保留本地版本,稍后提交(本地视角下为更新的写入)
        needPush = true;
      } else if (remoteUpdatedAt > localUpdatedAt) {
        if (local.text !== remoteItem.text || local.completed !== remoteItem.completed) {
          conflict = true;
        }
        todos[idx] = remoteItem;
        setLastSyncedItem(remoteItem);
        changed = true;
      } else if (remoteUpdatedAt === localUpdatedAt) {
        setLastSyncedItem(remoteItem);
      } else {
        needPush = true;
      }
    });

    if (changed) render();
    if (conflict) showSyncNotice();
    if (needPush) saveTodos();
  }

  function showSyncNotice() {
    if (!syncNotice) return;
    syncNotice.textContent = "已在其他设备更新";
    syncNotice.hidden = false;
    if (noticeTimer) window.clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(function () {
      syncNotice.hidden = true;
      noticeTimer = null;
    }, NOTICE_MS);
    if (noticeTimer && typeof noticeTimer.unref === "function") noticeTimer.unref();
  }

  // 页面隐藏时暂停轮询;恢复可见时立即拉取一次并恢复轮询
  if (typeof document.addEventListener === "function") {
    document.addEventListener("visibilitychange", function () {
      if (document.hidden) {
        stopPolling();
      } else if (isLoggedIn()) {
        startPolling();
        pollTodos();
      }
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
    renderClearCompletedButton();
    updateEmptyState(visible.length);
  }

  /** 仅当存在已完成项时,才显示并启用"清除已完成" */
  function renderClearCompletedButton() {
    if (!clearCompletedBtn) return;
    var hasCompleted = todos.some(function (t) { return t.completed; });
    clearCompletedBtn.hidden = !hasCompleted;
    clearCompletedBtn.disabled = !hasCompleted;
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
    renderClearCompletedButton();

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

  function clearCompleted() {
    var next = core.clearCompleted(todos);
    if (next === todos) return; // 没有已完成项:不写入、不重绘
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

  if (clearCompletedBtn) {
    clearCompletedBtn.addEventListener("click", clearCompleted);
  }

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
      lastSyncAt = 0;
      render();
      showAuth();
    });
  });

  /* ---------- 会话失效:统一 401 处理,清 token 回登录页 ---------- */
  if (api) {
    api.onUnauthorized = function () {
      todos = [];
      lastSynced = [];
      lastSyncAt = 0;
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
