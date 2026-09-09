/* 私有区字形还原 · glyphmap.js
 *
 * 干什么：BOSS 直聘把薪资数字换成了私有区码位（U+E000–U+F8FF），靠自带的
 * kanzhun-mix 字体渲染成数字。文本层面读到的是 "-K·薪"，数字全丢。
 * 这个模块把码位还原成数字。
 *
 * ⚠️ 这违反 content.js 设计原则第 1 条「不破解字体」，是用户在明确知道
 * 风险后要求做的（"无论如何，处理一下"）。所以这里的每一处设计都围绕
 * 同一条底线：**错一位数比空着糟得多**。宁可放弃还原，也不能输出一个
 * 看起来正常、实际错位的薪资。
 *
 * 怎么做（关键：不硬编码任何映射表）
 *   硬编码一张 U+E0xx→数字 的表是最省事的做法，也是最危险的：BOSS 换一次
 *   字体子集，表还在、结果全错，而且错得像真的。所以改成**每次在当前页面
 *   现场重算**：
 *     1. 这个字体自己带正常的 ASCII 数字字形（实测 document.fonts.check
 *        对 "0123456789" 返回 true，页面上 "1-3年" 这类明文也用它渲染）。
 *     2. 于是把每个私有区字符和 "0"–"9" 用**同一个字体**画到 canvas 上，
 *        比像素。谁最像谁就是谁。字体换了，重算的结果自动跟着换。
 *
 * 三个踩过的坑，别再踩回去（2026-09-09 在真实 BOSS 列表页上实测）
 *   a. 归一化必须保持宽高比（letterbox），不能各自拉伸到正方形。
 *      拉伸会把宽高比这个信号丢掉，而 "1" 和 "9" 的主要区别就是它——
 *      实测拉伸版把 1/9 判反，解出 "20-35K·95薪"。
 *   b. 必须加「一一对应」约束求全局最优，不能各自取最近邻。
 *      实测有 3 个字形（对应 9、1、3）不是各自的第一名，margin 只有
 *      0.08/0.17/0.65，是这个约束把它们摆正的。
 *      推论：**单字置信度不能当验收标准**，得用下面的 c。
 *   c. 验收必须是语义上的：拿整页几十条解码结果去过薪资合理性。
 *      排列错了会立刻产出 "95薪" 这种不可能的值——上面那个 bug 就是
 *      这么抓到的。这是唯一有牙齿的检验。
 */

const PUA_LO = 0xe000;
const PUA_HI = 0xf8ff;
const CANVAS_PX = 64; // 渲染字号。太小笔画糊在一起，太大纯浪费
const GRID = 20; // 归一化网格边长
const MIN_SAMPLES = 3; // 少于这么多样本不敢下结论
const MIN_PLAUSIBLE = 0.85; // 解码后必须有这么高比例是合理薪资
/* 说不通的样本上限。比例门槛单独用不够狠：实测把整张映射「整体偏移一位」
 * （最像"错得像真的"的那种错），合理率只掉到 0.5——因为像 "31-41K" 这种
 * 不带「N薪」的结果在数值上仍然说得通，真正有鉴别力的是月数。
 * 所以再加一道硬规则：**两条以上说不通就整个不要**。
 * 排列错了会波及所有数字、坏一大片；而真实页面上偶尔有一条怪格式，
 * 顶多坏一条。这条规则把两者分开。 */
const MAX_BAD = 1;

export const hasPua = (s) => {
  for (const ch of String(s || "")) {
    const c = ch.codePointAt(0);
    if (c >= PUA_LO && c <= PUA_HI) return true;
  }
  return false;
};

/** 收集一批文本里出现过的私有区码位（去重、升序）。 */
export function collectPua(texts) {
  const set = new Set();
  for (const t of texts) {
    for (const ch of String(t || "")) {
      const c = ch.codePointAt(0);
      if (c >= PUA_LO && c <= PUA_HI) set.add(c);
    }
  }
  return [...set].sort((a, b) => a - b);
}

