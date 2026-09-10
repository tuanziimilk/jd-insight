import {
  getSettings, saveSettings, chatOnce, explainError,
  getUsageTotal, resetUsage, fmtCost, PRICING_ESTIMATE } from "./lib/llm.js";
import { PROVIDERS, getProvider, getModel, providerByBaseUrl, priceSource,
  migrateModel, thinkOffBody } from "./lib/providers.js";
import {
  getSyncSettings, isSyncConfigured, isLoggedIn, login, logout, syncAll, explainSyncError,
  getTombstones,
} from "./lib/syncSupabase.js";

const $ = (id) => document.getElementById(id);

/* 去掉 ✓ / ✗ 之后成功失败只靠文案，所以状态必须带颜色类——
 * 不然"去 emoji"就成了退步。这两个函数是唯一的写入口，
 * 避免某处忘了清掉上一次的 class。 */
function setStatus(text, kind) {
  $("status").className = kind || "";
  $("status").textContent = text;
}
function setSyncStatus(text, kind) {
  $("syncStatus").className = kind || "";
  $("syncStatus").textContent = text;
}

/* ⚠️ 原来这里手抄了一份 PRESETS（六个厂商的 baseUrl + 一个模型名），
   而模型下拉在 options.html 里又写了一份 <option>，价格表在 llm.js 里
   写了第三份。三份数据必然分叉——实测就分叉了：PRESETS 里写的
   deepseek-v4-flash 已经不是官方现役模型名（官方现在叫 deepseek-flash），
   而价格表那份也还挂着一个早就下线的 vision-exp。
   现在全部来自 lib/providers.js 一处。 */

/* baseUrl / model / apiKey 不在这里了——它们各有自己的填充逻辑
   （厂商决定 baseUrl、下拉决定 model、key 按厂商取）。 */
// extraBody 不在这里了：它由「关闭思考模式」那个开关生成，不再让用户手填 JSON
const FIELDS = ["temperature", "maxTokens"];

/* ⚠️ 这里原来是「价格表」：三个函数（priceRow / paintPricing / readPricing）
   加 options.html 里一张可编辑的表格，让用户逐个模型填 输入/缓存/输出 三档单价。
   **整段删掉了。**

   删的理由：内置参考价已经带来源和抄录日期（lib/providers.js），
   那张表是在让用户维护一份我已经维护好的数据。而且它实际上更糟——
   用户截图里那张表只有一行、三个 0、来源写着"你手填的"，
   因为 paintPricing 只在 s.pricing 为空时才铺内置价，而老配置里有一行遗留数据，
   于是**18 个内置价一个都没显示出来**，累计用量还显示"1 次未配价格"。
   一个把正确数据挡住的编辑界面，比没有这个界面差。

   `pricing` 字段本身保留在存储里，priceOf() 也仍然优先用它——
   老用户手填过的值不会丢，只是不再提供编辑入口。
   价格过期的正解是更新 providers.js，不是让每个用户各自去抄一遍。 */

let PRICING = {};

/* 只剩三个数。输入/输出/缓存命中率/思考 token 那四列删了——
   情报台每条回答下面已经逐轮显示，设置页不该有第二份同样的东西。 */
async function paintUsage() {
  const t = await getUsageTotal();
  $("uCalls").textContent = t.calls || 0;
  $("uCost").textContent = t.unpriced
    ? fmtCost(t.cost) + "（其中 " + t.unpriced + " 次算不出价格）"
    : fmtCost(t.cost);
  $("uSince").textContent = t.since || "—";
}

/* ---------------- 厂商 / 模型下拉 ---------------- */

/* key 按厂商分开存。载入时整份读进来，切厂商只是换显示的那一个，
   保存时写回对应的那一格——这样配了三家就是三个 key，互不覆盖。 */
let KEYS = {};

function paintProviders(pid) {
  const sel = $("provider");
  sel.innerHTML = "";
  for (const p of PROVIDERS) {
    const o = document.createElement("option");
    o.value = p.id;
    o.textContent = p.label;
    sel.appendChild(o);
  }
  // 逃生舱放最后：它是兜底，不是默认路径
  const c = document.createElement("option");
  c.value = "";
  c.textContent = "— 自定义端点 —";
  sel.appendChild(c);
  sel.value = pid || "";
}

/** 模型下拉。
 *
 * ⚠️ 价格**不再塞进选项文字**。上一版是 "名字　入 ¥x / 出 ¥y"，
 * 而下拉当时和 API Key 挤在两列里，实测被截断成
 * 「DeepSeek Flash（便宜，推荐起步）　入 ¥」——价格那半截完全看不见。
 * 现在下拉独占一行、只放名字，价格由 paintModelPrice() 写在下面一行。
 */
