/* 内置模型目录：厂商 → Base URL / 模型列表 / 参考价。
 *
 * ⚠️ 为什么改成内置下拉，不让用户手填模型名
 *   手填模型名有三种失败方式，而且**全都表现成同一个 401/404**：
 *   拼错（deepseek-v4-flsah）、抄了已下线的别名（deepseek-chat 在 2026-07-24
 *   已经退役）、或者填了另一家的模型名。用户看到的只是一个报错，
 *   分不清是 key 错、URL 错还是模型名错。内置下拉把这一整类问题消掉。
 *   自定义那一栏保留——但它是逃生舱，不是默认路径。
 *
 * ⚠️ 为什么 key 按厂商存，而不是只存一个
 *   五家都是 OpenAI 兼容协议，所以"换模型"本该是一个下拉的事。
 *   但 key 是按厂商发的：如果只存一个 key，每次换厂商都要重新粘一次，
 *   于是人就不换了——那"支持多模型"等于没支持。
 *   现在 keys 按厂商分开存（keys[providerId]），换厂商换模型都不用重填。
 *
 * ══════════════ 价格 ══════════════
 *
 * ⚠️ **这些数字一定会过期。** 过期的表现是"看起来精确但其实错的成本"，
 * 那比不显示更糟。所以每一条都带 `src`（抄自哪里）和 `asOf`（抄录日期），
 * 设置页里也标着「参考价」并给出核对入口。用户手填的值永远优先。
 *
 * 三条取值原则（和之前 PRICING_ESTIMATE 一致，别改）：
 *   1. **取高价，不取优惠价。** DeepSeek 有低谷半价、Gemini/OpenAI 有 Batch
 *      五折、Gemini 部分型号有限时价——一律取贵的那个。
 *      估算偏低会让你以为某功能很便宜而放开用，月底才发现不是；
 *      偏高最多让你少用一点，代价小得多。
 *   2. 单位统一成**元 / 百万 token**。美元价按 USD_CNY 折算。
 *   3. 缓存命中价查不到的就写 null，**不推算**。界面显示「未知」，
 *      而不是编一个数字。
 *
 * 汇率对结论的影响远小于"命中缓存还是没命中"那个量级差
 * （DeepSeek Flash 输入：命中 ¥0.043 vs 未命中 ¥2.16，差 50 倍）。
 */

/** 汇率假设。放在一处，方便核对——它是假设，不是事实。 */
export const USD_CNY = 7.2;

/** 美元价 → 元/百万 token，保留两位 */
const cny = (usd) => (usd == null ? null : Math.round(usd * USD_CNY * 100) / 100);

