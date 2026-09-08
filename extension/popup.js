/* JD 采集器 · 弹窗
 * 导出格式刻意对齐 analyze_jd.py：
 *   #公司: / #岗位: / #来源: 这类元信息行 + JD 正文，条目之间用一行 ===== 分隔。
 */
"use strict";

const $ = (id) => document.getElementById(id);
let CACHE = [];

/* 打标：两个维度，点击循环切换。
 * 刻意不在采集时问——采集要一次点击不打断浏览，标签是回头整理时才需要的东西。 */
const INTENT_CYCLE = ["", "🔥", "👀", "❌"];
const INTENT_LABEL = { "": "未定", "🔥": "想投", "👀": "观察", "❌": "不考虑" };
const STATUS_CYCLE = ["", "已投", "面试中", "已挂", "已拒"];

function nextIn(cycle, cur) {
  const i = cycle.indexOf(cur || "");
  return cycle[(i + 1) % cycle.length];
}

async function setField(key, field, value) {
  const { jds = [] } = await chrome.storage.local.get({ jds: [] });
  const i = jds.findIndex((x) => x.key === key);
  if (i < 0) return;
  jds[i][field] = value;
  await chrome.storage.local.set({ jds });
  CACHE = jds;
  render();
}

const SITE_NAME = {
  "zhipin.com": "BOSS",
  "zhaopin.com": "智联",
  "liepin.com": "猎聘",
  "lagou.com": "拉勾",
  "51job.com": "前程无忧",
};

function siteLabel(host) {
  for (const k in SITE_NAME) if ((host || "").includes(k)) return SITE_NAME[k];
  return host || "—";
}

/** 单条 JD → 文本块 */
function toBlock(r) {
  const firstLine = (s) => (s || "").split("\n")[0].trim();
  const lines = [];
  if (r.company) lines.push("#公司: " + firstLine(r.company));
  if (r.title) lines.push("#岗位: " + firstLine(r.title));
  lines.push("#来源: " + siteLabel(r.site));
  if (r.salary) lines.push("#薪资: " + firstLine(r.salary));
  if (r.tagline) lines.push("#标签: " + r.tagline.replace(/\n+/g, " / "));
  if (r.intent) lines.push("#意向: " + (INTENT_LABEL[r.intent] || r.intent));
  if (r.status) lines.push("#状态: " + r.status);
  if (r.url) lines.push("#链接: " + r.url);
  if (r.ts) lines.push("#采集时间: " + r.ts);
  lines.push("");
  // 正文优先用抓到的 JD 段；太短就退回整页文本，交给 Python 那边解析
  const body = (r.body || "").length >= 120 ? r.body : r.pageText || "";
  lines.push(body);
  lines.push("");
  return lines.join("\n");
}

function toTxt(rows) {
  const head =
    "<!-- 由 JD 采集器导出 · " +
    new Date().toISOString().slice(0, 19).replace("T", " ") +
    " · 共 " +
    rows.length +
    " 条\n" +
    "     放到 career-knowledgebase/05-资源库/JD原始数据/jd_raw.txt，然后跑 analyze_jd.py -->\n\n";
  return head + rows.map(toBlock).join("\n=====\n\n") + "\n=====\n";
}

function download(text, filename, mime) {
  const blob = new Blob([text], { type: (mime || "text/plain") + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  chrome.downloads.download({ url, filename, saveAs: true }, () => {
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
}

function render() {
  $("n").textContent = CACHE.length;
  const list = $("list");
  const has = CACHE.length > 0;
  ["export", "copy", "json", "clear"].forEach((id) => ($(id).disabled = !has));

  if (!has) {
    list.innerHTML = '<div class="empty">还没有存任何 JD</div>';
    return;
  }
  list.innerHTML = "";
  CACHE.slice()
    .reverse()
    .forEach((r) => {
      const d = document.createElement("div");
      d.className = "item";
      const t = document.createElement("div");
      t.className = "t";
      t.textContent = (r.title || "（无标题）").split("\n")[0].slice(0, 26);
      const m = document.createElement("div");
      m.className = "m";
      const bits = [siteLabel(r.site)];
      if (r.salary) bits.push(r.salary.split("\n")[0]);
      if (r.company) bits.push(r.company.split("\n")[0].slice(0, 14));
      m.textContent = bits.join(" · ");
      d.appendChild(t);
      d.appendChild(m);
      if ((r.body || "").length < 120) {
        const w = document.createElement("div");
        w.className = "m warn";
        w.textContent = "⚠ 正文没抓准，已存整页文本兜底";
        d.appendChild(w);
      }

      // 两个可点切换的标签
      const tags = document.createElement("div");
      tags.className = "tags";
      const bi = document.createElement("button");
      bi.className = "chip" + (r.intent ? " on" : "");
      bi.textContent = r.intent ? r.intent + " " + INTENT_LABEL[r.intent] : "＋意向";
      bi.title = "点击切换：未定 → 想投 → 观察 → 不考虑";
      bi.onclick = () => setField(r.key, "intent", nextIn(INTENT_CYCLE, r.intent));
      const bs = document.createElement("button");
      bs.className = "chip" + (r.status ? " on" : "");
      bs.textContent = r.status || "＋状态";
      bs.title = "点击切换：未投 → 已投 → 面试中 → 已挂 → 已拒";
      bs.onclick = () => setField(r.key, "status", nextIn(STATUS_CYCLE, r.status));
      tags.appendChild(bi);
      tags.appendChild(bs);
      d.appendChild(tags);

      list.appendChild(d);
    });
}

function load() {
  chrome.storage.local.get({ jds: [] }, ({ jds }) => {
    CACHE = jds;
    render();
  });
}

$("export").addEventListener("click", () => {
  download(toTxt(CACHE), "jd_raw.txt");
});

$("json").addEventListener("click", () => {
  download(JSON.stringify(CACHE, null, 2), "jd_backup.json", "application/json");
});

$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(toTxt(CACHE));
    $("copy").textContent = "已复制 ✓";
    setTimeout(() => ($("copy").textContent = "复制全部"), 1600);
  } catch (e) {
    $("copy").textContent = "复制失败";
  }
});

$("clear").addEventListener("click", () => {
  if (!confirm("清空全部 " + CACHE.length + " 条？建议先导出备份。")) return;
  chrome.storage.local.set({ jds: [] }, load);
});

$("panel").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try {
    await chrome.sidePanel.open({ tabId: tab.id, windowId: tab.windowId });
    window.close();
  } catch (e) {
    $("panel").textContent = "请点工具栏图标旁的侧边栏按钮";
  }
});

load();
