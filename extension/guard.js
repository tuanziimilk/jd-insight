/* 页面级错误守卫（情报台 / 设置页）。
 *
 * ⚠️ 为什么需要它：2026-09-10 sidepanel.js 里一个字符串字面量含了真换行，
 * 整个模块不加载。表现是「点设置没反应、输入框不响应」——
 * 页面**长得完全正常**，因为静态 HTML 照样渲染，只是没有任何东西被接线。
 * 从界面上完全看不出这是一个语法错误，用户报的是"设置页打不开"，
 * 而真正的故障在另一个文件里。排查方向被带偏了一整轮。
 *
 * popup 早在更早一次白屏之后就有 popup-guard.js 了，
 * 但情报台和设置页一直没有——同一个坑挖了第二遍。
 *
 * 三个约束（和 popup-guard.js 同源，理由也一样）：
 *   1. 这是**普通脚本**不是 module，且必须排在页面主脚本前面 ——
 *      module 的加载/求值错误也能被 window.onerror 捕获到。
 *   2. 捕获到就把错误**写进界面**，而不是只写 console ——
 *      MV3 扩展页面的 console 要右键检查才看得到，而人只会看到"没反应"。
 *   3. MV3 的 CSP 禁止扩展页面用内联 <script>，所以只能单独一个文件。
 */
(function () {
  "use strict";
  var shown = false;

  function banner(title, detail) {
    if (shown) return;
    shown = true;
    try {
      var box = document.createElement("div");
      box.setAttribute("role", "alert");
      box.style.cssText = [
        "position:fixed", "left:0", "right:0", "top:0", "z-index:99999",
        "padding:10px 12px",
        "font:12.5px/1.55 -apple-system,'Segoe UI','Microsoft YaHei',sans-serif",
        "background:#f8e5e2", "color:#bd2521",
        "border-bottom:2px solid #bd2521",
        "white-space:pre-wrap", "word-break:break-word",
      ].join(";");
      // 刻意用硬编码颜色不用 theme.css 的 token：
      // 守卫要在「样式表也没加载成功」的情况下照样可读。
      box.textContent =
        "这个页面的脚本没跑起来，界面上的按钮不会有反应。\n" +
        title + "\n" + (detail || "") +
        "\n\n先刷新一次；如果还这样，就是代码问题（不是你的操作问题）。";
      (document.body || document.documentElement).appendChild(box);
    } catch (e) {
      /* 连插一个 div 都失败就没别的办法了。不再抛，避免掩盖原始错误。 */
    }
  }

  window.addEventListener("error", function (e) {
    var where = e.filename
      ? String(e.filename).split("/").pop() + ":" + e.lineno
      : "（位置未知）";
    banner((e.message || "脚本错误") + "　" + where,
      e.error && e.error.stack ? String(e.error.stack).split("\n")[1] || "" : "");
  });

  window.addEventListener("unhandledrejection", function (e) {
    var r = e && e.reason;
    banner("有一个 Promise 出错没被接住：" + (r && r.message ? r.message : String(r)));
  });
})();
