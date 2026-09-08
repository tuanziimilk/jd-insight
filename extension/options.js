import { getSettings, saveSettings, chatOnce, explainError } from "./lib/llm.js";

const $ = (id) => document.getElementById(id);

const PRESETS = {
  deepseek: { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat" },
  openai: { baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
  moonshot: { baseUrl: "https://api.moonshot.cn/v1", model: "moonshot-v1-8k" },
  dashscope: {
    baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    model: "qwen-plus",
  },
  ollama: { baseUrl: "http://localhost:11434/v1", model: "qwen2.5:7b" },
};

const FIELDS = ["baseUrl", "model", "apiKey", "temperature", "maxTokens"];

async function load() {
  const s = await getSettings();
  FIELDS.forEach((k) => ($(k).value = s[k] ?? ""));
}

$("preset").onchange = (e) => {
  const p = PRESETS[e.target.value];
  if (!p) return;
  $("baseUrl").value = p.baseUrl;
  $("model").value = p.model;
  if (e.target.value === "ollama") $("apiKey").value = "ollama"; // 本地不校验，但字段不能空
  $("status").textContent = "已填入，记得保存";
};

$("save").onclick = async () => {
  await saveSettings({
    baseUrl: $("baseUrl").value.trim(),
    model: $("model").value.trim(),
    apiKey: $("apiKey").value.trim(),
    temperature: parseFloat($("temperature").value) || 0.3,
    maxTokens: parseInt($("maxTokens").value, 10) || 1600,
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

$("clearKey").onclick = async () => {
  if (!confirm("清除 API Key？")) return;
  await saveSettings({ apiKey: "" });
  $("apiKey").value = "";
  $("status").textContent = "✓ Key 已清除";
};

load();