export const PROVIDERS = [
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyUrl: "https://platform.deepseek.com/api_keys",
    priceUrl: "https://api-docs.deepseek.com/quick_start/pricing",
    note:
      "V4 默认开启思考模式，思考 token 计入输出计费但你看不到内容。" +
      "本工具多数任务不需要思考，用附加参数关掉能明显省钱。" +
      "官方还有低谷半价（UTC 01-04 / 06-10 之外），下面取的是高峰价。",
    models: [
      {
        id: "deepseek-flash", label: "DeepSeek Flash（便宜，推荐起步）",
        // 官方页高峰价：in $0.30 / cacheIn $0.006 / out $1.20
        in: cny(0.30), cacheIn: cny(0.006), out: cny(1.20),
        src: "api-docs.deepseek.com 定价页（高峰价）", asOf: "2026-09-10",
      },
      {
        id: "deepseek-v4-pro", label: "DeepSeek V4 Pro（更强，更贵）",
        // 高峰价：in $1.32 / cacheIn $0.044 / out $3.96
        in: cny(1.32), cacheIn: cny(0.044), out: cny(3.96),
        src: "api-docs.deepseek.com 定价页（高峰价）", asOf: "2026-09-10",
        note: "官方文档提到 2026-09-14 起 V4 Pro 请求会切到 V4.1 Flash 计价，用之前先核对。",
      },
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyUrl: "https://platform.openai.com/api-keys",
    priceUrl: "https://developers.openai.com/api/docs/pricing",
    note: "价格取「standard」档；Batch 等模式更便宜，但本工具是交互式调用，用不上。",
    models: [
      { id: "gpt-5.6-luna", label: "GPT-5.6 Luna（最便宜）",
        in: cny(0.20), cacheIn: cny(0.02), out: cny(1.20),
        src: "developers.openai.com 定价页", asOf: "2026-09-10" },
      { id: "gpt-5-mini", label: "GPT-5 mini",
        in: cny(0.25), cacheIn: cny(0.025), out: cny(2.00),
        src: "developers.openai.com 定价页", asOf: "2026-09-10" },
      { id: "gpt-5.6-terra", label: "GPT-5.6 Terra（均衡）",
        in: cny(2.00), cacheIn: cny(0.20), out: cny(12.00),
        src: "developers.openai.com 定价页", asOf: "2026-09-10" },
      { id: "gpt-5.6-sol", label: "GPT-5.6 Sol（强）",
        in: cny(4.00), cacheIn: cny(0.40), out: cny(20.00),
        src: "developers.openai.com 定价页", asOf: "2026-09-10" },
    ],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    // ⚠️ 不是 generativelanguage 的原生端点，是它的 OpenAI 兼容层。
    //    少了 /openai 这一段会 404，而报错看起来像"模型不存在"。
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    keyUrl: "https://aistudio.google.com/apikey",
    priceUrl: "https://ai.google.dev/gemini-api/docs/pricing",
    note:
      "走的是 Gemini 的 OpenAI 兼容层（URL 末尾那个 /openai 不能少）。" +
      "Flash 系列有到 2026-12-31 的限时价，下面取的是**限时价结束后的正常价**——" +
      "宁可估高。另外它有免费额度，个人用量很可能一分钱不花。",
    models: [
      { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash",
        in: cny(1.50), cacheIn: cny(0.15), out: cny(7.50),
        src: "ai.google.dev 定价页（限时价后的正常价）", asOf: "2026-09-10" },
      { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash",
        in: cny(1.50), cacheIn: cny(0.15), out: cny(9.00),
        src: "ai.google.dev 定价页", asOf: "2026-09-10" },
      { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro（预览）",
        in: cny(2.00), cacheIn: cny(0.20), out: cny(12.00),
        src: "ai.google.dev 定价页（≤200k 上下文档）", asOf: "2026-09-10" },
    ],
  },
  {
    id: "volcengine",
    label: "火山引擎 · 豆包",
    baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
    keyUrl: "https://console.volcengine.com/ark",
    priceUrl: "https://www.volcengine.com/docs/82379/1544106",
    note:
      "⚠️ 方舟历史上要求把模型名填成**接入点 ID**（ep-… 那种），" +
      "得先在控制台给模型开一个接入点。如果直接用下面的模型名报「模型不存在」，" +
      "就把接入点 ID 填到「自定义模型」里。" +
      "缓存命中价我没查到可靠数字，所以留空——不编。",
    models: [
      { id: "doubao-seed-2.1-pro", label: "Doubao Seed 2.1 Pro",
        in: 6, cacheIn: null, out: 30,
        src: "volcengine.com 官方文章（2026-06 发布价）", asOf: "2026-09-10" },
      { id: "doubao-seed-2.0-pro", label: "Doubao Seed 2.0 Pro",
        in: 3.2, cacheIn: null, out: 16,
        src: "volcengine.com 定价信息", asOf: "2026-09-10" },
      { id: "doubao-seed-2.0-lite", label: "Doubao Seed 2.0 Lite（便宜）",
        in: 0.6, cacheIn: null, out: 3.6,
        src: "volcengine.com 定价信息", asOf: "2026-09-10" },
    ],
  },
  {
    id: "siliconflow",
    label: "硅基流动 SiliconFlow",
    baseUrl: "https://api.siliconflow.cn/v1",
    keyUrl: "https://cloud.siliconflow.cn/account/ak",
    priceUrl: "https://siliconflow.cn/pricing",
    note:
      "国产开源模型的统一推理入口，同一个 key 能调 DeepSeek / Qwen / GLM 等。" +
      "9B 及以下的小模型永久免费——不过那个量级做 JD 分析基本不可用，" +
      "别为了省钱换到那儿。缓存计费规则各模型不同，下面一律留空。",
    models: [
      { id: "Qwen/Qwen3.5-35B-A3B", label: "Qwen3.5 35B-A3B（便宜，≤128k）",
        in: 0.4, cacheIn: null, out: 3.2,
        src: "siliconflow.cn/pricing", asOf: "2026-09-10" },
      { id: "stepfun-ai/Step-3.5-Flash", label: "Step 3.5 Flash",
        in: 0.7, cacheIn: null, out: 2.1,
        src: "siliconflow.cn/pricing", asOf: "2026-09-10" },
      { id: "deepseek-ai/DeepSeek-V4-Pro", label: "DeepSeek V4 Pro（托管版）",
        in: 12, cacheIn: null, out: 24,
        src: "siliconflow.cn/pricing", asOf: "2026-09-10",
        note: "比 DeepSeek 官方直连贵不少，直连能拿到低谷半价和缓存价。" },
      { id: "zai-org/GLM-5.3", label: "GLM-5.3",
        in: 8, cacheIn: null, out: 28,
        src: "siliconflow.cn/pricing", asOf: "2026-09-10" },
    ],
  },
  {
    id: "ollama",
    label: "本地 Ollama（免费）",
    baseUrl: "http://localhost:11434/v1",
    keyUrl: "",
    priceUrl: "",
    note:
      "本地跑，不花钱也不出网。要在设置里授予 localhost 权限。" +
      "key 随便填一个非空值（本地不校验）。价格全部为 0——那是真的 0，不是未配。",
    models: [
      { id: "qwen3:8b", label: "qwen3:8b", in: 0, cacheIn: 0, out: 0,
        src: "本地运行", asOf: "—" },
      { id: "llama3.1:8b", label: "llama3.1:8b", in: 0, cacheIn: 0, out: 0,
        src: "本地运行", asOf: "—" },
    ],
  },
];

