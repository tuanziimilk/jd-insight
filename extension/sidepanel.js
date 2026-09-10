/* 侧边栏：对话式求职情报台
 *
 * 这一层是整个产品最"AI 产品"的部分，四个机制刻意做全：
 *   ① 意图识别   —— 规则先行、模型兜底，UI 上标出是哪种判定（rule / model）
 *   ② 槽位填充   —— 简历诊断缺"简历"就弹卡片要，绝不凭空诊断
 *   ③ 检索接地   —— 只依据采集到的 JD，答案带【JD n】编号 + 可点回原文
 *   ④ 人在环     —— 改写里的事实性内容标成【需你确认】，不自动编数字
 * 另外：统计类问题走确定性计算，不进模型（省钱、可复现、不会算错）。
 */
import { retrieve, buildContext, stats, coverage } from "./lib/retrieve.js";
import { aggregateGaps, renderGaps } from "./lib/gap.js";
import { renderFunnelTab } from "./lib/funnelUI.js";
import {
  // getUsageTotal 去掉了：累计用量那条开场系统消息删了，见 boot() 里的说明
  chatStream, chatOnce, getSettings, hasKey, explainError, fmtCost,
} from "./lib/llm.js";
import {
  INTENTS, ruleClassify, classifyPrompt, parseIntentId, extractKeywords, systemPrompt,
} from "./lib/intents.js";

const $ = (id) => document.getElementById(id);
const log = $("log");

let ALL = [];          // 全部采集到的 JD
let JDS = [];          // 当前筛选范围内的（回答只依据这些）
let SCOPE = "";        // "" | 🔥 | 👀 | 已投 | 进面 | 复面（须与 pipeline.js 的 Status 真实取值一致）
let PROFILE = {};
let HISTORY = [];      // [{role, content}] 只存文本，供多轮
let BUSY = false;
let PENDING = null;    // 槽位补齐后要继续的那次提问
// 本会话用量。hitTok 单独记，因为缓存命中率是可优化的成本指标
let SESSION = { calls: 0, inTok: 0, hitTok: 0, outTok: 0, reasonTok: 0, cost: 0, unpriced: 0 };

/* ---------------------------------------------------------------- 渲染 */

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/** 极简 markdown：表格 / 粗体 / 代码 / 【JD n】 / 【需你确认】 */
function md(text) {
  let s = esc(text);
  s = s.replace(/```([\s\S]*?)```/g, (m, c) => "<pre><code>" + c.trim() + "</code></pre>");
  s = s.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/【需你确认[：:]?([^】]*)】/g, '<span class="confirm">【需你确认$1】</span>');
  s = s.replace(/【JD\s*(\d+)】/g, '<span class="cite">【JD $1】</span>');
  // 表格
  s = s.replace(/(^\|.+\|\s*$\n?)+/gm, (block) => {
    const rows = block.trim().split("\n").map((r) => r.trim());
    const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (rows.length < 2) return block;
    const head = cells(rows[0]);
    const body = rows.slice(rows[1].replace(/[\s|:-]/g, "") === "" ? 2 : 1).map(cells);
    return (
      "<table><thead><tr>" + head.map((h) => "<th>" + h + "</th>").join("") +
      "</tr></thead><tbody>" +
      body.map((r) => "<tr>" + r.map((c) => "<td>" + c + "</td>").join("") + "</tr>").join("") +
      "</tbody></table>"
    );
  });
  return s;
}

function addUser(text) {
  const d = document.createElement("div");
  d.className = "msg u";
  d.innerHTML = '<div class="bubble">' + esc(text) + "</div>";
  log.appendChild(d);
  scroll();
}

function addSys(text) {
  const d = document.createElement("div");
  d.className = "sys";
  d.textContent = text;
  log.appendChild(d);
  scroll();
}

