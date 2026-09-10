/* 检索质量评测。
 *
 * 为什么必须有这个文件：在它出现之前，"检索变好了"只能靠感觉。而检索是
 * 整条问答链路的地基——它挑错了 JD，后面模型答得再漂亮也是错的，
 * 而且错得看不出来（模型会认认真真地基于错的上下文编一段合理的话）。
 *
 * 这个脚本回答一个问题：**换一种打分方式，召回是变好了还是变坏了。**
 * 没有它就没法判断"要不要上向量检索"——那会变成一场关于名词的争论。
 *
 * 用法：node jd-insight/scripts/eval-retrieve.mjs
 *
 * ⚠️ 下面的 12 条 JD 是**构造的测试数据**，不是真采集的。
 * 岗位名和公司取自真实截图（这样词汇分布接近真实），正文是我按真实 JD
 * 的写法编的。评测集的价值在于"改动前后可比"，不在于它是真数据。
 * 相关性标注（rel）是人工的，标注依据写在每条 query 的 why 里——
 * 没有依据的标注过两周就没人敢改了。
 */

import { retrieve } from "../extension/lib/retrieve.js";

/* ------------------------------------------------------------ 测试语料 */
const JDS = [
  {
    key: "j1",
    title: "AI 产品经理",
    company: "携程集团",
    tagline: "上海·长宁区 3-5年 本科",
    salary: "20-35K·15薪",
    body:
      "职位描述：1. AI中后台规划与落地。主导榜单业务AI中后台从0到1建设，涵盖知识库体系、" +
      "工作流/Skill设计等核心模块，制定版本迭代策略。(a) 知识库体系：与运营、开发合作，" +
      "沉淀业务数据资产（供给信息、内容数据、运营SOP等），持续提升模型回答的准确率。" +
      "(b) 工作流：抽象通用业务能力（如景点推荐、信息查询、内容生成等），封装为原子Skill；" +
      "基于业务场景设计多Skill协同的工作流。(c) 在保障业务效果的同时，有效控制token成本，" +
      "提升响应速度。2. AI效果评估体系建设：定义AI模型与应用的评估维度与量化指标，" +
      "搭建AI自动化评测、badcase优化流程。3. 跨团队合作：与开发、算法、运营、数据、业务等" +
      "团队高效协作，能识别业务方的模糊诉求，转译为AI产研可落地执行的需求。",
  },
  {
    key: "j2",
    title: "Agent 智能服务产品",
    company: "拼多多集团-PDD",
    tagline: "上海 经验不限 本科",
    salary: "25-50K",
    body:
      "负责智能客服Agent的产品设计与迭代。搭建多轮对话管理能力，处理意图识别、槽位填充、" +
      "上下文继承。建设RAG检索增强链路，负责向量召回与重排序策略，降低幻觉率。" +
      "设计人工接管（HITL）流程与兜底话术。定义客服满意度、一次解决率等北极星指标，" +
      "推动badcase闭环。要求熟悉大模型应用工程化，有Prompt工程实践经验。",
  },
  {
    key: "j3",
    title: "AI 产品经理 — 海外广告业务",
    company: "上海某小型人工智能营销平台Pre-A轮",
    tagline: "上海 经验不限 本科",
    salary: "25-50K·15薪",
    body:
      "面向海外市场的AI广告投放产品。负责Discord、Reddit等海外社区的增长与运营策略产品化，" +
      "搭建ABM线索体系。要求英语可作为工作语言，有出海经验。熟悉AARRR增长模型，" +
      "能用SQL自助取数做转化分析。与算法团队合作优化素材生成与人群定向。",
  },
  {
    key: "j4",
    title: "Ai 产品经理（教育行业）",
    company: "英语流利说",
    tagline: "上海·杨浦区 1-3年 本科 C端产品",
    salary: "20-30K",
    body:
      "负责AI产品在教育场景中的规划与设计，推动口语评测、个性化学习路径等能力落地。" +
      "撰写PRD与需求文档，组织需求评审，定义验收标准。跟进用户反馈与留存数据，" +
      "做A/B实验验证策略效果。需要有C端产品经验，理解学习动机与游戏化设计。",
  },
  {
    key: "j5",
    title: "AI 产品经理",
    company: "上海光之宇智能科技",
    tagline: "上海·闵行区 1-3年 本科",
    salary: "15-25K·14薪",
    body:
      "负责企业知识库产品。搭建文档解析、切片、向量化入库的完整链路，" +
      "优化召回准确率与引用可追溯性。设计知识治理流程：权限、版本、失效提醒。" +
      "要求了解embedding与向量数据库选型，有RAG落地经验者优先。",
  },
  {
    key: "j6",
    title: "产品经理（B端 + AI 方向）",
    company: "黑湖科技",
    tagline: "上海·长宁区·中山公园 3-5年 本科 ERP产品/软件产品",
    salary: "20-35K·15薪",
    body:
      "面向制造业的SaaS产品。负责生产排程、质量追溯等模块的需求梳理与方案设计。" +
      "输出PRD、流程图与数据字典，推动跨部门评审落地。有ERP或MES经验优先。" +
      "AI方向：探索用大模型做工单摘要与异常归因。要求扎实的B端产品基本功。",
  },
  {
    key: "j7",
    title: "AI客服产品经理",
    company: "滴滴",
    tagline: "上海 3-5年 本科",
    salary: "25-40K·15薪",
    body:
      "负责出行场景智能客服。优化意图识别准确率与多轮对话流程，" +
      "设计知识库运营机制与话术管理后台。定义客服机器人评测方案，" +
      "组织人工标注与抽检。推动与人工坐席的协同流程（转人工、工单流转）。" +
      "要求有对话式产品经验，熟悉客服业务指标。",
  },
  {
    key: "j8",
    title: "AI 产品经理",
    company: "上海柘野之间科技",
    tagline: "上海·静安区 4天/周 3个月 本科",
    salary: "200-250元/天",
    body:
      "兼职岗位。协助搭建内部AI工具链，包括Prompt模板管理、模型效果对比、" +
      "调用成本统计。需要能独立完成从需求到验证的小闭环。有Agent或工作流产品经验优先。",
  },
  {
    key: "j9",
    title: "出海招商运营助理",
    company: "上海从鲸信息技术",
    tagline: "上海 1-3年 大专",
    salary: "13-26K·14薪",
    body:
      "负责海外商家招募与冷启动运营。通过LinkedIn、Discord等渠道触达潜在商家，" +
      "维护社群活跃度。跟踪商家GMV与留存，输出周报。要求英语流利，有跨境电商经验。",
  },
  {
    key: "j10",
    title: "AI产品经理 (MJ036265)",
    company: "携程集团",
    tagline: "上海·长宁区·北新泾 1-3年 本科",
    salary: "20-35K·15薪",
    body:
      "负责旅游内容AI生成方向。设计内容生成的Prompt体系与质量校验规则，" +
      "建立人工评审与自动评测双轨机制。关注生成内容的事实准确性与合规风险。" +
      "与内容运营团队合作定义内容标准。",
  },
  {
    key: "j11",
    title: "ai语音产品经理-合肥",
    company: "科大讯飞",
    tagline: "合肥 1-3年 本科",
    salary: "13-26K·14薪",
    body:
      "负责语音交互产品。优化ASR识别率与TTS自然度的产品指标，" +
      "设计语音场景下的多轮对话与打断策略。需要理解语音链路的工程约束。",
  },
  {
    key: "j12",
    title: "AI 产品经理（协同办公创新方向）",
    company: "米哈游",
    tagline: "上海·徐汇区·漕河泾 经验不限 本科 B端产品",
    salary: "20-40K·16薪",
    body:
      "探索AI在协同办公场景的应用。设计文档助手、会议纪要、任务编排等能力。" +
      "需要有B端产品设计能力，能把模糊的效率诉求转化为可交付的功能。" +
      "对Agent与工具调用（function call）有理解者优先。",
  },
];

