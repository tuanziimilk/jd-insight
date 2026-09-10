/* 检索：从已采集的 JD 里挑出与问题最相关的几条，塞进 LLM 的上下文。
 *
 * ⚠️ 为什么这里**还没有**用向量检索 —— 这不是偷懒，是量过的结论。
 *   jd-insight/scripts/eval-retrieve.mjs 是这层的评测集（12 条语料 / 10 条
 *   人工标注用例）。2026-09-10 实测：
 *     旧版（纯 TF + 字段加权，无 IDF）  recall@3 86.7% / recall@5 93.3%
 *     现版（BM25F + IDF + 查询扩展）    见评测脚本输出
 *   在这个量级上，两个失败用例都是**同义词缺口**（问 "RAG" 但 JD 里写的是
 *   "知识库/召回"；问 "badcase" 但 JD 里写的是 "自动评测"）。
 *   向量检索能解决的正是这两例，而查询扩展也能解决 —— 代价差着数量级：
 *     向量要付：每条 JD 一次 embedding 调用（成本 + 首次等待）、
 *               浏览器里存索引、必须先配好 key 才能检索（冷启动变差）
 *     扩展要付：一个已经存在的词典文件
 *   所以先做便宜那个。**上向量的条件写在这里，到了就上**：
 *     ① 语料超过约 500 条（词典覆盖不住长尾了），或
 *     ② 评测集里出现"同义词典也补不上"的失败（跨语言/跨领域改写），或
 *     ③ recall@3 掉到 80% 以下
 *   判断依据只认评测脚本的数字，不认"感觉不够智能"。
 */

// 词典是自动生成的普通 ESM 模块（不是 .json）——理由写在 skills.js 头部：
// JSON 模块导入需要 import attributes，Chrome 123+ 才有，而这个风险
// 在开发机上验证不了（Node 支持 ≠ 用户的 Chrome 支持），
// 一旦不支持就是整个情报台在模块加载阶段直接失败。
import SKILLS from "./skills.js";

const STOP = new Set([
  "的", "了", "和", "与", "是", "在", "有", "我", "你", "他", "它", "这", "那",
  "个", "些", "吗", "呢", "吧", "啊", "哪", "什么", "怎么", "如何", "多少",
  "岗位", "工作", "要求", "需要", "请", "帮我", "一下", "关于",
  "哪些", "几条", "有没有", "相关", "这类", "方向",
  "the", "a", "an", "of", "to", "and", "or", "is", "are", "for", "in", "on",
]);

