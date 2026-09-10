/* JD 采集器 · 弹窗
 * 导出格式刻意对齐 analyze_jd.py：
 *   #公司: / #岗位: / #来源: 这类元信息行 + JD 正文，条目之间用一行 ===== 分隔。
 */
"use strict";

import { STATUS_CYCLE, FAIL_BUCKETS, pushStatus, isTerminal } from "./lib/pipeline.js";
import { parseSalary, formatSalary } from "./lib/salary.js";
import {
  addTombstone,
  getSyncSettings,
  isSyncConfigured,
  isLoggedIn,
  getTombstones,
  getLastSync,
  countPending,
  syncAll,
  explainSyncError,
} from "./lib/syncSupabase.js";

const $ = (id) => document.getElementById(id);

/** 取多行文本的第一行。原来定义在 toBlock() 内部，render() 里引用不到
 *  （会 ReferenceError）——提到模块作用域，两处共用一份。 */
const firstLine = (s) => (s || "").split("\n")[0].trim();
let CACHE = [];

/* 打标：两个维度，点击循环切换。
 * 刻意不在采集时问——采集要一次点击不打断浏览，标签是回头整理时才需要的东西。 */
/* ⚠️ 这三个 emoji 是**存进云端的枚举值**（types.ts 的 Intent，工作台也读它），
 * 不能因为界面不想显示 emoji 就改掉——那会让已有记录和云端对不上。
 * 所以数据照旧，只在渲染时换成文字标签。 */
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
        w.textContent = "正文没抓准，已存整页文本兜底";
        d.appendChild(w);
      }

      // 两个可点切换的标签
      const tags = document.createElement("div");
      tags.className = "tags";
      const bi = document.createElement("button");
      bi.className = "chip" + (r.intent ? " on" : "");
      bi.textContent = r.intent ? INTENT_LABEL[r.intent] : "＋意向";
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
        bf.className = "chip note"; // 挂因是标注，不是开关，同理不用 .on
        bf.textContent = r.failReason;
        bf.title = "挂掉原因，点击修改";
        bf.onclick = () => askFailReason(r.key);
        tags.appendChild(bf);
      }
      // 薪资 chip。没抓到就是"＋薪资"，点一下原地变输入框——
      // 采集时不打断，回头在这里一次性把待补的几条填完。
      const bsal = document.createElement("button");
      const hasSal = !!(r.salary && r.salary.trim());
      // ⚠️ 刻意不复用 .on。.on 表示"开关开着"，而薪资是**值**不是状态。
      // 之前两者共用 .on（黑底白字），结果薪资看起来像个开着的开关，
      // 而黑底在这套配色里是留给唯一主动作的——一行两三块黑，列表成了黑斑阵。
      bsal.className = "chip sal" + (hasSal ? "" : " pend");
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
    // 条数变了，"多少条没推"也跟着变——同步状态必须跟着列表一起刷。
    paintSync();
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
    $("copy").textContent = "已复制";
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


/* ── 云端同步 ──────────────────────────────────────────────
 * 原来只在设置页。但「采集完 → 同步 → 工作台能看到」是主链路，
 * 而设置页是个一年去两次的地方。逻辑不重写，直接复用
 * lib/syncSupabase.js 里那套（设置页也用它），只是把入口挪到这儿。 */

/** 把 ISO 时刻说成人话。刻意不引日期库：只需要"多久以前"这一种表达。 */
function ago(iso) {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  if (ms < 60e3) return "刚刚";
  const m = Math.floor(ms / 60e3);
  if (m < 60) return m + " 分钟前";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " 小时前";
  const d = Math.floor(h / 24);
  return d + " 天前";
}