/* --------------------------------------------------- 人工标注的评测集 */
const CASES = [
  {
    q: "有几条 JD 要求 Discord 或 Reddit 运营经验？",
    rel: ["j3", "j9"],
    why: "j3 明写 Discord、Reddit；j9 明写 Discord。其余都没提海外社区渠道。",
  },
  {
    q: "哪些岗位要做 RAG 或者向量召回？",
    rel: ["j2", "j5", "j1"],
    why: "j2 明写 RAG 与向量召回；j5 明写向量化入库与 RAG；j1 有知识库体系与召回准确率但没用 RAG 这个词——正是要靠同义扩展召回的那条。",
  },
  {
    q: "多轮对话和意图识别相关的岗位有哪些",
    rel: ["j2", "j7", "j11"],
    why: "j2/j7 明写多轮对话与意图识别；j11 是语音场景的多轮对话与打断策略。",
  },
  {
    q: "有哪些岗位需要写 PRD、做需求评审这类产品基本功？",
    rel: ["j4", "j6"],
    why: "j4 明写 PRD/需求文档/需求评审/验收标准；j6 明写输出 PRD 与跨部门评审。",
  },
  {
    q: "要英语好、有出海经验的是哪几条？",
    rel: ["j3", "j9"],
    why: "j3 要求英语可作为工作语言 + 出海经验；j9 要求英语流利 + 跨境电商。",
  },
  {
    q: "携程有几个岗位",
    rel: ["j1", "j10"],
    why: "公司字段命中，这条专门测字段加权是否生效。",
  },
  {
    q: "哪些岗位涉及模型效果评估、badcase 优化？",
    rel: ["j1", "j2", "j10"],
    why: "j1 有 AI 效果评估体系与 badcase；j2 有 badcase 闭环；j10 有自动评测与人工评审。",
  },
  {
    q: "有没有 B 端或者 SaaS 方向的产品岗",
    rel: ["j6", "j12"],
    why: "j6 是制造业 SaaS + B端基本功；j12 标签里就是 B端产品。",
  },
  {
    q: "Prompt 工程相关的岗位",
    rel: ["j2", "j8", "j10"],
    why: "j2 要求 Prompt 工程实践；j8 要做 Prompt 模板管理；j10 要设计 Prompt 体系。",
  },
  {
    q: "有兼职或者日结的岗位吗",
    rel: ["j8"],
    why: "只有 j8 是兼职、按天计薪。这条测的是稀有词能不能压过高频词。",
  },
];