function paintModels(pid, modelId) {
  const sel = $("modelSel");
  sel.innerHTML = "";
  const p = getProvider(pid);
  if (!p) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "自定义端点 —— 在「高级」里填模型名";
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const m of p.models) {
    const o = document.createElement("option");
    o.value = m.id;
    o.textContent = m.label;
    sel.appendChild(o);
  }
  sel.value = p.models.some((m) => m.id === modelId) ? modelId : p.models[0].id;
}

/** 当前模型的参考价，一行。替掉了原来那张可编辑的价格表。 */
function paintModelPrice() {
  const el = $("modelPrice");
  const custom = $("modelCustom").value.trim();
  const id = custom || $("modelSel").value;
  const p = PRICING_ESTIMATE[id];
  const src = priceSource(id);
  if (!p) {
    el.textContent = id
      ? "这个模型名不在内置目录里，算不出花费——用量里会记 token，但钱显示为「算不出」。"
      : "";
    return;
  }
  if (!p.in && !p.out) {
    el.textContent = "本地模型，不花钱。";
    return;
  }
  const bits = [
    "参考价：输入 ¥" + p.in,
    p.cacheIn === null ? "缓存命中价未知" : "缓存命中 ¥" + p.cacheIn,
    "输出 ¥" + p.out,
  ];
  el.textContent = bits.join(" · ") + "　（元/百万 token）" +
    (src ? "　" + src.asOf + " 抄自官方定价页，会过期" : "");
}

function paintProviderNote(pid) {
  const p = getProvider(pid);
  const el = $("provNote");
  $("keyFor").textContent = p ? "（" + p.label + "）" : "";
  if (!p) {
    el.textContent = "自定义端点：Base URL 和模型名都在下面「高级」里填。";
    return;
  }
  const bits = [];
  if (p.note) bits.push(esc(p.note));
  const links = [];
  if (p.keyUrl) links.push("拿 Key：<code>" + esc(p.keyUrl) + "</code>");
  if (p.priceUrl) links.push("核对价格：<code>" + esc(p.priceUrl) + "</code>");
  if (links.length) bits.push(links.join("　·　"));
  el.innerHTML = bits.join("<br>");
}

/* 这一页原来没有转义函数，而 provider 的 note 里有中文引号和斜杠。
   现在这些字符串是我写在代码里的常量、不是用户输入，但把它们
   直接塞进 innerHTML 仍然是个坏习惯——以后有人往 providers.js 里
   贴一段带 < 的说明就成了注入点。 */
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

/** 「关闭思考模式」开关。厂商不支持就整行隐藏。 */
function paintThinkOff(pid, extraBody) {
  const body = thinkOffBody(pid);
  const wrap = $("thinkWrap");
  if (!body) {
    wrap.hidden = true;
    $("thinkOff").checked = false;
    return;
  }
  wrap.hidden = false;
  $("thinkNote").textContent = pid === "deepseek"
    ? "（DeepSeek V4 默认开启。思考 token 按输出计费，而你看不到内容——本工具的统计和检索问答都不需要它）"
    : "（思考 token 按输出计费而你看不到内容，本工具多数任务不需要）";
  // 已存的 extraBody 里包含这个片段就算已开
  $("thinkOff").checked = (extraBody || "").indexOf("disabled") >= 0;
}

/** 切厂商：填 Base URL、重画模型列表、换出这家的 key */
function applyProvider(pid) {
  const p = getProvider(pid);
  if (p) $("baseUrl").value = p.baseUrl;
  paintModels(pid, null);
  paintProviderNote(pid);
  paintThinkOff(pid, $("thinkOff").checked ? "disabled" : "");
  $("apiKey").value = KEYS[pid] || "";
  // 本地 Ollama 不校验 key，但字段不能空
  if (pid === "ollama" && !$("apiKey").value) $("apiKey").value = "ollama";
  paintModelPrice();
}

