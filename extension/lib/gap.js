/* 能力缺口聚合 —— 跨全库 JD 统计「高频要求 × 我简历里有没有」。
 *
 * 这是情报台真正要输出的东西：**学习路数**，也就是"该补哪些能力"。
 * 刻意**不**输出学习方案、不推荐课程、不列书单、不排学习周期。
 * 理由是用户明确定过的边界：这里接的模型不高级，它整理的资料不可信。
 * 所以这条边界不是写在 prompt 里靠模型自觉，而是写成代码——
 * 本文件全部是确定性计算，**一个字都不过模型**（见 §边界）。
 *
 * ─── 三条规则，继承 career-web/src/lib/match.ts ───
 * 1. 每条命中必须带 JD 原文出处。指不回原文的结论不给。
 * 2. 正文没抓到的 JD 直接不参与统计，并如实报告跳过了几条。
 *    把只有标题的记录算进分母，会让所有能力的频次都被系统性低估。
 * 3. 硬性门槛（学历/年限）不进缺口列表。它们不是"能补的能力"，
 *    把"硕士"列进学习路数是荒谬的。
 *
 * ⚠️ 已知技术债：下面「命中判定」那一段（sentences / hits / evidenceScore）
 * 是 career-web/src/lib/match.ts 的移植。那边是 TS 且经过多轮调优，
 * 这边是零构建 ESM，没法直接共用，于是成了第三个会漂的副本
 * （前两个 salary.js / skills.js 已由 check-shared.mjs 看住）。
 * 正解是把这段抽成一个纯 .js 放在一处、两边都 import，
 * 但那要改动一个已经调好的文件，留作单独一件事做。
 * 改这里的启发式时，match.ts 必须同步改。
 *
 * ─── 边界 ───
 * 本模块的输出可以直接展示给用户，也可以塞进模型上下文当"事实"，
 * 但模型只准在这份事实上做**措辞**，不准新增能力项、不准给学习方案。
 * 对应的硬约束写在 intents.js 的 GAP 意图里。
 */
import SKILLS from "./skills.js";

/** 参与统计的最少 JD 条数。低于这个数"高频"两个字没有意义——
 *  3 条里有 2 条提到某个词，说的是这 3 条的巧合，不是市场的要求。 */
export const MIN_JDS = 5;
/** 单条 JD 至少要有多少正文才算能分析。和 match.ts 的阈值保持一致。 */
const MIN_BODY = 120;
const MIN_PAGETEXT = 200;

/* ═══ 命中判定（移植自 match.ts，改这里要同步改那边）═══ */

function sentences(text) {
  return text
    .split(/[\n\r]+|(?<=[。；！？;!?])/)
    .map((s) => s.trim().replace(/^[\s·•\-–—*]+/, ""))
    .filter((s) => s.length >= 4);
}

const REQ_MARKER = /(负责|要求|熟悉|精通|掌握|具备|需要|经验|优先|加分|能力|职责|设计|搭建|主导|独立|落地)/;

function evidenceScore(sentence, indexRatio) {
  let n = 0;
  if (REQ_MARKER.test(sentence)) n += 3;
  if (indexRatio > 0.12) n += 1;
  if (sentence.length >= 12 && sentence.length <= 120) n += 1;
  if (/^[>|]/.test(sentence)) n -= 3;
  return n;
}

/** 关键词在句子里出现。英文按词边界（SQL 不该被 MySQLite 命中），中文直接包含。 */
function hits(sentence, pattern) {
  const isAscii = /^[\x20-\x7e]+$/.test(pattern);
  if (!isAscii) return sentence.includes(pattern);
  const esc = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp("(^|[^A-Za-z0-9])" + esc + "($|[^A-Za-z0-9])", "i").test(sentence);
}

/* ═══ 单文本 → 命中的技能集合 ═══ */

/** 取正文。抓不到就返回 null，让调用方把这条算进 skipped。 */
function usableText(rec) {
  const body = (rec.body || "").trim();
  if (body.length >= MIN_BODY) return body;
  const page = (rec.pageText || "").trim();
  if (page.length >= MIN_PAGETEXT) return page;
  return null;
}

/**
 * 在一段文本里找命中的技能。
 * @returns Map<skillId, {matched, evidence}>，evidence 是最像"要求"的那句原文
 */
export function matchSkills(text) {
  const sents = sentences(text);
  const out = new Map();
  for (const sk of SKILLS.skills || []) {
    let best = -Infinity;
    let evidence = "";
    let matched = "";
    // 跨所有 pattern 挑最像要求的那句，不是"第一个命中的 pattern 就停"——
    // 后者会让 patterns 的书写顺序决定依据质量（match.ts 里踩过）。
    for (const p of sk.patterns || []) {
      sents.forEach((x, i) => {
        if (!hits(x, p)) return;
        const sc = evidenceScore(x, sents.length > 1 ? i / (sents.length - 1) : 1);
        if (sc > best) {
          best = sc;
          evidence = x.slice(0, 160);
          matched = p;
        }
      });
    }
    if (evidence) out.set(sk.id, { matched, evidence });
  }
  return out;
}

/* ═══ 跨库聚合 ═══ */

/**
 * 聚合能力缺口。
 * @param jds        采集到的记录数组
 * @param resumeText 简历正文（chrome.storage.local.profile.resume）。空字符串也接受，
 *                   此时所有项都算"未验证"，而不是全部算缺口。
 * @param opts.scope 只是用来回显给用户的口径描述，不影响计算
 */
