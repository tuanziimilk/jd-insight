/* JD 采集器 · 弹窗
 * 导出格式刻意对齐 analyze_jd.py：
 *   #公司: / #岗位: / #来源: 这类元信息行 + JD 正文，条目之间用一行 ===== 分隔。
 */
"use strict";

import { STATUS_CYCLE, FAIL_BUCKETS, pushStatus, isTerminal } from "./lib/pipeline.js";
import { parseSalary, formatSalary } from "./lib/salary.js";
import { addTombstone, getSyncSettings, isSyncConfigured } from "./lib/syncSupabase.js";

const $ = (id) => document.getElementById(id);

/** 取多行文本的第一行。原来定义在 toBlock() 内部，render() 里引用不到
 *  （会 ReferenceError）——提到模块作用域，两处共用一份。 */
const firstLine = (s) => (s || "").split("\n")[0].trim();
let CACHE = [];

/* 打标：两个维度，点击循环切换。
 * 刻意不在采集时问——采集要一次点击不打断浏览，标签是回头整理时才需要的东西。 */
const INTENT_CYCLE = ["", "🔥", "👀", "❌"];
const INTENT_LABEL = { "": "未定", "🔥": "想投", "👀": "观察", "❌": "不考虑" };

function nextIn(cycle, cur) {
  const i = cycle.indexOf(cur || "");
  return cycle[(i + 1) % cycle.length];
}

/** 补录薪资。一次把三个相关字段一起写，避免出现"有 salary 但 salaryParsed 是旧值"
 *  这种自相矛盾的状态。解析不出来时保留原文、salaryParsed 置 null——
 *  留着原文比丢掉好，至少人还能看；但绝不塞一个猜出来的数字。 */
async function setSalary(key, text) {
  const { jds = [] } = await chrome.storage.local.get({ jds: [] });
  const i = jds.findIndex((x) => x.key === key);
  if (i < 0) return;
  const t = String(text || "").trim();
  const p = t ? parseSalary(t) : null;
  jds[i] = {
    ...jds[i],
    salary: t,
    salarySource: t ? "手填" : "",
    salaryParsed: p && p.parsed ? p : null,
    salaryBlocked: !t,
    salaryPending: false,
  };
  await chrome.storage.local.set({ jds });
  CACHE = jds;
  render();
}

/** 删掉一条。
 *
 * 三件事一起做，缺一件就会留下不一致：
 *   1. 从本地存储移除
 *   2. 记一条删除墓碑 —— 下次同步时把云端那条也删掉。
 *      不这么做的话本地删了、云端还在，工作台照样显示它（鬼影记录）。
 *   3. 确认框里必须带岗位名 —— 列表里每行都有删除按钮，
 *      只写"确定删除吗"防不住误点到相邻那条。
 *
 * 刻意不做撤销：弹窗一点外面就关，撤销提示活不过那一下，
 * 做了反而给人虚假的安全感。备份走「导出 JSON」。 */
async function deleteJob(key) {
  const rec = CACHE.find((x) => x.key === key);
  const label = firstLine(rec?.title) || "这条";
  const company = rec?.company ? "（" + rec.company.slice(0, 14) + "）" : "";

  const sync = await getSyncSettings();
  const willSyncDelete = isSyncConfigured(sync);
  const extra = willSyncDelete
    ? "\n\n下次同步时也会从云端删掉。"
    : "\n\n（还没配置云端同步，只删本地。）";

  if (!confirm("删除「" + label + "」" + company + "？" + extra)) return;

  const { jds = [] } = await chrome.storage.local.get({ jds: [] });
  const next = jds.filter((x) => x.key !== key);
  await chrome.storage.local.set({ jds: next });
  if (willSyncDelete) await addTombstone(key);

  CACHE = next;
  render();
}

async function setField(key, field, value) {
  const { jds = [] } = await chrome.storage.local.get({ jds: [] });
  const i = jds.findIndex((x) => x.key === key);
  if (i < 0) return;
  // 状态走 pushStatus，会带上时间戳写进 statusHistory
  jds[i] = field === "status" ? pushStatus(jds[i], value) : { ...jds[i], [field]: value };
  await chrome.storage.local.set({ jds });
  CACHE = jds;
  render();
}

