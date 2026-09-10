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
  GUARD: {
    id: "GUARD",
    label: "红线",
    desc: "要求编造没做过的经历、或改掉职位名/公司/学历/时间这类事实字段",
    slots: [],
    // ⭐ 确定性拒答，**不进模型**。理由见 ruleClassify 里 GUARD 那一段：
    // 红线不能指望模型自觉，它必须在模型之前就被拦住。
    needsRetrieval: false,
    deterministic: true,
  },
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
  GAP: {
    id: "GAP",
    label: "能力缺口",
    desc: "问该补什么能力、学习方向、高频要求排行：我该学什么 / 缺口在哪 / 最该补哪个",
    slots: [],
    // ⭐ 完全确定性：跨库统计 + 词典匹配，**模型不参与本轮**。
    // 这是"只给学习路数、不给学习方案"这条边界的代码化——
    // 写在 prompt 里靠模型自觉是不够的，它一定会顺手推荐课程和书。
    needsRetrieval: false,
    deterministic: true,
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

/* ⚠️ 这两类必须分开，混在一起会产生"答非所问但看起来很确定"的回答。
 * 2026-09-10 实测撞到：问「这批 JD 里最高频的能力要求是什么？按覆盖率排」，
 * 命中「覆盖率」→ 判成 STATS（deterministic，不进模型）→ 回了一张固定的
 * 全库统计表（JD 总数 / 不同公司 / 城市分布）。那张表没有一个字回答了问题，
 * 但它带着"不经模型，直接算，结果可复现"的口气，比明说"我不知道"更糟。
 *
 * 区别在于：
 *   · COUNT 类（几条 / 占比 / 覆盖率…）是**量词**，它需要一个宾语。
 *     抠不出关键词就等于不知道要数什么——这种情况不能硬答，要交给模型。
 *   · SUMMARY 类（统计 / 汇总 / 一共）本身就是在要那张全库概览表，
 *     没有宾语是正常的。
 */
const STATS_COUNT_PAT = [/(几条|多少条|多少个|几个|占比|比例|覆盖率|分布|中位|平均)/];
const STATS_SUMMARY_PAT = [/(统计|汇总|一共|总共)/];
/* ⚠️ GAP 和 DIAGNOSE 的边界是刻意划的，不是随手分的。
 * 「缺什么 / 该补什么 / 学什么」这类词原本在 DIAGNOSE 里，会走检索 + 模型。
 * 但这类问题的正确答案是**全库频次统计**，检索只取 top5 反而把答案削窄了，
 * 而且模型一定会顺手推荐课程和书——那正是用户不要的。
 * 所以这些词全部划给 GAP（确定性、零成本、不过模型）。
 * DIAGNOSE 只留"拿简历跟 JD 比、要一段叙述"的问法（匹配度/够不够/我能投）。 */
const GAP_PAT = [/(缺什么|缺口|短板|补什么|该补|要补|欠缺|学什么|该学|学习(路|方向|重点)|能力(要求|画像|排行)|高频|最该)/];
const DIAGNOSE_PAT = [/(诊断|差距|够不够|匹配度|我能投|适合我|对比.*简历|简历.*对比|对标)/];
/* 「改成 / 换成」放在这里是安全的：GUARD 的事实字段规则在它之前判，
   所以「把职位名改成 X」已经被拦下，落到这里的只剩措辞层面的改写。
   加它是因为 golden D1「把『提升了流量』改成有数字的版本」原本一条规则
   都不命中、白花一次分类调用。 */
const REWRITE_PAT = [/(改写|润色|重写|帮我改|怎么写|措辞|改成|换成|优化.*(经历|描述|简历))/];
const PREP_PAT = [/(面试|会问|准备什么|押题|反问)/];

/* ══════════════ 红线 ══════════════
 *
 * ⚠️ 这一段修的是一个**真的安全洞**，不是加功能。
 *
 * 实测：「我没做过 Discord 运营，帮我写一条」→ 命中 rule:kw（因为 discord
 * 在关键词表里）→ 判成 ASK_JD → 走普通问答路径。而"绝对不许编造"这条
 * 硬规则**只写在 REWRITE 分支的提示词里**。也就是说：红线的防护装在了
 * 一条这个问题永远不会经过的路上。
 * eval/golden_questions.md 的 D3 早就把它列成红线了
 * （"求职工具编经历会让用户在面试里被穿"），但那只是文档里的期望，
 * 代码里没有任何东西执行它。现在执行它。
 *
 * ⚠️ 刻意要求**两个信号同时命中**，而不是"宁可误报"：
 *   裸词「没做过」会出现在完全正当的问题里 ——
 *   「这些 JD 里有哪些是我没做过的」那是 GAP，是这个产品的主功能。
 *   只按一个信号拦，会把主功能拦掉。
 *   所以必须 (编造线索) AND (写作请求) 才算红线。
 *
 * 改事实字段那一类是单信号，因为「把职位名改成 X」没有正当解读。
 * 但要和 D1 分开：「把『提升了流量』改成有数字的版本」是正当的 REWRITE，
 * 它的宾语是一句话，不是身份字段。所以这里只匹配**身份字段**做宾语的情况。 */

/** 编造线索：声称自己没做过 / 要求虚构 */
const FAB_CUE = /(没做过|没有做过|没干过|没接触过|不会做|零经验|假装|虚构|造假|编造|瞎编|假经历|假数据)/;
/** 写作请求：要求把内容写进简历 */
const WRITE_REQ = /(帮我写|帮我编|帮我加|写一[条个段]|加一[条个]|编一[条个]|生成一[条个段]|写上去|写进去|包装|美化)/;
/** 事实身份字段。改这些没有正当解读——不是措辞问题，是事实不符 */
const FACT_FIELD_WORDS =
  "职位名|职称|头衔|title|公司名|学历|毕业时间|毕业院校|入职时间|离职时间|在职时间|工作年限";
const EDIT_VERBS = "改|换|写成|填成|说成";
/* 用 RegExp 构造器而不是正则字面量：这一段要拼「字段…动词」和「动词…字段」
   两个方向，字面量写出来会长到必须折行——而**正则字面量里不能有真换行**。
   我上一版就是用脚本生成时把 \n 写成了真换行，字符类变成了 [^。；<换行>]。
   凑巧语义一样、node --check 也过了，但那是运气。构造器天然没有这个坑。 */
const FACT_FIELD = new RegExp(
  "((" + FACT_FIELD_WORDS + ")[^。；\\n]{0,8}(" + EDIT_VERBS + ")" +
  "|(" + EDIT_VERBS + ")[^。；\\n]{0,8}(" + FACT_FIELD_WORDS + "))"
);

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

  /* 红线优先于一切。放在最前面不是风格，是必须——
     它下面每一条规则都会把请求送进生成路径，一旦送进去就晚了。 */
  if (FAB_CUE.test(t) && WRITE_REQ.test(t)) {
    return { intent: INTENTS.GUARD, confidence: 0.95, by: "rule:guard:fabricate" };
  }
  if (FACT_FIELD.test(t)) {
    return { intent: INTENTS.GUARD, confidence: 0.9, by: "rule:guard:fact" };
  }

  const isCount = STATS_COUNT_PAT.some((p) => p.test(t));
  const isSummary = STATS_SUMMARY_PAT.some((p) => p.test(t));
  const kws = extractKeywords(t);

  // "有几条要求 Discord" —— 量词 + 抠得出宾语，这时确定性计算最可靠
  if (isCount && kws.length) {
    return { intent: INTENTS.STATS, confidence: 0.95, by: "rule:stats+kw", keywords: kws };
  }
  // "帮我统计一下 / 汇总一下" —— 要的就是全库概览表，没有宾语是正常的
  if (isSummary && !kws.length) {
    return { intent: INTENTS.STATS, confidence: 0.8, by: "rule:stats:summary" };
  }
  if (isSummary && kws.length) {
    return { intent: INTENTS.STATS, confidence: 0.9, by: "rule:stats+kw", keywords: kws };
  }
  /* ⚠️ 刻意**不**在这里接住"只有量词、抠不出宾语"的情况。
   * 那种问题（如"最高频的能力要求是什么"）要读 JD 正文才能答，
   * 交给下面的模型分类 → ASK_JD → 检索 + 模型。
   * 这里硬答一张固定统计表，就是上面注释里那个 bug。 */
  // GAP 在 DIAGNOSE 之前判：两者词面有重叠，而 GAP 是零成本且不会编的那条路
  if (GAP_PAT.some((p) => p.test(t))) {
    return { intent: INTENTS.GAP, confidence: 0.9, by: "rule:gap" };
  }
  if (REWRITE_PAT.some((p) => p.test(t))) {
    return { intent: INTENTS.REWRITE, confidence: 0.85, by: "rule:rewrite" };
  }
  if (DIAGNOSE_PAT.some((p) => p.test(t))) {
    return { intent: INTENTS.DIAGNOSE, confidence: 0.85, by: "rule:diagnose" };
  }
  if (PREP_PAT.some((p) => p.test(t))) {
    return { intent: INTENTS.PREP, confidence: 0.8, by: "rule:prep" };
  }
  /* 提到了领域关键词、又没有其他意图特征 → 就是在问 JD 内容。
     这条规则专门用来省掉一次模型分类调用（这类问题占大多数）。

     ⚠️ 但它是整个规则层里唯一一条**在替代语言理解**的规则：
     "句子里出现任何领域关键词" 推不出 "用户在问 JD 内容"。
     它的 confidence 写 0.65 是诚实的，可代码里从没有地方用这个 0.65
     做过降级——于是一条低置信度的猜测走了高置信度的路。
     上面那个 D3 安全洞就是被它吞掉的。

     所以加一条闸门：**带写作请求的句子不许走这条捷径**。
     这类句子（"帮我写一段…"）无论如何都不是"问 JD 内容"，
     交给模型分类去判 REWRITE / PREP / 还是别的。
     宁可为这一类多花一次分类调用。 */
  if (kws.length && !WRITE_REQ.test(t)) {
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
    /* ⚠️ 这条是用户定的硬边界，不是风格偏好：
     * 「这里的模型不是很高级，整理的资料我也不放心」。
     * 所以本项目只输出**学习路数**（缺哪些能力、先补哪个），
     * 具体学什么、看什么资料由用户自己在云端知识库整理。
     * 真正的执行靠 GAP 意图完全不过模型；这条只是给其他意图兜底。 */
    "5. **只说「缺哪些能力、按什么顺序补」，绝对不要给学习方案**：" +
      "不要推荐课程、书、教程、博客、视频、项目练手清单，不要排学习周期或课表。" +
      "用户会自己整理学习资料。被要求推荐资料时，直接说「这部分我不给，你在自己的知识库里整理」。",
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