function addAssistant(intent, by) {
  const d = document.createElement("div");
  d.className = "msg a";
  // 红线优先于 rule/model 的区分：这一轮被拒了，比"谁判的"更需要被看见
  const tagCls = intent.id === "GUARD" ? "guard"
    : by && by.startsWith("rule") ? "rule" : "model";
  d.innerHTML =
    '<div class="meta"><span class="tag ' + tagCls + '">' + esc(intent.label) + "</span>" +
    '<span>判定：' + esc(by || "—") + "</span></div>" +
    '<div class="bubble dots"></div>';
  log.appendChild(d);
  scroll();
  return d.querySelector(".bubble");
}

function addSources(bubble, picked) {
  if (!picked || !picked.length) return;
  const w = document.createElement("div");
  w.className = "sources";
  w.innerHTML =
    "<b>依据的 JD：</b><br>" +
    picked.map((r, i) =>
      '【JD ' + (i + 1) + '】<a href="' + esc(r.url || "#") + '" target="_blank">' +
      esc((r.title || "—").slice(0, 26)) + "</a>" +
      (r.company ? " · " + esc(r.company.slice(0, 14)) : "") +
      ' <span class="s">(相关度 ' + (r._score || 0).toFixed(1) + ")</span>"
    ).join("<br>");
  bubble.parentElement.appendChild(w);
  scroll();
}

function scroll() { log.scrollTop = log.scrollHeight; }

/** 按标签限定范围。范围之外的 JD 完全不参与检索和统计 */
function applyScope() {
  JDS = !SCOPE
    ? ALL.slice()
    : ALL.filter((r) => r.intent === SCOPE || r.status === SCOPE);
  $("count").textContent = JDS.length + (SCOPE ? " / " + ALL.length : "") + " 条 JD";
  $("count").title = SCOPE ? "已按「" + SCOPE + "」筛选" : "全部";
  if (TAB === "funnel") renderFunnelTab($("funnelTab"), JDS);
}

/* ---------------- 标签页：对话 / 漏斗 ---------------- */
let TAB = "chat";

function switchTab(tab) {
  TAB = tab;
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  const chat = tab === "chat";
  $("log").hidden = !chat;
  $("quick").hidden = !chat;
  document.querySelector("footer").hidden = !chat;
  $("funnelTab").hidden = chat;
  // 漏斗用当前筛选后的 JDS，和头部那个「N / M 条 JD」保持同一个口径，
  // 否则筛了范围却看到全量漏斗，数字对不上会让人以为算错了。
  if (!chat) renderFunnelTab($("funnelTab"), JDS);
}

document.querySelector(".tabs").addEventListener("click", (e) => {
  const tab = e.target.dataset && e.target.dataset.tab;
  if (tab) switchTab(tab);
});

/** 在回答下方挂一行用量。PRD 里「效率成本」这层指标要看得见才有用 */
function addUsage(bubble, res) {
  const u = res && res.split;
  if (!u) return;
  SESSION.calls += 1;
  SESSION.inTok += u.prompt;
  SESSION.hitTok += u.hit;
  SESSION.outTok += u.out;
  SESSION.reasonTok += u.reasoning;
  if (res.priced) SESSION.cost += res.cost || 0;
  else SESSION.unpriced += 1;

  const bits = [];
  bits.push("入 " + u.prompt.toLocaleString());
  if (u.hit) bits.push("缓存命中 " + u.hit.toLocaleString());
  bits.push("出 " + u.out.toLocaleString());
  if (u.reasoning) bits.push("其中思考 " + u.reasoning.toLocaleString());
  const money = res.priced ? "≈" + fmtCost(res.cost) : "未配价格";

  const d = document.createElement("div");
  d.className = "usage";
  d.textContent =
    bits.join(" · ") + " tok · " + money +
    (u.estimated ? "  端点未回 usage，按字符数估算" : "");
  bubble.parentElement.appendChild(d);
  paintSession();
}