/** 终止态要问一下挂在哪——不分桶就不知道该改什么 */
async function askFailReason(key) {
  const list = FAIL_BUCKETS.map((b, i) => (i + 1) + ". " + b).join("\n");
  const v = prompt("挂在哪一环？填序号或直接写（可留空跳过）：\n\n" + list, "");
  if (v == null) return;
  const n = parseInt(v.trim(), 10);
  const reason = n >= 1 && n <= FAIL_BUCKETS.length ? FAIL_BUCKETS[n - 1] : v.trim();
  if (reason) await setField(key, "failReason", reason);
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
  const lines = [];
  if (r.company) lines.push("#公司: " + firstLine(r.company));
  if (r.title) lines.push("#岗位: " + firstLine(r.title));
  lines.push("#来源: " + siteLabel(r.site));
  if (r.salary) lines.push("#薪资: " + firstLine(r.salary));
  if (r.tagline) lines.push("#标签: " + r.tagline.replace(/\n+/g, " / "));
  if (r.intent) lines.push("#意向: " + (INTENT_LABEL[r.intent] || r.intent));
  if (r.status) lines.push("#状态: " + r.status);
  if (r.failReason) lines.push("#归因: " + r.failReason);
  if (r.statusHistory && r.statusHistory.length) {
    lines.push("#轨迹: " + r.statusHistory.map((h) => (h.status || "采集") + "@" + h.at).join(" → "));
  }
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
  // 告诉 popup-guard.js "我确实跑到这儿了"。
  // 不打这个标记的话，真的 0 条时界面文案和"脚本挂了"完全一样，守卫会误报。
  list.dataset.rendered = "1";
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
      // 薪资不放这行了——下面那个可点击的 chip 已经在显示它，而且显示的是
      // 结构化之后的格式。两处显示同一个值，改了一处忘了另一处就会自相矛盾。
      // 公司名抓不到时明确写出来，不是留空：留空看起来像"这家公司没名字"。
      bits.push(r.company ? r.company.split("\n")[0].slice(0, 14) : "公司名未抓到");
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
      bs.title = "点击切换：想投 → 已投 → 进面 → 复面 → offer → 已挂 → 已拒";
      bs.onclick = async () => {
        const next = nextIn(STATUS_CYCLE, r.status);
        await setField(r.key, "status", next);
        if (isTerminal(next) && !r.failReason) await askFailReason(r.key);
      };
      if (r.failReason) {
        const bf = document.createElement("button");
        bf.className = "chip on";
        bf.textContent = "↯ " + r.failReason;
        bf.title = "挂掉原因，点击修改";
        bf.onclick = () => askFailReason(r.key);
        tags.appendChild(bf);
      }
      // 薪资 chip。没抓到就是"＋薪资"，点一下原地变输入框——
      // 采集时不打断，回头在这里一次性把待补的几条填完。
      const bsal = document.createElement("button");
      const hasSal = !!(r.salary && r.salary.trim());
      bsal.className = "chip" + (hasSal ? " on" : "");
      bsal.textContent = hasSal
        ? r.salaryParsed
          ? formatSalary(r.salaryParsed)
          : firstLine(r.salary)
        : "＋薪资";
      bsal.title = hasSal
        ? "薪资来源：" + (r.salarySource || "未记录") + "　点击修改"
        : "页面上显示多少就填多少，点击输入";
      bsal.onclick = () => {
        const inp = document.createElement("input");
        inp.className = "salinput";
        inp.value = hasSal ? r.salary : "";
        inp.placeholder = "如 25-40K·15薪";
        const commit = () => {
          if (inp.dataset.done) return;
          inp.dataset.done = "1";
          setSalary(r.key, inp.value);
        };
        inp.onkeydown = (e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            inp.dataset.done = "1";
            render();
          }
        };
        inp.onblur = commit;
        bsal.replaceWith(inp);
        inp.focus();
        inp.select();
      };
      tags.appendChild(bsal);
      tags.appendChild(bi);
      tags.appendChild(bs);

      // 删除推到最右边、和其他 chip 隔开——它是这一行里唯一不可逆的操作，
      // 不该和「切换意向」这种随便点的按钮挨在一起。
      const bd = document.createElement("button");
      bd.className = "chip del";
      bd.textContent = "删除";
      bd.title = "删掉这条（会确认；配了云端同步的话下次同步一并删云端）";
      bd.onclick = () => deleteJob(r.key);
      tags.appendChild(bd);

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

$("clear").addEventListener("click", async () => {
  const sync = await getSyncSettings();
  const willSyncDelete = isSyncConfigured(sync);
  const extra = willSyncDelete
    ? "\n\n下次同步时这些记录也会从云端删掉。"
    : "\n\n（还没配置云端同步，只删本地。）";
  if (!confirm("清空全部 " + CACHE.length + " 条？建议先导出 JSON 备份。" + extra)) return;

  // 清空同样要记墓碑——否则清完本地，云端还留着全部记录，
  // 工作台照样显示它们，而你以为已经清干净了。
  if (willSyncDelete) {
    for (const r of CACHE) await addTombstone(r.key);
  }
  await chrome.storage.local.set({ jds: [] });
  load();
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
