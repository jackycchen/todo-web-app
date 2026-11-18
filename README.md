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

## 静态资源暴露范围

静态托管采用**白名单**策略:只有 `server.js` 中 `STATIC_ASSETS` 列出的前端资源
可以被匿名访问,当前包括:

- `/index.html`、`/style.css`、`/todo-core.js`、`/api.js`、`/todo.js`
- `/`(映射到 `index.html`)

除此之外的所有路径(如 `/server.js`、`/lib/**`、`/test/**`、`/package.json`、
`/data/**`)均返回 **404**,不会从磁盘读取或返回源码内容。白名单在
`express.static` 之前生效,因此新增的服务端文件、测试或配置文件默认不会被暴露;
新增前端资源时需要显式加入 `STATIC_ASSETS`。

选择白名单而不是"排除若干敏感路径"的原因:排除法依赖维护者记得把每个新文件
都加进黑名单,漏掉一个就会造成源码泄露;白名单则让未登记的文件默认不可访问,
把安全默认值放在正确的一侧。

## 功能

- 用户名 + 密码注册/登录,**密码最短 12 位,经 scrypt 加盐哈希存储,不保存明文**
- 登录/注册成功下发 `todo_sid` 会话 cookie(`HttpOnly` + `SameSite=Lax`),
  浏览器端不接触也不持久化 token,可降低 XSS 窃取会话的风险;
  API 客户端仍可用 `Authorization: Bearer <token>` 鉴权
- **登录失败限流**:同一 `IP|用户名` 60 秒内失败 5 次后返回
  `429` `{ code: "RATE_LIMITED" }` 并带 `Retry-After`;注册失败按同 IP
  60 秒 10 次限流;成功登录会清零失败计数
- **会话有过期时间**:默认 30 天,可用 `TODO_SESSION_TTL_MS` 覆盖;
  过期 token 一律返回 401,过期记录会被定期清理
- 待办数据按用户在服务端隔离,任何浏览器登录同一账号都能看到同样数据
- 会话失效(任一 API 返回 401)时自动清除本地会话标志并回到登录页,重新登录即可继续
- **多端实时同步**:客户端每 5 秒轮询一次 `GET /api/todos?since=<上次同步时间>`,
  页面隐藏时暂停,恢复可见时立即拉取一次
- **冲突处理(last-write-wins)**:按服务端毫秒级 `updatedAt` 比较,较新的写入胜出;
  本地列表被其他设备改动时在页面上提示「已在其他设备更新」
- **空状态引导**:无待办(或筛选无匹配)时展示插画与引导文案,可直接聚焦输入框添加第一条
- **长列表分页**:超过 20 条时只渲染当前页,滚动到底部自动加载下一页,
  也可用「加载更多」按钮手动追加;分页大小可通过 `window.TODO_PAGE_SIZE` 调整
- **优先级**:每条待办可设为「高 / 普通 / 低」,列表按优先级从高到低展示,
  同级按创建时间升序;修改优先级会刷新 `updatedAt`,可同步到其他端
- **筛选标签**:「全部 / 进行中 / 已完成」三个标签可切换展示集合,选中态带
  `role="tab"` / `aria-selected` 等无障碍属性,并支持方向键切换
- **关键字搜索**:输入关键字后经 250ms 防抖调用 `GET /api/todos?q=`,
  只展示命中项,并可与筛选标签、分页叠加;搜索输入支持中文输入法组合期(不误触发),
  Esc / 清除按钮 / 空状态按钮均可恢复全量视图;搜索词不做持久化,刷新后清除
- **实时计数**:筛选栏下方实时显示「还剩 N 项未完成」,随增删改与多端同步自动更新
- **一键清除已完成**:仅删除已完成项(进行中项不受影响);首次点击进入二次确认,
  再次点击才执行,超时或数据变化会自动取消确认