function paintSession() {
  const el = $("cost");
  if (!el) return;
  if (!SESSION.calls) { el.textContent = ""; el.title = ""; return; }
  const hitRate = SESSION.inTok
    ? Math.round((SESSION.hitTok / SESSION.inTok) * 100) : 0;
  el.textContent = SESSION.unpriced === SESSION.calls
    ? "本会话 " + SESSION.calls + " 次"
    : "本会话 " + fmtCost(SESSION.cost);
  el.title =
    "调用 " + SESSION.calls + " 次\n" +
    "输入 " + SESSION.inTok.toLocaleString() + " tok（缓存命中 " + hitRate + "%）\n" +
    "输出 " + SESSION.outTok.toLocaleString() + " tok" +
    (SESSION.reasonTok ? "（其中思考 " + SESSION.reasonTok.toLocaleString() + "）" : "") +
    (SESSION.unpriced ? "\n" + SESSION.unpriced + " 次未配价格，钱数不含它们" : "");
}

/* ---------------------------------------------------------------- 槽位追问 */

const SLOT_ASK = {
  resume: {
    title: "先要一样东西：你的简历",
    // ⚠️ 原来写"只存在你本机"。现在简历的权威副本在云端
    // （career_profile.resume_text，工作台 06 简历正文 那一页负责写），
    // 同步时会拉到本机。这里粘的这一份只进本机，不会往上传——
    // 文案必须说清，否则用户会以为在这儿粘一次就到处都有了。
    tip: "诊断和改写必须基于真实经历——没有简历我只能瞎猜，那不如不答。粘一份纯文本就行。想让它在所有设备上都有，去工作台的「06 简历正文」上传一次，之后点同步会自动拉下来。",
    ph: "把简历正文粘进来…",
  },
  target: {
    title: "改写目标是哪个岗位？",
    tip: "贴岗位名，或直接说「按 JD 3 那个」。",
    ph: "例如：AI 客服产品经理 / 按 JD 2 那个",
  },
};

function askSlot(slot, onFill) {
  const cfg = SLOT_ASK[slot] || { title: "需要补充：" + slot, tip: "", ph: "" };
  const d = document.createElement("div");
  d.className = "msg a";
  d.innerHTML =
    '<div class="slot"><h4>' + esc(cfg.title) + "</h4>" +
    "<p>" + esc(cfg.tip) + "</p>" +
    '<textarea placeholder="' + esc(cfg.ph) + '"></textarea>' +
    '<div class="row"><button class="primary">保存并继续</button>' +
    '<button class="ghost">跳过</button></div></div>';
  log.appendChild(d);
  scroll();
  const ta = d.querySelector("textarea");
  const [ok, skip] = d.querySelectorAll("button");
  ta.focus();
  ok.onclick = async () => {
    const v = ta.value.trim();
    if (!v) { ta.focus(); return; }
    PROFILE[slot] = v;
    await chrome.storage.local.set({ profile: PROFILE });
    d.remove();
    addSys("已保存「" + slot + "」，继续回答");
    onFill(true);
  };
  skip.onclick = () => { d.remove(); onFill(false); };
}

/* ---------------------------------------------------------------- 确定性统计 */

function answerStats(question, kws) {
  const st = stats(JDS);
  const lines = [];
  lines.push("**全库统计**（不经模型，直接算，结果可复现）\n");
  lines.push("| 项 | 值 |");
  lines.push("|---|---|");
  lines.push("| JD 总数 | " + st.total + " |");
  lines.push("| 不同公司 | " + st.companies + " |");
  lines.push("| 有薪资信息 | " + st.withSalary + "/" + st.total + "（其余被网站字体反爬挡住） |");
  const cities = Object.entries(st.cities).sort((a, b) => b[1] - a[1]);
  if (cities.length) lines.push("| 城市分布 | " + cities.map(([c, n]) => c + " " + n).join(" · ") + " |");
  lines.push("");

  if (kws && kws.length) {
    lines.push("**关键词覆盖率**（出现在多少条 JD 里）\n");
    lines.push("| 关键词 | 覆盖 | 占比 |");
    lines.push("|---|---|---|");
    kws.forEach((k) => {
      const c = coverage(JDS, [k]);
      lines.push("| `" + k + "` | " + c.count + "/" + c.total + " | " +
        (st.total ? Math.round((c.count / st.total) * 100) : 0) + "% |");
    });
    lines.push("");
    const first = coverage(JDS, [kws[0]]);
    if (first.docs.length) {
      lines.push("命中 `" + kws[0] + "` 的岗位：" +
        first.docs.slice(0, 8).map((d) => (d.title || "—") + "（" + (d.company || "—") + "）").join("、"));
    }
  } else {
    lines.push("_想看某个关键词的覆盖率，直接问「有几条要求 Discord」这样。_");
  }
  return lines.join("\n");
}

