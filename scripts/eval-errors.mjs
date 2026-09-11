/* 错误处理的断言（golden_questions 的 F 组）。
 *
 *     node jd-insight/scripts/eval-errors.mjs
 *
 * ══════════ F 组为什么一直是 ⬜，以及为什么它其实能自动化 ══════════
 *
 * F1~F4（Key 填错 / base_url 填错 / 超时 / 429 限流）四条一直没跑过，
 * 大概是因为它们看起来需要"真的把 key 填错再点一次"。
 *
 * 但这四条考的根本不是模型，是**两个纯粹的本地逻辑**：
 *   ① 分类：HTTP 状态码 / 网络异常 → 哪一类错误码
 *   ② 文案：错误码 → 给人看的那句话
 * 前者只要把 `fetch` 换成一个假的就能测，后者本来就是纯函数。
 *
 * ⚠️ 所以这里把 `globalThis.fetch` 和 `globalThis.chrome` 都换成假的。
 * 这不是"为了测试而测试" —— 真实触发 429 需要把某家厂商的限流打满，
 * 而那件事没人会在每次改代码后做一遍。
 *
 * ⚠️ 这里测不到的：真实厂商在这些情况下**到底返回什么状态码**。
 * 比如余额为 0，DeepSeek 返 402 还是 401，我没验过 ——
 * 402 会走到 `HTTP_402` 这条兜底文案（"接口报错：…"），
 * 那句话没有"怎么办"。这属于已知缺口，写在下面的断言里。
 */

/* ── 先装好假环境，再 import 被测模块 ── */
const settings = {
  provider: "deepseek",
  keys: { deepseek: "sk-fake" },
  model: "deepseek-flash",
  baseUrl: "https://api.deepseek.com/v1",
  timeoutMs: 30000,
};
globalThis.chrome = {
  storage: { local: { get: async () => ({ llm: settings }), set: async () => {} } },
};

const { explainError, chatStream, getSettings } = await import("../extension/lib/llm.js");

let fail = 0;
function check(name, cond, detail) {
  console.log((cond ? "  ok   " : "  FAIL ") + name + (detail ? "  " + detail : ""));
  if (!cond) fail++;
}

/** 让下一次 fetch 变成指定的失败。 */
function stubFetch(kind, status) {
  globalThis.fetch = async () => {
    if (kind === "abort") {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    if (kind === "network") throw new TypeError("Failed to fetch");
    return {
      ok: false,
      status,
      text: async () => JSON.stringify({ error: { message: "stub" } }),
    };
  };
}

async function codeOf(kind, status) {
  stubFetch(kind, status);
  try {
    await chatStream([{ role: "user", content: "x" }], () => {});
    return "(没抛错)";
  } catch (e) {
    return e.message;
  }
}

console.log("── 分类：真实故障 → 错误码 ──");
check("F1 Key 被拒（401）→ BAD_KEY", (await codeOf("http", 401)) === "BAD_KEY");
check("F1 Key 被拒（403）→ BAD_KEY", (await codeOf("http", 403)) === "BAD_KEY");
check("F2 base_url 错 / 域名不通 → NETWORK", (await codeOf("network")) === "NETWORK");
check("F3 超时（AbortError）→ TIMEOUT", (await codeOf("abort")) === "TIMEOUT");
check("F4 429 → RETRYABLE:429", (await codeOf("http", 429)) === "RETRYABLE:429");
check("5xx 也算可重试 → RETRYABLE:503", (await codeOf("http", 503)) === "RETRYABLE:503");
check("其他状态码走兜底 → HTTP_400", (await codeOf("http", 400)).startsWith("HTTP_400"));

console.log("\n── 没配 Key 时**不发请求** ──");
/* 这条不只是文案问题：没 key 就发请求等于白等一次超时，
   而且用户看到的会是网络错误，指向完全错误的方向。 */
{
  let called = 0;
  globalThis.fetch = async () => {
    called++;
    return { ok: false, status: 401, text: async () => "" };
  };
  settings.keys = {};
  settings.apiKey = "";
  let code = "";
  try {
    await chatStream([{ role: "user", content: "x" }], () => {});
  } catch (e) {
    code = e.message;
  }
  check("抛 NO_KEY", code === "NO_KEY", code);
  check("并且一次请求都没发出去", called === 0, `发了 ${called} 次`);
  settings.keys = { deepseek: "sk-fake" }; // 复原，后面还要用
}

console.log("\n── 文案：错误码 → 给人看的那句话 ──");
/* 标准来自 golden_questions：**说清「怎么办」，不是只说「失败了」。**
   所以断言的不是文案长什么样，而是里面有没有一个可执行的动作。 */
const ACTIONABLE = /检查|重试|换|去设置|改对|清空|等几秒|点右上角/;
const CASES = [
  ["NO_KEY", ["设置"], "要指路去哪配"],
  ["BAD_KEY", ["401", "过期", "余额"], "F1：要说清三种可能"],
  ["NETWORK", ["base_url"], "F2：要点出 base_url"],
  ["TIMEOUT", ["重试"], "F3：要说可以重试"],
  ["RETRYABLE:429", ["429", "重试"], "F4：要说明是可重试的"],
  ["BAD_EXTRA_BODY", ["JSON"], "要说清是哪个字段不合法"],
];
for (const [code, musts, why] of CASES) {
  const msg = explainError(code);
  check(
    `${code} —— ${why}`,
    musts.every((w) => msg.includes(w)) && ACTIONABLE.test(msg),
    msg.slice(0, 60)
  );
}

console.log("\n── 文案不能把技术细节直接糊给用户 ──");
{
  const raw = explainError('HTTP_500:{"error":{"message":"internal"}}');
  check("HTTP_ 兜底会带上原文（否则没法排查）", raw.includes("internal"));
  check("但有长度上限（不会糊一整页 JSON）", explainError("HTTP_500:" + "x".repeat(500)).length < 200);
  /* ⚠️ 已知缺口，如实断言它现在的样子：兜底文案里**没有**"怎么办"。
     402（余额不足）这种会走到这里，而用户看到的只有"接口报错：…"。
     这一条是绿的不代表它是对的 —— 它是"我知道它缺什么"。 */
  check(
    "⚠️ 已知缺口：HTTP_ 兜底文案不含可执行动作（记录现状，不是认可）",
    !ACTIONABLE.test(explainError("HTTP_402:insufficient balance"))
  );
}

console.log("\n── 未知错误不许静默 ──");
{
  const msg = explainError("something nobody handled");
  check("原文透出来（不是空字符串，也不是「未知错误」）", msg.includes("something"));
  check("空输入不炸", explainError("") === "" && explainError(undefined) === "");
}

console.log("\n── 设置读取的兼容：旧字段 apiKey 仍然算配了 Key ──");
/* 这条钉的是 getKey 注释里那句话：老用户的 key 存在 apiKey 里，
   只读 keys[provider] 会让他们升级后突然"没配 key"。 */
{
  settings.keys = {};
  settings.apiKey = "sk-old-style";
  const s = await getSettings();
  const { hasKey } = await import("../extension/lib/llm.js");
  check("只有旧字段也算有 key", hasKey(s) === true);
  settings.apiKey = "";
  settings.keys = { deepseek: "sk-fake" };
}

console.log("");
if (fail) {
  console.log(`!! ${fail} 条断言不过`);
  process.exit(1);
}
console.log("全部断言通过");
