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
  model: "deepseek-chat",
  temperature: 0.3,
  maxTokens: 1600,
};

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
  };

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
  return { text, usage };
}

/** 非流式的一次性调用，用于意图分类这种短任务 */
export async function chatOnce(messages, opts = {}) {
  let out = "";
  const r = await chatStream(messages, (d) => (out += d), {
    maxTokens: opts.maxTokens || 60,
    temperature: opts.temperature ?? 0,
  });
  return (r.text || out).trim();
}

/** 把错误码翻成人话——错误信息要说清「怎么办」，不是只说「失败了」 */
export function explainError(msg) {
  const m = String(msg || "");
  if (m === "NO_KEY") return "还没配 API Key。点右上角 ⚙ 设置，填一个（支持 DeepSeek / OpenAI / 任何兼容端点）。";
  if (m === "BAD_KEY") return "Key 被拒了（401/403）。检查有没有复制错、是否过期、余额是否为 0。";
  if (m === "TIMEOUT") return "请求超时。可能是网络问题或模型太慢——重试一次，或换个更快的模型。";
  if (m === "NETWORK") return "网络请求失败。检查 base_url 是否正确、能不能访问该域名（有些端点需要代理）。";
  if (m.startsWith("RETRYABLE:")) return "服务端忙（" + m.split(":")[1] + "），这是可重试错误，等几秒再点重试。";
  if (m.startsWith("HTTP_")) return "接口报错：" + m.slice(5, 160);
  return m.slice(0, 200);
}
