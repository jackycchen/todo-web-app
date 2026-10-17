自动验证于 2026-10-16

# todo-web-app

网页版待办清单应用,现已升级为**多用户版本**:前端 + 后端 API + SQLite 持久化。
需要先启动后端服务器,再打开页面。

## 运行

需要 Node.js >= 22.5(后端使用内置的 `node:sqlite`)。

```bash
# 1. 安装依赖
npm install

# 2. 启动服务器(同时托管前端静态页面与 REST API)
npm start
# 默认监听 http://localhost:3000,可用 PORT 环境变量覆盖:
# PORT=8080 npm start
```

启动后打开 <http://localhost:3000> 即可注册/登录使用。
数据保存在服务端 SQLite 文件 `data/todo.db`(首次启动自动创建)。

## 功能

- 用户名 + 密码注册/登录,**密码经 scrypt 加盐哈希存储,不保存明文**
- 登录后返回会话 token,后续请求通过 `Authorization: Bearer <token>` 鉴权
- 待办数据按用户在服务端隔离,任何浏览器登录同一账号都能看到同样数据
- 原有 pure-core 逻辑(`todo-core.js`)保持纯函数不变,仍可独立单元测试

## REST API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查 | 
| POST | `/api/register` | 注册,body `{ username, password }`,返回 `{ token, username }` |
| POST | `/api/login` | 登录,body 同上,返回 `{ token, username }` |
| POST | `/api/logout` | 登出(需鉴权) |
| GET | `/api/me` | 获取当前登录用户(需鉴权) |
| GET | `/api/todos` | 列出当前用户待办(需鉴权) |
| POST | `/api/todos` | 新建待办,body `{ text, id?, completed?, createdAt? }`(需鉴权) |
| PATCH | `/api/todos/:id` | 更新待办,body `{ text?, completed? }`(需鉴权) |
| DELETE | `/api/todos/:id` | 删除待办(需鉴权) |

待办项数据结构与 `todo-core.js` 一致:`{ id, text, completed, createdAt }`。

## 单元与集成测试

核心逻辑测试独立在 `todo-core.js`,后端 API 与前端端到端测试
各自使用独立的临时 SQLite 数据库,不影响仓库数据。**无需额外依赖**:

```bash
npm test
# 等价于 node --test test/*.test.js
```

单独运行:
- `npm run test:core` — todo 核心逻辑纯函数测试
- `npm run test:api`   — 后端 API 集成测试(注册/登录/CRUD/多用户隔离)

## 代码结构

| 文件 | 说明 |
|---|---|
| `index.html` | 页面入口,依次加载 `todo-core.js`、`api.js`、`todo.js` |
| `todo-core.js` | 纯逻辑核心(create/add/toggle/remove/filter/sanitize),UMD 兼容浏览器与 Node |
| `api.js` | 前端 API 封装:注册/登录/登出 + 待办 CRUD,Token 存 localStorage |
| `todo.js` | DOM 渲染、事件绑定、认证流程;`loadTodos`/`saveTodos` 改为调用后端 API |
| `server.js` | Express 后端:静态托管 + 认证 + 待办 CRUD,按用户隔离 |
| `lib/db.js` | SQLite 持久化层(users / sessions / todos 三张表) |
| `test/todo-core.test.js` | 核心逻辑单元测试 |
| `test/api.test.js` | 后端 API 集成测试 |
| `test/frontend.test.js` | 前端端到端测试(DOM 轻量桩) |

push 验证 2026-10-16
PR 创建验证 2026-10-16