/* ------------------------------------------------------------ 指标 */
function evalOne(c, k) {
  const { picked } = retrieve(JDS, c.q, k);
  const got = picked.map((r) => r.key);
  const relSet = new Set(c.rel);
  const hit = got.filter((g) => relSet.has(g));
  // recall@k：应该找到的里面找到了几个
  const recall = c.rel.length ? hit.length / c.rel.length : 0;
  // 第一个正确结果的排名倒数（MRR）：排在第一位比排在第五位有用得多
  let rr = 0;
  for (let i = 0; i < got.length; i++) {
    if (relSet.has(got[i])) {
      rr = 1 / (i + 1);
      break;
    }
  }
  // 排在前面的错误结果（噪声）：它们会挤掉真正相关的，也会污染模型上下文
  const noise = got.filter((g) => !relSet.has(g));
  return { recall, rr, got, noise, missed: c.rel.filter((r) => !relSet.has(r) || !got.includes(r)) };
}

const K = Number(process.argv[2] || 5);
let sumRecall = 0;
let sumRR = 0;
let perfect = 0;

console.log(`检索评测 · k=${K} · 语料 ${JDS.length} 条 · 用例 ${CASES.length} 条\n`);
for (const c of CASES) {
  const r = evalOne(c, K);
  sumRecall += r.recall;
  sumRR += r.rr;
  if (r.recall === 1) perfect++;
  const flag = r.recall === 1 ? "  OK  " : r.recall > 0 ? " PART " : " MISS ";
  console.log(`${flag} recall ${(r.recall * 100).toFixed(0).padStart(3)}%  rr ${r.rr.toFixed(2)}  ${c.q}`);
  console.log(`        应召回 [${c.rel.join(",")}]  实际 [${r.got.join(",") || "空"}]`);
  if (r.missed.length) console.log(`        漏掉 [${r.missed.join(",")}]`);
}

const n = CASES.length;
console.log("\n————————————————————————————————");
console.log(`平均 recall@${K}   ${((sumRecall / n) * 100).toFixed(1)}%`);
console.log(`MRR             ${(sumRR / n).toFixed(3)}`);
console.log(`全对的用例       ${perfect}/${n}`);