/* ── 退役别名迁移 ───────────────────────────────────
 *
 * ⚠️ 这不是"顺手做的兼容"，是修一个真 bug。
 * 实测（用户截图）：设置里存的模型是 `deepseek-v4-flash`，而下拉里没有它，
 * 于是走了"自定义模型名"那条路——**高级栏自动展开、把一个已经退役的
 * 别名当成用户的自定义选择**。DeepSeek 在 2026-07-24 就把 deepseek-chat /
 * deepseek-reasoner 退役了，现役名是 deepseek-flash。
 * 那个配置调用出去就是错，而界面上看起来一切正常。
 *
 * 所以退役名必须**静默迁移**，不能当成自定义。
 * 自定义那条路只留给"下拉里还没有的新模型"和"方舟接入点 ID"。
 */
export const RETIRED_ALIASES = {
  // DeepSeek 2026-07-24 退役的两个别名 + 我自己早期写错的那个
  "deepseek-chat": "deepseek-flash",
  "deepseek-reasoner": "deepseek-flash",
  "deepseek-v4-flash": "deepseek-flash",
  "deepseek-v4-flash-vision-exp": "deepseek-flash",
};

/** 退役名 → 现役名。不是退役名就原样返回。 */
export function migrateModel(id) {
  return RETIRED_ALIASES[id] || id;
}

/* ── 关闭思考模式 ───────────────────────────────────
 *
 * ⚠️ 原来这里是一个让用户手填 JSON 的输入框，提示写着"参数名各厂不同且会变，
 * 请照官网文档填（我不猜）"。那句话是诚实的，但它把一件**该由工具知道**的事
 * 推给了用户——而这个开关是本项目最有效的省钱手段之一
 * （DeepSeek V4 默认开思考，思考 token 按输出计费，用户还看不到内容）。
 * 一个没人会去查文档填的字段等于不存在。
 *
 * 所以改成按厂商内置：知道参数名的就给一个复选框，不知道的就不显示。
 * ⚠️ 只写我能确认的。查不到的厂商这里是 null，界面上那个复选框直接不出现——
 * 宁可少一个开关，也不要发一个厂商不认识的参数过去。
 */
const THINK_OFF = {
  deepseek: { thinking: { type: "disabled" } },
  // 火山方舟的豆包同样支持 thinking 开关，参数形状和 DeepSeek 一致
  volcengine: { thinking: { type: "disabled" } },
  // OpenAI / Gemini / 硅基流动：各家关思考的方式不统一（有的是 model 变体、
  // 有的是 reasoning_effort、有的压根不暴露），我没有可靠依据 → 不给开关。
};

/** 某厂商关思考的请求体片段；不支持就返回 null（界面上不显示这个开关） */
export function thinkOffBody(providerId) {
  return THINK_OFF[providerId] || null;
}

/* ── 查询辅助 ───────────────────────────────────────── */

export function getProvider(id) {
  return PROVIDERS.find((p) => p.id === id) || null;
}

export function getModel(providerId, modelId) {
  const p = getProvider(providerId);
  if (!p) return null;
  return p.models.find((m) => m.id === modelId) || null;
}

/** 按 baseUrl 反查厂商。用来兼容升级前存的老设置（那时候只有 baseUrl 没有 provider）。 */
export function providerByBaseUrl(baseUrl) {
  const u = String(baseUrl || "").replace(/\/+$/, "");
  if (!u) return null;
  return PROVIDERS.find((p) => p.baseUrl.replace(/\/+$/, "") === u) || null;
}

/**
 * 内置参考价，拍平成 { 模型ID: {in, cacheIn, out} }。
 * llm.js 的 PRICING_ESTIMATE 直接用这个，保证目录和计价是同一份数据——
 * 之前那份是手抄的常量，改了目录不会同步。
 */
export function builtinPricing() {
  const out = {};
  for (const p of PROVIDERS) {
    for (const m of p.models) {
      out[m.id] = { in: m.in, cacheIn: m.cacheIn, out: m.out };
    }
  }
  return out;
}

/** 某个模型的价格来源，给设置页显示"这个数字是哪来的" */
export function priceSource(modelId) {
  for (const p of PROVIDERS) {
    for (const m of p.models) {
      if (m.id === modelId) return { src: m.src, asOf: m.asOf, provider: p.label };
    }
  }
  return null;
}
