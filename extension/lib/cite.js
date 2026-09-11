/* 引用校验 —— 检查回答里的【JD n】是不是真对应检索到的那一条。
 *
 * ══════════ 为什么这件事值得单独做一道检查 ══════════
 *
 * ROADMAP v2.1 的原话是「**引用错位是最隐蔽的幻觉，用户不会发现**」。
 * 原因很具体：一个带着【JD 3】的句子看起来比不带出处的句子**更可信**，
 * 而没人会真的点开 JD 3 去核。出处在这里起的是"免检标签"的作用 ——
 * 所以它错的时候，代价比没有出处更大。
 *
 * ══════════ 三类检查，可信度不一样，所以分级 ══════════
 *
 * 1. 【JD n】的 n 超出范围 —— **硬错**。上下文里只放了 5 条，出现【JD 7】
 *    就是模型自己编的编号，没有任何解释空间。
 * 2. 需要接地的回答里**一个出处都没有** —— **硬错**，但性质不同：
 *    不是引错，是整段没接地。
 * 3. 引用错位嫌疑 —— **软提示**。句子里提到的技能/公司，在它引的那条 JD 里
 *    找不到。这一类只能"可疑"，不能"判定"，原因见下面 CAVEAT。
 *
 * ⚠️ CAVEAT：软提示一定会有误报，所以界面上的措辞是「这几句需要你核一下」，
 * 不是「这几句错了」。会误报的原因是真实的：
 *   · 句子可以在综述（「RAG 是普遍要求，例如【JD 2】【JD 4】」）——
 *     关键词出现在句子里，但并不声称出自某一条
 *   · 模型可以用同义表达（JD 写"向量检索"，回答写"RAG"）
 *   · 一句话可以引多条，其中一条对一条错
 * 所以它的产出是**一个复核清单**，不是判决。
 *
 * ⚠️ 另一个必须守住的细节：校验用的正文必须是**模型实际看到的那一段**。
 * `buildContext()` 把每条 JD 的正文截到 perDoc（默认 1400）字。
 * 如果这里拿全文去校验，第 3000 字上的一个词会让"模型不可能知道的事"
 * 被判成"有依据" —— 那是把校验器和被校验对象的视野搞得不一样，
 * 和「体检页必须复用线上判定」是同一条原则。
 */
import { matchSkills } from "./gap.js";

/** 和 buildContext 的默认值保持一致。改那边必须改这边 —— 这两个数的含义是
    "模型看到了多少字"，不一致就等于校验器在看另一份材料。 */
export const CONTEXT_PER_DOC = 1400;

/** 模型实际看到的那一条 JD 的文本。字段拼法照抄 buildContext。 */
export function visibleText(rec, perDoc = CONTEXT_PER_DOC) {
  const body = String(rec.body || rec.pageText || "").slice(0, perDoc);
  return [rec.title || "", rec.company || "", rec.tagline || "", body].join("\n");
}

/** 把回答切成句子。【JD n】不能当断句点，它经常出现在句中。 */
function splitSentences(text) {
  return String(text || "")
    .split(/(?<=[。！？；\n])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 一句话里引的所有编号（去重，保持出现顺序）。 */
function citedIn(sentence) {
  const out = [];
  const re = /【JD\s*(\d+)】/g;
  let m;
  while ((m = re.exec(sentence)) !== null) {
    const n = Number(m[1]);
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * 校验一段回答。
 *
 * @param answer 模型输出的全文
 * @param picked 这次检索交给模型的 JD 数组（顺序就是编号顺序，1 起）
 * @param opts.needsRetrieval 这个意图是否本该接地（不接地的意图不检查"没出处"）
 * @param opts.perDoc buildContext 用的截断长度
 * @returns {{ cited, hard, soft }}
 *   hard/soft 都是 {kind, n?, text, detail} 数组
 */
export function checkCitations(answer, picked, opts = {}) {
  const list = Array.isArray(picked) ? picked : [];
  const perDoc = opts.perDoc || CONTEXT_PER_DOC;
  const hard = [];
  const soft = [];
  const sentences = splitSentences(answer);

  const all = [];
  for (const s of sentences) for (const n of citedIn(s)) if (!all.includes(n)) all.push(n);

  /* ── 1. 编号越界：硬错 ── */
  for (const n of all) {
    if (n < 1 || n > list.length) {
      hard.push({
        kind: "out-of-range",
        n,
        text: sentences.find((s) => citedIn(s).includes(n)) || "",
        detail:
          "这次只给了模型 " + list.length + " 条 JD（编号 1~" + list.length + "），" +
          "【JD " + n + "】不存在 —— 这个编号是模型自己编的。",
      });
    }
  }

  /* ── 2. 该接地却一个出处都没有：硬错 ── */
  if (opts.needsRetrieval && list.length > 0 && all.length === 0 && String(answer || "").trim()) {
    hard.push({
      kind: "no-citation",
      text: "",
      detail:
        "这是一个需要依据 JD 回答的问题，给了 " + list.length + " 条 JD，" +
        "但整段回答一个【JD n】都没有 —— 也就是说它没有接地，来源区那几条只是摆着。",
    });
  }

  /* ── 3. 错位嫌疑：软提示 ── */
  const visible = list.map((r) => visibleText(r, perDoc));
  const skillsInJd = visible.map((t) => new Set(matchSkills(t).keys()));
  /* 公司名单独看：它是**确定的字符串**，不像技能要靠 pattern 猜，
     所以"句子里出现了另一条 JD 的公司名"是比技能不重合强得多的信号。 */
  const companies = list.map((r) => String(r.company || "").trim());

  for (const s of sentences) {
    const ns = citedIn(s).filter((n) => n >= 1 && n <= list.length);
    if (!ns.length) continue;

    /* 3a. 句子里提到了别家公司，却只引了这几条 */
    for (let i = 0; i < companies.length; i++) {
      const c = companies[i];
      if (!c || c === "—" || c.length < 3) continue; // 太短的公司名容易撞词
      if (!s.includes(c)) continue;
      if (ns.includes(i + 1)) continue; // 引的正是这家，没问题
      soft.push({
        kind: "company-mismatch",
        n: ns[0],
        text: s,
        detail:
          "这句话里出现了「" + c + "」（那是【JD " + (i + 1) + "】的公司），" +
          "但它引的是【JD " + ns.join("】【JD ") + "】。",
      });
      break; // 一句话报一次就够
    }

    /* 3b. 句子提到的技能，在它引的那些 JD 里一个都找不到 */
    const inSentence = new Set(matchSkills(s).keys());
    if (inSentence.size === 0) continue;
    const union = new Set();
    for (const n of ns) for (const id of skillsInJd[n - 1]) union.add(id);
    const overlap = [...inSentence].filter((id) => union.has(id));
    if (overlap.length === 0) {
      soft.push({
        kind: "no-overlap",
        n: ns[0],
        text: s,
        detail:
          "这句话提到了 " + [...inSentence].join("、") +
          "，但【JD " + ns.join("】【JD ") + "】的正文里（模型看到的那 " + perDoc +
          " 字内）一项都没匹配上。",
      });
    }
  }

  return { cited: all, hard, soft };
}