/* 红线拒答。确定性，不进模型。
 *
 * 为什么拒答也不交给模型：一旦把"帮我编一条经历"送进生成路径，
 * 拒不拒就取决于那一轮模型的心情——而这是个求职工具，
 * 编出来的经历会让人在面试里被当场穿。这条不能是概率性的。
 *
 * 拒答必须给出**能做的替代**。只说"不行"会把人推去别的工具真的编一条，
 * 那比在这里给他一条可迁移的真实经验要糟。
 */
/* ⚠️ 这两段文案用**数组 + join** 拼，不用带 \n 的长字符串拼接。
   不是风格问题：上一版这里是 "…**\n\n" + "…" 那种写法，而我是用脚本
   生成这段代码的，转义层套多了一层，`\n` 落到磁盘上变成了**真换行**——
   字符串字面量里出现真换行是 SyntaxError，整个 sidepanel.js 直接不加载，
   表现是「点设置没反应、对话框不响应」，看起来完全不像一个字符串的问题。
   数组写法没有转义字符，脚本改不坏。 */
function answerGuard(by) {
  if (by === "rule:guard:fact") {
    return [
      "**这条我不做。**",
      "",
      "你要改的是职位名、公司、学历或起止时间这类**事实字段**。" +
        "这不是措辞问题——简历上的这几项是会被背景调查和面试交叉核对的，改了就是事实不符。",
      "",
      "能做的替代：",
      "",
      "- 职位名和实际职责不符，可以在**职责描述**里体现你真实承担的范围" +
        "（「实际负责 X、Y 两条线」），职位名保持原样",
      "- 想突出级别，用**带得出结果的事实**（团队规模、决策范围、影响面），而不是换一个头衔",
      "",
      "想改措辞的话，把那句话发给我，我按「经历改写」来处理。",
    ].join("\n");
  }
  return [
    "**这条我不做。**",
    "",
    "你说了自己没做过这件事，然后要我写一条相关经历。那是编经历。" +
      "这个工具是用来投递的，编出来的东西会在面试追问里被当场穿——而且被穿的代价远大于少写一条。",
    "",
    "能做的替代，按有用程度排：",
    "",
    "1. **写可迁移的真实经验。** 你做过的事里大概率有同类内核" +
      "（同样的用户获取逻辑、同样的从零搭流程）。把真实那件事写出来，" +
      "用目标 JD 的用词描述它——这是「经历改写」能帮你做的，且不涉及编造。",
    "2. **把它当缺口，而不是当要填的空。** 问我「我该补什么能力」，" +
      "它会告诉你这项在你采集的 JD 里出现的频次，值不值得真的去补。",
    "3. **面试里如实说没做过 + 说你的判断。** 「这块我没实操过，" +
      "但我理解它要解决的是 X，我会先从 Y 入手」——这个答案比一条假经历安全得多。",
  ].join("\n");
}

/* 能力缺口：全部确定性计算，本轮**不调模型**。
 *
 * 为什么这条要写死成"不过模型"而不是靠提示词约束：
 * 用户的边界是「只要学习路数，不要学习方案」——而模型被问到"我该补什么"
 * 时，一定会顺手推荐课程、书和练手项目。那些内容它编得很像真的，
 * 但用户明确说过不信任这个模型整理的资料。
 * 既然缺口本身能靠词典 + 频次算准，就没有任何理由让模型参与。
 */