async function load() {
  const s = await getSettings();
  FIELDS.forEach((k) => ($(k).value = s[k] ?? ""));
  KEYS = { ...(s.keys || {}) };

  /* 兼容老设置：升级前只有 baseUrl + apiKey，没有 provider。
     按 baseUrl 反查厂商，并把那个 key 归到查出来的厂商名下——
     否则老用户升级后会看到一个空的 Key 框，以为配置丢了。 */
  let pid = s.provider;
  if (!pid) {
    const guess = providerByBaseUrl(s.baseUrl);
    pid = guess ? guess.id : "";
  }
  if (s.apiKey && pid && !KEYS[pid]) KEYS[pid] = s.apiKey;

  paintProviders(pid);
  $("baseUrl").value = s.baseUrl || "";
  PRICING = s.pricing || {};

  /* ⚠️ 退役别名先迁移，再判断"是不是自定义模型"。
     实测（用户截图）：存的是 deepseek-v4-flash，下拉里没有它，
     于是被当成自定义模型名、把高级栏自动展开——而它是个 2026-07-24
     就退役的别名，调用出去必然失败，界面上却看起来一切正常。 */
  const model = migrateModel(s.model);
  const migrated = model !== s.model;
  const known = getModel(pid, model);

  paintModels(pid, model);
  paintProviderNote(pid);
  paintThinkOff(pid, s.extraBody);

  // 下拉里没有的模型名 → 真的是自定义的，放进高级栏并展开
  if (model && !known) {
    $("modelCustom").value = model;
    $("advWrap").open = true;
  }
  $("apiKey").value = KEYS[pid] || "";
  paintModelPrice();
  await paintUsage();

  if (migrated) {
    setStatus("模型名 " + s.model + " 已退役，自动换成 " + model + "，点保存生效", "bad");
  }
}

$("provider").onchange = (e) => {
  applyProvider(e.target.value);
  $("modelCustom").value = "";
  setStatus("已填入，记得保存");
};

$("modelSel").onchange = () => {
  $("modelCustom").value = "";
  paintModelPrice();
};

$("modelCustom").addEventListener("input", paintModelPrice);

$("save").onclick = async () => {
  const pid = $("provider").value;
  // 自定义模型名优先——它存在的理由就是"下拉里还没有"或"方舟接入点 ID"
  const model = $("modelCustom").value.trim() || $("modelSel").value;
  const key = $("apiKey").value.trim();
  if (pid) KEYS[pid] = key;

  /* extraBody 现在由「关闭思考模式」那个开关生成，参数名按厂商内置。
     不勾就是空字符串——不发任何厂商特有参数，最安全的默认。 */
  const think = thinkOffBody(pid);
  const extraBody = ($("thinkOff").checked && think) ? JSON.stringify(think) : "";

  await saveSettings({
    provider: pid,
    keys: KEYS,
    // 旧字段清空：key 已经归到 keys[provider] 里了，两处都留会分不清谁是真的
    apiKey: "",
    baseUrl: $("baseUrl").value.trim(),
    model,
    temperature: parseFloat($("temperature").value) || 0.3,
    maxTokens: parseInt($("maxTokens").value, 10) || 2000,
    extraBody,
    // 价格表的编辑界面删了，但存量值原样带回去——老用户手填过的不能丢
    pricing: PRICING,
  });
  const n = Object.values(KEYS).filter((v) => v && v.trim()).length;
  setStatus("已保存" + (n > 1 ? "（已配 " + n + " 家，切厂商不用重填 key）" : ""), "ok");
  setTimeout(() => ($("status").textContent = ""), 2200);
};

$("test").onclick = async () => {
  $("status").textContent = "测试中…";
  await $("save").onclick();
  try {
    const r = await chatOnce(
      [{ role: "user", content: "只回复两个字：可以" }],
      { maxTokens: 12 }
    );
    setStatus("连接正常，模型回复：" + r.slice(0, 24), "ok");
  } catch (e) {
    setStatus(explainError(e.message), "bad");
  }
};

$("clearProfile").onclick = async () => {
  if (!confirm("清除已保存的简历？下次诊断会重新问你要。")) return;
  await chrome.storage.local.set({ profile: {} });
  setStatus("简历已清除", "ok");
};

$("clearUsage").onclick = async () => {
  if (!confirm("重置累计用量统计？（不影响 JD 和简历）")) return;
  await resetUsage();
  await paintUsage();
  setStatus("用量已重置", "ok");
};

$("clearKey").onclick = async () => {
  const pid = $("provider").value;
  const p = getProvider(pid);
  const who = p ? p.label : "自定义端点";
  if (!confirm("清除「" + who + "」的 API Key？其他厂商的 key 不动。")) return;
  delete KEYS[pid];
  // 旧字段一起清掉，否则 getKey() 会退回去用它，看起来像"没清干净"
  await saveSettings({ keys: KEYS, apiKey: "" });
  $("apiKey").value = "";
  setStatus(who + " 的 Key 已清除", "ok");
};

/* ---------------- Cloud Sync ---------------- */

