/* 引用校验的断言（golden_questions 的 C3）。
 *
 *     node jd-insight/scripts/eval-cite.mjs
 *
 * ══════════ C3 为什么能自动化，C1/C2/C4 为什么不能 ══════════
 *
 * golden_questions.md 的 C 组（防幻觉）四条一直是 ⬜。它们里面：
 *   · C1「有哪个岗位要求区块链经验？（语料里没有）」
 *   · C2「滴滴那个岗位薪资多少？（薪资被反爬为空）」
 *   · C4「哪家公司要葡萄牙语？」
 *   这三条考的是**模型的输出**，必须真调一次 API 才知道，没法在这里断言。
 *
 *   · C3「引用【JD 2】说的内容，是否真的出自第 2 条？」
 *   这一条不一样：它是**可判定的**。给定回答文本和交给模型的那几条 JD，
 *   "这个编号存不存在""这句话提到的东西在那条 JD 里有没有"都是确定的。
 *
 * 所以这一轮把 C3 从"人工逐条核对来源区链接"变成一道自动检查，
 * C1/C2/C4 仍然需要人跑（清单见 golden_questions.md）。
 *
 * ⚠️ 下面「不该报」的那一组和「该报」的一样重要。
 * 软提示天生会误报（综述句、同义词、一句引多条），
 * 而一个动不动就报的校验器会被学会无视 —— 那时它比没有更糟，
 * 因为它还占着"已经检查过了"这个位置。
 */
import { checkCitations, visibleText, CONTEXT_PER_DOC } from "../extension/lib/cite.js";

let fail = 0;
function check(name, cond, detail) {
  console.log((cond ? "  ok   " : "  FAIL ") + name + (detail ? "  " + detail : ""));
  if (!cond) fail++;
}

/* 三条合成 JD。刻意让每条有**互不重叠**的技能，这样"错位"才可判定。 */
const PICKED = [
  {
    title: "AI 产品经理（RAG 方向）",
    company: "甲公司科技",
    tagline: "上海 · 3-5年",
    body:
      "负责检索增强生成（RAG）产品的设计与落地，搭建向量检索链路，" +
      "推动知识库召回效果优化，输出评测集并跟踪 recall 指标。",
  },
  {
    title: "对话产品经理",
    company: "乙公司网络",
    tagline: "北京 · 5-10年",
    body:
      "负责多轮对话产品的整体体验，设计对话流程与意图识别方案，" +
      "打磨提示词策略，提升多轮对话的任务完成率。",
  },
  {
    title: "增长产品经理",
    company: "丙公司信息",
    tagline: "深圳 · 3-5年",
    body: "负责海外市场的用户增长，搭建投放与归因体系，做 A/B 实验与数据分析。",
  },
];

console.log("── 硬错 1：编号越界（模型自己编了一个不存在的编号）──");
{
  const r = checkCitations("这个岗位要求 RAG 经验【JD 7】。", PICKED, { needsRetrieval: true });
  check("报了硬错", r.hard.length === 1, JSON.stringify(r.hard.map((h) => h.kind)));
  check("类型是 out-of-range", r.hard[0] && r.hard[0].kind === "out-of-range");
  check("说清了只有几条", r.hard[0] && r.hard[0].detail.includes("3 条"));
  check("带上了原句（不然没法定位）", r.hard[0] && r.hard[0].text.includes("【JD 7】"));
}
{
  const r = checkCitations("【JD 0】说的。", PICKED, { needsRetrieval: true });
  check("0 也算越界（编号从 1 起）", r.hard.some((h) => h.kind === "out-of-range"));
}

console.log("\n── 硬错 2：该接地却一个出处都没有 ──");
{
  const r = checkCitations("这些岗位普遍要求有大模型落地经验，建议重点补评测。", PICKED, {
    needsRetrieval: true,
  });
  check("报了 no-citation", r.hard.some((h) => h.kind === "no-citation"));
}
{
  /* 反面：不需要接地的意图（比如纯统计、纯改写）不该被这条打扰 */
  const r = checkCitations("这些岗位普遍要求大模型落地经验。", PICKED, {
    needsRetrieval: false,
  });
  check("不接地的意图不报这一条", !r.hard.some((h) => h.kind === "no-citation"));
}
{
  const r = checkCitations("", PICKED, { needsRetrieval: true });
  check("空回答不报（那是别的问题，不是引用问题）", r.hard.length === 0);
}
{
  const r = checkCitations("普遍要求大模型经验。", [], { needsRetrieval: true });
  check("一条 JD 都没检索到时不报（没得引）", r.hard.length === 0);
}

