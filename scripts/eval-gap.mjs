/* 能力缺口聚合的验证脚本。
 *
 *     node jd-insight/scripts/eval-gap.mjs
 *
 * 为什么需要这个：aggregateGaps 的输出是"排行榜"，肉眼看一眼总觉得"挺合理"，
 * 但**合理和正确是两件事**。检索层就吃过这个亏——我加了 bigram 扩展，
 * 看着更聪明，实测 recall 从 86.7 掉到 85.0，只有 eval 集能发现。
 * 所以这里也先把断言写下来，再谈调参。
 *
 * 断言用的是 fixture 的**已知事实**，不是我对结果的印象：
 *   · 这批 JD 是 AI 产品岗，RAG/知识库 必然被命中，且简历里写过 → 必须归入 have
 *   · 只有标题没正文的记录必须被跳过，而不是拉低所有频次
 *   · 简历里写过的项必须出现在 have 而不是 gap
 *   · 每一条都必须带得回 JD 原文（没出处不算命中）
 *   · JD 条数不足时必须明确拒答，不能给一张看似可信的表
 *   · 展示出来的排序必须能用展示出来的列验算（权重/优先级两列）
 */
import { aggregateGaps, renderGaps, MIN_JDS, matchSkills } from
  "../extension/lib/gap.js";
import JDS from "./fixtures/jd-full.mjs";

/* 一份简化的简历正文，只保留能力关键词。刻意**故意漏掉** RAG/评测 之外的几项，
   用来验证"简历里有的不该出现在缺口里"这条。 */
const RESUME = [
  "AI 产品经理。负责需求文档 PRD 撰写与需求评审，定义验收标准。",
  "搭建 RAG 知识库检索链路，做过召回评测与 badcase 优化流程。",
  "熟悉提示词设计与多轮对话产品设计，独立推动 0 到 1 落地。",
  "负责 SEO / GEO 出海内容增长，跨团队协作推动上线。",
].join("\n");

let fail = 0;
function check(name, cond, detail) {
  console.log((cond ? "  ok   " : "  FAIL ") + name + (detail ? "  " + detail : ""));
  if (!cond) fail++;
}

console.log("fixture：%d 条 JD\n", JDS.length);

/* ── 1. 正常聚合 ───────────────────────────────────────── */
const res = aggregateGaps(JDS, RESUME, { scope: "全部" });
console.log("── 聚合结果 ──");
console.log(renderGaps(res, 10));
console.log("");

console.log("── 断言 ──");
check("ok=true", res.ok === true);
check("参与统计的条数 = fixture 条数", res.analyzed === JDS.length,
  `analyzed=${res.analyzed}`);
check("跳过 0 条（fixture 都是完整长度正文）", res.skipped === 0,
  `skipped=${res.skipped}`);
check("识别到简历正文", res.resumeKnown === true, `${res.resumeChars} 字`);

const ids = res.rows.map((r) => r.id);
check("命中的能力项 >= 8（词典没空跑）", res.rows.length >= 8,
  `${res.rows.length} 项`);
check("每一项都带 JD 出处", res.rows.every((r) => r.evidence.length > 0));
check("每条出处都指得回具体公司", res.rows.every(
  (r) => r.evidence.every((e) => e.company && e.sentence.length >= 4)));
check("按 priority 降序", res.rows.every(
  (r, i) => i === 0 || res.rows[i - 1].priority >= r.priority));
check("jdCount 不超过 analyzed", res.rows.every((r) => r.jdCount <= res.analyzed));

/* 简历侧：写过的必须进 have，没写过的才进 gap */
const resumeHits = matchSkills(RESUME);
const wrongSide = res.gap.filter((r) => resumeHits.has(r.id));
check("简历里写过的项不出现在缺口里", wrongSide.length === 0,
  wrongSide.map((r) => r.label).join("、"));
check("have + gap = rows", res.have.length + res.gap.length === res.rows.length);

/* fixture 的已知事实：这批 JD 是 AI 产品岗，RAG/知识库 必然是高频项 */
const rag = res.rows.find((r) => r.id === "rag");
check("rag 被命中", !!rag, rag ? `${rag.jdCount}/${res.analyzed} 条` : "没命中");
check("rag 在简历里 → 归入 have", !!rag && rag.inResume === true);

/* 硬性门槛不能混进能力项——学历/年限不是"能补的能力" */
check("学历/年限不在能力项里",
  !ids.includes("degree") && !ids.includes("years"), ids.join(","));

/* ── 2. JD 太少 → 必须明确拒答，不能给一张看似可信的表 ── */
const few = aggregateGaps(JDS.slice(0, MIN_JDS - 1), RESUME);
check("JD 不足时 ok=false", few.ok === false);
check("拒答理由里带条数", few.ok === false && /\d/.test(few.reason));

/* ── 3. 只有标题没正文的记录必须被跳过，不能拉低频次 ── */
const noBody = [{ title: "AI 产品经理", company: "某公司", body: "", pageText: "" }];
const mixed = aggregateGaps([...JDS, ...noBody], RESUME);
check("空正文记录被跳过", mixed.skipped === 1, `skipped=${mixed.skipped}`);
check("分母不含被跳过的", mixed.analyzed === JDS.length);
const ragMixed = mixed.rows.find((r) => r.id === "rag");
check("加一条空记录不改变任何频次", !!ragMixed && !!rag && ragMixed.jdCount === rag.jdCount);

/* ── 4. 没有简历 → 降级成"高频要求排行"，绝不把所有项都当缺口 ── */
const noResume = aggregateGaps(JDS, "");
check("无简历时 resumeKnown=false", noResume.resumeKnown === false);
check("无简历时文案说明这不是缺口",
  /不是缺口/.test(renderGaps(noResume)));

console.log("");
if (fail) {
  console.log("!! %d 条断言不过", fail);
  process.exit(1);
}
console.log("全部断言通过");
