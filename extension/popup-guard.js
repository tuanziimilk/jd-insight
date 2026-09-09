/* popup 的错误守卫。
 *
 * 为什么需要它：popup.html 的 #list 静态内容就是"还没有存任何 JD"，
 * 而 popup.js 是 module、最后一行才调用 load()。中间任何一处抛错
 * （某个 id 拿不到、某个模块加载失败、某个导出名写错），
 * load() 就永远执行不到，界面停在初始状态——看起来完全等同于"你没有数据"。
 *
 * 真实踩坑：存储里明明有 1 条（内容脚本的提示都写着"共 1 条"），
 * popup 却显示 0 条 + "还没有存任何 JD"，无从判断是数据没存进去
 * 还是界面没读出来。这两件事的排查方向完全相反。
 *
 * 所以：
 *   1. 这是**普通脚本**不是 module，且排在 popup.js 前面 ——
 *      module 的加载/求值错误也能被 window.onerror 捕获到。
 *      （MV3 的 CSP 禁止扩展页面用内联 <script>，只能单独一个文件。）
 *   2. 捕获到就把错误写进界面，而不是只写 console ——
 *      console 要右键检查才看得到，而人只会看到"没数据"。
 */
(function () {
  "use strict";
  var shown = false;

  function fatal(what, detail) {
    if (shown) return; // 只报第一个错，后续的都是它的连带后果
    shown = true;
    var msg = String(detail && detail.stack ? detail.stack : detail || "未知错误");
    var list = document.getElementById("list");
    if (list) {
      list.textContent = "";
      var box = document.createElement("div");
      box.className = "empty";
      box.style.cssText = "color:var(--stop);text-align:left;white-space:pre-wrap;word-break:break-all;font-size:11px;line-height:1.5;";
      // textContent 而不是 innerHTML：错误信息里可能带页面内容，不给它执行机会
      box.textContent =
        "⚠ 界面脚本出错，数据没能读出来（这不代表没有数据）\n\n" + what + "\n" + msg.slice(0, 600);
      list.appendChild(box);
    }
    var n = document.getElementById("n");
    if (n) n.textContent = "?";
  }

  window.addEventListener("error", function (e) {
    // 资源加载失败（script/img）没有 e.error，只有 target
    if (e && e.target && e.target !== window && e.target.src) {
      fatal("加载失败：" + e.target.src, "这个文件不存在或被 CSP 挡住了");
      return;
    }
    fatal("运行出错", (e && (e.error || e.message)) || "");
  });

  window.addEventListener("unhandledrejection", function (e) {
    fatal("异步出错（未捕获的 Promise）", e && e.reason);
  });

  /* 兜底：正常情况下 popup.js 会在 1 秒内把 #list 填上内容。
   * 到点还是初始那句静态文案，说明脚本压根没跑到 load()，而且
   * 没抛出能被上面两个监听器捕获的错误（比如根本没加载）。 */
  setTimeout(function () {
    if (shown) return;
    var list = document.getElementById("list");
    if (list && /还没有存任何 JD/.test(list.textContent) && !list.dataset.rendered) {
      fatal("popup.js 似乎没有执行", "检查 popup.html 里的 script 标签路径，或右键此弹窗 → 检查 看 Console");
    }
  }, 1200);
})();
