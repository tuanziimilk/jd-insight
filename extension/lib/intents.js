/* 意图识别与路由
 *
 * 设计原则：**规则先行，模型兜底。**
 *   能用确定性规则判定的意图（"有几条要求 X"这类统计题）绝不交给模型——
 *   规则零成本、零延迟、结果可复现，而且统计题模型反而容易算错。
 *   规则判不了的才调一次模型分类。
 *
 * 每个意图都必须定义三件事：
 *   1. 需要哪些槽位（slots）——缺了就澄清追问，不猜
 *   2. 要不要检索（needsRetrieval）
 *   3. 出错/低置信时怎么兜底（fallback）
 */

export const INTENTS = {
  STATS: {
    id: "STATS",
    label: "全库统计",
    desc: "问覆盖率、数量、分布：有几条要求 Discord / 多少条在上海 / 薪资中位数",
    slots: [],
    needsRetrieval: false, // 走确定性计算，不进模型
    deterministic: true,
  },
  ASK_JD: {
    id: "ASK_JD",
    label: "岗位追问",
    desc: "针对采集到的 JD 内容提问：哪些岗位要出海经验 / 这家公司要什么",
    slots: [],
    needsRetrieval: true,
  },
  DIAGNOSE: {
    id: "DIAGNOSE",
    label: "简历诊断",
    desc: "拿我的简历对比这些 JD，找差距",
    slots: ["resume"], // ⭐ 缺简历就必须先要，不能凭空诊断
    needsRetrieval: true,
  },
  REWRITE: {
    id: "REWRITE",
    label: "经历改写",
    desc: "把某条经历改写成更贴目标岗位的措辞",
    slots: ["resume", "target"],
    needsRetrieval: true,
    hitl: true, // ⭐ 涉及事实性数字，必须人工确认
  },
  PREP: {
    id: "PREP",
    label: "面试准备",
    desc: "根据这些 JD 猜面试会问什么、我该准备什么",
    slots: [],
    needsRetrieval: true,
  },
  SMALLTALK: {
    id: "SMALLTALK",
    label: "闲聊/兜底",
    desc: "与求职情报无关的问题",
    slots: [],
    needsRetrieval: false,
  },
};

/* ---------------------------------------------------------------- 规则层 */

const STATS_PAT = [
  /(几条|多少条|多少个|几个|占比|比例|覆盖率|分布|中位|平均)/,
  /(统计|汇总|一共|总共)/,
];
const DIAGNOSE_PAT = [/(诊断|差距|缺什么|补什么|该补|欠缺|够不够|匹配度|我能投|适合我|对比.*简历|简历.*对比|对标)/];
const REWRITE_PAT = [/(改写|润色|重写|帮我改|怎么写|措辞|优化.*(经历|描述|简历))/];
const PREP_PAT = [/(面试|会问|准备什么|押题|反问)/];

/** 从"有几条要求 Discord"里抠出关键词 */
export function extractKeywords(text) {
  const out = [];
  // 引号里的
  (text.match(/[「『"'"]([^」』"'"]{1,20})[」』"'"]/g) || []).forEach((m) =>
    out.push(m.replace(/[「『"'"」』]/g, ""))
  );
  // 常见技术/渠道词直接命中
  const KNOWN = [
    "discord", "reddit", "intercom", "abm", "linkedin", "rag", "agent", "prompt",
    "sft", "rlhf", "sql", "prd", "英语", "出海", "海外", "多轮对话", "意图识别",
    "客服", "评测", "幻觉", "向量", "微调", "社群", "增长", "seo", "aarrr",
    "金融", "电商", "saas", "工作流", "mcp", "function call",
  ];
  const low = text.toLowerCase();
  KNOWN.forEach((k) => {
    if (low.includes(k) && !out.includes(k)) out.push(k);
  });
  return out;
}

/**
 * 规则判定。返回 {intent, confidence, by} 或 null（交给模型）
 */
export function ruleClassify(text) {
  const t = (text || "").trim();
  if (!t) return { intent: INTENTS.SMALLTALK, confidence: 1, by: "empty" };

  const isStats = STATS_PAT.some((p) => p.test(t));
  const kws = extractKeywords(t);
  // "有几条要求 Discord" —— 既有统计词又有关键词，规则最可靠
  if (isStats && kws.length) {
    return { intent: INTENTS.STATS, confidence: 0.95, by: "rule:stats+kw", keywords: kws };
  }
  if (isStats) return { intent: INTENTS.STATS, confidence: 0.7, by: "rule:stats" };
  if (REWRITE_PAT.some((p) => p.test(t))) {
    return { intent: INTENTS.REWRITE, confidence: 0.85, by: "rule:rewrite" };
  }
  if (DIAGNOSE_PAT.some((p) => p.test(t))) {
    return { intent: INTENTS.DIAGNOSE, confidence: 0.85, by: "rule:diagnose" };
  }
  if (PREP_PAT.some((p) => p.test(t))) {
    return { intent: INTENTS.PREP, confidence: 0.8, by: "rule:prep" };
  }
  // 提到了领域关键词、又没有其他意图特征 → 就是在问 JD 内容。
  // 这条规则专门用来省掉一次模型分类调用（这类问题占大多数）。
  if (kws.length) {
    return { intent: INTENTS.ASK_JD, confidence: 0.65, by: "rule:kw", keywords: kws };
  }
  return null; // 规则拿不准 → 模型分类
}

