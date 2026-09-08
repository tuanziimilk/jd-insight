/* JD 采集器 · 内容脚本  v1.1
 *
 * 设计原则：
 *   1. 只读取「当前页面已经渲染出来的内容」——不发请求、不翻页、不模拟点击、不破解字体。
 *   2. 字段提取限定在「详情面板」范围内，避免抓到左侧列表的第一张卡片。
 *   3. 无论字段抓得准不准，都额外存一份整页纯文本（pageText）兜底——
 *      真正的字段解析交给 analyze_jd.py，那边改规则比改插件容易。
 *
 * v1.1 修复（2026-09-08 在真实页面实测后）：
 *   - BOSS 已改版为「左列表 + 右内嵌详情面板」，不再跳独立详情页。
 *     新版容器 .job-detail-box / .job-detail-body .desc，老版选择器全部失效。
 *   - ⚠️ 致命 bug：去重 key 原来用 location.href，而新版列表页所有岗位共享
 *     同一个 URL（/web/geek/jobs），导致后存的岗位覆盖先存的，计数永远是 1。
 *     改为用详情链接里的 jobId 做 key。
 *   - 薪资被自定义字体（kanzhun-mix）映射，innerText 只能读到 "-K"。
 *     不破解字形，改为读不到时弹一次输入框让人补——人看一眼就知道，3 秒的事。
 */
