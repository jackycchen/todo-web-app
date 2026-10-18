/**
 * 前端 API 封装:账号注册/登录/登出 + 待办 CRUD
 *
 * 依赖浏览器原生 fetch,Token 使用 localStorage 持久化,
 * 每次请求通过 Authorization: Bearer <token> 携带。
 */
(function (root) {
  "use strict";

  var TOKEN_KEY = "todo-app.token";

  // 允许通过 window.TODO_API_BASE 覆盖 API 前缀(测试/子路径部署用)
  var API_BASE = String((root.TODO_API_BASE || "")).replace(/\/+$/, "");

  function getToken() {
    try {
      return root.localStorage.getItem(TOKEN_KEY) || null;
    } catch (err) {
      return null;
    }
  }

  function setToken(token) {
    try {
      if (token) {
        root.localStorage.setItem(TOKEN_KEY, token);
      } else {
        root.localStorage.removeItem(TOKEN_KEY);
      }
    } catch (err) {
      // localStorage 不可用时静默忽略
    }
  }

  function request(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    var token = getToken();
    if (token) headers["Authorization"] = "Bearer " + token;
    if (opts.body && !headers["Content-Type"]) {
      headers["Content-Type"] = "application/json";
    }
    return fetch(API_BASE + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body
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
          // 会话失效:统一清除本地 token,并通知页面回到登录页
          setToken(null);
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

  function withToken(promiseData) {
    return promiseData.then(function (data) {
      if (data && data.token) setToken(data.token);
      return data;
    });
  }

  var api = {
    // 页面层在加载时注册:任一请求返回 401 时被调用
    onUnauthorized: null,
    getToken: getToken,
    setToken: setToken,
    clearToken: function () {
      setToken(null);
    },
    register: function (username, password) {
      return withToken(post("/api/register", { username: username, password: password }));
    },
    login: function (username, password) {
      return withToken(post("/api/login", { username: username, password: password }));
    },
    logout: function () {
      return request("/api/logout", { method: "POST" }).catch(function () {
        // 即使服务端失败也清除本地 token
      }).then(function () {
        setToken(null);
      });
    },
    getMe: function () {
      return request("/api/me");
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
    createTodo: function (item) {
      return post("/api/todos", item);
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
