/* JD 采集器 · 内容脚本  v1.5.1
 *
 * v1.5.1（2026-09-09）：识别「插件刚更新过」这种失效状态。
 *   在 chrome://extensions 点刷新重载插件后，已打开的页面里那份 content.js
 *   还在跑但连接已断，任何 chrome.* 调用都抛 "Extension context invalidated"。
 *   实测就出现过一次「列表页点存 JD 一直失败，只能绕道点进详情页保存」，
 *   而真正要做的只是按 F5。原文错误对人毫无指导意义，现在换成该做的动作。
 *   storage 的两个回调里也各查一次 lastError——回调里的异常进不了
 *   save() 外面那层 catch，只查外层等于漏掉真正会失败的地方。
 *
 *   同时实测确认（这条别再反复试了）：列表版面上**卡片里的薪资也是私有区
 *   字符**，每个 6 个 PUA 码位，文本层面就是 "-K·薪"。屏幕上能看到
 *   25-50K·15薪 是 kanzhun-mix 字体把码位画成了数字。页面上也没有暴露
 *   Vue 实例或全局初始状态可以绕（__vue__ / __vueParentComponent /
 *   __INITIAL_STATE__ 全都没有）。所以列表页的「薪资待补」是准确的，
 *   不是漏抓。
 *
 * v1.5（2026-09-09，在真实 BOSS 列表页上实测后写的）：
 *   存 JD 现在抓「鼠标最后停留过的那张卡」，面板不是那条就先自动切过去，
 *   不用再手工点开一遍。
 *
 *   ⚠️ 实测顺带发现一个静默错数据：BOSS 的 /web/geek/jobs 一落地就把
 *   **列表第一条**预加载进右侧面板，而且从不给任何卡片加 .selected
 *   （15 张卡的 class 完全一样）。也就是说 v1.4 及之前，你在看第 7 条、
 *   按下存 JD，存下来的是第 1 条，界面上没有任何提示。
 *   这同时说明 getJobId 里那个「取 .selected 卡」的兜底在现在的版面上是死代码
 *   （留着是给老版布局兜底，不是现在生效的路径）。
 *
 *   ⚠️ 更严重的一个（也是 v1.3 我自己埋的）：BOSS 列表页的外层容器叫
 *   div.job-recommend-result > div.recommend-result-job，v1.3 为了跳过
 *   「相似职位」加的 [class*='recommend'] 通配命中了**整页外壳**，
 *   于是 pick() 把标题/正文/薪资全部当成推荐位跳过。实测同一个面板：
 *   带过滤时标题和正文都是空串，不带过滤才拿到「Ai产品经理（教育行业）」+
 *   完整职责。也就是说在列表页上按存 JD 一直报「没抓到岗位内容」，
 *   面板其实开着好好的。改成 inReco()：命中 RECO_SEL 的祖先如果把详情区
 *   整个包在里面，它就是页面外壳而不是推荐位。
 *
 *   「切到哪一条」只认真实信号：鼠标**停留** 400ms 以上的那张卡。列表上有
 *   15~30 张，猜错就是存下一条你从没看过的岗位；而且鼠标从列表移到按钮的
 *   路上会横穿好几张卡，一掠过就记同样会存错，所以要停留判定。
 *   拿不到这个信号就退回用面板里现有的内容，不替你选第一张。
 *   等面板的判据是「面板里的 job_detail id == 目标 id」，不是「文字够长」——
 *   换面板时旧内容还在，长度判据会骗人。
 *
 * v1.4（2026-09-09）：按钮位置改成「拖到哪就记在哪」。
 *   原来是 CSS 固定 right:22px / bottom:96px，实测在 BOSS 详情页右下角
 *   正好压在它自己那摞悬浮组件（回到顶部/客服/反馈）上，看不见也点不准。
 *   换一个「更好的固定位置」是没有终点的——屏幕尺寸、页面缩放、BOSS 改版
 *   都会让它重新撞上，所以不再由我猜：位置存在 chrome.storage.local.btnPos，
 *   用户拖一次就定死。默认落在右侧边缘、视口 62% 高度处（这块区域在详情页
 *   上是空的，且离底部那摞组件足够远）。
 *   拖动判定用 4px 阈值，低于阈值仍然算点击（否则手抖就存不上 JD）；
 *   拖完那一次的 click 用捕获阶段拦掉，避免「松手即误存」。
 *
 * v1.3 修复（2026-09-09 用浏览器自动化在真实 BOSS 页面上实测后）：
 *   - ⚠️ 公司名一直是空的（详情页）。原逻辑假设「时代传浮 · 招聘者」在同一行，
 *     但详情页把 · 单独渲染成一行，于是它匹配到那个孤立的 · 、split 后取到空串。
 *     改成「标题 → 招聘者块按行解析（剔噪声行，取第一行不取最长行）→ 选择器兜底」。
 *   - pick() 现在遍历全部命中并跳过推荐位，而不是 querySelector 取第一个。
 *     实测这个详情页上 .company-name 有 6 个命中，第一个是推荐位里的「携程集团」。
 *   - ⚠️ 严重：getJobId 在独立详情页上抓到了页脚「相似职位」里的第一个推荐岗位。
 *     实测把「SEO Engineer @ 时代传浮」存到了「SEO负责人 @ 四海一家科技」的键上——
 *     内容是 A、主键和 URL 是 B，之后会被 B 覆盖、点 URL 跳到 B。静默脏数据。
 *     根因是优先级搞反了 + 一个 `|| document.querySelector()` 全局回退。
 *     改为「地址栏优先 → 面板内且排除推荐位 → 左侧 selected 卡」，去掉全局回退。
 *   - 薪资同样加了推荐位排除，并与 meta description 交叉校验：
 *     两处都有却对不上就留空让人补，不在薪资上二选一赌一个。
 *   - 实测确认两种布局的薪资可见性完全不同：
 *       · 独立详情页 /job_detail/xxx.html：.salary 和 meta 都是明文（25-50K）
 *       · 列表+面板页 /web/geek/jobs：标题/meta/属性/script 里全都没有明文，
 *         正文里 78 个私有区字符。这种页面上自动识别不可能成功，只能手工补。
 *
 * 设计原则：
 *   1. 只读取「当前页面已经渲染出来的内容」——不发请求、不翻页、不破解字体。
 *      v1.5 起有一个例外：会派发一次 click 把详情面板切到鼠标指着的那条
 *      （见 openCard）。边界是「只做用户本来要自己做的那一下」，
 *      绝不点投递 / 立即沟通这类有外部后果的按钮。
 *   2. 字段提取限定在「详情面板」范围内，避免抓到左侧列表的第一张卡片。
 *   3. 无论字段抓得准不准，都额外存一份整页纯文本（pageText）兜底——
 *      真正的字段解析交给 analyze_jd.py，那边改规则比改插件容易。
 *   4. 抓不准就留空并标记，绝不塞一个猜出来的值。薪资尤其如此：
 *      错一位数比空着糟得多。
 *
 * v1.1 修复（2026-09-08 在真实页面实测后）：
 *   - BOSS 已改版为「左列表 + 右内嵌详情面板」，不再跳独立详情页。
 *     新版容器 .job-detail-box / .job-detail-body .desc，老版选择器全部失效。
 *   - ⚠️ 致命 bug：去重 key 原来用 location.href，而新版列表页所有岗位共享
 *     同一个 URL（/web/geek/jobs），导致后存的岗位覆盖先存的，计数永远是 1。
 *     改为用详情链接里的 jobId 做 key。
 *
 * v1.2 薪资改造（起因：每存一条都弹窗手填，摩擦全压在最频繁的动作上）：
 *   - 不再破解字形、也不再逐条弹 prompt。BOSS 只对「详情面板那个薪资元素」
 *     做了字体替换，同一个数字在页面标题 / meta / title 属性里常常是明文，
 *     于是改成**换个地方读**：面板 → 标题 → meta → 面板属性，按可信度排序。
 *   - 刻意不从整页文本里找：左侧列表其他岗位的薪资也在里面，抓错就是脏数据。
 *     同一来源出现多个互不相同的候选时一律放弃，不猜。
 *   - 全都读不到 → 存下来标记 salaryPending，回头在扩展弹窗里内联批量补。
 *   - 薪资同时存成结构化的 salaryParsed（月薪上下限/几薪/折算年薪），
 *     工作台才能排序、筛选、画分布。解析规则在 lib/salary.js，有离线测试。
 *   - salarySource 记下这个数是从哪读到的，自动抓的和手填的可信度不一样。
 *   - ⚠️ 顺带修了时间戳：原来写的是 UTC 时刻但没有时区标记，
 *     而两端的解析都当本地时间读，东八区差 8 小时。改成完整 ISO（带 Z）。
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

  /* 薪资解析复用 lib/salary.js（工作台和扩展页面也用同一份，避免两套正则各自漂移）。
   * 内容脚本不是 module、不能顶层 import，所以走动态 import——
   * 这要求 lib/salary.js 在 manifest 的 web_accessible_resources 里。 */
  let SAL = null;
  const salReady = import(chrome.runtime.getURL("lib/salary.js"))
    .then((m) => {
      SAL = m;
    })
    .catch((e) => {
      console.warn("[jd-insight] 薪资解析模块加载失败，会退回手填：", e && e.message);
    });

  /** 模块没加载成功时返回空数组——降级成"读不到薪资"，而不是用一套简化正则
   *  给出可能不一致的结果。两套解析规则各自漂移是更难查的问题。 */
  const findSalaryCandidates = (t) => (SAL ? SAL.findSalaryCandidates(t) : []);

  /** 统一时间戳格式：完整 ISO（带 Z）。
   *  原来用 toISOString().slice(0,19).replace("T"," ") —— 那是 UTC 时刻却写成了
   *  没有时区标记的样子，而 pipeline.js 的 parseAt 和工作台的 weekSummary 都会把
   *  它当本地时间解析，东八区直接差 8 小时，"沉默天数""本周新增"跟着错。
   *  带 Z 之后两边的 Date.parse 都能正确当 UTC 解析，解析代码一行都不用改。 */
  const nowStamp = () => new Date().toISOString();

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

  /* 相似职位/推荐位的容器。这些区块里放的是**别的岗位**，
   * 所有字段提取都必须跳过它们。 */
  const RECO_SEL =
    ".similar-job-list, .similar-job, .job-recommend, .recommend-job, .look-more, [class*='similar'], [class*='recommend']";

  /* 详情区自己的容器。用来识别「假推荐位」，见下面 inReco 的注释。 */
  const DETAIL_SEL = ".job-detail-box, .job-detail-container, .job-detail-body, .job-primary";

  /**
   * el 在推荐位里吗。
   *
   * ⚠️ 不能直接写 el.closest(RECO_SEL)——这是 v1.3 埋的一个把整页打瞎的 bug，
   * 2026-09-09 在真实列表页上才发现：BOSS 的 /web/geek/jobs 外层容器叫
   * div.job-recommend-result > div.recommend-result-job，于是 [class*='recommend']
   * 命中了**整页外壳**，pick() 把标题、正文、薪资全部当成推荐位跳过，
   * 结果面板明明开着，存 JD 却一直报「没抓到岗位内容」。
   *
   * 判据改成：命中 RECO_SEL 的祖先，如果它把详情区整个包在里面，
   * 那它是页面外层容器而不是推荐位。真正的推荐位里不会有详情面板。
   * 这个判据不依赖 BOSS 的具体类名，比继续往选择器里打补丁稳。
   */
  function inReco(el) {
    let n = el && el.closest ? el.closest(RECO_SEL) : null;
    while (n) {
      if (!n.querySelector(DETAIL_SEL)) return true;
      const up = n.parentElement;
      n = up && up.closest ? up.closest(RECO_SEL) : null;
    }
    return false;
  }

  /* 左侧列表里的一张岗位卡。 */
  const CARD_SEL =
    "li.job-card-box, .job-card-box, .job-card-wrapper, [class*='job-card-box'], [class*='job-card-wrapper']";

  /* 鼠标最后停留过的那张卡。
   *
   * 这是本文件里最重要的一个信号，理由见 ensurePanel 的注释：
   * BOSS 的列表页一落地就把**第一条**岗位预加载进右侧面板，而且从不给
   * 任何卡片加 .selected（2026-09-09 在真实页面上实测，15 张卡 class 全一样）。
   * 所以「面板里开着哪条」和「人正在看哪条」是两件事，只认面板就会在
   * 「你在看第 7 条」的时候静默存下第 1 条。
   * 鼠标划过是能拿到的唯一真实意图信号：翻列表时指针必然停在正在看的那条上。
   * 而且正常点开一条之后指针就在那张卡上，所以这个信号和「手动点开」不冲突。 */
  let lastCard = null;
  let hoverTimer = null;
  /* 要停留 HOVER_DWELL 毫秒才算「在看这条」。
   *
   * 不能一掠过就记：鼠标从列表移到存 JD 按钮的路上会横穿好几张卡，
   * 最后掠过的那张会被当成你在看的那条——那就又变成静默存错了。
   * 停留判定把「路过」和「在读」分开。400ms 是读一行岗位名的量级，
   * 快速划过达不到。 */
  const HOVER_DWELL = 400;
  document.addEventListener(
    "mouseover",
    (e) => {
      const t = e.target;
      if (!t || !t.closest) return;
      if (t.closest("#jdc-btn, .jdc-toast")) return; // 自己的 UI 不算，也别取消已有的选择
      const c = t.closest(CARD_SEL);
      if (!c || inReco(c)) {
        // 移出卡片区：取消待定的计时，但保留上一次已经确认的那张。
        clearTimeout(hoverTimer);
        return;
      }
      if (c === lastCard) return;
      clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => {
        lastCard = c;
      }, HOVER_DWELL);
    },
    true
  );

  /** 从一个节点里取岗位 id（卡片和面板都有 job_detail 链接）。 */
  function jobIdIn(node) {
    if (!node || !node.querySelectorAll) return "";
    for (const a of node.querySelectorAll('a[href*="job_detail"]')) {
      if (inReco(a)) continue;
      const m = (a.getAttribute("href") || "").match(JOB_ID_RE);
      if (m) return m[1];
    }
    return "";
  }

  const cardName = (card) =>
    clean((card.querySelector(".job-name") || card).innerText || "").slice(0, 20);

  /** 触发一张卡打开右侧面板。
   *
   * ⚠️ 这一步违反了本文件开头设计原则第 1 条「不模拟点击」。是有意为之：
   * 让人每次先手点一遍卡片，摩擦全落在这个工具最频繁的动作上。
   * 破例的边界划在这里——只派发一次 click 到岗位名上，不翻页、不发请求、
   * 不点任何「投递 / 立即沟通」这类有外部后果的按钮。 */
  function openCard(card) {
    const el = card.querySelector(".job-name") || card;
    // 卡片里嵌着 <a href="/job_detail/...">，冒泡上去会跳走。
    // 捕获阶段拦掉 a 的默认行为，但不 stopPropagation——
    // BOSS 自己绑在卡片上的「换面板」处理器还要照常跑。
    const block = (ev) => {
      const a = ev.target && ev.target.closest && ev.target.closest("a");
      if (a) ev.preventDefault();
    };
    document.addEventListener("click", block, true);
    try {
      el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    } finally {
      // 同步派发，事件在 dispatchEvent 返回前就跑完了，可以立刻摘掉。
      document.removeEventListener("click", block, true);
    }
  }

  /** 等面板真的换成 wantId 那条。
   *
   * 判据是「面板里的 job_detail 链接 id == 想要的 id」，不是「面板文字够长」。
   * 长度判据在这里会骗人：换面板过程中旧内容还在，长度一直是够的。 */
  function waitPanelJob(wantId, ms) {
    const t0 = Date.now();
    return new Promise((resolve) => {
      const tick = () => {
        if (jobIdIn(document.querySelector(".job-detail-box")) === wantId) return resolve(true);
        if (Date.now() - t0 > ms) return resolve(false);
        setTimeout(tick, 100);
      };
      tick();
    });
  }

  /** 面板里已经有能用的内容了吗（老版整页布局也算）。 */
  function panelReady() {
    const s = scope();
    return s.layout === "panel" || s.layout === "page";
  }

  /**
   * 保证「面板里开着的」就是「人正在看的」。返回 {ok, reason, switched, label}。
   *
   * 独立详情页（/job_detail/xxx.html）没有列表，直接放过。
   */
  async function ensurePanel() {
    if (JOB_ID_RE.test(location.pathname)) return { ok: true, switched: false };

    const card = lastCard && lastCard.isConnected ? lastCard : null;
    const panelId = jobIdIn(document.querySelector(".job-detail-box"));

    // 没有悬浮信号：面板里有内容就用它（人看到的就是它），否则明说。
    if (!card) {
      if (panelReady()) return { ok: true, switched: false };
      return { ok: false, reason: "右边没有打开的岗位详情 —— 鼠标划过一条岗位再点存 JD" };
    }

    const wantId = jobIdIn(card);
    if (!wantId) {
      // 卡片上取不到 id，不猜。面板有内容就退回用面板。
      if (panelReady()) return { ok: true, switched: false };
      return { ok: false, reason: "这张卡上没有岗位链接 —— 手动点开它再存" };
    }
    if (wantId === panelId) return { ok: true, switched: false };

    const label = cardName(card);
    toast("正在打开「" + label + "」…", "warn");
    openCard(card);
    if (!(await waitPanelJob(wantId, 5000))) {
      return {
        ok: false,
        reason: "面板没换到「" + label + "」—— 手动点开它再存，别存错一条",
      };
    }
    // id 对上了但字段可能还在渲染，等一下再抓。
    await new Promise((r) => setTimeout(r, 300));
    return { ok: true, switched: true, label: label, wantId: wantId };
  }

  /**
   * 只在 root 内找，找不到返回空——绝不回退到全局。
   *
   * ⚠️ 而且必须跳过推荐位：独立详情页上 root 就是整个 document，
   * 页脚"相似职位"里同样有 .company-name / .salary 这些类名。
   * 实测这个页面上 .company-name 有 6 个命中，第一个是推荐位里的另一家公司——
   * 只要前面几个更具体的选择器有一天改版失效，公司名就会静默变成别人的。
   * 所以这里遍历全部命中、取第一个不在推荐位里的，而不是 querySelector 取第一个。
   */
  function pick(root, selectors) {
    for (const sel of selectors) {
      let els;
      try {
        els = root.querySelectorAll(sel);
      } catch (e) {
        continue;
      }
      for (const el of els) {
        if (inReco(el)) continue;
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
  const JOB_ID_RE = /job_detail\/([A-Za-z0-9_~-]+)\.html/;

  /**
   * 取当前岗位的 jobId。这是去重的主键，算错的代价是"把 A 岗位的内容存到 B 的键上"，
   * 之后被 B 覆盖、点 URL 跳到 B —— 静默的脏数据，比抓不到严重得多。
   *
   * ⚠️ 优先级必须是「地址栏优先」：
   *   独立详情页 /job_detail/xxx.html 的地址栏就是权威答案，没有任何歧义。
   *   原来的实现先去查 a[href*="job_detail"] 且带 `|| document.querySelector(...)`
   *   全局回退，结果在详情页上抓到了页脚 similar-job-list 里的第一个推荐岗位，
   *   实测把「SEO Engineer @ 时代传浮」存到了「SEO负责人 @ 四海一家科技」的键上。
   *   全局回退本来就违反本文件设计原则第 2 条，这里彻底去掉。
   */
  function getJobId(root) {
    // ① 地址栏。独立详情页上这是唯一正确答案。
    const fromUrl = location.pathname.match(JOB_ID_RE);
    if (fromUrl) return fromUrl[1];

    // ② 列表+面板布局：只在详情面板里找，且跳过推荐位。绝不回退到全局。
    //    实测（2026-09-09）面板里唯一的 job_detail 链接是底部那个
    //    a.more-job-btn「查看更多信息」，它指向的就是面板当前这条岗位
    //    （和左侧对应卡片的 href 逐字符相同）。所以这条路径是有效的，
    //    但它取到的是**面板里的**那条，前提是面板已经切到你要的岗位上——
    //    这件事由 ensurePanel() 保证。
    const scopeRoot = root && root.querySelector ? root : null;
    if (scopeRoot) {
      for (const a of scopeRoot.querySelectorAll('a[href*="job_detail"]')) {
        if (inReco(a)) continue;
        const m = (a.getAttribute("href") || "").match(JOB_ID_RE);
        if (m) return m[1];
      }
    }

    // ③ 面板里没有链接时，退到「左侧被选中的那张卡」——注意是 selected，
    //    不是第一张。找不到就返回空，由调用方退回 URL 做键并且不假装抓到了。
    //    ⚠️ 实测（2026-09-09）现在的 BOSS 版面**从不给卡片加 .selected**：
    //    15 张卡的 class 全是 job-card-box，一个不差。所以这一段在新版面上
    //    是死代码，留着只为老版布局兜底，别指望它。
    for (const sel of [
      ".job-card-box.selected a[href*='job_detail']",
      ".job-card-wrapper.selected a[href*='job_detail']",
      "li.job-card-box.selected a[href*='job_detail']",
    ]) {
      const a = document.querySelector(sel);
      if (a && !inReco(a)) {
        const m = (a.getAttribute("href") || "").match(JOB_ID_RE);
        if (m) return m[1];
      }
    }
    return "";
  }

  /* 招聘者信息块里的噪声行：活跃状态、身份标签、App 引导、孤立的分隔符。
   * 这些都不是公司名，但长度未必短，所以不能靠"取最长行"绕过。 */
  const BOSS_NOISE =
    /^(刚刚活跃|在线|今日活跃|本周活跃|\d+(分钟|小时|天|个?月)(内)?活跃|HR|人事|招聘者|BOSS|去App|前往App|与BOSS随时沟通|立即沟通|继续沟通|已沟通|收藏|举报|分享|·|・|\||[-—])$/;
  /** "李女士" / "王先生" / "张经理" —— 招聘者本人的称呼，不是公司 */
  const BOSS_PERSON = /^[一-龥]{1,4}(女士|先生|小姐|总|老师|经理|主管|同学)$/;

  /**
   * 公司名。
   *
   * ⚠️ 原来的实现是"找含 · 的那一行，取 · 前面的部分"，假设 BOSS 会把
   * 「时代传浮 · 招聘者」渲染在同一行。这个假设在独立详情页上已经不成立——
   * 那边 innerText 是「李女士 \n 刚刚活跃 \n 四海一家科技 \n · \n HR」，
   * 于是它找到那个**孤立的 ·**、split 之后取到空字符串，
   * 公司名一直是空的（实测确认）。
   *
   * 改成三条路，按可信度排序，每条都在真实页面上验过：
   *   ① 页面标题 —— 独立详情页的标题格式是「岗位招聘」_公司招聘-BOSS直聘，
   *      公司名在里面且无歧义。列表页标题不含公司，正则自然不匹配。
   *   ② 招聘者信息块按行解析 —— 同行带 · 的老格式仍然支持；
   *      否则剔掉噪声行和人名行，取**剩下的第一行**（不是最长行：
   *      "与BOSS随时沟通" 有 8 个字，比多数公司名都长）。
   *   ③ 其余选择器兜底（走 pick，已排除推荐位）。
   * 三条都没有就返回空——不硬凑一个。
   */
  function getCompany(root) {
    // ① 标题
    const fromTitle = document.title.match(/」?_(.+?)招聘\s*[-–—]\s*BOSS直聘/);
    if (fromTitle && fromTitle[1].trim()) return fromTitle[1].trim();

    // ② 招聘者信息块
    const bossRaw = pick(root, [".job-boss-info", ".job-sec-company .company-info a"]);
    if (bossRaw) {
      const ls = lines(bossRaw);
      const inline = ls.find(
        (l) => /[·・]/.test(l) && l.replace(/[·・]/g, "").trim().length > 1
      );
      if (inline) return inline.split(/[·・]/)[0].trim();
      const kept = ls.filter((l) => !BOSS_NOISE.test(l) && !BOSS_PERSON.test(l) && l.length > 1);
      if (kept[0]) return kept[0];
    }

    // ③ 兜底
    const other = pick(root, [
      ".company-info a.name",
      ".sider-company .company-name",
      ".company-name",
    ]);
    return other ? lines(other).filter((l) => l.length > 1)[0] || "" : "";
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

  /* ------------------------------------------------------- 薪资
   *
   * BOSS 只把「详情面板里那个薪资元素」的数字换成了私有区字符，
   * 但同一个数字在别处往往是明文——页面标题、og:title/description、
   * 各种 title/aria-label/data-* 属性。所以策略是**换个地方读**，
   * 而不是去破解字形映射（字体会轮换，破解出来的映射迟早失效；
   * 而按字形相似度猜数字更是在薪资这种字段上绝对不能做的事——
   * 猜错一位比读不到糟得多）。
   *
   * 找不到就找不到，绝不返回一个可能是错的数。
   */

  /** 从一批 (来源名, 文本) 里找薪资。要求候选唯一，多个不同候选视为无法判定。 */
  function salaryFromTexts(pairs) {
    for (const [source, text] of pairs) {
      if (!text) continue;
      const cands = findSalaryCandidates(text);
      // 同一来源里出现多个互不相同的薪资 → 说不清哪个是当前岗位的，宁可放弃。
      // 典型场景：整页文本里混进了左侧列表其他岗位的薪资。
      if (cands.length === 1) return { raw: cands[0], source };
      if (cands.length > 1) continue;
    }
    return null;
  }

  /** 详情面板内所有可能藏着明文薪资的属性值 */
  function attrTexts(root) {
    const out = [];
    const scopeRoot = root.querySelectorAll ? root : document;
    scopeRoot.querySelectorAll("[title], [aria-label], [data-salary], [content]").forEach((el) => {
      ["title", "aria-label", "data-salary", "content"].forEach((a) => {
        const v = el.getAttribute && el.getAttribute(a);
        if (v && /\d/.test(v)) out.push(v);
      });
    });
    return out.join("\n");
  }

  function metaTexts() {
    const out = [];
    document
      .querySelectorAll('meta[name="description"], meta[property^="og:"], meta[name="keywords"]')
      .forEach((m) => {
        const v = m.getAttribute("content");
        if (v) out.push(v);
      });
    return out.join("\n");
  }

  /**
   * @returns {{raw:string, source:string, usable:boolean}}
   *   source 说明这个数字是从哪读到的，会显示在保存提示里——
   *   这样第一次用就能看出哪条来源真的有效，不必靠猜。
   */
  /** 在 root 里按选择器找薪资元素，跳过相似职位/推荐位。
   *  独立详情页上 root 是整个 document，而页脚的推荐岗位也带 .salary，
   *  直接 querySelector 有抓到别人薪资的风险。 */
  function pickSalaryEl(root) {
    const scopeRoot = root && root.querySelectorAll ? root : document;
    for (const sel of [".job-salary", ".salary", ".job-limit .red", ".job-banner .salary"]) {
      for (const el of scopeRoot.querySelectorAll(sel)) {
        if (inReco(el)) continue;
        const t = clean(el.innerText);
        if (t) return t;
      }
    }
    return "";
  }

  function getSalary(root) {
    // ① DOM 里的薪资元素（排除推荐位）。BOSS 的独立详情页 /job_detail/xxx.html
    //    上薪资是明文，走这条就够；列表+面板页上会被字体挡住，读到 "-K"。
    const direct = pickSalaryEl(root);
    const metaCand = findSalaryCandidates(metaTexts());

    if (/\d/.test(direct)) {
      const c = findSalaryCandidates(direct);
      const domVal = c.length === 1 ? c[0] : direct;
      // 和 meta 交叉校验。两边都有却对不上，说明至少一个抓错了对象
      // （最可能是抓到了推荐位里别的岗位）——这种情况宁可留空让人补，
      //  也不要在薪资这种字段上二选一赌一个。
      if (metaCand.length === 1 && metaCand[0] !== domVal) {
        return {
          raw: "",
          source: "",
          usable: false,
          conflict: domVal + " vs " + metaCand[0],
        };
      }
      return { raw: domVal, source: "详情面板", usable: true };
    }

    // ② DOM 被挡住时退到明文来源，按「范围越小越可信」排序。
    //    刻意不含整页文本：列表里其他岗位的薪资也在里面，抓错就是脏数据。
    const found = salaryFromTexts([
      ["页面标题", document.title],
      ["meta 标签", metaTexts()],
      ["详情面板属性", attrTexts(root)],
    ]);
    if (found) return { raw: found.raw, source: found.source, usable: true };

    return { raw: direct, source: "", usable: false };
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
      // 薪资从哪读到的（"页面标题"/"meta 标签"/"详情面板属性"/"手填"）。
      // 存下来是为了以后能回答"这个数可信吗"——自动抓的和手填的可信度不一样。
      salarySource: salaryOverride ? "手填" : sal.source || "",
      // 结构化薪资：月薪上下限、几薪、折算年薪。工作台要按薪资排序、
      // 画分布、跟期望比，都得有数而不是字符串。解析不出来就是 null，不硬凑。
      salaryParsed: (() => {
        const t = salaryOverride || (sal.usable ? sal.raw : "");
        if (!t || !SAL) return null;
        const p = SAL.parseSalary(t);
        return p.parsed ? p : null;
      })(),
      salaryBlocked: !sal.usable && !salaryOverride,
      // 两处明文薪资互相矛盾时记下来，提示里会说明——比单说"待补"多给一条线索
      salaryConflict: sal.conflict || undefined,
      company: getCompany(root),
      tagline: getTagline(root, title),
      body,
      pageText: clean(document.body.innerText).slice(0, 12000),
      layout,
      site: location.hostname.replace(/^www\./, ""),
      ts: nowStamp(),
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
  /** save 是 async，三个调用点（按钮、快捷键、后台消息）都不 await。
   *  不包一层的话任何异常都是未处理的 Promise rejection——界面毫无反应，
   *  人只会以为"按钮坏了"。采集是这个工具最频繁的动作，绝不能静默失败。 */
  /** 插件本体还连着吗。
   *
   * 在 chrome://extensions 点「刷新」重载插件之后，已经打开的页面里那份
   * content.js 还在跑，但它和插件的连接已经断了：任何 chrome.* 调用都会抛
   * "Extension context invalidated"。这个原文错误对人毫无指导意义——
   * 实测就出现过一次「点存 JD 一直失败，只好绕道点进详情页」，
   * 而真正要做的只是刷新一下页面。所以这里专门识别它并给出该做的动作。 */
  function extAlive() {
    try {
      return !!(chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  const STALE_MSG = "插件刚更新过，这个页面里的旧脚本已失效 —— 按 F5 刷新页面再存";
  const isStale = (e) =>
    !extAlive() || /Extension context invalidated|context invalidated/i.test((e && e.message) || "");

  function safeSave() {
    if (!extAlive()) {
      toast(STALE_MSG, "warn");
      return;
    }
    save().catch((e) => {
      console.error("[jd-insight] 保存失败：", e);
      toast(isStale(e) ? STALE_MSG : "保存失败：" + ((e && e.message) || "未知错误"), "warn");
    });
  }

  async function save() {
    // 等薪资解析模块就绪。文件很小、只加载一次，第二次点是同步返回。
    await salReady;

    // 先保证面板里开着的就是鼠标正指着的那条。BOSS 列表页一落地就把第一条
    // 预加载进面板，只认面板会在「你在看第 7 条」时静默存下第 1 条。
    const panel = await ensurePanel();
    if (!panel.ok) {
      toast(panel.reason, "warn");
      return;
    }

    let rec = extract();

    if (!rec.title && rec.body.length < 120) {
      toast("没抓到岗位内容 —— 先点开一个岗位的详情再存", "warn");
      return;
    }

    // 自动切过面板时再核对一次 id。waitPanelJob 已经等到 id 相符，
    // 这里是防「等到之后又被 BOSS 换掉」——一旦对不上宁可不存也不存错。
    if (panel.switched && panel.wantId && rec.jobId && rec.jobId !== panel.wantId) {
      toast("面板又被换掉了 —— 没存，手动点开「" + panel.label + "」再试", "warn");
      return;
    }

    // 到这一步还没薪资，说明标题、meta、面板属性里都没有明文。
    // 不再弹 prompt 打断采集——直接存，薪资留空并标记，之后在扩展弹窗里
    // 一次性批量补。逐条弹窗是"采集 10 条要被打断 10 次"，摩擦全在最频繁的动作上。
    if (rec.salaryBlocked) {
      rec.salaryPending = true;
    }

    chrome.storage.local.get({ jds: [] }, (got) => {
      // 回调里的异常进不了 save() 外面那层 catch，所以在这里自己查一次。
      if (chrome.runtime.lastError || !got) {
        toast(isStale(chrome.runtime.lastError) ? STALE_MSG : "读本地存储失败", "warn");
        return;
      }
      const jds = got.jds || [];
      const i = jds.findIndex((x) => x.key === rec.key);
      const isNew = i < 0;
      if (isNew) jds.push(rec);
      else jds[i] = rec;
      chrome.storage.local.set({ jds }, () => {
        if (chrome.runtime.lastError) {
          toast(isStale(chrome.runtime.lastError) ? STALE_MSG : "写本地存储失败", "warn");
          return;
        }
        const label = (rec.title || "这条").split("\n")[0].slice(0, 16);
        // 公司名也显示出来。两个理由：存的时候就该看见存的是哪家；
        // 以及抓不到会当场暴露——公司名曾经因为 · 换行而一直是空的，
        // 而那个 bug 之所以能活很久，就是因为界面上根本看不见这个字段。
        const co = rec.company ? " · " + rec.company.slice(0, 14) : " · 公司名没抓到";
        // 把薪资和它的来源一起显示出来。这是刻意的：第一次在真实页面上用，
        // 就能看出哪条明文来源真的有效（标题？meta？属性？），不用靠猜选择器。
        const sal = rec.salaryConflict
          ? "　薪资待补（页面上两处对不上：" + rec.salaryConflict + "）"
          : rec.salaryBlocked
          ? "　薪资待补"
          : "　" + rec.salary + (rec.salarySource ? "（" + rec.salarySource + "）" : "");
        toast(
          (isNew ? "已存 · " : "已更新 · ") + label + co + sal + "　共 " + jds.length + " 条",
          rec.salaryBlocked || !rec.company ? "warn" : isNew ? "ok" : "warn"
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
    safeSave();
  });

  /* ── 位置：可拖动 + 记住 ────────────────────────────────
   *
   * 原来固定在 right:22px / bottom:96px，正好撞进 BOSS 自己那一摞
   * 悬浮组件（客服、反馈、回到顶部）里，被挡住看不见。
   *
   * 但换一个"更好的固定位置"是没有终点的：屏幕尺寸、缩放比例、
   * BOSS 改版都会让它重新撞上。所以改成拖到哪就记在哪——
   * 位置这件事交给用户，比我猜一百次可靠。
   *
   * 默认位置改到右侧垂直居中偏下：这个区域在 BOSS 的详情页上是空的，
   * 而且离底部那摞组件足够远。
   */
  const POS_KEY = "btnPos";
  const BTN_MARGIN = 12;

  function clamp(pos) {
    const w = btn.offsetWidth || 96;
    const h = btn.offsetHeight || 40;
    return {
      left: Math.min(Math.max(pos.left, BTN_MARGIN), window.innerWidth - w - BTN_MARGIN),
      top: Math.min(Math.max(pos.top, BTN_MARGIN), window.innerHeight - h - BTN_MARGIN),
    };
  }

  function applyPos(pos) {
    const p = clamp(pos);
    btn.style.left = p.left + "px";
    btn.style.top = p.top + "px";
    btn.style.right = "auto";
    btn.style.bottom = "auto";
  }

  function defaultPos() {
    const w = btn.offsetWidth || 96;
    return { left: window.innerWidth - w - 20, top: Math.round(window.innerHeight * 0.62) };
  }

  chrome.storage.local.get({ [POS_KEY]: null }, (res) => {
    applyPos(res[POS_KEY] || defaultPos());
    btn.style.visibility = "visible";
  });

  /* 拖动。用 pointer 事件一套管鼠标和触控。
   * ⚠️ 关键细节：拖动超过 4px 才算拖，否则普通点击会被当成拖动、
   * 松手时不触发保存——那等于把按钮点坏了。 */
  let drag = null;
  btn.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    const r = btn.getBoundingClientRect();
    drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, moved: false, x0: e.clientX, y0: e.clientY };
    btn.setPointerCapture(e.pointerId);
  });
  btn.addEventListener("pointermove", (e) => {
    if (!drag) return;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 4) return;
    drag.moved = true;
    btn.classList.add("jdc-dragging");
    applyPos({ left: e.clientX - drag.dx, top: e.clientY - drag.dy });
  });
  btn.addEventListener("pointerup", (e) => {
    if (!drag) return;
    const wasDrag = drag.moved;
    drag = null;
    btn.classList.remove("jdc-dragging");
    btn.releasePointerCapture(e.pointerId);
    if (wasDrag) {
      // 拖完紧接着会来一个 click，那一下不该触发保存。
      // ⚠️ 标记必须在这里设：另写一个 pointerup 监听器去判断 .jdc-dragging
      // 是行不通的——这个handler 已经把那个 class 摘了，而监听器按注册顺序跑。
      btn.dataset.justDragged = "1";
      const r = btn.getBoundingClientRect();
      chrome.storage.local.set({ [POS_KEY]: { left: r.left, top: r.top } });
      toast("按钮位置已记住（随时可再拖）", "ok");
    }
  });
  // 捕获阶段拦掉拖动后的那一次 click
  btn.addEventListener(
    "click",
    (e) => {
      if (btn.dataset.justDragged === "1") {
        e.stopImmediatePropagation();
        e.preventDefault();
        btn.dataset.justDragged = "";
      }
    },
    true
  );

  // 窗口变小时把按钮拉回可视区，否则它会跑到屏幕外再也点不到
  window.addEventListener("resize", () => {
    const r = btn.getBoundingClientRect();
    applyPos({ left: r.left, top: r.top });
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
      safeSave();
    }
  });

  // 兜底通道：页面焦点在 iframe / 输入框时，页面级 keydown 收不到，
  // 由 background 的快捷键转发过来。
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === "JDC_SAVE") safeSave();
  });
})();