console.log("\n── 软提示：错位嫌疑 ──");
{
  /* 把甲公司的 RAG 要求挂到乙公司那条上 —— 这就是 C3 说的那种错位。 */
  const r = checkCitations("【JD 2】要求做 RAG 和向量检索。", PICKED, { needsRetrieval: true });
  check("报了软提示", r.soft.length >= 1, JSON.stringify(r.soft.map((x) => x.kind)));
  check("类型是 no-overlap", r.soft.some((x) => x.kind === "no-overlap"));
  check("没有升级成硬错（这一类只能是嫌疑）", r.hard.length === 0);
}
{
  /* 公司名错位：句子里写着甲公司，引的却是 JD 2（乙公司）。
     公司名是确定字符串，所以这个信号比技能不重合强。 */
  const r = checkCitations("甲公司科技那个岗位要求多轮对话【JD 2】。", PICKED, {
    needsRetrieval: true,
  });
  check("报了 company-mismatch", r.soft.some((x) => x.kind === "company-mismatch"));
  check(
    "指出了那家公司其实是第几条",
    r.soft.some((x) => x.kind === "company-mismatch" && x.detail.includes("【JD 1】"))
  );
}

console.log("\n── 不该报的（误报会让这道检查失去意义）──");
const MUST_BE_CLEAN = [
  ["引对了：RAG 挂在 JD 1 上", "【JD 1】要求做 RAG 和向量检索，还要输出评测集。"],
  ["引对了：多轮对话挂在 JD 2 上", "【JD 2】要求多轮对话和意图识别。"],
  ["引对了：增长挂在 JD 3 上", "【JD 3】要求做用户增长和 A/B 实验。"],
  [
    "一句引两条，两条都对得上",
    "RAG 和多轮对话分别出现在【JD 1】和【JD 2】里。",
  ],
  ["提到自己公司名 + 引对了", "甲公司科技那个岗位要求 RAG【JD 1】。"],
  [
    "句子里没有任何可匹配的技能（纯叙述句）",
    "【JD 1】这条的薪资采集时没抓到，页面用了字体反爬。",
  ],
  ["没有引用、也不需要接地", "你可以把这段经历按目标岗位的用词重写一遍。"],
];
for (const [name, text] of MUST_BE_CLEAN) {
  const r = checkCitations(text, PICKED, { needsRetrieval: !text.includes("重写一遍") });
  const bad = r.hard.length + r.soft.length;
  check(
    name,
    bad === 0,
    bad ? JSON.stringify([...r.hard, ...r.soft].map((x) => x.kind + ":" + x.detail.slice(0, 40))) : ""
  );
}

console.log("\n── 校验用的正文必须和模型看到的一样多 ──");
/* ⚠️ 这条钉的是一个很容易写错、而且错了之后**校验结果会偏向"没问题"**的细节：
   buildContext 把正文截到 1400 字，如果校验器拿全文去比，
   第 3000 字上的一个词就会让"模型不可能知道的事"被判成"有依据"。 */
{
  const long = {
    title: "长文岗位",
    company: "丁公司",
    tagline: "",
    body: "普通描述。".repeat(300) + "需要做向量检索和 RAG。",
  };
  const vis = visibleText(long, CONTEXT_PER_DOC);
  check(
    "截断之后看不到末尾那句（否则校验器比模型知道得多）",
    !vis.includes("向量检索"),
    `可见 ${vis.length} 字 / 全文 ${long.body.length} 字`
  );
  const r = checkCitations("【JD 1】要求做 RAG 和向量检索。", [long], { needsRetrieval: true });
  check("于是这句被标成需要核对（对的，模型没看到那段）", r.soft.length >= 1);
  /* 反过来：如果把 perDoc 放大到能看见，就不该报了 —— 证明上面那条不是巧合 */
  const r2 = checkCitations("【JD 1】要求做 RAG 和向量检索。", [long], {
    needsRetrieval: true,
    perDoc: 99999,
  });
  check("把可见范围放大到全文，就不报了（证明判据真是可见范围）", r2.soft.length === 0);
}

console.log("\n── 返回值要够用来渲染 ──");
{
  const r = checkCitations("【JD 2】要求做 RAG【JD 7】。", PICKED, { needsRetrieval: true });
  check("cited 列出所有引用过的编号", JSON.stringify(r.cited) === "[2,7]", JSON.stringify(r.cited));
  check("硬错和软提示分开返回", r.hard.length >= 1 && r.soft.length >= 1);
  check("每一项都有 detail（界面直接显示它）", [...r.hard, ...r.soft].every((x) => !!x.detail));
}

console.log("");
if (fail) {
  console.log(`!! ${fail} 条断言不过`);
  process.exit(1);
}
console.log("全部断言通过");