- 原有 pure-core 逻辑(`todo-core.js`)保持纯函数不变,仍可独立单元测试
- **编辑待办**:双击待办文本进入编辑态(高亮显示),Enter 或失焦保存、Esc 取消;
  空白文本视为取消,不写回服务端;输入法组合期(如中文候选词)的回车不会误提交;
  轮询同步导致整表重绘时会保留编辑态与未提交的输入

## REST API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/healthz` | 健康检查(执行 `SELECT 1` 探活) | 
| GET | `/api/health` | 健康检查(与 `/healthz` 复用同一实现) | 
| POST | `/api/register` | 注册,body `{ username, password }`(密码 ≥ 12 位),返回 `{ token, username, expiresAt }` 并下发 `todo_sid` cookie |
| POST | `/api/login` | 登录,body 同上,返回 `{ token, username, expiresAt }` 并下发 `todo_sid` cookie |
| POST | `/api/logout` | 登出,删除当前会话并清除 cookie(幂等,重复调用仍返回 204) |
| GET | `/api/me` | 获取当前登录用户(需鉴权) |
| GET | `/api/todos` | 列出当前用户全部未删除待办(需鉴权) |
| GET | `/api/todos?since=<ms>` | 增量拉取 `updatedAt > since` 的变更,含删除墓碑(需鉴权) |
| GET | `/api/todos?q=<keyword>` | 按关键字检索当前用户待办(需鉴权;不能与 `since` 同时使用) |
| POST | `/api/todos` | 新建待办,body `{ text, completed?, priority? }`(需鉴权) |
| PATCH | `/api/todos/:id` | 更新待办,body `{ text?, completed?, priority? }`(需鉴权) |
| DELETE | `/api/todos/:id` | 删除待办(软删除,需鉴权) |

待办项数据结构:`{ id, text, completed, priority, createdAt, updatedAt, deleted }`。

优先级 `priority` 取值为整数 `0`(低)/ `1`(普通)/ `2`(高),新待办默认 `1`。
之所以用数值而不是字符串,是因为排序可以直接在 SQL 中完成
(`ORDER BY priority DESC, created_at ASC`),也便于以后插入中间档位;
非法值(字符串、小数、越界整数等)一律返回 400,不会被写入。

服务端输入约束:

- `text` 去除首尾空白后不能为空,且最长 **200 个字符**(与前端 `maxlength=200` 一致;
  服务端独立校验,不能通过绕过前端限制提交超长内容)。
- `id` 与 `createdAt` 完全由服务端生成。客户端在 `POST /api/todos` 中传入的同名字段
  会被忽略,避免伪造 id 覆盖已有数据或伪造创建时间。

`createdAt` / `updatedAt` 均为服务端毫秒时间戳;`since` 必须是非负整数,
非法参数返回 400。

### 载荷与配额限制

- **请求体上限 16KB**:`express.json({ limit: "16kb" })` 显式限制
  (不再使用默认的 100KB),超限返回
  `413` `{ error, code: "PAYLOAD_TOO_LARGE" }`。
- **非法 JSON**:返回 `400` `{ error, code: "INVALID_JSON" }`,
  不再落到 Express 默认的 HTML 错误页。
- **单用户待办配额 1000 条**:只统计未删除待办。达到上限后新建返回
  `409` `{ error, code: "TODO_QUOTA_EXCEEDED", limit }`;
  更新已有条目不受影响,删除后立即释放额度。
  墓碑(已删除记录)不计入配额,因此长期使用不会因历史删除次数累积而撞上限。
  可通过 `openDb(path, { maxTodosPerUser })` 或
  `startServer({ maxTodosPerUser })` 覆盖(主要便于测试与运维调优)。

### 增量同步与删除

- 所有写操作(新增、修改、勾选完成、删除)都会刷新 `updatedAt`
  (进程内单调递增,避免同毫秒写入被 `since` 漏掉)。
- 删除采用 **soft delete tombstone**:数据库保留记录并置 `deleted = 1`,
  删除同样刷新 `updatedAt`。全量接口过滤墓碑,增量接口返回
  `deleted: true` 的条目,其他端据此移除本地项。
