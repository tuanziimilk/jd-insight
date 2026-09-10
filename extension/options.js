import {
  getSettings, saveSettings, chatOnce, explainError,
  getUsageTotal, resetUsage, fmtCost,
} from "./lib/llm.js";
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

const PRESETS = {
  "deepseek-flash": { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-flash" },
  "deepseek-pro": { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-v4-pro" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  moonshot: { baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  dashscope: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
  ollama: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
};

const FIELDS = ["baseUrl", "model", "apiKey", "temperature", "maxTokens", "extraBody"];

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

async function load() {
  const s = await getSettings();
  FIELDS.forEach((k) => ($(k).value = s[k] ?? ""));
  PRICING = s.pricing || {};
  paintPricing(PRICING, s.model);
  await paintUsage();
}

$("addModel").onclick = () => {
  $("priceTable").appendChild(priceRow("", {}));
};

$("preset").onchange = (e) => {
  const p = PRESETS[e.target.value];
  if (!p) return;
  $("baseUrl").value = p.baseUrl;
  $("model").value = p.model;
  paintPricing(readPricing(), p.model);   // 换模型时自动补一行价格
  if (e.target.value === "ollama") $("apiKey").value = "ollama"; // 本地不校验，但字段不能空
  $("status").textContent = "已填入，记得保存";
};

$("save").onclick = async () => {
  await saveSettings({
    baseUrl: $("baseUrl").value.trim(),
    model: $("model").value.trim(),
    apiKey: $("apiKey").value.trim(),
    temperature: parseFloat($("temperature").value) || 0.3,
    maxTokens: parseInt($("maxTokens").value, 10) || 2000,
    extraBody: $("extraBody").value.trim(),
    pricing: readPricing(),
  });
  setStatus("已保存", "ok");
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
  if (!confirm("清除 API Key？")) return;
  await saveSettings({ apiKey: "" });
  $("apiKey").value = "";
  setStatus("Key 已清除", "ok");
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