/** 极简中英分词：英文按词，中文按 2-gram（不引依赖，够用） */
export function tokenize(text) {
  const s = (text || "").toLowerCase();
  const out = [];
  // 英文 / 数字 / 常见技术词
  (s.match(/[a-z][a-z0-9+#./-]{1,20}/g) || []).forEach((w) => {
    if (!STOP.has(w) && w.length > 1) out.push(w);
  });
  // 中文 2-gram
  const zh = s.replace(/[^一-龥]+/g, " ").trim();
  zh.split(/\s+/).forEach((seg) => {
    for (let i = 0; i + 2 <= seg.length; i++) {
      const g = seg.slice(i, i + 2);
      if (!STOP.has(g)) out.push(g);
    }
  });
  return out;
}

/* ------------------------------------------------------------ 查询扩展 */

/**
 * 用共享的技能词典做查询扩展。
 *
 * skills.json 是 career-web 那份的原样复制（26 技能 / 15 组 / 280 个 pattern），
 * 一致性由 career-web 的 npm run check:shared 保证（生成 + 校验）。它本来只用于匹配分析，
 * 但它记录的正是"同一个能力的不同说法"——那就是查询扩展要的东西。
 *
 * 权重刻意压低（0.45）：扩展词是推测出来的，不能和用户真的打出来的词等权。
 * 不压的话问 "RAG" 会把所有提到 "知识库" 的岗位排到真正写了 RAG 的前面。
 */
const EXPANSION_WEIGHT = 0.45;
const MAX_EXPANSION_TERMS = 24;

/**
 * 命中一个技能，就把这个技能的**其它说法**作为短语拿去匹配。
 *
 * ⚠️ 关键：扩展词必须**整体作为短语**匹配，绝不能像查询词那样拆成 2-gram。
 * 第一版就是拆成了 2-gram，评测立刻变差（recall@3 86.7% → 85.0%）：
 * 问「有没有 B 端或者 SaaS 方向的产品岗」，SaaS 命中 backend-system 技能，
 * 扩展出「内部工具 / 效率工具 / 运营工具」，拆成 bigram 后通用的「工具」
 * 命中了一个兼职岗的「内部AI工具链」，把它顶到了第一名。
 * 扩展的语义是"同一件事的另一种说法"——那是短语级的判断，拆到字就没意义了。
 */
function expandPhrases(query) {
  const q = (query || "").toLowerCase();
  const out = [];
  for (const sk of SKILLS.skills || []) {
    const pats = (sk.patterns || []).map(String);
    const hit = pats.find((p) => q.includes(p.toLowerCase()));
    if (!hit) continue;
    for (const p of pats) {
      if (out.length >= MAX_EXPANSION_TERMS) break;
      if (p.toLowerCase() === hit.toLowerCase()) continue; // 原词已在查询里
      // 太短的短语（"中台""B端""提效"）当短语匹配也容易乱命中，跳过。
      // 长度门槛按字符算：中文 3 字、英文 4 字以上才够特指。
      const isLatin = /^[a-z0-9 +#./-]+$/i.test(p);
      if (p.length < (isLatin ? 4 : 3)) continue;
      if (!out.includes(p.toLowerCase())) out.push(p.toLowerCase());
    }
  }
  return out;
}

/** 查询词表：只放用户真的打出来的词，权重 1。扩展短语单独走 phrase 通道。 */
function queryTerms(query) {
  const terms = new Map();
  for (const t of tokenize(query)) terms.set(t, 1);
  return [...terms.entries()].map(([t, w]) => ({ t, w }));
}

/* ------------------------------------------------------------ BM25F */

/** 字段加权：标题/公司里命中比正文里命中更说明相关 */
const WEIGHT = { title: 3, company: 2.5, tagline: 1.5, body: 1 };
/** BM25 的两个常数，用标准取值。k1 控制词频饱和，b 控制长度归一强度 */
const K1 = 1.2;
const B = 0.75;

const fieldsOf = (rec) => ({
  title: rec.title || "",
  company: rec.company || "",
  tagline: rec.tagline || "",
  body: (rec.body || rec.pageText || "").slice(0, 6000),
});

/**
 * 建索引。每次检索重建一次——12~500 条语料下这是毫秒级，
 * 而缓存要处理"记录变了怎么失效"，那类 bug 比这点开销贵得多。
 */
function buildIndex(records) {
  const docs = records.map((rec) => {
    const f = fieldsOf(rec);
    const tf = {}; // field -> {token: count}
    const len = {};
    for (const [name, text] of Object.entries(f)) {
      const toks = tokenize(text);
      len[name] = toks.length || 1;
      const c = {};
      for (const t of toks) c[t] = (c[t] || 0) + 1;
      tf[name] = c;
    }
    // 短语匹配用的小写原文，按字段分开存（字段加权还要用）
    const raw = {};
    for (const [name, text] of Object.entries(f)) raw[name] = String(text).toLowerCase();
    return { rec, tf, len, raw };
  });

  // df：一个词出现在多少条 JD 里（跨字段只算一次）
  const df = {};
  for (const d of docs) {
    const seen = new Set();
    for (const c of Object.values(d.tf)) for (const t of Object.keys(c)) seen.add(t);
    for (const t of seen) df[t] = (df[t] || 0) + 1;
  }

  const avgLen = {};
  for (const name of Object.keys(WEIGHT)) {
    avgLen[name] = docs.reduce((s, d) => s + d.len[name], 0) / (docs.length || 1) || 1;
  }
  return { docs, df, avgLen, N: docs.length };
}

/** BM25 的 IDF。加 0.5 平滑并保证非负——
 *  不然在小语料里"几乎每条都有的词"会得到负分，把命中它的文档往下压。 */
function idf(term, index) {
  const n = index.df[term] || 0;
  return Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
}

/** 短语的文档频率，用来给扩展短语算 IDF。语料小，直接扫。 */
function phraseDf(index, phrases) {
  const df = {};
  for (const p of phrases) {
    let n = 0;
    for (const d of index.docs) {
      if (Object.values(d.raw).some((t) => t.includes(p))) n++;
    }
    df[p] = n;
  }
  return df;
}

function scoreDoc(doc, qTerms, index, phrases, pdf) {
  let score = 0;
  const hits = [];
  for (const { t, w } of qTerms) {
    // 字段加权词频，每个字段各自做长度归一
    let wtf = 0;
    for (const [name, fw] of Object.entries(WEIGHT)) {
      const c = doc.tf[name][t];
      if (!c) continue;
      const norm = 1 - B + B * (doc.len[name] / index.avgLen[name]);
      wtf += (fw * c) / norm;
    }
    if (!wtf) continue;
    // 词频饱和：说 5 次不等于比说 1 次相关 5 倍
    const sat = (wtf * (K1 + 1)) / (wtf + K1);
    score += w * idf(t, index) * sat;
    hits.push(t);
  }

  // 扩展短语：只看"在不在"，不看出现几次。
  // 它是推测来的证据，给一次存在性加分就够，不该因为重复出现而放大。
  for (const p of phrases || []) {
    let best = 0;
    for (const [name, fw] of Object.entries(WEIGHT)) {
      if (doc.raw[name] && doc.raw[name].includes(p)) best = Math.max(best, fw);
    }
    if (!best) continue;
    const n = (pdf && pdf[p]) || 0;
    const pIdf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
    score += EXPANSION_WEIGHT * pIdf * best;
    hits.push("~" + p); // 前缀 ~ 标明这是扩展命中，debug 时能分清
  }
  return { score, hits };
}

/**
 * @param {Array} records 已采集的 JD
 * @param {string} query 用户问题
 * @param {number} k 取前几条
 * @returns {{picked: Array, debug: Array}} picked 带 _score/_hits
 */
export function retrieve(records, query, k = 5) {
  if (!records || !records.length) return { picked: [], debug: [] };
  const index = buildIndex(records);
  const qTerms = queryTerms(query);
  // 环境变量只给评测脚本用，方便把"BM25/IDF"和"查询扩展"两个改动分开量。
  // 线上没有 process，短路取值不会报错。
  const noExpand =
    typeof process !== "undefined" && process.env && process.env.JDI_NO_EXPAND === "1";
  const phrases = noExpand ? [] : expandPhrases(query);
  const pdf = phrases.length ? phraseDf(index, phrases) : null;

  const scored = index.docs.map((d) => {
    const { score, hits } = scoreDoc(d, qTerms, index, phrases, pdf);
    return { ...d.rec, _score: score, _hits: hits };
  });
  scored.sort((a, b) => b._score - a._score);

  // 全部零分 = 问题和语料无关（比如问"你是谁"），返回空让上层走兜底
  const picked = scored.filter((r) => r._score > 0).slice(0, k);
  return {
    picked,
    debug: scored.slice(0, k).map((r) => ({
      title: r.title,
      score: +r._score.toFixed(2),
      hits: r._hits.slice(0, 8),
    })),
  };
}

/** 把选中的 JD 拼成给模型看的上下文，每条截断，并编号方便引用 */
export function buildContext(picked, perDoc = 1400) {
  return picked
    .map((r, i) => {
      const body = (r.body || r.pageText || "").slice(0, perDoc);
      return [
        `【JD ${i + 1}】`,
        `岗位：${r.title || "—"}`,
        `公司：${r.company || "—"}`,
        `薪资：${r.salary || "（未采集到，BOSS 字体反爬）"}`,
        `标签：${r.tagline || "—"}`,
        `链接：${r.url || "—"}`,
        `正文：${body}`,
      ].join("\n");
    })
    .join("\n\n----\n\n");
}

/** 全库统计——「有多少条要求 X」这类问题不该走检索，直接算 */
export function stats(records) {
  const n = records.length;
  const withSalary = records.filter((r) => /\d/.test(r.salary || "")).length;
  const cities = {};
  const companies = new Set();
  records.forEach((r) => {
    companies.add(r.company || "—");
    const m = (r.tagline || "").match(
      /(上海|北京|深圳|杭州|广州|成都|南京|苏州|武汉|西安|厦门|合肥|远程)/
    );
    if (m) cities[m[1]] = (cities[m[1]] || 0) + 1;
  });
  return { total: n, withSalary, companies: companies.size, cities };
}

/** 关键词在多少条 JD 里出现过（覆盖率）——回答"几条要求 Discord"这种问题 */
export function coverage(records, keywords) {
  const kws = keywords.map((k) => k.toLowerCase());
  const hitDocs = [];
  records.forEach((r) => {
    const hay = ((r.title || "") + (r.tagline || "") + (r.body || r.pageText || "")).toLowerCase();
    const hit = kws.filter((k) => hay.includes(k));
    if (hit.length) hitDocs.push({ title: r.title, company: r.company, hit });
  });
  return { count: hitDocs.length, total: records.length, docs: hitDocs };
}
