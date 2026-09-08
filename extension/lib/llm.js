/* LLM 客户端：任何 OpenAI 兼容的 /chat/completions 端点都能用
 * （OpenAI、DeepSeek、Moonshot、通义、本地 Ollama / vLLM …）
 *
 * ⚠️ 安全取舍：**key 由用户自己持有，存在浏览器本地，只发给用户自己填的 base_url。**
 *   我不做托管代理——那意味着我要替所有使用者付 API 账单，
 *   而且他们的 JD 数据会经过我的服务器。让用户自带 key 更贵一点点，
 *   但责任边界清楚：数据只在「用户浏览器 → 用户选的模型厂商」之间流动。
 *   代价是：key 存在 chrome.storage.local，同机器的其他扩展拿不到，
 *   但物理接触这台电脑的人能看到。README 里明确写了这一点。
 */

const DEFAULTS = {
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-v4-flash",
  temperature: 0.3,
  maxTokens: 2000,
  extraBody: "",   // 厂商特有参数（JSON），例如关掉思考模式——见 options 页说明
  // 按模型分别配价：{ 模型名: { in, cacheIn, out } }，单位「元 / 百万 token」
  // ⚠️ **刻意不预填任何数字。** 价格是外部易变事实，写进代码迟早过期，
  //    而一个"看起来精确但其实错的成本"比不显示更糟。首次使用请去官网抄当前价。
  pricing: {},
};

/** 取当前模型的价格档；没配就返回 null（上层显示「未配价格」而不是 ¥0） */
export function priceOf(s, model) {
  const m = model || s.model;
  const p = (s.pricing || {})[m];
  if (!p) return null;
  const hasAny = ["in", "cacheIn", "out"].some((k) => Number(p[k]) > 0);
  return hasAny ? p : null;
}

/**
 * 拆解 usage，兼容 OpenAI 标准字段 + DeepSeek 的缓存字段 + 思考 token。
 * 这三类必须分开，因为**它们的单价不一样**：
 *   - 缓存命中的输入 token 便宜得多
 *   - 思考（reasoning）token 计入输出计费，但用户看不见内容
 */
export function splitUsage(usage) {
  if (!usage) return null;
  const prompt = usage.prompt_tokens || 0;
  // DeepSeek 风格
  let hit = usage.prompt_cache_hit_tokens;
  let miss = usage.prompt_cache_miss_tokens;
  // OpenAI 风格：prompt_tokens_details.cached_tokens
  if (hit == null && usage.prompt_tokens_details) {
    hit = usage.prompt_tokens_details.cached_tokens;
  }
  hit = Number(hit) || 0;
  miss = miss == null ? Math.max(prompt - hit, 0) : Number(miss) || 0;

  const out = usage.completion_tokens || 0;
  const reasoning =
    Number(usage.completion_tokens_details?.reasoning_tokens) ||
    Number(usage.reasoning_tokens) || 0;

  return { prompt, hit, miss, out, reasoning, estimated: !!usage.estimated };
}

/** 估算花费（元）。价格没配返回 null，让上层显示「未配价格」 */
export function estimateCost(usage, s, model) {
  const u = splitUsage(usage);
  const p = priceOf(s, model);
  if (!u || !p) return null;
  const pIn = Number(p.in) || 0;
  // 缓存命中价没填就退回普通输入价（保守，不会低估）
  const pHit = Number(p.cacheIn) > 0 ? Number(p.cacheIn) : pIn;
  const pOut = Number(p.out) || 0;
  return (u.miss / 1e6) * pIn + (u.hit / 1e6) * pHit + (u.out / 1e6) * pOut;
}

/** 累计用量，存本地。这是「效率成本」这层指标的数据来源 */
export async function bumpUsage(usage, cost) {
  const u = splitUsage(usage);
  if (!u) return;
  const { usageTotal = {} } = await chrome.storage.local.get({ usageTotal: {} });
  const t = {
    calls: (usageTotal.calls || 0) + 1,
    inTok: (usageTotal.inTok || 0) + u.prompt,
    hitTok: (usageTotal.hitTok || 0) + u.hit,
    outTok: (usageTotal.outTok || 0) + u.out,
    reasonTok: (usageTotal.reasonTok || 0) + u.reasoning,
    cost: (usageTotal.cost || 0) + (cost || 0),
    // 价格没配时也累计 token，只是钱算不出来——把这个情况记下来
    unpriced: (usageTotal.unpriced || 0) + (cost == null ? 1 : 0),
    since: usageTotal.since || new Date().toISOString().slice(0, 10),
  };
  await chrome.storage.local.set({ usageTotal: t });
  return t;
}

export async function getUsageTotal() {
  const { usageTotal = {} } = await chrome.storage.local.get({ usageTotal: {} });
  return usageTotal;
}

export async function resetUsage() {
  await chrome.storage.local.set({ usageTotal: {} });
}

export async function getSettings() {
  const s = await chrome.storage.local.get({ llm: {} });
  return { ...DEFAULTS, ...(s.llm || {}) };
}

