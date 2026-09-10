import {
  getSettings, saveSettings, chatOnce, explainError,
  getUsageTotal, resetUsage, fmtCost, PRICING_ESTIMATE } from "./lib/llm.js";
import { PROVIDERS, getProvider, getModel, providerByBaseUrl, priceSource }
  from "./lib/providers.js";
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
const FIELDS = ["temperature", "maxTokens", "extraBody"];

/* ---------------- 价格表：按模型一行三档 ---------------- */
let PRICING = {};

function priceRow(model, p) {
  const tr = document.createElement("tr");
  const mk = (val, ph, cls) => {
    const td = document.createElement("td");
    const inp = document.createElement("input");
    inp.value = val ?? "";
    inp.placeholder = ph;
    if (cls) inp.type = "number", inp.step = "0.1", inp.min = "0";
    td.appendChild(inp);
    tr.appendChild(td);
    return inp;
  };
  const im = mk(model, "模型名，如 deepseek-v4-flash");
  const ii = mk(p.in, "—", 1);
  const ic = mk(p.cacheIn, "留空=同未命中", 1);
  const io_ = mk(p.out, "—", 1);
  // 来源列：这个数字是哪来的、哪天抄的。没有出处的价格等于没有价格
  const tdSrc = document.createElement("td");
  tdSrc.className = "mini";
  tdSrc.style.color = "var(--muted)";
  const src = priceSource(model);
  tdSrc.textContent = src ? src.asOf + " · " + src.src : (model ? "你手填的" : "—");
  tr.appendChild(tdSrc);

  const tdDel = document.createElement("td");
  tdDel.style.border = "0";
  const del = document.createElement("button");
  del.className = "ghost";
  del.textContent = "×";
  del.style.padding = "2px 8px";
  del.onclick = () => { tr.remove(); };
  tdDel.appendChild(del);
  tr.appendChild(tdDel);
  tr._read = () => {
    const name = im.value.trim();
    if (!name) return null;
    return [name, { in: parseFloat(ii.value) || 0, cacheIn: parseFloat(ic.value) || 0, out: parseFloat(io_.value) || 0 }];
  };
  return tr;
}

function paintPricing(pricing, currentModel) {
  const t = $("priceTable");
  /* ⚠️ 只在**一条都没配过**的时候才铺预估价。用户手填过的值绝不覆盖——
   * 他填的是从官网抄的真价，比我这份估算可信得多。 */
  if (!pricing || !Object.keys(pricing).length) {
    pricing = JSON.parse(JSON.stringify(PRICING_ESTIMATE));
  }
  Array.from(t.querySelectorAll("tr")).slice(1).forEach((r) => r.remove());
  const entries = Object.entries(pricing || {});
  // 当前模型没有价格行就自动加一行，省得用户找不到入口
  if (currentModel && !entries.find(([m]) => m === currentModel)) {
    entries.unshift([currentModel, {}]);
  }
  if (!entries.length) entries.push(["", {}]);
  entries.forEach(([m, p]) => t.appendChild(priceRow(m, p || {})));
}

function readPricing() {
  const out = {};
  Array.from($("priceTable").querySelectorAll("tr")).slice(1).forEach((r) => {
    const kv = r._read && r._read();
    if (kv) out[kv[0]] = kv[1];
  });
  return out;
}

async function paintUsage() {
  const t = await getUsageTotal();
  const inTok = t.inTok || 0;
  $("uCalls").textContent = t.calls || 0;
  $("uIn").textContent = inTok.toLocaleString();
  $("uHit").textContent = inTok ? Math.round(((t.hitTok || 0) / inTok) * 100) + "%" : "—";
  $("uOut").textContent = (t.outTok || 0).toLocaleString();
  $("uReason").textContent = (t.reasonTok || 0).toLocaleString();
  $("uCost").textContent = t.unpriced
    ? fmtCost(t.cost) + "（" + t.unpriced + " 次未配价格）"
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

/** 模型下拉。选项文字里带上价格——选择的那一刻才是价格有用的时刻。 */
function paintModels(pid, modelId) {
  const sel = $("modelSel");
  sel.innerHTML = "";
  const p = getProvider(pid);
  if (!p) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = "自定义端点 —— 在下面「高级」里填模型名";
    sel.appendChild(o);
    sel.disabled = true;
    return;
  }
  sel.disabled = false;
  for (const m of p.models) {
    const o = document.createElement("option");
    o.value = m.id;
    const free = !m.in && !m.out;
    o.textContent = m.label + (free ? "　免费" : "　入 ¥" + m.in + " / 出 ¥" + m.out);
    sel.appendChild(o);
  }
  sel.value = p.models.some((m) => m.id === modelId) ? modelId : p.models[0].id;
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

/** 切厂商：填 Base URL、重画模型列表、换出这家的 key */
function applyProvider(pid, keepModel) {
  const p = getProvider(pid);
  if (p) $("baseUrl").value = p.baseUrl;
  paintModels(pid, keepModel);
  paintProviderNote(pid);
  $("apiKey").value = KEYS[pid] || "";
  // 本地 Ollama 不校验 key，但字段不能空
  if (pid === "ollama" && !$("apiKey").value) $("apiKey").value = "ollama";
  paintPricing(readPricing(), $("modelSel").value);
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

  const known = getModel(pid, s.model);
  paintModels(pid, s.model);
  paintProviderNote(pid);
  // 下拉里没有的模型名 → 它是自定义的，放进高级栏并把高级栏展开
  if (s.model && !known) {
    $("modelCustom").value = s.model;
    $("advWrap").open = true;
  }
  $("apiKey").value = KEYS[pid] || "";

  paintPricing(PRICING, s.model);
  await paintUsage();
}

$("provider").onchange = (e) => {
  applyProvider(e.target.value, null);
  $("modelCustom").value = "";
  setStatus("已填入，记得保存");
};

$("modelSel").onchange = () => {
  paintPricing(readPricing(), $("modelSel").value);
  $("modelCustom").value = "";
};

$("addModel").onclick = () => {
  $("priceTable").appendChild(priceRow("", {}));
};

$("save").onclick = async () => {
  const pid = $("provider").value;
  // 自定义模型名优先——它存在的理由就是"下拉里还没有"或"方舟接入点 ID"
  const model = $("modelCustom").value.trim() || $("modelSel").value;
  const key = $("apiKey").value.trim();
  if (pid) KEYS[pid] = key;

  await saveSettings({
    provider: pid,
    keys: KEYS,
    // 旧字段清空：key 已经归到 keys[provider] 里了，两处都留会分不清谁是真的
    apiKey: "",
    baseUrl: $("baseUrl").value.trim(),
    model,
    temperature: parseFloat($("temperature").value) || 0.3,
    maxTokens: parseInt($("maxTokens").value, 10) || 2000,
    extraBody: $("extraBody").value.trim(),
    pricing: readPricing(),
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
