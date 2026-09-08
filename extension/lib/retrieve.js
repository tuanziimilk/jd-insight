/* 检索：从已采集的 JD 里挑出与问题最相关的几条，塞进 LLM 的上下文。
 *
 * ⚠️ 关键设计取舍：**这里刻意不用向量检索。**
 *   语料规模是几十到几百条 JD，全是同一垂类、词汇高度重叠。
 *   在这个量级上，关键词打分 + 字段加权的召回质量已经够用，而向量检索要付：
 *     ① 每条 JD 一次 embedding 调用（成本 + 首次使用要等）
 *     ② 浏览器里存向量（IndexedDB）与维护索引的复杂度
 *     ③ 用户必须先配好 key 才能用检索，冷启动体验变差
 *   语料上千条、或需要跨语言语义匹配时再上向量——那时它才划算。
 *   （判断依据：先问"确定性方案够不够"，不够才加不确定的那层。）
 */

const STOP = new Set([
  "的", "了", "和", "与", "是", "在", "有", "我", "你", "他", "它", "这", "那",
  "个", "些", "吗", "呢", "吧", "啊", "哪", "什么", "怎么", "如何", "多少",
  "岗位", "工作", "要求", "需要", "请", "帮我", "一下", "关于",
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

/** 字段加权：标题/公司里命中比正文里命中更说明相关 */
const WEIGHT = { title: 3, company: 2.5, tagline: 1.5, body: 1 };

function scoreOne(rec, qTokens) {
  const fields = {
    title: rec.title || "",
    company: rec.company || "",
    tagline: rec.tagline || "",
    body: (rec.body || rec.pageText || "").slice(0, 4000),
  };
  const idx = {};
  for (const [k, v] of Object.entries(fields)) {
    const set = new Set(tokenize(v));
    for (const t of set) idx[t] = (idx[t] || 0) + WEIGHT[k];
  }
  let score = 0;
  const hits = [];
  const seen = new Set();
  for (const t of qTokens) {
    if (seen.has(t)) continue; // 同一词只算一次，避免长问题刷分
    seen.add(t);
    if (idx[t]) {
      score += idx[t];
      hits.push(t);
    }
  }
  // 长文本天然更容易命中，做一点长度归一
  const norm = 1 / Math.log(120 + (fields.body.length || 1));
  return { score: score * norm * 10, hits };
}

/**
 * @param {Array} records 已采集的 JD
 * @param {string} query 用户问题
 * @param {number} k 取前几条
 * @returns {{picked: Array, debug: Array}} picked 带 _score/_hits
 */
export function retrieve(records, query, k = 5) {
  const qTokens = tokenize(query);
  const scored = records.map((r) => {
    const { score, hits } = scoreOne(r, qTokens);
    return { ...r, _score: score, _hits: hits };
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
    const m = (r.tagline || "").match(/(上海|北京|深圳|杭州|广州|成都|南京|苏州|武汉|西安|厦门|远程)/);
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
