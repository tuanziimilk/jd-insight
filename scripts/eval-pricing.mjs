/* 模型目录与计价的自查。
 *
 *     node jd-insight/scripts/eval-pricing.mjs
 *
 * 设置页跑在 chrome-extension:// 里，浏览器打不开，所以这一层只能靠
 * 纯函数测试来兜。测的是**行为**不是语法——这次改的时候
 * `const FIELDS = const FIELDS = [...]` 这种重复声明我是靠肉眼发现的，
 * 而更早一次写坏的正则 node --check 直接放过去了。
 *
 * 重点防三类问题：
 *   1. 模型 id 跨厂商重复 → builtinPricing() 拍平时后者覆盖前者，
 *      于是某个厂商的价格会**静默变成另一家的**。
 *   2. 价格字段类型不对（写成字符串、写成 undefined）→ 成本静默算成 0。
 *   3. 老设置升级后"key 突然没了" → 那是把升级做成了故障。
 */
import { PROVIDERS, builtinPricing, getProvider, getModel, providerByBaseUrl, priceSource, USD_CNY }
  from "../extension/lib/providers.js";
import { priceOf, getKey, hasKey, PRICING_ESTIMATE, estimateCost } from "../extension/lib/llm.js";

let fail = 0;
function check(name, cond, detail) {
  console.log((cond ? "  ok   " : "  FAIL ") + name + (detail ? "  " + detail : ""));
  if (!cond) fail++;
}

console.log("── 目录结构 ──");
check("厂商数量 >= 5（用户要的 5 家 + 本地）", PROVIDERS.length >= 5, PROVIDERS.length + " 家");
check("用户点名的五家都在", ["openai", "gemini", "deepseek", "volcengine", "siliconflow"]
  .every((id) => !!getProvider(id)));