function answerGap() {
  const res = aggregateGaps(JDS, PROFILE.resume, { scope: SCOPE || "全部" });
  const body = renderGaps(res);
  // 同 answerGuard：数组 + join，不写带 \n 的字符串拼接。
  // 这个函数上一版就是被那种写法弄坏的，而且坏了一整个提交没人发现——
  // 因为 sidepanel.js 整个不加载，看起来像"侧边栏没反应"，不像文案问题。
  if (!res.ok) return ["**能力缺口**", "", body].join("\n");
  return [
    "**能力缺口**（不经模型，按词典 + 频次直接算，结果可复现）",
    "",
    body,
    "",
    "_只给「该补哪些能力」这一层。具体学什么资料这里不给——" +
      "这个模型整理的资料不可信，那部分在你自己的知识库里做。_",
  ].join("\n");
}

/* ---------------------------------------------------------------- 主流程 */

async function ask(question, opts = {}) {
  if (BUSY) return;
  if (!question.trim()) return;
  BUSY = true; $("send").disabled = true;
  if (!opts.silentUser) addUser(question);

  try {
    if (!JDS.length) {
      const b = addAssistant(INTENTS.SMALLTALK, "rule:no-data");
      b.classList.remove("dots");
      b.innerHTML = md(
        "还没有采集任何 JD，我没有可依据的资料。\n\n" +
        "先去招聘网站的岗位详情页，点右下角「+ 存 JD」或按 `Alt+S` 存几条（建议 15~20 条），再回来问我。"
      );
      return;
    }

    // ① 意图识别：规则先行
    let r = ruleClassify(question);
    let by = r && r.by;
    let intent = r && r.intent;
    if (!intent) {
      const s = await getSettings();
      if (hasKey(s)) {
        try {
          intent = parseIntentId(await chatOnce(classifyPrompt(question)));
          by = "model";
        } catch (e) {
          intent = INTENTS.ASK_JD; by = "fallback:分类失败";
        }
      } else {
        intent = INTENTS.ASK_JD; by = "fallback:无 key";
      }
    }

    // ② 确定性意图：不进模型
    if (intent.deterministic) {
      const b = addAssistant(intent, by);
      b.classList.remove("dots");
      let text;
      let memo;
      if (intent.id === "GUARD") {
        text = answerGuard(by);
        memo = "[已拒答：红线]";
      } else if (intent.id === "GAP") {
        text = answerGap();
        memo = "[已给出能力缺口表]";
      } else {
        const kws = (r && r.keywords) || extractKeywords(question);
        text = answerStats(question, kws);
        memo = "[已给出统计结果]";
      }
      b.innerHTML = md(text);
      HISTORY.push({ role: "user", content: question });
      HISTORY.push({ role: "assistant", content: memo });
      return;
    }

    // ③ 槽位检查：缺了就问，不猜
    //    opts.force = 用户已经明确跳过过一次，别再问第二遍（否则死循环）
    const missing = opts.force ? [] : (intent.slots || []).filter((s) => !PROFILE[s]);
    if (missing.length) {
      PENDING = { question, intent };
      askSlot(missing[0], (filled) => {
        BUSY = false; $("send").disabled = false;
        if (filled && PENDING) {
          const p = PENDING; PENDING = null;
          ask(p.question, { silentUser: true });
        } else {
          addSys("跳过了，那我只能基于 JD 泛泛地说——结论会弱很多");
          const p = PENDING; PENDING = null;
          // force=true 让下一轮跳过槽位检查，degraded 让系统提示知道是降级回答
          if (p) ask(p.question, { silentUser: true, force: true, degraded: true });
        }
      });
      return; // 注意：BUSY 由回调解锁
    }

    // ④ 检索接地
    let ctx = "", picked = [];
    if (intent.needsRetrieval) {
      const res = retrieve(JDS, question, 5);
      picked = res.picked;
      if (!picked.length) picked = JDS.slice(0, 3); // 一个都没命中就给最近的几条
      ctx = buildContext(picked);
    }

    // ⑤ 生成（流式）
    const b = addAssistant(intent, by);
    const msgs = [
      { role: "system", content: systemPrompt(intent, ctx, PROFILE, opts.degraded) },
      ...HISTORY.slice(-6),
      { role: "user", content: question },
    ];
    let acc = "";
    let res = null;
    try {
      res = await chatStream(msgs, (d) => {
        acc += d;
        b.classList.remove("dots");
        b.innerHTML = md(acc);
        scroll();
      });
    } catch (e) {
      b.classList.remove("dots");
      b.innerHTML = md(explainError(e.message));
      if (e.message === "NO_KEY") {
        const btn = document.createElement("button");
        btn.className = "ghost"; btn.textContent = "去设置";
        btn.style.marginTop = "8px";
        btn.onclick = () => chrome.runtime.openOptionsPage();
        b.appendChild(btn);
      }
      return;
    }
    b.classList.remove("dots");
    b.innerHTML = md(acc);
    addSources(b, picked);
    if (res) addUsage(b, res);
    HISTORY.push({ role: "user", content: question });
    HISTORY.push({ role: "assistant", content: acc.slice(0, 2000) });
    if (intent.hitl && !/【需你确认/.test(acc)) {
      addSys("提醒：改写内容涉及事实的部分请自己核对，不要直接用");
    }
  } finally {
    if (!PENDING) { BUSY = false; $("send").disabled = false; }
  }
}