export async function saveSettings(patch) {
  const cur = await getSettings();
  const next = { ...cur, ...patch };
  await chrome.storage.local.set({ llm: next });
  return next;
}

export function hasKey(s) {
  return !!(s && s.apiKey && s.apiKey.trim());
}

/**
 * 流式对话。onDelta 每收到一小段文本调用一次。
 * @returns {Promise<{text:string, usage:object|null}>}
 */
export async function chatStream(messages, onDelta, opts = {}) {
  const s = await getSettings();
  if (!hasKey(s)) throw new Error("NO_KEY");

  const url = s.baseUrl.replace(/\/$/, "") + "/chat/completions";
  const body = {
    model: opts.model || s.model,
    messages,
    temperature: opts.temperature ?? s.temperature,
    max_tokens: opts.maxTokens ?? s.maxTokens,
    stream: true,
    // 让流式响应也带 usage（OpenAI 兼容端点普遍支持；不支持的会忽略）
    stream_options: { include_usage: true },
  };

  // 厂商特有参数（如关闭思考模式）。做成用户可填的 JSON，
  // 因为各厂参数名不一样、还会变——**我不猜参数名，让用户照官网文档填。**
  if (s.extraBody && s.extraBody.trim()) {
    try {
      Object.assign(body, JSON.parse(s.extraBody));
    } catch (e) {
      throw new Error("BAD_EXTRA_BODY");
    }
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs || 90000);

  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + s.apiKey.trim(),
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    // 区分「网络/超时」（可重试）和其他
    throw new Error(e.name === "AbortError" ? "TIMEOUT" : "NETWORK");
  }

  if (!resp.ok) {
    clearTimeout(timer);
    const t = await resp.text().catch(() => "");
    // 可重试 vs 不可重试——和 Agent 的工具调用同一套分类
    if (resp.status === 429 || resp.status >= 500) throw new Error("RETRYABLE:" + resp.status);
    if (resp.status === 401 || resp.status === 403) throw new Error("BAD_KEY");
    throw new Error("HTTP_" + resp.status + ":" + t.slice(0, 200));
  }

  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let usage = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const parts = buf.split("\n");
    buf = parts.pop();
    for (const line of parts) {
      const l = line.trim();
      if (!l.startsWith("data:")) continue;
      const payload = l.slice(5).trim();
      if (payload === "[DONE]") continue;
      let j;
      try {
        j = JSON.parse(payload);
      } catch (e) {
        continue;
      }
      if (j.usage) usage = j.usage;
      const d = j.choices?.[0]?.delta?.content;
      if (d) {
        text += d;
        onDelta && onDelta(d);
      }
    }
  }
  clearTimeout(timer);

  // 有些端点流式返回不带 usage，估一个（约 1.6 字符/token，中文偏保守）
  if (!usage) {
    const promptChars = JSON.stringify(messages).length;
    usage = {
      prompt_tokens: Math.round(promptChars / 1.6),
      completion_tokens: Math.round(text.length / 1.6),
      estimated: true,
    };
  }
  const cost = estimateCost(usage, s, body.model);
  await bumpUsage(usage, cost);
  return { text, usage, cost, split: splitUsage(usage), priced: cost != null };
}

/** 非流式的一次性调用，用于意图分类这种短任务。用量已由 chatStream 内部累计 */
export async function chatOnce(messages, opts = {}) {
  let out = "";
  const r = await chatStream(messages, (d) => (out += d), {
    maxTokens: opts.maxTokens || 60,
    temperature: opts.temperature ?? 0,
  });
  return (r.text || out).trim();
}

/** 金额格式化：小额显示到 4 位小数，否则 2 位 */
export function fmtCost(v) {
  const n = Number(v) || 0;
  if (n === 0) return "¥0";
  return "¥" + (n < 0.01 ? n.toFixed(4) : n.toFixed(2));
}

/** 把错误码翻成人话——错误信息要说清「怎么办」，不是只说「失败了」 */
export function explainError(msg) {
  const m = String(msg || "");
  if (m === "NO_KEY") return "还没配 API Key。点右上角 ⚙ 设置，填一个（支持 DeepSeek / OpenAI / 任何兼容端点）。";
  if (m === "BAD_KEY") return "Key 被拒了（401/403）。检查有没有复制错、是否过期、余额是否为 0。";
  if (m === "TIMEOUT") return "请求超时。可能是网络问题或模型太慢——重试一次，或换个更快的模型。";
  if (m === "NETWORK") return "网络请求失败。检查 base_url 是否正确、能不能访问该域名（有些端点需要代理）。";
  if (m.startsWith("RETRYABLE:")) return "服务端忙（" + m.split(":")[1] + "），这是可重试错误，等几秒再点重试。";
  if (m === "BAD_EXTRA_BODY") return "设置里的「附加请求参数」不是合法 JSON，改对或清空。";
  if (m.startsWith("HTTP_")) return "接口报错：" + m.slice(5, 160);
  return m.slice(0, 200);
}
