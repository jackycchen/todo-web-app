# 分支整合报告:todo-web-app open PR 收敛

- 日期:2026-11-17
- 工作区:`/workspaces/admin/jackycchen-todo-web-app-main`
- 当前任务分支:`main`(本地,**未 push**)
- 整合前基线:`origin/main` = `7ec11c8`

## 1. 合并顺序与执行的 git 命令

```bash
git fetch origin agent/p0-hardening-20261116 agent/fms-1013-todo-search agent/task-f41b8bbf

# 第 1 步:PR #44
git merge --no-ff origin/agent/p0-hardening-20261116 -m "merge: PR #44 P0 安全加固"
# 输出:Already up to date.

# 第 1 步:PR #43
git merge --no-ff origin/agent/fms-1013-todo-search -m "merge: PR #43 关键字搜索"
# 输出:Auto-merging lib/db.js / server.js / test/api.test.js
#       Merge made by the 'ort' strategy. 3 files changed, 177 insertions(+), 11 deletions(-)
```

### PR #44 的实际情况(重要)

工作区本地 `main` 的 tip 已经是 `79ef1d3`(即 `origin/agent/p0-hardening-20261116`
的同一个 commit),而 `origin/main` 仍停在 `7ec11c8`。因此合并 #44 得到
`Already up to date`,不是遗漏:整合基线上已经包含 #44 的全部内容。
已用测试数量(整合前 158 条全绿)与线上响应头实测交叉确认这一点。

### 最终 commit 列表

| commit | 说明 |
|---|---|
| `79ef1d3` | PR #44 P0 安全加固(整合前已位于本地 main tip,非本次新产生) |
| `9c4acfb` | `merge: PR #43 关键字搜索`(merge commit,父提交 `79ef1d3` + `873709d`) |
| `ed37c83` | `test: 搜索用例密码常量提升到 12 位以匹配 P0 安全策略` |
| 本报告所在 commit | `docs: 新增三 PR 整合报告`(`MERGE-REPORT.md`) |

## 2. 冲突与语义决策逐条记录

git 未产生任何文本冲突(两个 PR 的改动区域不同,ort 自动合并成功)。但按要求
逐处做了语义核对,不把「自动合并成功」当作正确:

1. **`server.js` `GET /api/todos`(#43 × #44)**
   - 决策:完整保留 #43 的 `q` 处理与 `q`/`since` 互斥分支;#44 未改动该路由,
     合并后 `since` 路径仍走 `store.getChangedTodos`。
   - 核对:`server.js:463-501`;空白 `q` + `since` 仍按增量语义返回(测试
     `q 与 since 同时出现返回 400,空白 q 不触发冲突` 通过)。
2. **`lib/db.js`(#43 × #44)**
   - 决策:保留 #43 新增的 `selectTodosByKeyword`(`lib/db.js:246-251`)与
     `searchTodos`(`lib/db.js:344-350`),同时保留 #44 的 `withTx`
     (`lib/db.js:303`)与 `insertTodo` 内「配额 count + insert 同事务」的原子性
     (`lib/db.js:413-420`)。
   - 核对:grep 确认无重复定义;`db-write.test.js` 事务用例全绿。
3. **`test/api.test.js`(#43 × #44,语义冲突)**
   - 现象:合并后 #43 的 8 条测试全部失败,`401 !== 200`。
   - 根因:用例用 9 位密码 `secret123` 注册,而 #44 已把
     `PASSWORD_MIN_LENGTH` 提到 12(`server.js:35`),注册返回 400、
     `ensureUser` 拿不到 token。
   - 决策:**以安全策略为准修测试**。把这 8 条用例的密码常量改为仓库其余用例
     已在用的 `secret1234567`(13 位);未改 `PASSWORD_MIN_LENGTH`、未删测试、
     未加 skip、未放宽断言。共 9 处替换(`ed37c83`)。
4. **请求体/配额中间件(#36 等价实现 × #43)**
   - #43 只新增 `q` 解析,未触碰 `express.json({ limit: "16kb" })`
     (`server.js:332`)与统一 JSON 错误中间件(`server.js:593-612`),
     #36 等价能力完整保留,未产生第二套配额检查。
5. **安全响应头中间件顺序**
   - 核对:`server.js:324-330` 的安全头中间件仍在 `express.json()` 之前
     (`server.js:332`),API 与静态资源均覆盖(实测见 §4)。

## 3. PR #36 六项验收核验(结论:全部已成立,不合并)

#36 的提交 `8e2b83e` 从未删除,其内容已通过 `122aae0` 进入 main 历史
(`b72ecb2` "merge: PR #41 …(含 #36 #39 #40)")。因此不重复实现,避免两套配额
检查与重复错误中间件。

| # | 验收点 | 代码位置 | 实测证据 |
|---|---|---|---|
| a | 显式 16kb 上限 | `server.js:33` `JSON_BODY_LIMIT = "16kb"`;`server.js:332` `express.json({ limit: JSON_BODY_LIMIT })` | 代码确认,无默认 100kb |
| b | 超限 413 `PAYLOAD_TOO_LARGE` | `server.js:595-599` | 17KB 注册体 → `status=413` `{"error":"请求体过大,最大允许 16kb","code":"PAYLOAD_TOO_LARGE"}` |
| c | 非法 JSON 400 `INVALID_JSON` | `server.js:601-605` | `POST /api/todos` 体 `{"text":` → `status=400` `{"error":"请求体不是合法的 JSON","code":"INVALID_JSON"}` |
| d | 配额上限 409 + `limit` | `lib/db.js:266`(`COUNT ... deleted = 0`)、`lib/db.js:418-420`、`server.js:530-535` | `maxTodosPerUser=3` 起真实服务:前 3 条 201,第 4 条 → `409 {"code":"TODO_QUOTA_EXCEEDED","limit":3}` |
| e | 覆盖不占额度;删除后释放 | `lib/db.js:410-420` 只在「新 id 或复活墓碑」时计数;`lib/db.js:280` 软删除 | 满额时 `PATCH /api/todos/:id` → `200`;`DELETE` → `204` 后新建 → `201`;再建 → `409`;列表始终 `count=3` |
| f | README 说明 | `README.md:107-119` | 「载荷与配额限制」小节含 16KB、413/400 错误码、1000 条配额、`maxTodosPerUser` 覆盖方式 |

补充:「清理已完成项」当前没有批量接口(仅 `DELETE /api/todos/:id`),其效果等价于
逐条删除已完成项,已由 e 的删除后释放额度实测覆盖。

## 4. 测试与实测结果

### 自动化测试

```
node --test test/*.test.js
ℹ tests 166
ℹ pass 166
ℹ fail 0
ℹ skipped 0
```

166 = #44 的 158 + #43 的 8,与预期一致。当前 Node 24。

### 手工 curl 实测(真实 `startServer`,端口 3901,临时库)

注:环境有 egress 代理,所有请求均用 `curl --noproxy '*'` 直连本地。

```
healthz=200
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Referrer-Policy: no-referrer
theme-init.js=200

17KB 请求体           -> 413 PAYLOAD_TOO_LARGE
坏 JSON              -> 400 INVALID_JSON
create1..3           -> 201 201 201
create4 (quota=3)    -> 409 TODO_QUOTA_EXCEEDED limit=3
PATCH 已有条目(满额)  -> 200
DELETE               -> 204
DELETE 后新建         -> 201
再新建(满额)          -> 409 TODO_QUOTA_EXCEEDED limit=3
```

## 5. 原 PR 处置建议(由人工执行)

| PR | 建议 | 关闭时请注明 |
|---|---|---|
| #44 | 内容已在本地整合分支(其 head 即整合基线 tip),可关闭 | 「已随整合分支落地,head commit `79ef1d3` 已在 main 线」 |
| #43 | 已合并且测试修复(密码常量)在 `ed37c83`,可关闭 | 「已合并;8 条测试因 #44 的 12 位密码策略调整了测试常量,安全策略未放宽」 |
| #36 | **建议关闭,不合并** | 「其内容已通过 `122aae0` / merge `b72ecb2`(PR #41)以等价方式实现;实测 16kb/413/400/409 均成立,无需重复合并」 |

## 6. 遗留风险与未覆盖项

1. **#43 描述中的前端搜索框不在该分支内**:`873709d` 实际只改
   `server.js`、`lib/db.js`、`test/api.test.js`(3 文件),仓库中
   `index.html` / `todo.js` / `api.js` 没有任何搜索输入框或 `q` 参数调用。
   按「本次不开发新特性」的约束未补实现,若产品需要 UI 搜索需另开 PR。
2. **配额并发**:`insertTodo` 的 count+insert 已在 `BEGIN IMMEDIATE` 事务内,单进程
   安全;多进程/多实例共享同一 SQLite 文件仍不在支持范围(README 已注明单实例约束)。
3. **限流为进程内存实现**:重启清零、多实例不共享;这是 #44 的既定设计。
4. **本地 `main` 领先 `origin/main`**:交付依赖 hook 推送当前分支;未手动 push,
   未修改任何既有远端分支。
5. 未关闭/评论任何 PR;`.github` 与依赖未改动。