/**
 * 把一个字符用指定字体画出来，裁掉空白，letterbox 归一化成 GRID×GRID 灰度。
 * 返回 null 表示没画出任何墨迹（字体里没这个字形）。
 */
function inkGrid(ch, font) {
  const pad = 10;
  const size = CANVAS_PX + pad * 2;
  const cv = document.createElement("canvas");
  cv.width = size;
  cv.height = size;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.fillStyle = "#fff";
  cx.fillRect(0, 0, size, size);
  cx.fillStyle = "#000";
  cx.font = font;
  cx.textBaseline = "alphabetic";
  cx.fillText(ch, pad, CANVAS_PX + pad * 0.6);

  const data = cx.getImageData(0, 0, size, size).data;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      if (data[(py * size + px) * 4] < 128) {
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        if (py > y1) y1 = py;
      }
    }
  }
  if (x1 < 0) return null;

  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  // letterbox：按长边缩放、居中，保持宽高比 —— 见文件头坑 a。
  const scale = GRID / Math.max(w, h);
  const tw = Math.max(1, Math.round(w * scale));
  const th = Math.max(1, Math.round(h * scale));
  const offX = Math.floor((GRID - tw) / 2);
  const offY = Math.floor((GRID - th) / 2);
  const out = new Float32Array(GRID * GRID);
  for (let gy = 0; gy < th; gy++) {
    const pyA = Math.floor((gy * h) / th);
    const pyB = Math.max(Math.floor(((gy + 1) * h) / th), pyA + 1);
    for (let gx = 0; gx < tw; gx++) {
      const pxA = Math.floor((gx * w) / tw);
      const pxB = Math.max(Math.floor(((gx + 1) * w) / tw), pxA + 1);
      let sum = 0;
      let n = 0;
      for (let py = pyA; py < pyB; py++) {
        for (let px = pxA; px < pxB; px++) {
          sum += (255 - data[((y0 + py) * size + (x0 + px)) * 4]) / 255;
          n++;
        }
      }
      out[(offY + gy) * GRID + (offX + gx)] = n ? sum / n : 0;
    }
  }
  return out;
}

const l2 = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return Math.sqrt(s);
};