/* ---------------------------------------------------------------- 启动 */

async function boot() {
  const s = await chrome.storage.local.get({ jds: [], profile: {} });
  ALL = s.jds || [];
  PROFILE = s.profile || {};
  applyScope();

  const st = await getSettings();
  if (!hasKey(st)) {
    $("hint").innerHTML = "还没配 API Key，只有「统计」类问题能用。点右上角「设置」配置。";
  }

  addSys(
    ALL.length
      ? "已载入 " + JDS.length + " 条 JD" +
        (SCOPE ? "（已按「" + SCOPE + "」筛选，共 " + ALL.length + " 条）" : "") +
        "。回答只依据它们。"
      : "还没采集 JD。去岗位详情页按 Alt+S 存几条。"
  );

  /* ⚠️ 这里原来还会再发一条系统消息，报累计调用次数 / token / 缓存命中率 / 花费。
     删掉了，三个理由：
     ① 它**每次打开都出现**，而它不会改变你接下来做什么——
        开面板是为了问问题，不是为了看账；
     ② 第一屏因此固定被两条居中灰字占掉，真正的对话从第三行开始；
     ③ 这些数在两个地方已经有了：会话内花费在页头那个 #cost 胶囊里
        （实时更新），累计的在设置页「本地数据」那一节。
     一个信息出现三遍，就有两遍是噪声。 */
  paintSession();
}

$("send").onclick = () => { const v = $("q").value; $("q").value = ""; ask(v); };
$("q").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("send").click(); }
});
$("q").addEventListener("input", (e) => {
  e.target.style.height = "auto";
  e.target.style.height = Math.min(e.target.scrollHeight, 130) + "px";
});
$("quick").addEventListener("click", (e) => {
  const q = e.target.getAttribute("data-q");
  if (q) ask(q);
});
$("newchat").onclick = () => {
  HISTORY = []; log.innerHTML = ""; PENDING = null;
  SESSION = { calls: 0, inTok: 0, hitTok: 0, outTok: 0, reasonTok: 0, cost: 0, unpriced: 0 };
  boot();
};
$("settings").onclick = () => chrome.runtime.openOptionsPage();

$("scope").addEventListener("change", (e) => {
  SCOPE = e.target.value;
  applyScope();
  addSys(
    SCOPE
      ? "范围已限定为「" + SCOPE + "」：" + JDS.length + " 条 —— 之后的回答只看这些"
      : "范围恢复为全部 " + JDS.length + " 条"
  );
});

chrome.storage.onChanged.addListener((ch) => {
  if (ch.jds) { ALL = ch.jds.newValue || []; applyScope(); }
});

boot();