async function paintSyncStatus() {
  const s = await getSyncSettings();
  if (!isSyncConfigured(s)) {
    setSyncStatus("未配置 Supabase URL / key", "bad");
  } else if (isLoggedIn(s)) {
    setSyncStatus("已登录：" + s.syncEmail, "ok");
  } else if (s.refreshToken) {
    setSyncStatus("登录已过期，重新登录一次", "bad");
  } else {
    setSyncStatus("未登录", "bad");
  }
}

$("supabaseUrl").addEventListener("change", async (e) => {
  const s = await getSyncSettings();
  await chrome.storage.local.set({ sync: { ...s, supabaseUrl: e.target.value.trim() } });
});
$("supabaseAnonKey").addEventListener("change", async (e) => {
  const s = await getSyncSettings();
  await chrome.storage.local.set({ sync: { ...s, supabaseAnonKey: e.target.value.trim() } });
});

$("syncLogin").onclick = async () => {
  const email = $("syncEmail").value.trim();
  const password = $("syncPassword").value;
  if (!email || !password) {
    $("syncStatus").textContent = "请填邮箱和密码";
    return;
  }
  $("syncStatus").textContent = "登录中…";
  try {
    await login(email, password);
    $("syncPassword").value = "";
    await paintSyncStatus();
  } catch (e) {
    setSyncStatus(explainSyncError(e.message), "bad");
  }
};

$("syncLogout").onclick = async () => {
  await logout();
  await paintSyncStatus();
};

$("syncNow").onclick = async () => {
  const { jds = [] } = await chrome.storage.local.get({ jds: [] });
  const tombs = await getTombstones();
  // 本地空但有待删墓碑时也要能同步——不然"删完最后一条"这个动作
  // 永远推不到云端，云端那条就成了永久的鬼影。
  if (!jds.length && !tombs.length) {
    $("syncProgress").textContent = "本地还没有采集任何 JD。";
    return;
  }
  $("syncNow").disabled = true;
  $("syncProgress").textContent = tombs.length
    ? `同步中… 先处理 ${tombs.length} 条删除`
    : `同步中… 0/${jds.length}`;
  const res = await syncAll(jds, (done, total) => {
    $("syncProgress").textContent = `同步中… ${done}/${total}`;
  });
  $("syncNow").disabled = false;
  if (res.ok) {
    const parts = [`已同步 ${res.synced} 条`];
    if (res.deleted) parts.push(`推送删除 ${res.deleted} 条`);
    // 工作台/其他设备删掉的记录，本地也跟着清掉了——必须说出来，
    // 否则用户会以为"我的记录莫名少了几条"
    if (res.pulledRemoved) parts.push(`本地清掉 ${res.pulledRemoved} 条（别处已删）`);
    if (res.pulledRevived) parts.push(`${res.pulledRevived} 条重新采集后已恢复`);
    const left = await getTombstones();
    // 墓碑没清完要说出来：那意味着云端还留着已经被本地删掉的记录
    if (left.length) parts.push(`${left.length} 条删除未生效，下次同步重试`);
    $("syncProgress").className = "";
    $("syncProgress").textContent = parts.join(" · ");
  } else {
    $("syncProgress").className = "bad";
    $("syncProgress").textContent = `同步到第 ${res.synced} 条时失败：${res.reason || ""}`;
  }
};

async function loadSync() {
  const s = await getSyncSettings();
  $("supabaseUrl").value = s.supabaseUrl || "";
  $("supabaseAnonKey").value = s.supabaseAnonKey || "";
  $("syncEmail").value = s.syncEmail || "";
  await paintSyncStatus();
}

/* popup 的「同步到云端」在未配置/未登录时会打开 options.html#sync。
 * 光靠浏览器的锚点跳转只能滚到那一节，人还要自己找输入框——
 * 既然已经知道他是为什么来的，就直接把光标放好。 */
async function focusFromHash() {
  const h = location.hash;
  if (!h) return;
  const el = document.querySelector(h);
  if (!el) return;
  el.scrollIntoView({ block: "start" });
  // 使用说明默认收起（它在页尾），从 popup 的入口跳进来时得自动展开，
  // 否则用户点了「使用说明」却只看到一行标题
  if (h === "#help") { $("helpBody").open = true; return; }
  if (h !== "#sync") return;
  await loadSync(); // 等 URL/key/邮箱填回去，才知道该聚焦哪一个
  const st = await getSyncSettings();
  const target = !isSyncConfigured(st)
    ? $("supabaseUrl") // 连 URL 都没有，从第一个空格子开始
    : $("syncPassword");
  target.focus();
  target.select?.();
}

loadSync();
load();
focusFromHash();