(() => {
  "use strict";
  if (window.__jdCollectorLoaded) return;
  window.__jdCollectorLoaded = true;

  const UI_WORDS = /^(收藏|立即沟通|举报|微信扫码分享|分享|投递|继续沟通|已沟通)$/;

  /* BOSS 把薪资数字替换成 Unicode 私有区字符（U+E000–U+F8FF），
   * 靠自定义字体 kanzhun-mix 渲染成数字。这些字符在 DOM 里是真实存在的，
   * 但复制出去就是乱码。这里一律剥掉——不去破解字形映射，
   * 读不到的薪资让人补一次（她此刻正看着页面，读一眼就有）。 */
  const PUA = /[\uE000-\uF8FF]/g;

  const clean = (s) =>
    (s || "")
      .replace(PUA, "")
      .replace(/ /g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const lines = (s) => clean(s).split("\n").map((x) => x.trim()).filter(Boolean);

  // ------------------------------------------------------- 作用域：详情面板
  /** 返回"详情"所在的根节点。新版是右侧内嵌面板，老版是整页。 */
  function scope() {
    const box = document.querySelector(".job-detail-box");
    if (box && clean(box.innerText).length > 200) return { root: box, layout: "panel" };
    const old =
      document.querySelector(".job-detail") ||
      document.querySelector(".job-primary") ||
      document.querySelector(".job-banner");
    if (old) return { root: document, layout: "page" };
    return { root: document, layout: "unknown" };
  }

  /** 只在 root 内找，找不到返回空——绝不回退到全局，否则会抓到列表第一张卡 */
  function pick(root, selectors) {
    for (const sel of selectors) {
      let el;
      try {
        el = root.querySelector(sel);
      } catch (e) {
        continue;
      }
      if (el) {
        const t = clean(el.innerText);
        if (t) return t;
      }
    }
    return "";
  }

  /** 启发式找正文：含"职责/要求"关键词、长度合适、字数最多的块 */
  function findBody(root) {
    let best = "";
    const nodes = (root.querySelectorAll ? root : document).querySelectorAll(
      "div, section, article, dd, li"
    );
    for (const n of nodes) {
      if (n.children.length > 40) continue;
      let t;
      try {
        t = clean(n.innerText);
      } catch (e) {
        continue;
      }
      if (t.length < 150 || t.length > 9000) continue;
      if (!/(职责|要求|任职|加分|我们希望|你将|Responsib|Requirement)/i.test(t)) continue;
      if (t.length > best.length) best = t;
    }
    return best;
  }

  // ------------------------------------------------------- 各字段
  function getJobId(root) {
    const sels = [
      'a[href*="job_detail"]',
      ".job-card-box.selected a[href*='job_detail']",
      ".job-card-wrapper.selected a[href*='job_detail']",
    ];
    for (const s of sels) {
      const a = (root.querySelector && root.querySelector(s)) || document.querySelector(s);
      if (a) {
        const m = (a.getAttribute("href") || "").match(/job_detail\/([A-Za-z0-9_~-]+)\.html/);
        if (m) return m[1];
      }
    }
    // 老版独立详情页：直接从地址栏取
    const m2 = location.pathname.match(/job_detail\/([A-Za-z0-9_~-]+)\.html/);
    return m2 ? m2[1] : "";
  }

  /** "虞女士 / 刚刚活跃 / 时代传浮 · 招聘者" → "时代传浮" */
  function getCompany(root) {
    const raw = pick(root, [
      ".job-boss-info",
      ".company-info a.name",
      ".sider-company .company-name",
      ".company-name",
      ".job-sec-company .company-info a",
    ]);
    if (!raw) return "";
    const ls = lines(raw);
    const withDot = ls.find((l) => l.includes("·") || l.includes("・"));
    if (withDot) return withDot.split(/[·・]/)[0].trim();
    return (ls[ls.length - 1] || "").replace(/(招聘者|HR|人事)$/,"").trim();
  }

  /** 标签行：城市 / 年限 / 学历，剔掉薪资占位和"收藏"这类按钮字 */
  function getTagline(root, title) {
    const raw = pick(root, [
      ".job-detail-header",
      ".job-primary .info-primary p",
      ".job-limit p",
      ".text-desc",
      ".job-tags",
    ]);
    return lines(raw)
      .filter((l) => l !== title)
      .filter((l) => !UI_WORDS.test(l))
      .filter((l) => !/^[-·—\s]*[Kk]?[·\s]*薪?$/.test(l)) // 干掉 "-K" / "-K·薪"
      .slice(0, 6)
      .join(" / ");
  }

  function getSalary(root) {
    const raw = pick(root, [".job-salary", ".salary", ".job-limit .red", ".job-banner .salary"]);
    return { raw, usable: /\d/.test(raw) };
  }

  // ------------------------------------------------------- 提取
  function extract(salaryOverride) {
    const { root, layout } = scope();

    const title =
      pick(root, [".job-name", ".name h1", "h1.name", ".job-title-box .job-title"]) ||
      lines(pick(root, [".job-detail-header", ".job-banner"]))[0] ||
      "";

    let body = pick(root, [
      ".job-detail-body .desc", // ⭐ 新版正文
      ".job-sec-text", // 老版
      ".job-detail-section .desc",
      ".job-detail-body",
      ".job-sec .text",
      ".position-content",
    ]);
    if (body.length < 120) body = findBody(root);

    const sal = getSalary(root);
    const jobId = getJobId(root);

    return {
      jobId,
      key: jobId || location.href.split("?")[0], // 有 jobId 就用它，没有才退回 URL
      url: jobId
        ? "https://www.zhipin.com/job_detail/" + jobId + ".html"
        : location.href.split("#")[0],
      title,
      salary: salaryOverride || (sal.usable ? sal.raw : ""),
      salaryBlocked: !sal.usable && !salaryOverride,
      company: getCompany(root),
      tagline: getTagline(root, title),
      body,
      pageText: clean(document.body.innerText).slice(0, 12000),
      layout,
      site: location.hostname.replace(/^www\./, ""),
      ts: new Date().toISOString().slice(0, 19).replace("T", " "),
    };
  }

  // ------------------------------------------------------- 提示条
  function toast(msg, kind) {
    const old = document.getElementById("jdc-toast");
    if (old) old.remove();
    const d = document.createElement("div");
    d.id = "jdc-toast";
    d.className = "jdc-toast" + (kind ? " jdc-" + kind : "");
    d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 3000);
  }

  // ------------------------------------------------------- 保存
  function save() {
    let rec = extract();

    if (!rec.title && rec.body.length < 120) {
      toast("没抓到岗位内容 —— 先点开一个岗位的详情再存", "warn");
      return;
    }

    // 薪资被字体反爬挡住 → 让人补一次（她此刻正看着页面，读一眼就有）
    if (rec.salaryBlocked) {
      const v = window.prompt(
        "薪资被 BOSS 的字体反爬挡住了，页面上显示多少就填多少（可直接回车跳过）：\n\n" +
          (rec.title || "") +
          "　" +
          (rec.company || ""),
        ""
      );
      if (v && v.trim()) rec = extract(v.trim());
    }

    chrome.storage.local.get({ jds: [] }, ({ jds }) => {
      const i = jds.findIndex((x) => x.key === rec.key);
      const isNew = i < 0;
      if (isNew) jds.push(rec);
      else jds[i] = rec;
      chrome.storage.local.set({ jds }, () => {
        const label = (rec.title || "这条").split("\n")[0].slice(0, 16);
        const warn = rec.salaryBlocked ? "（薪资空缺）" : "";
        toast(
          (isNew ? "已存 · " : "已更新 · ") + label + warn + "　共 " + jds.length + " 条",
          isNew ? "ok" : "warn"
        );
        btn.classList.add("jdc-saved");
        setTimeout(() => btn.classList.remove("jdc-saved"), 1200);
      });
    });
  }

  // ------------------------------------------------------- 按钮
  const btn = document.createElement("button");
  btn.id = "jdc-btn";
  btn.className = "jdc-btn";
  btn.type = "button";
  btn.title = "存下当前打开的这条 JD（Alt+S）";
  btn.innerHTML = '<span class="jdc-plus">+</span><span class="jdc-label">存 JD</span>';
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    save();
  });

  function mount() {
    if (!document.body) return;
    if (!document.body.contains(btn)) document.body.appendChild(btn);
  }
  mount();
  // 单页应用切换岗位时按钮可能被清掉，兜一下
  new MutationObserver(mount).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  window.addEventListener("keydown", (e) => {
    if (e.altKey && (e.key === "s" || e.key === "S")) {
      e.preventDefault();
      save();
    }
  });

  // 兜底通道：页面焦点在 iframe / 输入框时，页面级 keydown 收不到，
  // 由 background 的快捷键转发过来。
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "JDC_SAVE") save();
  });
})();
