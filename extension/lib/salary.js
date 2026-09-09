/* 薪资解析：把招聘网站那一坨字符串变成能算的数。
 *
 * 为什么值得单独一个文件：薪资是这个工具里唯一"能排序、能算分布、能跟
 * 你的期望比"的定量字段。存成 "25-40K·15薪" 这种字符串等于没有——
 * 工作台想画薪资分布、想筛掉低于某个数的岗位，都得先有数。
 *
 * 纯函数、不碰 DOM、不碰 chrome API，所以能用 node 直接跑测试。
 * 这一点是刻意的：字符串解析最容易想漏 case，必须能离线穷举。
 */

/** 数字单位 → 倍数。K 和「千」是一回事，w 和「万」也是。 */
const UNIT = { k: 1000, K: 1000, 千: 1000, w: 10000, W: 10000, 万: 10000 };

/* 区间分隔符穷举了全角/半角所有变体（连字符、各种破折号、减号、两种波浪号、
 * 全角减号、中文「到」「至」）。
 *
 * 踩过的坑：最初只写了半角 ~，于是 "25～40K"（全角波浪号 U+FF5E）匹配不上
 * 区间，退化到单值分支、把上限 40K 当成了全部薪资，而且 parsed=true。
 * 静默给出一个错的数字比解析失败糟糕得多，所以这里宁可列长一点。 */
const RANGE =
  /(\d+(?:\.\d+)?)\s*([kK千wW万])?\s*[-‐-―−~～－〜到至]\s*(\d+(?:\.\d+)?)\s*([kK千wW万])?/;
const SINGLE = /(\d+(?:\.\d+)?)\s*([kK千wW万])/;
const MONTHS = /(\d{2})\s*薪/;
const PER_DAY = /(元\s*\/\s*天|\/\s*天|日薪)/;
const PER_YEAR = /(年薪|万\s*\/?\s*年|\/\s*年)/;
const NEGOTIABLE = /(面议|competitive|negotiable)/i;

/**
 * 解析一个薪资字符串。解析不出来就不猜——parsed=false 并说明原因，
 * 上层据此决定留空还是让人补，绝不返回一个看起来像数字的错误值。
 */
export function parseSalary(text) {
  const raw = String(text || "").trim();
  if (!raw) return { raw, parsed: false, note: "空字符串" };
  if (NEGOTIABLE.test(raw) && !/\d/.test(raw)) {
    return { raw, parsed: false, note: "面议，没有具体数字" };
  }
  if (!/\d/.test(raw)) {
    return { raw, parsed: false, note: "没有任何数字（可能被字体反爬挡住了）" };
  }
  // BOSS 薪资被字体挡住后的典型长相是 "-K·13薪"：只剩「几薪」那两位数字。
  // 把这两位当薪资会算出 13 元/月这种荒唐值，必须单独拦掉并说清原因。
  if (/^[^\d]*\d{2}\s*薪[^\d]*$/.test(raw)) {
    return { raw, parsed: false, note: "只剩「几薪」，薪资数字被字体反爬挡住了" };
  }

  const period = PER_DAY.test(raw) ? "day" : PER_YEAR.test(raw) ? "year" : "month";

  let min;
  let max;
  const r = raw.match(RANGE);
  if (r) {
    // "25-40K"：单位只写在后面，前一个数要跟着用后面的单位
    const u1 = r[2] || r[4];
    const u2 = r[4] || r[2];
    min = parseFloat(r[1]) * (UNIT[u1] || 1);
    max = parseFloat(r[3]) * (UNIT[u2] || 1);
  } else {
    const s = raw.match(SINGLE);
    if (s) {
      min = parseFloat(s[1]) * (UNIT[s[2]] || 1);
      max = min;
    } else {
      // 只有裸数字，比如 "8000"。没有单位时不敢乘倍数，直接当元。
      const n = raw.match(/(\d{3,})/);
      if (!n) return { raw, parsed: false, note: "数字太短，无法判断是不是薪资" };
      min = parseFloat(n[1]);
      max = min;
    }
  }

  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0) {
    return { raw, parsed: false, note: "解析出的数字不合法" };
  }
  if (min > max) {
    const t = min;
    min = max;
    max = t;
  }

  // 日薪按 21.75 个计薪日折月——这是劳动法的月计薪天数，不是随手取的数。
  // 年薪反过来除 12。period 一并保留，让人知道原始口径是什么。
  let monthMin = min;
  let monthMax = max;
  if (period === "day") {
    monthMin = min * 21.75;
    monthMax = max * 21.75;
  } else if (period === "year") {
    monthMin = min / 12;
    monthMax = max / 12;
  }

  const m = period === "month" ? raw.match(MONTHS) : null;
  const months = m ? parseInt(m[1], 10) : undefined;

  // months 没写时按 12 算年薪，但 months 字段本身留 undefined——
  // "没写几薪"和"明确写了 12 薪"是不同的信息，不能在数据里抹平。
  const mult = months || 12;

  return {
    raw,
    period,
    min: Math.round(monthMin),
    max: Math.round(monthMax),
    months,
    annualMin: Math.round(monthMin * mult),
    annualMax: Math.round(monthMax * mult),
    parsed: true,
  };
}

/**
 * 从任意文本里捞薪资形状的片段。
 *
 * 用途：BOSS 只对详情面板那个薪资元素做了字体反爬，但页面标题、meta、
 * 各种 title/aria-label 属性里常常是明文。与其去破解字形，不如换个地方读。
 * 返回全部候选（按出现顺序去重），信不信、要不要交叉验证由调用方决定。
 */
export function findSalaryCandidates(text) {
  const s = String(text || "");
  const out = [];
  const seen = new Set();
  const pats = [
    /\d+(?:\.\d+)?\s*[kK千wW万]?\s*[-‐-―−~～－〜到至]\s*\d+(?:\.\d+)?\s*[kK千wW万]\s*(?:[·・]?\s*\d{2}\s*薪)?/g,
    /\d+(?:\.\d+)?\s*[-‐-―−~～－〜到至]\s*\d+(?:\.\d+)?\s*元\s*\/\s*天/g,
    /\d+(?:\.\d+)?\s*[-‐-―−~～－〜到至]\s*\d+(?:\.\d+)?\s*万\s*\/?\s*年/g,
  ];
  pats.forEach((re) => {
    let m;
    while ((m = re.exec(s))) {
      const t = m[0].replace(/\s+/g, "");
      if (!seen.has(t)) {
        seen.add(t);
        out.push(t);
      }
    }
  });
  return out;
}

/** 压回一行人话，给界面显示用 */
export function formatSalary(sal) {
  if (!sal || !sal.parsed) return sal && sal.raw ? sal.raw : "";
  const k = (n) => (n % 1000 === 0 ? n / 1000 + "K" : (n / 1000).toFixed(1) + "K");
  const range = sal.min === sal.max ? k(sal.min) : k(sal.min) + "-" + k(sal.max);
  return range + (sal.months ? "·" + sal.months + "薪" : "");
}
