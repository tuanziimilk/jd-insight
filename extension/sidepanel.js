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
import {
  chatStream, chatOnce, getSettings, hasKey, explainError, fmtCost, getUsageTotal,
} from "./lib/llm.js";
import {
  INTENTS, ruleClassify, classifyPrompt, parseIntentId, extractKeywords, systemPrompt,
} from "./lib/intents.js";

const $ = (id) => document.getElementById(id);
const log = $("log");

let ALL = [];          // 全部采集到的 JD
let JDS = [];          // 当前筛选范围内的（回答只依据这些）
let SCOPE = "";        // "" | 🔥 | 👀 | 已投 | 面试中
let PROFILE = {};
let HISTORY = [];      // [{role, content}] 只存文本，供多轮
let BUSY = false;
let PENDING = null;    // 槽位补齐后要继续的那次提问
let SESSION = { calls: 0, inTok: 0, outTok: 0, cost: 0 }; // 本会话用量

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
  const tagCls = by && by.startsWith("rule") ? "rule" : "model";
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
}

/** 在回答下方挂一行用量。PRD 里「效率成本」这层指标要看得见才有用 */
function addUsage(bubble, usage, cost) {
  if (!usage) return;
  const i = usage.prompt_tokens || 0;
  const o = usage.completion_tokens || 0;
  SESSION.calls += 1;
  SESSION.inTok += i;
  SESSION.outTok += o;
  SESSION.cost += cost || 0;
  const d = document.createElement("div");
  d.className = "usage";
  d.textContent =
    (i + o).toLocaleString() + " tok（入 " + i.toLocaleString() +
    " / 出 " + o.toLocaleString() + "）· ≈" + fmtCost(cost) +
    (usage.estimated ? "  ⚠ 端点未回 usage，按字符数估算" : "");
  bubble.parentElement.appendChild(d);
  paintSession();
}

function paintSession() {
  const el = $("cost");
  if (!el) return;
  if (!SESSION.calls) { el.textContent = ""; el.title = ""; return; }
  el.textContent = "本会话 " + fmtCost(SESSION.cost);
  el.title =
    "调用 " + SESSION.calls + " 次 · 输入 " + SESSION.inTok.toLocaleString() +
    " tok · 输出 " + SESSION.outTok.toLocaleString() + " tok";
}

/* ---------------------------------------------------------------- 槽位追问 */

const SLOT_ASK = {
  resume: {
    title: "先要一样东西：你的简历",
    tip: "诊断和改写必须基于真实经历——没有简历我只能瞎猜，那不如不答。粘贴纯文本即可，只存在你本机。",
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
    '<div class="slot"><h4>⚠ ' + esc(cfg.title) + "</h4>" +
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
      const kws = (r && r.keywords) || extractKeywords(question);
      const b = addAssistant(intent, by);
      b.classList.remove("dots");
      b.innerHTML = md(answerStats(question, kws));
      HISTORY.push({ role: "user", content: question });
      HISTORY.push({ role: "assistant", content: "[已给出统计结果]" });
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
      b.innerHTML = md("⚠️ " + explainError(e.message));
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
    if (res) addUsage(b, res.usage, res.cost);
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
    $("hint").innerHTML = "⚠ 还没配 API Key，只有「统计」类问题能用。点右上角 ⚙ 配置。";
  }

  addSys(
    ALL.length
      ? "已载入 " + JDS.length + " 条 JD" +
        (SCOPE ? "（已按「" + SCOPE + "」筛选，共 " + ALL.length + " 条）" : "") +
        "。回答只依据它们。"
      : "还没采集 JD。去岗位详情页按 Alt+S 存几条。"
  );

  const tot = await getUsageTotal();
  if (tot.calls) {
    addSys(
      "累计用量：" + tot.calls + " 次调用 · " +
      ((tot.inTok || 0) + (tot.outTok || 0)).toLocaleString() + " tok · ≈" +
      fmtCost(tot.cost) + "（自 " + (tot.since || "—") + "）"
    );
  }
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
  SESSION = { calls: 0, inTok: 0, outTok: 0, cost: 0 };
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
