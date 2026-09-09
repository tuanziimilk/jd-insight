/* 投递漏斗的数据模型与指标定义
 *
 * ⚠️ 核心决策：**状态变更必须记时间戳，不能只存当前状态。**
 *   「当前状态」只能算转化率；「回音时长」「沉默率」「投递到 offer 的周期」
 *   都需要知道每次变更发生在什么时候。而**时间戳一旦没记就永远补不回来**——
 *   等投了 30 个岗再想做漏斗，只能看到一堆「已挂」，不知道各自挂在第几天。
 *
 *   所以这一层先于看板落地：哪怕图还没画，数据得先开始攒。
 */

/** 漏斗阶段。顺序即漏斗顺序，索引用于判断"是否到达过某阶段" */
export const STAGES = [
  { id: "", label: "已采集", short: "采集" },
  // ⚠️ optional=可跳过的标记阶段。逐级转化率必须跳过它，
  //    否则会算出「转化率 150%」——因为有些岗位直接从采集跳到已投，
  //    从没标过「想投」，分母比分子小。（v2.2.0 实测发现）
  { id: "想投", label: "想投", short: "想投", optional: true },
  { id: "已投", label: "已投递", short: "已投" },
  { id: "进面", label: "进入面试", short: "进面" },
  { id: "复面", label: "复面/多轮", short: "复面" },
  { id: "offer", label: "拿到 Offer", short: "offer" },
];

/** 终止态：不算流失，单独统计 */
export const TERMINAL = ["已挂", "已拒", "不考虑"];

export const STATUS_CYCLE = ["", "想投", "已投", "进面", "复面", "offer", "已挂", "已拒"];

/** 挂掉的原因分桶——这是复盘的核心，不分桶就不知道该改什么 */
export const FAIL_BUCKETS = [
  "简历没过",      // 投了没回音 / 明确拒
  "笔试挂",
  "一面挂-项目深挖",
  "一面挂-概念不熟",
  "一面挂-表达散",
  "二面挂",
  "薪资谈崩",
  "我主动放弃",
  "岗位关闭",
];

export function stageIndex(status) {
  const i = STAGES.findIndex((s) => s.id === status);
  return i < 0 ? -1 : i;
}

export function isTerminal(status) {
  return TERMINAL.includes(status);
}

/**
 * 追加一次状态变更。**只在状态真的变了时候写历史**，避免重复点击刷出噪声。
 * @returns 新的 record（不改原对象）
 */
export function pushStatus(rec, status) {
  const prev = rec.status || "";
  if (prev === status) return rec;
  const hist = Array.isArray(rec.statusHistory) ? rec.statusHistory.slice() : [];
  // 第一次记录时，把"采集时刻"补成起点，否则算不出第一段时长
  if (!hist.length) {
    hist.push({ status: prev, at: rec.ts || new Date().toISOString() });
  }
  hist.push({ status, at: new Date().toISOString() });
  return { ...rec, status, statusHistory: hist };
}

const DAY = 86400000;

function parseAt(s) {
  if (!s) return null;
  const t = Date.parse(String(s).replace(" ", "T"));
  return Number.isNaN(t) ? null : t;
}

/** 某条记录进入某状态的时间 */
export function enteredAt(rec, status) {
  const h = rec.statusHistory || [];
  const e = h.find((x) => x.status === status);
  return e ? parseAt(e.at) : null;
}

/** 距今多少天（向下取整） */
export function daysSince(ts) {
  if (!ts) return null;
  return Math.floor((Date.now() - ts) / DAY);
}

function median(arr) {
  const a = arr.filter((x) => x != null).sort((x, y) => x - y);
  if (!a.length) return null;
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

/**
 * 漏斗指标。
 *
 * 指标定义（写清楚，否则看板上的数字没人知道怎么来的）：
 *   到达数      = 曾经进入过该阶段的条数（看历史，不看当前状态）
 *                 —— 用"曾经到达"而不是"当前停留"，否则已挂的岗位会从漏斗里消失
 *   转化率      = 本阶段到达数 / 上一阶段到达数
 *   沉默率      = 已投且距今 >= silentDays 天、且从未进面 / 已投总数
 *                 —— 这是求职里最真实的一个指标：没有拒信，只有沉默
 *   回音中位数  = 从"已投"到下一次状态变更的天数中位数（仅统计有变更的）
 */
export function funnel(records, opts = {}) {
  const silentDays = opts.silentDays || 14;
  const reached = {};
  STAGES.forEach((s) => (reached[s.id] = 0));

  const replyDays = [];
  let silent = 0, applied = 0, terminal = 0;

  records.forEach((r) => {
    const hist = r.statusHistory || (r.status ? [{ status: r.status, at: r.ts }] : []);
    const seen = new Set(hist.map((h) => h.status));
    // 当前状态也算到达过
    if (r.status) seen.add(r.status);
    seen.add(""); // 采集本身就是第 0 阶段
    STAGES.forEach((s) => { if (seen.has(s.id)) reached[s.id] += 1; });

    if (isTerminal(r.status)) terminal += 1;

    const at投 = enteredAt(r, "已投");
    if (at投) {
      applied += 1;
      // 投递之后有没有变更
      const after = (hist || []).filter((h) => parseAt(h.at) > at投);
      if (after.length) {
        replyDays.push(Math.floor((parseAt(after[0].at) - at投) / DAY));
      } else if (!seen.has("进面") && daysSince(at投) >= silentDays) {
        silent += 1;
      }
    }
  });

  const rows = STAGES.map((s, i) => {
    const n = reached[s.id];
    // 逐级转化率：分母取上一个**必经**阶段（跳过 optional 的标记阶段）
    let prev = null;
    for (let j = i - 1; j >= 0; j--) {
      if (!STAGES[j].optional) { prev = reached[STAGES[j].id]; break; }
    }
    return {
      ...s,
      count: n,
      // optional 阶段不给逐级转化率——它不是漏斗的一环，是个筛选标记
      rate: s.optional || !prev ? null : n / prev,
      fromTop: reached[STAGES[0].id] ? n / reached[STAGES[0].id] : null,
    };
  });

  return {
    rows,
    applied,
    terminal,
    silent,
    silentRate: applied ? silent / applied : null,
    replyMedianDays: median(replyDays),
    silentDays,
  };
}

/** 待跟进：投了很久没动静的，按沉默天数排 —— 工作台最该显眼的一块 */
export function needsFollowUp(records, silentDays = 14) {
  return records
    .map((r) => ({ r, at: enteredAt(r, "已投") }))
    .filter((x) => x.at && !x.r.statusHistory?.some((h) => h.status === "进面"))
    .map((x) => ({ ...x.r, _silentFor: daysSince(x.at) }))
    .filter((x) => x._silentFor >= silentDays && !isTerminal(x.status))
    .sort((a, b) => b._silentFor - a._silentFor);
}

/** 挂掉原因分桶统计 */
export function failBreakdown(records) {
  const m = {};
  records.forEach((r) => {
    if (!isTerminal(r.status)) return;
    const k = r.failReason || "未归因";
    m[k] = (m[k] || 0) + 1;
  });
  return Object.entries(m).sort((a, b) => b[1] - a[1]);
}