/** 打同步状态行。四种状态各有各的下一步动作，不能都写成"点一下同步"。 */
async function paintSync() {
  const el = $("syncline");
  const btn = $("sync");
  el.className = "syncline";
  const s = await getSyncSettings();

  /* ⚠️ 未就绪时**不禁用**按钮。禁用按钮的问题是它不告诉你怎么办——
   * 你只能去读旁边那行小字再找链接。现在按钮照常可点，点了直接把
   * 设置页打开并聚焦到密码框，一步到位。needSetup 标记给 click 用。 */
  if (!isSyncConfigured(s)) {
    btn.disabled = false;
    btn.dataset.needSetup = "config";
    el.classList.add("need");
    el.textContent = "还没配置云端，点上面的按钮去设置";
    return;
  }
  if (!isLoggedIn(s)) {
    btn.disabled = false;
    btn.dataset.needSetup = "login";
    el.classList.add("need");
    // refreshToken 还在但过期了，和"从没登录过"是两件事，
    // 前者只需要重输一次密码，后者还要填 URL/key。说清楚省一轮试错。
    el.textContent = s.refreshToken
      ? "登录已过期，点上面的按钮重新登录"
      : "还没登录，点上面的按钮去登录";
    return;
  }
  btn.dataset.needSetup = "";

  const { fresh, deletes, neverSynced } = await countPending(CACHE);
  btn.disabled = !CACHE.length && !deletes;

  const parts = [];
  parts.push(neverSynced ? "还没同步过" : "上次同步 " + ago(await getLastSync()));
  // 措辞是「新采集未推」而不是「待同步」：改动（补薪资、改意向）不更新 ts，
  // 数不出来。见 countPending 的注释——这个数字是下限不是总数。
  if (fresh) parts.push(fresh + " 条新采集未推");
  if (deletes) parts.push(deletes + " 条删除未推");
  if (!fresh && !deletes && !neverSynced) parts.push("已是最新");
  el.textContent = parts.join(" · ");
  if (fresh || deletes || neverSynced) el.classList.add("need");
}

/** 打开设置页的某一节。openOptionsPage 带不了 #hash，所以用 tabs.create。 */
function openOptions(hash) {
  chrome.tabs.create({ url: chrome.runtime.getURL("options.html" + (hash || "")) });
  window.close();
}

$("sync").addEventListener("click", async () => {
  const btn = $("sync");
  const el = $("syncline");
  // 没配置 / 没登录：直接把设置页打开并落到同步那一节。
  // 用 tabs.create 而不是 openOptionsPage —— 后者带不了 #hash，
  // 到不了具体那一节，也没法让它聚焦密码框。
  if (btn.dataset.needSetup) {
    chrome.tabs.create({ url: chrome.runtime.getURL("options.html#sync") });
    window.close();
    return;
  }
  const tombs = await getTombstones();
  // 本地空但有待删墓碑时也要能同步——否则"删掉最后一条"这个动作
  // 永远推不到云端，云端那条就成了永久的鬼影。
  if (!CACHE.length && !tombs.length) {
    el.className = "syncline";
    el.textContent = "本地还没有采集任何 JD";
    return;
  }
  btn.disabled = true;
  btn.textContent = "同步中…";
  el.className = "syncline";
  el.textContent = tombs.length ? "先处理 " + tombs.length + " 条删除…" : "0/" + CACHE.length;

  let res;
  try {
    res = await syncAll(CACHE, (done, total) => {
      el.textContent = done + "/" + total;
    });
  } catch (e) {
    res = { ok: false, synced: 0, reason: explainSyncError((e && e.message) || "未知错误") };
  }
  btn.textContent = "同步到云端";

  if (!res.ok) {
    el.className = "syncline bad";
    el.textContent = "同步到第 " + res.synced + " 条时失败：" + (res.reason || "");
    btn.disabled = false;
    return;
  }

  // 成功也要把"顺带发生了什么"说出来。尤其是 pulledRemoved——
  // 那是别处删掉、本地跟着清掉的记录，不说的话用户会以为记录莫名少了。
  const parts = ["已同步 " + res.synced + " 条"];
  if (res.deleted) parts.push("推送删除 " + res.deleted);
  if (res.pulledRemoved) parts.push("本地清掉 " + res.pulledRemoved + " 条（别处已删）");
  if (res.pulledRevived) parts.push(res.pulledRevived + " 条已恢复");
  const left = await getTombstones();
  if (left.length) parts.push(left.length + " 条删除未生效，下次重试");
  el.textContent = parts.join(" · ");

  // 云端可能删掉了本地记录，列表要重新读一遍。
  // load() 里会再调 paintSync()，状态行随之刷新——但那会盖掉上面这句结果，
  // 所以先让它显示 2.5 秒。
  setTimeout(() => load(), 2500);
});

// ③ 说明入口。操作说明和导出流程都搬到设置页了——popup 每天开几十次，
// 不该常驻两段只在头几次有用的文字。这里只留一个入口。
$("help").addEventListener("click", (e) => {
  e.preventDefault();
  openOptions("#help");
});

load();