export function aggregateGaps(jds, resumeText, opts = {}) {
  const all = Array.isArray(jds) ? jds : [];
  const skipped = [];
  const usable = [];
  for (const r of all) {
    const t = usableText(r);
    if (t) usable.push({ rec: r, text: t });
    else skipped.push(r);
  }

  if (usable.length < MIN_JDS) {
    return {
      ok: false,
      reason:
        "能分析的 JD 只有 " + usable.length + " 条（至少要 " + MIN_JDS + " 条）。" +
        (skipped.length
          ? "另有 " + skipped.length + " 条只抓到标题没抓到正文——" +
            "那些是在列表页存的，去详情页重新按 Alt+S 存一次就有正文了。"
          : "先多存几个岗位。"),
      analyzed: usable.length,
      skipped: skipped.length,
    };
  }

  // 简历侧：同一套词典反向匹配。
  // ⚠️ "简历里写了" ≠ "我真的会"。这里只能证明我**声明过**这项能力，
  // 所以下游文案一律说"简历里没提到"，不说"你不会"。
  const resume = (resumeText || "").trim();
  const inResume = resume ? matchSkills(resume) : new Map();
  const resumeKnown = resume.length >= MIN_BODY;

  const byId = new Map();
  for (const sk of SKILLS.skills || []) {
    byId.set(sk.id, {
      id: sk.id,
      label: sk.label,
      group: sk.group,
      weight: sk.weight || 1,
      jdCount: 0,
      evidence: [], // [{company, title, sentence}]，最多留 3 条
    });
  }

  for (const { rec, text } of usable) {
    const m = matchSkills(text);
    for (const [id, hit] of m) {
      const row = byId.get(id);
      if (!row) continue;
      row.jdCount += 1;
      if (row.evidence.length < 3) {
        row.evidence.push({
          company: rec.company || "—",
          title: rec.title || "—",
          sentence: hit.evidence,
        });
      }
    }
  }

  const rows = [];
  for (const row of byId.values()) {
    if (row.jdCount === 0) continue; // 全库都没要求过的能力不列，那是噪声
    const has = inResume.has(row.id);
    rows.push({
      ...row,
      jdRatio: row.jdCount / usable.length,
      inResume: has,
      resumeEvidence: has ? inResume.get(row.id).evidence : "",
      // 优先级 = 出现频次 × 词典权重。
      // 频次代表"市场要"，权重代表"这项对我这个方向有多核心"（词典里校准过）。
      // 只用频次会把"沟通协作"这种人人都写的套话顶到第一。
      priority: row.jdCount * (row.weight || 1),
    });
  }
  rows.sort((a, b) => b.priority - a.priority || b.jdCount - a.jdCount);

  const gap = rows.filter((r) => !r.inResume);
  const have = rows.filter((r) => r.inResume);

  return {
    ok: true,
    analyzed: usable.length,
    skipped: skipped.length,
    total: all.length,
    scope: opts.scope || "全部",
    resumeKnown,
    resumeChars: resume.length,
    rows,
    gap,
    have,
  };
}

/** 缺口 → 纯文本表格，给聊天气泡和模型上下文共用（同一份事实，两处不会不一致）。 */
export function renderGaps(res, topN = 8) {
  if (!res.ok) return res.reason;
  const L = [];
  L.push(
    "口径：" + res.scope + " 共 " + res.total + " 条，其中 " + res.analyzed +
      " 条有正文参与统计" + (res.skipped ? "，跳过 " + res.skipped + " 条（没抓到正文）" : "") + "。"
  );
  if (!res.resumeKnown) {
    L.push(
      "⚠️ 还没有简历正文（当前 " + res.resumeChars + " 字），所以下面只是**高频要求排行**，" +
        "不是缺口——分不出哪些你已经有了。去工作台 06 简历 上传一次就能对比。"
    );
  }
  const list = res.resumeKnown ? res.gap : res.rows;
  const head = res.resumeKnown ? "简历里没提到的高频要求" : "高频要求";
  L.push("");
  /* ⚠️ 权重和优先级两列必须显示出来。
   * 第一版只显示「命中 / 占比」，但排序用的是 频次 × 权重——
   * 于是表里出现 57% / 43% / 57% 这种交错，看起来像排序坏了。
   * **排序依据必须能从表面上的列自己验算出来**，否则这张表就是不可验证的。 */
  L.push("| " + head + " | 命中 | 占比 | 权重 | 优先级 |");
  L.push("| --- | --- | --- | --- | --- |");
  for (const r of list.slice(0, topN)) {
    L.push(
      "| " + r.label + " | " + r.jdCount + "/" + res.analyzed + " | " +
        Math.round(r.jdRatio * 100) + "% | ×" + r.weight + " | " + r.priority + " |"
    );
  }
  L.push("");
  L.push("_优先级 = 命中条数 × 词典权重。权重是「这项对我这个求职方向有多核心」，" +
    "在技能词典里校准过——只按频次排会把「跨部门协作」这种人人都写的套话顶到第一。_");
  if (res.resumeKnown && res.have.length) {
    L.push("");
    L.push(
      "简历里已经写到的（" + res.have.length + " 项）：" +
        res.have.slice(0, 10).map((r) => r.label).join("、")
    );
  }
  if (list.length) {
    L.push("");
    L.push("出处（第 1 项）：" + list[0].evidence.map(
      (e) => e.company + "《" + e.title + "》「" + e.sentence.slice(0, 60) + "」"
    ).join("；"));
  }
  return L.join("\n");
}
