/* 意图路由评测集。
 *
 *     node jd-insight/scripts/eval-intents.mjs
 *
 * ⚠️ 为什么必须有这个，而不是靠 `node --check`：
 * 就在写 GUARD 的时候，我用脚本生成代码时把 `\n` 写成了真换行，
 * 正则字面量里出现了换行符——**而 node --check 通过了**。
 * 语法检查只回答"能不能解析"，回答不了"路由对不对"。
 * 这是这个项目第三次踩「脚本生成代码写坏字符串」，
 * 前两次都是靠人在界面上发现白屏。行为测试是唯一的自动闸门。
 *
 * 断言分三类，严重程度不同：
 *   · RED  红线。错了就是安全问题（编经历 / 改事实字段）。
 *   · MUST 必须命中某个意图，且必须由规则命中（省钱指标）。
 *   · NOT  必须**不是**某个意图。用来钉住误报边界——
 *          「这些 JD 里有哪些是我没做过的」绝不能被红线拦掉，
 *          那是这个产品的主功能。
 *   · MODEL 规则故意不接，交给模型分类。这类是**已知的覆盖洞**，
 *          在这里如实登记，不假装它被覆盖了。
 */
import { ruleClassify, INTENTS } from "../extension/lib/intents.js";

const CASES = [
  // ── 红线（golden D 组） ────────────────────────────────
  { kind: "RED", q: "我没做过 Discord 运营，帮我写一条", want: "GUARD",
    why: "D3。原来命中 rule:kw 被判成 ASK_JD，红线防护装在了它不经过的分支上" },
  { kind: "RED", q: "帮我把职位名改成「AI 产品总监」", want: "GUARD",
    why: "D2。改身份字段不是措辞问题，是事实不符" },
  { kind: "RED", q: "我完全没接触过向量数据库，帮我加一条相关经历", want: "GUARD",
    why: "同 D3 的另一种问法，验证 FAB_CUE + WRITE_REQ 两信号都能覆盖" },
  { kind: "RED", q: "把我的学历写成硕士", want: "GUARD",
    why: "动词在前、字段在后的方向，验证 FACT_FIELD 双向都拼对了" },

  // ── 红线的误报边界 ────────────────────────────────────
  { kind: "NOT", q: "这些 JD 里有哪些能力是我没做过的", not: "GUARD",
    why: "只有「没做过」没有写作请求。这是 GAP，是主功能，绝不能被拦" },
  { kind: "NOT", q: "帮我把「提升了流量」改成有数字的版本", not: "GUARD",
    why: "golden D1。宾语是一句话不是身份字段，属于正当改写（HITL 会要求确认数字）" },

  // ── 意图必须命中（golden A 组，A2/A4 已按新决策更新） ──
  { kind: "MUST", q: "有几条 JD 要求 Discord 或 Reddit 运营经验？", want: "STATS",
    why: "A1。量词 + 抠得出宾语 → 确定性计算" },
  { kind: "MUST", q: "这批 JD 里最高频的能力要求是什么？按覆盖率排", want: "GAP",
    why: "A2。**期望值已改**：原来标 STATS 且打了 ✅，但那正是代码里记录成 bug 的假通过" },
  { kind: "MUST", q: "哪些岗位要求多轮对话和意图识别？", want: "ASK_JD",
    why: "A3。有领域关键词、无其他意图特征 → 走检索" },
  { kind: "MUST", q: "拿我的简历对比这些 JD，我最该补什么？", want: "GAP",
    why: "A4。**期望值已改**：用户定的——要那张确定性缺口表，不要模型写的叙述" },
  { kind: "MUST", q: "帮我改写一下 SEO 那条经历", want: "REWRITE", why: "A5" },
  { kind: "MUST", q: "根据这些 JD，面试最可能追问我什么？", want: "PREP", why: "A6" },
  { kind: "MUST", q: "帮我统计一下", want: "STATS", why: "汇总类无宾语是正常的" },
  { kind: "MUST", q: "我该补什么能力", want: "GAP", why: "缺口的最直白问法" },
  { kind: "MUST", q: "我这简历匹配度怎么样", want: "DIAGNOSE",
    why: "要叙述性对比 → 走模型。这条钉住 GAP/DIAGNOSE 的边界没被 GAP 吃掉" },

  // ── 已知覆盖洞：规则不接，交给模型 ────────────────────
  { kind: "MODEL", q: "今天天气怎么样", why: "A7。越界问题，规则判不准，交模型" },
  { kind: "MODEL", q: "这些公司都在哪个城市",
    why: "A8。**已知洞**：stats() 里有城市分布，但没有量词也没有关键词，路由不到。待补字段型意图" },
  { kind: "MODEL", q: "我有哪些岗位该跟进了",
    why: "**已知洞**：pipeline.js 的 needsFollowUp() 现成，对话层够不到。待补 PIPELINE 意图" },
  { kind: "MODEL", q: "薪资中位数是多少",
    why: "**已知洞**：STATS 的 desc 里承诺了中位数，规则路由不到，stats() 也没实现" },
  { kind: "MODEL", q: "帮我写一段自我介绍",
    why: "带写作请求，不许走 rule:kw 捷径（就算句子里有领域关键词）" },
];

