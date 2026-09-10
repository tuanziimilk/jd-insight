/* 技能词典 —— **自动生成，不要手改这个文件。**
 *
 * 权威来源：career-web/src/data/skills.json（那边有校准记录 calibration）。
 * 由 career-web/scripts/check-shared.mjs 生成与校验：
 *   npm run check:shared           只校验，不一致就报错
 *   npm run check:shared -- --fix  按权威来源重新生成这个文件
 *
 * 为什么不直接 import 那个 .json：
 *   JSON 模块导入要写 with { type: "json" }，Chrome 123+ 才支持。
 *   万一用户的 Chrome 不支持，整个情报台会在模块加载阶段直接失败——
 *   而这个风险在开发机上验证不了（Node 支持不代表 Chrome 支持）。
 *   生成一个普通 ESM 模块，把这个不确定性彻底去掉。
 */
export default {
  "version": 2,
  "note": "技能词典 v2 · 按「简历正文-AI产品经理版.md」(2026-09-08) 校准。group 必须和 career_profile.capabilities 里的能力组名逐字一致——我的水平从那儿来，这里不写死。patterns 命中时必须能指回 JD 原文句子。",
  "domain": {
    "label": "AI 产品经理 / AI Agent 方向",
    "note": "这份词典**只对这个方向成立**。它的 26 项是按一份 AI 产品经理简历校准的，AI/Agent 那一侧覆盖到实测零漏判，而通用产品、技术岗、非产品岗几乎没有对应项。所以一条不在这个方向上的 JD（比如财务经理、前端工程师）跑出来的缺口表是**看起来正常但毫无意义**的——这比报错更糟。coreSkills 就是用来判定「这条 JD 到底在不在这个方向上」的：一条都没命中，就当领域外处理，明说而不是硬算。",
    "coreSkills": [
      "rag",
      "agent",
      "workflow",
      "prompt",
      "dialog",
      "eval",
      "guardrail",
      "llm-basic",
      "multimodal"
    ]
  },
  "calibration": [
    "v1 → v2 的三处修正：",
    "1. 补上简历里最强的两条：「一人全栈 0→1」和「AI 落地护栏」。v1 一项都没有，导致 JD 说「独立推动落地」「兜底」「风险控制」时全部漏判。",
    "2. SEO/GEO 从「出海/国际化」里独立出来，权重 2→3。它是核心业务背景 + Plan C 主攻方向，不是出海的附属。",
    "3. prd 权重 2→3（PM 岗最核心的要求且是 🟢）；backend-system 1→2（内部工具/效率工具是明确加投的方向）。",
    "v2.1 修正：dialog 的 pattern 从裸词「对话」改成「多轮对话/对话式/对话产品」等复合词。裸词「对话」会被「与研发对话」这类沟通语义误命中，把真短板判成已具备。",
    "v2.2 修正（2026-09-10）。这三条是靠「扫真实 JD 里一条技能都没命中的句子」发现的，不是拍脑袋想的：",
    "① scoping 补「拆成/抽象/归纳/模糊需求/可复用」。原来只有「拆解」，而 JD 里写的是「把模糊需求拆成可执行的方案」「抽象为可复用的产品能力」，整句漏判。",
    "② backend-system 补「To B/toB/企业服务/企业级/ERP/MES/CRM」。原来只有「B端」和「SaaS」，于是「有 To B 企业服务产品经验者优先」「有 ERP 或 MES 经验优先」都漏了。",
    "③ 刻意**不加**行业背景标签（旅游/本地生活/教育/制造业）。行业背景和学历年限一样是**门槛**而不是**能补的能力**——把它列进缺口列表会输出「你该去做旅游行业」这种荒谬建议。finance 那一项是历史遗留，保留但不再往这个方向扩。",
    "⚠️ v2.2 同时修了命中判定里一个更根本的漏判（在 match.ts / gap.js，不在这份词典里）：中文 pattern 走 includes()，而真实 JD 写「B 端」而不是「B端」——中英之间那个空格让整条漏掉。现在两侧都做中英空格归一化。所以这份词典里的 pattern **不需要**为空格写两个版本。"
  ],
  "skills": [
    {
      "id": "prd",
      "label": "PRD / 规格 / 验收标准",
      "group": "产品基本功",
      "weight": 3,
      "patterns": [
        "PRD",
        "需求文档",
        "产品需求",
        "需求评审",
        "需求定义",
        "功能设计",
        "验收",
        "规格",
        "spec",
        "requirement"
      ]
    },
    {
      "id": "prototype",
      "label": "原型 / 交互设计",
      "group": "产品基本功",
      "weight": 2,
      "patterns": [
        "原型",
        "高保真",
        "交互设计",
        "信息架构",
        "Axure",
        "Figma",
        "线框",
        "视觉稿"
      ]
    },
    {
      "id": "scoping",
      "label": "范围裁剪 / 优先级",
      "group": "产品基本功",
      "weight": 2,
      "patterns": [
        "优先级",
        "范围",
        "拆解",
        "MVP",
        "取舍",
        "版本规划",
        "roadmap",
        "路线图",
        "非目标",
        "拆成",
        "抽象",
        "归纳",
        "模糊需求",
        "可复用"
      ]
    },
    {
      "id": "backend-system",
      "label": "后台 / 中台 / 效率工具",
      "group": "产品基本功",
      "weight": 2,
      "patterns": [
        "后台系统",
        "中台",
        "管理后台",
        "SaaS",
        "B端",
        "工作台",
        "内部工具",
        "效率工具",
        "运营工具",
        "提效",
        "To B",
        "toB",
        "企业服务",
        "企业级",
        "ERP",
        "MES",
        "CRM"
      ]
    },
    {
      "id": "zero-to-one",
      "label": "0→1 独立交付",
      "group": "一人全栈 0→1",
      "weight": 3,
      "patterns": [
        "从0到1",
        "0-1",
        "0到1",
        "0→1",
        "从零",
        "独立负责",
        "独立推动",
        "端到端",
        "全生命周期",
        "独立完成",
        "owner",
        "主导"
      ]
    },
    {
      "id": "hands-on",
      "label": "能自己动手实现",
      "group": "一人全栈 0→1",
      "weight": 2,
      "patterns": [
        "技术产品",
        "技术背景",
        "懂技术",
        "能写代码",
        "动手能力",
        "自己搭",
        "快速验证",
        "demo",
        "原型验证",
        "全栈"
      ]
    },
    {
      "id": "guardrail",
      "label": "AI 护栏 / 兜底设计",
      "group": "AI 落地护栏",
      "weight": 3,
      "patterns": [
        "兜底",
        "护栏",
        "安全审查",
        "内容安全",
        "审核机制",
        "风险控制",
        "风控",
        "合规",
        "人工审核",
        "人工复核",
        "人审",
        "降级",
        "异常处理",
        "容错",
        "可控"
      ]
    },
    {
      "id": "rollout",
      "label": "灰度 / 放量纪律",
      "group": "AI 落地护栏",
      "weight": 2,
      "patterns": [
        "灰度",
        "放量",
        "小流量",
        "分批",
        "试点",
        "pilot",
        "上线节奏",
        "回滚",
        "AB",
        "A/B",
        "abtest"
      ]
    },
    {
      "id": "eval",
      "label": "效果评测 / 指标体系",
      "group": "评测 / 质量",
      "weight": 3,
      "patterns": [
        "评测",
        "评估体系",
        "效果评估",
        "效果评测",
        "badcase",
        "bad case",
        "指标体系",
        "指标定义",
        "北极星",
        "准确率",
        "召回率",
        "基线",
        "对标",
        "质量把控",
        "质检"
      ]
    },
    {
      "id": "sql",
      "label": "SQL / 数据分析",
      "group": "数据能力",
      "weight": 3,
      "patterns": [
        "SQL",
        "数据分析",
        "数据驱动",
        "取数",
        "看板",
        "BI",
        "Metabase",
        "漏斗",
        "留存",
        "转化率",
        "埋点",
        "数据口径"
      ]
    },
    {
      "id": "seo-geo",
      "label": "SEO / GEO / AI 搜索",
      "group": "SEO / GEO / 内容增长",
      "weight": 3,
      "patterns": [
        "SEO",
        "GEO",
        "AEO",
        "AI搜索",
        "搜索优化",
        "自然流量",
        "收录",
        "meta",
        "内链",
        "关键词",
        "AI可见性",
        "搜索引擎",
        "内容分发"
      ]
    },
    {
      "id": "content-ops",
      "label": "内容质量 / 内容治理",
      "group": "SEO / GEO / 内容增长",
      "weight": 2,
      "patterns": [
        "内容质量",
        "内容运营",
        "内容生产",
        "内容治理",
        "文案",
        "UGC",
        "AIGC",
        "内容审核",
        "批量生成"
      ]
    },
    {
      "id": "growth",
      "label": "增长 / 拉新留存",
      "group": "SEO / GEO / 内容增长",
      "weight": 2,
      "patterns": [
        "增长",
        "拉新",
        "留存",
        "用户增长",
        "growth",
        "GMV",
        "转化提升",
        "投放",
        "获客"
      ]
    },
    {
      "id": "overseas",
      "label": "出海 / 跨境 / 多市场",
      "group": "出海 / 国际化",
      "weight": 3,
      "patterns": [
        "出海",
        "海外",
        "国际化",
        "跨境",
        "多语言",
        "本地化",
        "overseas",
        "global",
        "东南亚",
        "北美",
        "欧美",
        "多国",
        "多站点"
      ]
    },
    {
      "id": "language",
      "label": "外语工作能力",
      "group": "出海 / 国际化",
      "weight": 2,
      "patterns": [
        "英语",
        "English",
        "英文",
        "西班牙语",
        "小语种",
        "口语",
        "海外团队",
        "外籍",
        "跨时区"
      ]
    },
    {
      "id": "engineering",
      "label": "工程栈 / 部署运维",
      "group": "工程实现",
      "weight": 2,
      "patterns": [
        "Python",
        "FastAPI",
        "React",
        "Node",
        "MySQL",
        "Docker",
        "API",
        "接口",
        "部署",
        "上线",
        "架构",
        "技术方案",
        "选型"
      ]
    },
    {
      "id": "cross-team",
      "label": "跨部门推动",
      "group": "工程沟通",
      "weight": 2,
      "patterns": [
        "跨部门",
        "跨团队",
        "协同",
        "推动",
        "沟通能力",
        "项目管理",
        "抗压",
        "向上管理",
        "对齐"
      ]
    },
    {
      "id": "rag",
      "label": "RAG / 检索增强",
      "group": "RAG / 检索",
      "weight": 3,
      "patterns": [
        "RAG",
        "检索增强",
        "向量",
        "embedding",
        "召回",
        "重排",
        "rerank",
        "知识库",
        "知识图谱",
        "语义检索",
        "语义相似"
      ]
    },
    {
      "id": "prompt",
      "label": "提示词工程",
      "group": "RAG / 检索",
      "weight": 2,
      "patterns": [
        "prompt",
        "提示词",
        "提示工程",
        "指令设计",
        "few-shot",
        "COT",
        "思维链",
        "调优"
      ]
    },
    {
      "id": "agent",
      "label": "Agent / 智能体",
      "group": "Agent / 工作流",
      "weight": 3,
      "patterns": [
        "Agent",
        "智能体",
        "agentic",
        "自主决策",
        "多智能体",
        "MCP",
        "function call",
        "工具调用",
        "tool use",
        "copilot",
        "助手"
      ]
    },
    {
      "id": "workflow",
      "label": "工作流编排 / 自动化",
      "group": "Agent / 工作流",
      "weight": 3,
      "patterns": [
        "工作流",
        "workflow",
        "编排",
        "流程自动化",
        "自动化",
        "RPA",
        "coze",
        "dify",
        "n8n",
        "langchain",
        "低代码"
      ]
    },
    {
      "id": "llm-basic",
      "label": "大模型原理 / 选型",
      "group": "模型技术原理",
      "weight": 2,
      "patterns": [
        "大模型",
        "LLM",
        "transformer",
        "微调",
        "fine-tune",
        "SFT",
        "预训练",
        "推理成本",
        "token",
        "模型选型",
        "开源模型"
      ]
    },
    {
      "id": "multimodal",
      "label": "多模态",
      "group": "模型技术原理",
      "weight": 1,
      "patterns": [
        "多模态",
        "图生文",
        "文生图",
        "语音识别",
        "ASR",
        "TTS",
        "视觉",
        "OCR",
        "视频生成",
        "数字人"
      ]
    },
    {
      "id": "dialog",
      "label": "对话式产品 / 多轮",
      "group": "对话式产品",
      "weight": 3,
      "patterns": [
        "多轮对话",
        "对话式",
        "对话产品",
        "对话机器人",
        "chatbot",
        "聊天机器人",
        "智能客服",
        "语音助手",
        "问答机器人",
        "会话管理",
        "多轮交互",
        "对话流"
      ],
      "note": "⚠️ 刻意不用裸词「对话」：JD 里「能与算法团队对话」「与研发同层对话」说的是沟通，不是对话式产品。实测这条误命中过，会把真短板判成已具备——这类误判比漏判更危险。"
    },
    {
      "id": "toc",
      "label": "To C 产品经验",
      "group": "To C 产品",
      "weight": 2,
      "patterns": [
        "C端",
        "toC",
        "To C",
        "消费者",
        "用户体验",
        "用户增长产品",
        "亿级用户",
        "DAU",
        "MAU",
        "App"
      ]
    },
    {
      "id": "finance",
      "label": "金融行业经验",
      "group": "行业·金融",
      "weight": 2,
      "patterns": [
        "金融",
        "银行",
        "保险",
        "证券",
        "信贷",
        "风控模型",
        "支付",
        "理财",
        "券商"
      ]
    }
  ],
  "gates": [
    {
      "id": "years",
      "label": "工作年限",
      "kind": "years",
      "patterns": [
        "(\\d+)\\s*[-~至到]\\s*(\\d+)\\s*年",
        "(\\d+)\\s*年以上",
        "(\\d+)\\s*年\\+"
      ]
    },
    {
      "id": "degree",
      "label": "学历",
      "kind": "degree",
      "patterns": [
        "博士",
        "硕士",
        "研究生",
        "本科",
        "大专",
        "统招",
        "985",
        "211"
      ]
    }
  ]
};
