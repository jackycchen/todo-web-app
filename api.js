/**
 * 前端 API 封装:账号注册/登录/登出 + 待办 CRUD
 *
 * 依赖浏览器原生 fetch。会话由服务端下发的 HttpOnly cookie(todo_sid)承载,
 * 前端不接触、也不持久化 token;每个请求以 credentials: "same-origin" 携带 cookie,
 * 因此 XSS 无法从 localStorage 读取会话凭据。
 */
(function (root) {
  "use strict";

  // 允许通过 window.TODO_API_BASE 覆盖 API 前缀(测试/子路径部署用)
  var API_BASE = String((root.TODO_API_BASE || "")).replace(/\/+$/, "");

  // 仅表示「本次页面生命周期内已确认登录」,不落盘;
  // 刷新后由 getMe() 向服务端重新确认。
  var sessionActive = false;

  function hasSession() {
    return sessionActive;
  }

  function request(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if (opts.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    return fetch(API_BASE + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body,
      // 同源请求携带 HttpOnly cookie;跨源部署需要显式配置反向代理与 CORS
      credentials: "same-origin"
    }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        if (text) {
          try {
            data = JSON.parse(text);
          } catch (err) {
            data = null;
          }
        }
        if (res.status === 401) {
          // 会话失效:清除内存标志,并通知页面回到登录页
          sessionActive = false;
          if (typeof api.onUnauthorized === "function") {
            api.onUnauthorized();
          }
        }
        if (!res.ok) {
          var err = new Error((data && data.error) || ("请求失败: HTTP " + res.status));
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  }

  function post(path, body) {
    return request(path, { method: "POST", body: JSON.stringify(body || {}) });
  }

  function patch(path, body) {
    return request(path, { method: "PATCH", body: JSON.stringify(body || {}) });
  }

  function del(path) {
    return request(path, { method: "DELETE" });
  }

  // 登录/注册成功后,服务端已通过 Set-Cookie 建立会话
  function markSession(promiseData) {
    return promiseData.then(function (data) {
      sessionActive = true;
      return data;
    });
  }

  var api = {
    // 页面层在加载时注册:任一请求返回 401 时被调用
    onUnauthorized: null,
    hasSession: hasSession,
    register: function (username, password) {
      return markSession(post("/api/register", { username: username, password: password }));
    },
    login: function (username, password) {
      return markSession(post("/api/login", { username: username, password: password }));
    },
    logout: function () {
      return request("/api/logout", { method: "POST" })
        .catch(function () {
          // 即使服务端失败也清除本地会话标志
        })
        .then(function () {
          sessionActive = false;
        });
    },
    getMe: function () {
      // 启动时用它恢复会话:200 表示 cookie 仍有效,401 由统一逻辑处理
      return markSession(request("/api/me"));
    },
    /**
     * 拉取待办。不传 since 时为全量;传入毫秒时间戳时只拉取该时间之后的变更
     * (变更数组可能包含 deleted:true 的删除墓碑)。
     */
    getTodos: function (since) {
      if (since === undefined || since === null) {
        return request("/api/todos");
      }
      return request("/api/todos?since=" + encodeURIComponent(String(since)));
    },
    /**
     * 按关键字检索待办(GET /api/todos?q=)。
     * 服务端对英文大小写不敏感,并把 % / _ 当作字面量。
     * 只发送 q 参数:q 与 since 互斥,检索是全量语义而非增量同步;
     * 空白关键字等价于不检索,直接请求全量列表。
     */
    searchTodos: function (keyword) {
      var query = keyword == null ? "" : String(keyword).trim();
      if (!query) {
        return request("/api/todos");
      }
      return request("/api/todos?q=" + encodeURIComponent(query));
    },
    createTodo: function (item) {
      // id / createdAt 由服务端生成,前端只提交用户可控的业务字段。
      // priority 缺省时不提交,由服务端按「普通」处理。
      var body = {
        text: item && item.text,
        completed: !!(item && item.completed)
      };
      if (item && item.priority !== undefined) body.priority = item.priority;
      return post("/api/todos", body);
    },
    updateTodo: function (id, patchData) {
      return patch("/api/todos/" + encodeURIComponent(id), patchData);
    },
    deleteTodo: function (id) {
      return del("/api/todos/" + encodeURIComponent(id));
    }
  };

  root.TodoApi = api;
})(window);
