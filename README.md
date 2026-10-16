自动验证于 2026-10-16

# todo-web-app

网页版待办清单应用。纯静态页面,打开 `index.html` 即可使用。

## 运行

直接双击或通过任意静态服务器打开 `index.html`,无构建步骤、无依赖。

```bash
# 本地起一个静态服务器
python3 -m http.server 8000
# 然后访问 http://localhost:8000
```

## 单元测试

核心逻辑(add/toggle/remove)独立在 `todo-core.js`,可脱离浏览器进行单元测试。
测试位于 `test/`,使用 Node 内置的 `node:test` 运行器,**无需安装任何依赖**,要求 Node >= 18。

```bash
npm test
# 等价于 node --test test/*.test.js
```

若未提供 Node 环境,或只想单独跑测试文件:

```bash
node --test test/todo-core.test.js
```

## 代码结构

| 文件 | 说明 |
|---|---|
| `index.html` | 页面入口,依次加载 `todo-core.js` 与 `todo.js` |
| `todo-core.js` | 纯逻辑核心(create/add/toggle/remove/filter/sanitize),UMD 兼容浏览器与 Node |
| `todo.js` | DOM 渲染、事件绑定、localStorage 持久化,调用 `TodoCore` 完成核心操作 |
| `test/todo-core.test.js` | 核心逻辑单元测试 |