let fail = 0;
let ruleHit = 0;
let ruleTotal = 0;

function line(ok, tag, got, q) {
  console.log((ok ? "  ok   " : "  FAIL ") + tag.padEnd(6) + (got + "").padEnd(10) + q);
  if (!ok) fail++;
}

console.log("── 意图路由 ──");
for (const c of CASES) {
  const r = ruleClassify(c.q);
  const got = r ? r.intent.id : "(模型)";
  const by = r ? r.by : "model";

  if (c.kind === "MODEL") {
    line(r === null, "MODEL", got, c.q);
  } else if (c.kind === "NOT") {
    line(got !== c.not, "NOT", got + " ≠ " + c.not, c.q);
  } else {
    ruleTotal++;
    const ok = got === c.want && by.startsWith("rule:");
    if (ok) ruleHit++;
    line(ok, c.kind, got + (by.startsWith("rule:") ? "" : " [非规则]"), c.q);
  }
  if (!r || r.intent.id !== (c.want || r.intent.id)) {
    // 失败时把 why 打出来，省得回头翻这个文件
    const bad = c.kind === "MODEL" ? r !== null
      : c.kind === "NOT" ? (r && r.intent.id === c.not)
      : !(r && r.intent.id === c.want);
    if (bad) console.log("         ↑ " + c.why);
  }
}

/* 每个确定性意图都必须有一个真的能回答它的执行体。
   这条断言防的是最坏的一种情况：**意图声明了一个执行体没有的能力**——
   分类器会把问题往那儿送，然后答非所问。
   STATS 的 desc 里写着"薪资中位数"而 stats() 没实现，就是这个坑。 */
console.log("\n── 意图定义自查 ──");
const DETERMINISTIC_WITH_HANDLER = ["GUARD", "STATS", "GAP"];
for (const id of Object.keys(INTENTS)) {
  const it = INTENTS[id];
  const problems = [];
  if (!it.label || !it.desc) problems.push("缺 label/desc");
  if (it.deterministic && !DETERMINISTIC_WITH_HANDLER.includes(id)) {
    problems.push("标了 deterministic 但 sidepanel 里没有对应执行体");
  }
  if (it.deterministic && it.needsRetrieval) problems.push("deterministic 却要检索，矛盾");
  line(problems.length === 0, "DEF", id, problems.join("；") || "ok");
}

console.log("");
console.log("规则命中率 %d/%d（省钱指标，越高越好）", ruleHit, ruleTotal);
if (fail) {
  console.log("!! %d 条不过", fail);
  process.exit(1);
}
console.log("全部断言通过");
