/**
 * 首帧前应用持久化的主题选择,避免刷新时闪错配色。
 *
 * 单独成文件而不是内联 <script>:CSP 只允许 script-src 'self',
 * 内联脚本会被浏览器拦掉。此文件必须保持在 <head> 中同步加载。
 */
(function () {
  "use strict";
  try {
    var theme = localStorage.getItem("todo-app.theme");
    if (theme === "dark" || theme === "light") {
      document.documentElement.dataset.theme = theme;
    }
  } catch (err) {
    // localStorage 不可用时静默回退到系统主题
  }
})();