for (const p of PROVIDERS) {
  const bad = [];
  if (!p.label) bad.push("缺 label");
  if (!/^https?:\/\//.test(p.baseUrl)) bad.push("baseUrl 不是 http(s)");
  if (!p.models || !p.models.length) bad.push("没有模型");
  for (const m of p.models || []) {
    if (!m.id) bad.push("有模型缺 id");
    for (const k of ["in", "out"]) {
      if (typeof m[k] !== "number") bad.push(m.id + "." + k + " 不是数字");
    }
    // cacheIn 允许 null（查不到就不编），但不允许 undefined（那是漏写）
    if (m.cacheIn !== null && typeof m.cacheIn !== "number") {
      bad.push(m.id + ".cacheIn 既不是数字也不是 null");
    }
    if (!m.src || !m.asOf) bad.push(m.id + " 缺来源/日期");
    if (m.out < m.in) bad.push(m.id + " 输出价低于输入价（所有厂商都不是这样，大概率抄反了）");
  }
  check("厂商 " + p.id, bad.length === 0, bad.join("；"));
}

/* 跨厂商模型 id 必须唯一。不唯一的后果是静默的：
   builtinPricing() 是个扁平对象，后遍历到的会覆盖前面的，
   于是你选了 A 家的模型、算钱用的是 B 家的价，而界面上看不出任何异常。 */
console.log("\n── id 唯一性 ──");
const seen = new Map();
const dup = [];
for (const p of PROVIDERS) {
  for (const m of p.models) {
    if (seen.has(m.id)) dup.push(m.id + "（" + seen.get(m.id) + " / " + p.id + "）");
    else seen.set(m.id, p.id);
  }
}
check("模型 id 跨厂商不重复", dup.length === 0, dup.join("，"));
check("builtinPricing 条数 = 模型总数", Object.keys(builtinPricing()).length === seen.size,
  Object.keys(builtinPricing()).length + " vs " + seen.size);

console.log("\n── 反查与来源 ──");
check("按 baseUrl 反查得到 deepseek",
  providerByBaseUrl("https://api.deepseek.com/v1")?.id === "deepseek");
check("末尾多个斜杠也能反查",
  providerByBaseUrl("https://api.deepseek.com/v1/")?.id === "deepseek");
check("未知 baseUrl 返回 null", providerByBaseUrl("https://example.com/v1") === null);
check("每个模型都查得到来源",
  [...seen.keys()].every((id) => !!priceSource(id)));
check("汇率是数字且合理", typeof USD_CNY === "number" && USD_CNY > 5 && USD_CNY < 10, String(USD_CNY));

console.log("\n── 取价优先级 ──");
const S = { model: "deepseek-flash", pricing: {}, provider: "deepseek", keys: {} };
check("没手填时用内置价",
  priceOf(S)?.in === PRICING_ESTIMATE["deepseek-flash"].in,
  JSON.stringify(priceOf(S)));
check("手填价优先于内置价",
  priceOf({ ...S, pricing: { "deepseek-flash": { in: 1, cacheIn: 0.1, out: 2 } } }).in === 1);
check("手填全 0 = 还没填 → 退回内置价",
  priceOf({ ...S, pricing: { "deepseek-flash": { in: 0, cacheIn: 0, out: 0 } } }).in
    === PRICING_ESTIMATE["deepseek-flash"].in);
/* 本地 Ollama 全 0 是**真的免费**，必须给出 0 而不是 null。
   这两种"全 0"含义相反，是 priceOf 里唯一一处不能合并判断的地方。 */
const oll = priceOf({ model: "qwen3:8b", pricing: {} });
check("Ollama 全 0 = 真免费，不是「未配价格」", oll !== null && oll.in === 0, JSON.stringify(oll));
check("完全未知的模型返回 null", priceOf({ model: "不存在的模型", pricing: {} }) === null);

console.log("\n── key 兼容（升级不许变成故障）──");
check("按厂商取 key", getKey({ provider: "openai", keys: { openai: "sk-a" } }) === "sk-a");
check("老设置只有 apiKey 也能取到",
  getKey({ provider: "deepseek", keys: {}, apiKey: "sk-old" }) === "sk-old");
check("厂商 key 优先于老字段",
  getKey({ provider: "deepseek", keys: { deepseek: "sk-new" }, apiKey: "sk-old" }) === "sk-new");
check("配了 A 家的 key，切到 B 家应判成未配",
  !hasKey({ provider: "openai", keys: { deepseek: "sk-a" } }));
check("空白 key 不算已配", !hasKey({ provider: "openai", keys: { openai: "   " } }));

console.log("\n── 成本估算 ──");
/* 用一组好算的数字对账：10 万未命中输入 + 10 万命中 + 1 万输出。
   缓存命中价缺失时必须退回未命中价（保守，不低估）。 */
const usage = { prompt_tokens: 200000, prompt_cache_hit_tokens: 100000,
  prompt_cache_miss_tokens: 100000, completion_tokens: 10000 };
const c1 = estimateCost(usage, S, "deepseek-flash");
const p1 = PRICING_ESTIMATE["deepseek-flash"];
const want = 0.1 * p1.in + 0.1 * p1.cacheIn + 0.01 * p1.out;
check("按三档分别计价", Math.abs(c1 - want) < 1e-9, c1.toFixed(4) + " 元");
const c2 = estimateCost(usage, { model: "doubao-seed-2.0-lite", pricing: {} }, "doubao-seed-2.0-lite");
const p2 = PRICING_ESTIMATE["doubao-seed-2.0-lite"];
check("缓存价为 null 时退回未命中价（不低估）",
  Math.abs(c2 - (0.2 * p2.in + 0.01 * p2.out)) < 1e-9, c2.toFixed(4) + " 元");

console.log("\n── 参考价一览（元 / 百万 token）──");
for (const p of PROVIDERS) {
  console.log("  " + p.label);
  for (const m of p.models) {
    // Node 的 console.log 不支持 %-30s 这种宽度写法（只认 %s/%d/%j 等），
    // 用 padEnd 自己对齐
    console.log("    " + m.id.padEnd(30) +
      " 入 " + String(m.in).padEnd(6) +
      " 缓存 " + String(m.cacheIn === null ? "未知" : m.cacheIn).padEnd(6) +
      " 出 " + m.out);
  }
}

console.log("");
if (fail) {
  console.log("!! %d 条不过", fail);
  process.exit(1);
}
console.log("全部断言通过");