const sameGrid = (a, b) => {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

/** 一一对应的最小总代价分配。n ≤ 10 时穷举（带剪枝，实测毫秒级）；
 *  更多就退到「每次取全局最小」的贪心——宁可差一点也不要卡住页面。 */
function assign(cost, n) {
  if (n <= 10) {
    let best = null;
    let bestCost = Infinity;
    const used = new Array(10).fill(false);
    const cur = new Array(n);
    const rec = (i, acc) => {
      if (acc >= bestCost) return; // 剪枝
      if (i === n) {
        bestCost = acc;
        best = cur.slice();
        return;
      }
      for (let d = 0; d < 10; d++) {
        if (used[d]) continue;
        used[d] = true;
        cur[i] = d;
        rec(i + 1, acc + cost[i][d]);
        used[d] = false;
      }
    };
    rec(0, 0);
    return { pick: best, cost: bestCost };
  }
  const pairs = [];
  for (let i = 0; i < n; i++) for (let d = 0; d < 10; d++) pairs.push([cost[i][d], i, d]);
  pairs.sort((a, b) => a[0] - b[0]);
  const pick = new Array(n).fill(-1);
  const taken = new Array(10).fill(false);
  let total = 0;
  for (const [c, i, d] of pairs) {
    if (pick[i] < 0 && !taken[d]) {
      pick[i] = d;
      taken[d] = true;
      total += c;
    }
  }
  return { pick, cost: total };
}

/** 用给定映射替换文本里的私有区字符。映射里没有的码位原样留着，不猜。 */
export function decodeWith(text, map) {
  let out = "";
  for (const ch of String(text || "")) {
    const d = map.get(ch.codePointAt(0));
    out += d === undefined ? ch : String(d);
  }
  return out;
}

/**
 * 在当前页面推导「私有区码位 → 数字」的映射。
 *
 * @param {object} o
 * @param {string[]} o.samples   含私有区字符的样本文本（薪资串）。既用来收集
 *                               码位，也用来验收——所以给得越多越可靠。
 * @param {string}  o.fontFamily 渲染这些字符的 font-family（取自 computedStyle）
 * @param {(s:string)=>boolean} o.isPlausible 判断一条解码后的文本是否是合理薪资
 * @returns {{ok:boolean, reason?:string, map?:Map<number,number>, stats?:object}}
 */
export function deriveDigitMap({ samples, fontFamily, isPlausible }) {
  const cps = collectPua(samples || []);
  if (!cps.length) return { ok: false, reason: "样本里没有私有区字符" };
  if (cps.length > 10) {
    // 超过 10 个码位说明被换掉的不只是数字，「映射到 0-9」的前提就不成立。
    return { ok: false, reason: "私有区码位有 " + cps.length + " 个，超过 10，不敢按数字还原" };
  }

  const fam = (fontFamily || "").split(",")[0].trim().replace(/^["']|["']$/g, "");
  if (!fam) return { ok: false, reason: "拿不到 font-family" };
  const font = CANVAS_PX + 'px "' + fam + '"';

  // 字体真的生效了吗。没生效时 canvas 会静默回退到默认字体，
  // 那时候比出来的映射是纯噪声——必须挡住。
  const probe = String.fromCodePoint(cps[0]);
  const withFont = inkGrid(probe, font);
  if (!withFont) return { ok: false, reason: "字体里画不出这个私有区字符（可能没加载完）" };
  if (sameGrid(withFont, inkGrid(probe, CANVAS_PX + "px monospace"))) {
    return { ok: false, reason: "canvas 没用上 " + fam + "（渲染结果和回退字体一样）" };
  }

  const digits = [];
  for (let d = 0; d < 10; d++) {
    const g = inkGrid(String(d), font);
    if (!g) return { ok: false, reason: fam + " 里没有数字 " + d + " 的字形，无法比对" };
    digits.push(g);
  }

  const grids = [];
  for (const cp of cps) {
    const g = inkGrid(String.fromCodePoint(cp), font);
    if (!g) return { ok: false, reason: "U+" + cp.toString(16) + " 没有字形" };
    grids.push(g);
  }

  const cost = grids.map((g) => digits.map((d) => l2(g, d)));
  const { pick, cost: totalCost } = assign(cost, cps.length);
  if (!pick) return { ok: false, reason: "分配失败" };

  const map = new Map();
  cps.forEach((cp, i) => map.set(cp, pick[i]));

  const stats = {
    codepoints: cps.length,
    cost: +totalCost.toFixed(2),
    mapping: cps.map((cp, i) => "U+" + cp.toString(16).toUpperCase() + "→" + pick[i]).join(" "),
  };

  // 验收：解码全部样本，看有多少是合理薪资。见文件头坑 c。
  const decoded = (samples || []).filter(hasPua).map((s) => decodeWith(s, map));
  stats.samples = decoded.length;
  if (decoded.length < MIN_SAMPLES) {
    return {
      ok: false,
      reason: "只有 " + decoded.length + " 条样本，不足 " + MIN_SAMPLES + " 条，不敢下结论",
      map,
      stats,
    };
  }
  const good = decoded.filter((s) => {
    try {
      return !!isPlausible(s);
    } catch (e) {
      return false;
    }
  });
  stats.plausible = good.length;
  stats.bad = decoded.length - good.length;
  stats.ratio = +(good.length / decoded.length).toFixed(3);
  if (stats.ratio < MIN_PLAUSIBLE || stats.bad > MAX_BAD) {
    return {
      ok: false,
      reason:
        "解码后有 " +
        stats.bad +
        "/" +
        decoded.length +
        " 条说不通（如 " +
        (decoded.find((d) => !good.includes(d)) || "?") +
        "），映射不可信",
      map,
      stats,
    };
  }
  return { ok: true, map, stats };
}