/** 给模型的分类提示词（只回一个词，好解析） */
export function classifyPrompt(text) {
  const list = Object.values(INTENTS)
    .map((i) => `${i.id}：${i.desc}`)
    .join("\n");
  return [
    {
      role: "system",
      content:
        "你是意图分类器。把用户问题归入下列意图之一，**只输出意图 ID，不要任何解释**。\n\n" +
        list +
        "\n\n拿不准就输出 ASK_JD。",
    },
    { role: "user", content: text },
  ];
}

export function parseIntentId(raw) {
  const id = String(raw || "").toUpperCase().match(/[A-Z_]{3,}/);
  return (id && INTENTS[id[0]]) || INTENTS.ASK_JD;
}

/* ---------------------------------------------------------------- 系统提示 */

/* ⚠️ 提示词拼装顺序 = 成本问题，不只是可读性问题。
 *
 * 各家的上下文缓存都是**前缀匹配**：只要开头一段字节完全一致就能命中，
 * 一旦中间某处变了，后面全部失效、按全价重算。
 *
 * 所以顺序必须是「越不变的放越前」：
 *   ① base 硬规则（永不变）
 *   ② 用户简历（同一用户内稳定）
 *   ③ 意图指令（换意图才变）
 *   ④ 降级标记（偶发）
 *   ⑤ 检索到的 JD（每次都变）
 *
 * 之前的顺序把「意图指令」放在「简历」前面——换个意图就把简历那一大段
 * 也踢出缓存了。简历动辄几千 token，这个顺序错误的代价是实打实的。
 */
export function systemPrompt(intent, ctx, profile, degraded) {
  const base = [
    "你是「JD Insight」的求职情报助手。用户采集了一批真实招聘 JD，你基于这些 JD 回答。",
    "",
    "硬规则：",
    "1. **只依据提供的 JD 内容回答。JD 里没有的，明确说「采集到的 JD 里没有这个信息」，不要编。**",
    "2. 引用具体岗位时带上【JD n】编号，方便用户回溯原文。",
    "3. 涉及数字（薪资、年限、数量）时，只用 JD 原文里出现的；" +
      "**如果 JD 里薪资是空的，说明是采集时被网站字体反爬挡住了，不要猜。**",
    "4. 回答要短、有结构。能用表格就用表格。不要写客套话。",
  ];

  // ② 简历：同一用户内稳定，放在会变的意图指令之前
  if (profile && profile.resume) {
    base.push("", "---", "【用户简历】", profile.resume.slice(0, 6000));
  }

  // ③ 意图指令
  if (intent.id === "DIAGNOSE") {
    base.push(
      "",
      "本轮任务：**简历诊断**。按「JD 高频要求 × 用户是否具备」逐条对比，输出三段：",
      "① 强匹配（有真实项目支撑的）",
      "② 部分匹配（概念懂但缺实操）",
      "③ 空白（完全没做过）——这一段最重要，要按「JD 覆盖率高低」排序，告诉他先补哪个。",
      "不要安慰，直接说缺什么。"
    );
  }
  if (intent.id === "REWRITE") {
    base.push(
      "",
      "本轮任务：**经历改写**。规则：",
      "- **绝对不许编造或修改任何数字、公司名、职位名、时间。**",
      "- 需要用户补充事实才能写好的地方，用 `【需你确认：xxx】` 标出来，不要自己填。",
      "- 改写只动措辞和结构，让它贴目标 JD 的用词；同时说明你改了什么、为什么。"
    );
  }
  if (intent.id === "PREP") {
    base.push(
      "",
      "本轮任务：**面试准备**。基于这些 JD 的共性要求，列出最可能被追问的问题，",
      "并标注哪些问题用户目前答不上来（依据他的画像）。"
    );
  }

  if (degraded) {
    base.push(
      "",
      "⚠️ 本轮是**降级回答**：用户跳过了必要信息（如简历）。",
      "所以你必须在开头一句话说明「因为没有 XX，以下只能基于 JD 泛泛地说」，",
      "**不要假装结论很可靠**，也不要虚构用户的背景。"
    );
  }

  // ⑤ 检索结果：每次都变，必须放最后
  if (ctx) {
    base.push("", "---", "【检索到的相关 JD】", ctx);
  }
  return base.join("\n");
}