- 旧数据库自动迁移:`ALTER TABLE` 新增 `updated_at` / `deleted` / `priority` 列,
  旧记录 `updated_at` 回填为 `created_at`,`priority` 回填为 `1`(普通)。
  因此迁移后未设置优先级的条目仍按 `created_at` 升序,原有列表观感不变。

### 关键字搜索

- **匹配规则**:对 `text` 做子串匹配(SQLite `instr(lower(text), lower(q))`),
  ASCII 字母大小写不敏感;`%`、`_` 按普通字符处理(不是 SQL 通配符)。
  非 ASCII 字符不做额外的大小写折叠(与 `lower()` 的 SQLite 行为一致)。
  只检索当前用户、未删除的条目,排序与全量接口相同
  (`priority DESC, created_at ASC`)。
- **参数约束**:关键字去除首尾空白;空串/纯空白等价于不检索;
  最长 **200 个字符**,超长返回 `400`(不截断,避免产生假命中);
  重复 `q`(被解析为数组)返回 `400`;`q` 与 `since` 互斥,同时使用返回 `400`。
- **前端行为**:输入经 250ms 防抖(可通过 `window.TODO_SEARCH_DEBOUNCE_MS`
  覆盖,测试用),输入法组合期不触发;回车立即检索,清空输入 / 清除按钮 / Esc /
  空状态按钮均可退出搜索。搜索结果以 id 集合投影到本地 canonical 待办上,
  不会成为第二份可变状态,因此写操作、分页、筛选与多端同步的语义保持不变。
- **与筛选/分页/同步的关系**:搜索结果仍套用当前筛选标签并参与分页;
  「还剩 N 项未完成」「清除已完成」维持全局口径,不随搜索收窄。
  搜索期间轮询继续用 `since` 合并增量到 canonical 列表,有变更时延迟 150ms
  重新检索以刷新命中集合;搜索响应不会推进 `lastSyncAt`。搜索结果中本地缺失
  的条目会合并进列表,但本地待删除的条目不会被搜索响应复活。
- **不持久化**:搜索词不写入 URL 或 localStorage,刷新页面后恢复全量视图。

### 会话生命周期

- 登录/注册成功签发 token 时会写入 `created_at` 与 `expires_at`(均为毫秒时间戳),
  响应体同时返回 `expiresAt`。
- `expires_at = created_at + TTL`。会话默认有效期 **30 天**,可用环境变量
  `SESSION_TTL_DAYS`(正数天数)覆盖:

  ```bash
  SESSION_TTL_DAYS=7 npm start
  ```

  TTL 也可通过 `TODO_SESSION_TTL_MS`(毫秒)或 `openDb(dbPath, { sessionTtlMs })`
  配置,非法值回退默认值,上限 1 年。
- 鉴权时同时校验 `created_at` 与 `expires_at`,任一过期即视为无效并返回 401,
  因此 token 不会永久有效;被用于请求的失效 token 会立即删除(惰性清理),
  避免过期行长期堆积。
- 服务启动时清理一次过期会话,之后每小时清理一次;也可通过
  `startServer({ cleanupIntervalMs })` 调整间隔。定时器调用 `unref()`,
  不会阻止进程退出。
- 清理方法为 `deleteExpiredSessions` / `cleanupExpiredSessions`(语义化别名)。
- 登出删除当前会话;重复登出仍返回 204(幂等)。
- 旧数据库自动迁移:`ALTER TABLE sessions ADD COLUMN expires_at`,并按
  `created_at + TTL` 回填,老会话不会全部失效,也不会全部变成永久有效。

## 部署约束与健康检查

### 单实例部署

本应用使用 Node 内置的 `node:sqlite`(`DatabaseSync`),数据库是**进程内**连接:
SQLite 文件由单个服务进程独占写入。同一份 `TODO_DB_PATH` 被多个实例共享时,
并发写入会触发 `SQLITE_BUSY`(连接已设置 `PRAGMA busy_timeout = 5000` 只能缓解短暂争用,
不能解决多写者冲突)。

因此当前版本要求 **单实例部署**:

- 用进程管理器(systemd / Docker restart 策略等)保证只有一个 `node server.js` 写该库文件;
- 需要水平扩容时,先把持久化层换成独立的数据库服务(如 PostgreSQL/MySQL),
  再让多个无状态实例共享它;
- 不要在滚动发布时让新旧实例同时写同一个 `TODO_DB_PATH`。

### 环境变量

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `3000` | HTTP 监听端口 |
| `TODO_DB_PATH` | `data/todo.db` | SQLite 文件路径(目录不存在会自动创建) |
| `TODO_SESSION_TTL_MS` / `SESSION_TTL_DAYS` | 30 天 | 会话有效期 |

```bash
PORT=8080 TODO_DB_PATH=/var/lib/todo/todo.db npm start
```

### `/healthz`

`GET /healthz` 会真实执行一次 `SELECT 1` 探活,适合作为容器/负载均衡的就绪探针;
`GET /api/health` 保留且与它复用同一实现。成功返回 `200`:

```json
{ "ok": true, "db": "ok", "uptimeMs": 123456 }
```

数据库不可用时返回 `503`:

```json
{ "ok": false, "db": "error" }
```

探针请以 **HTTP 状态码** 判断(200 = 就绪,503 = 未就绪),不要只解析 `ok` 字段。

### 会话与密码

- 注册密码最短 **12 位**(上限 128 位),服务端与前端提示保持一致。
- 浏览器会话通过 `Set-Cookie: todo_sid=<token>; Path=/; HttpOnly; SameSite=Lax`
  下发;`Max-Age` 与会话 TTL 一致。仅在直连 HTTPS 或反向代理声明
  `X-Forwarded-Proto: https` 时追加 `Secure`。
- 前端不再把 token 写入 `localStorage`;API 客户端(非浏览器)可继续使用
  `Authorization: Bearer <token>`,服务端两者都接受且 Bearer 优先。

### 已知的部署边界

- 登录/注册限流是**进程内内存**实现,重启后清零,多实例之间也不共享;
  需要跨实例一致限流时应放到反向代理或 Redis 层。
- 页面通过 `connect-src 'self'` 限定同源请求,若把前端与 API 分域名部署,
  需要同时调整 CSP 与 cookie 的 `SameSite`/`Domain` 配置。

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
| `todo-core.js` | 纯逻辑核心(create/add/toggle/edit/remove/filter/sanitize),UMD 兼容浏览器与 Node |
| `api.js` | 前端 API 封装:注册/登录/登出 + 待办 CRUD/关键字搜索,会话由 `todo_sid` HttpOnly cookie 承载 |
| `todo.js` | DOM 渲染、事件绑定、认证流程、搜索投影与防抖;`loadTodos`/`saveTodos` 调用后端 API |
| `server.js` | Express 后端:静态托管 + 认证 + 待办 CRUD,按用户隔离 |
| `lib/db.js` | SQLite 持久化层(users / sessions / todos 三张表) |
| `test/todo-core.test.js` | 核心逻辑单元测试 |
| `test/api.test.js` | 后端 API 集成测试(含 updatedAt / since / 删除同步 / LWW) |
| `test/api-client.test.js` | 前端 API 客户端单元测试(假 fetch,含搜索 URL 编码) |
| `test/frontend.test.js` | 前端端到端测试(DOM 轻量桩,含双端轮询同步与关键字搜索) |
| `test/migration.test.js` | 旧库迁移测试(ALTER TABLE + updatedAt 回填) |
| `test/priority.test.js` | 优先级测试(旧库默认值 / SQL 排序 / 增量同步) |
| `test/session.test.js` | 会话生命周期测试(过期 401 / 惰性删除 / 定时清理 / TTL 解析 / expires_at 迁移) |
| `test/security.test.js` | 安全专项测试(登录/注册限流、密码强度、cookie 会话、安全响应头、CSP、健康检查) |
| `test/db-write.test.js` | 写路径事务测试(并发配额、withTx 回滚、busy_timeout) |

push 验证 2026-10-16
PR 创建验证 2026-10-16