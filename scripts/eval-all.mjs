#!/usr/bin/env node
/* 一条命令跑完扩展侧的全部检查。
 *
 *     node jd-insight/scripts/eval-all.mjs
 *
 * ══════════ 为什么要有这个 ══════════
 *
 * 扩展是零构建的，没有 package.json，也就没有 `npm run build` 那样一个
 * "改完必须跑一次"的入口。于是这七个脚本的实际状况是：
 * 改哪块记得跑哪块，而"记得"是不可靠的 —— 这个项目已经在别处证明过一次。
 *
 * 这里不搞任何聚合逻辑，只是逐个跑、汇总退出码。
 * 有一个不过就整体非零退出，方便以后挂进任何地方。
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));

const SCRIPTS = [
  ["check-syntax.mjs", "真 ESM 解析（node --check 对 ESM 是假通过）"],
  ["eval-intents.mjs", "意图规则 + 红线 + 提示词契约"],
  ["eval-retrieve.mjs", "检索召回与排序"],
  ["eval-gap.mjs", "能力缺口聚合"],
  ["eval-pricing.mjs", "厂商目录与计价"],
  ["eval-cite.mjs", "引用校验（golden C3）"],
  ["eval-errors.mjs", "错误分类与文案（golden F 组）"],
];

const results = [];
for (const [file, what] of SCRIPTS) {
  const r = spawnSync(process.execPath, [join(HERE, file)], { encoding: "utf8" });
  const okRun = r.status === 0;
  results.push({ file, what, ok: okRun, out: (r.stdout || "") + (r.stderr || "") });
  console.log((okRun ? "✓ " : "✗ ") + file.padEnd(22) + what);
  if (!okRun) {
    // 只在失败时把输出摊开——全绿时七个脚本的输出加起来两百多行，没人会看
    console.log(
      (r.stdout || "")
        .split("\n")
        .filter((l) => /FAIL|!!|✗/.test(l))
        .map((l) => "    " + l)
        .join("\n") || "    （没有 FAIL 行，看完整输出：node scripts/" + file + "）"
    );
  }
}

const bad = results.filter((r) => !r.ok);
console.log("");
if (bad.length) {
  console.log(`!! ${bad.length}/${results.length} 个脚本不过：` + bad.map((b) => b.file).join(", "));
  process.exit(1);
}
console.log(`全部 ${results.length} 个脚本通过。`);
console.log("");
console.log("⚠️ 这些**全都是本地逻辑**。真调模型才能验的那几条（golden_questions 的");
console.log("   C1/C2/C4 和 D1 的输出那一半）不在这里，也没有任何本地检查能替代 ——");
console.log("   清单在 jd-insight/eval/golden_questions.md。");
