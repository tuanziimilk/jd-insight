import {
  getSettings, saveSettings, chatOnce, explainError,
  getUsageTotal, resetUsage, fmtCost,
} from "./lib/llm.js";

const $ = (id) => document.getElementById(id);

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
  $("status").textContent = "✓ 已保存";
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
    $("status").textContent = "✓ 连接正常，模型回复：" + r.slice(0, 24);
  } catch (e) {
    $("status").textContent = "✗ " + explainError(e.message);
  }
};

$("clearProfile").onclick = async () => {
  if (!confirm("清除已保存的简历？下次诊断会重新问你要。")) return;
  await chrome.storage.local.set({ profile: {} });
  $("status").textContent = "✓ 简历已清除";
};

$("clearUsage").onclick = async () => {
  if (!confirm("重置累计用量统计？（不影响 JD 和简历）")) return;
  await resetUsage();
  await paintUsage();
  $("status").textContent = "✓ 用量已重置";
};

$("clearKey").onclick = async () => {
  if (!confirm("清除 API Key？")) return;
  await saveSettings({ apiKey: "" });
  $("apiKey").value = "";
  $("status").textContent = "✓ Key 已清除";
};

load();
