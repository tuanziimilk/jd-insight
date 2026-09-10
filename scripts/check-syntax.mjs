/* 扩展所有 JS 的**真 ESM 解析**检查。
 *
 *     node jd-insight/scripts/check-syntax.mjs
 *
 * ⚠️ 为什么不能用 `node --check`
 *
 * `node --check file.js` 把文件按**脚本**解析，而扩展里全是 ESM 模块。
 * 实测（2026-09-10）：sidepanel.js 里字符串字面量中出现了真换行——
 * 那是确定的 SyntaxError——而 `node --check` 报的是 **OK**。
 * 于是坏代码被提交了两次，一整个功能（能力缺口）在浏览器里从没跑起来过，
 * 表现是「点设置没反应、侧边栏不响应」，完全不像一个字符串的问题。
 *
 * 这是本项目**第四次**踩「脚本生成代码把 \n 写成真换行」：
 *   1. popup.js  → 弹窗白屏（靠人看到界面空白发现）
 *   2. sidepanel.js → 侧边栏白屏（同上）
 *   3. intents.js 的正则 → 凑巧语义一样，蒙过去了
 *   4. sidepanel.js 的 answerGap / answerGuard → 整个模块不加载
 *
 * 前三次的教训都记在注释里了，但注释不会执行。这个脚本会。
 *
 * 顺带查一件用眼睛容易漏的：扩展页面 HTML 引用的脚本文件是否真的存在
 * ——少一个文件的表现同样是"页面没反应"。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, relative } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXT = join(HERE, "..", "extension");

function jsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "icons") continue;
      out.push(...jsFiles(p));
    } else if (e.name.endsWith(".js")) {
      out.push(p);
    }
  }
  return out;
}

let fail = 0;
const files = jsFiles(EXT).sort();
console.log("── ESM 解析 ──");

for (const f of files) {
  const rel = relative(EXT, f).replace(/\\/g, "/");
  try {
    /* 只解析不执行：动态 import 会执行模块顶层代码，而扩展模块顶层会碰
       chrome.* / document。所以用 `new Function` 不行（那是脚本语法），
       改用 import() 但把它包在 try 里——执行期的 ReferenceError 无所谓，
       我们只关心 SyntaxError。两者能靠 error 的类型区分。 */
    await import(pathToFileURL(f).href);
    console.log("  ok       " + rel);
  } catch (e) {
    if (e instanceof SyntaxError) {
      console.log("  SYNTAX!  " + rel + "  " + String(e.message));
      fail++;
    } else {
      // ReferenceError: chrome is not defined 之类 —— 语法是好的，这就够了
      console.log("  ok       " + rel + "  （解析通过；执行期 " + e.constructor.name + "，不算问题）");
    }
  }
}

/* ⚠️ 这里原本还有一个「扫字符串里的真换行」启发式：剥掉注释，然后逐行
   数引号是否成对。写完当场就发现它在误报，删掉了。

   误报原因：剥「行注释」那一步是按两个连续斜杠截到行尾——它会把字符串里的
   网址从协议后面的双斜杠处截断，于是一个存着 https 网址的字段变成了
   只剩前半截、引号成了奇数。providers.js 一个文件报了 16 行。

   要写对就得实现一个真的 JS 词法分析器，而上面那个 ESM 解析已经能 100%
   抓到这个 bug 了——它就是解析器本身。多一个会误报的检查只会让人学会
   忽略输出，那比没有检查更糟。这条原则这个项目里用过一次：我给装饰性
   分隔线编了个对比度门槛然后判它不合格，那门槛是我自己造的。

   ⚠️ 还有一条：这段注释的第一版里我写了那个行注释正则的字面量，
   而生成这个文件时转义又被吃了一层，正则末尾的星号加斜杠**提前把块注释
   关掉了**，于是这个「用来抓语法错误的脚本」自己成了语法错误。
   所以现在这里一个正则都不写，全部用中文描述。 */

/* 扩展页面引用的脚本必须真的在包里。少一个文件的表现同样是"页面没反应"。 */
console.log("\n── HTML 引用的脚本是否存在 ──");
for (const h of ["popup.html", "sidepanel.html", "options.html"]) {
  const p = join(EXT, h);
  if (!existsSync(p)) { console.log("  缺页面  " + h); fail++; continue; }
  const src = readFileSync(p, "utf8");
  const srcs = [...src.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]);
  for (const s of srcs) {
    const ok = existsSync(join(EXT, s));
    console.log((ok ? "  ok      " : "  缺文件! ") + h + " → " + s);
    if (!ok) fail++;
  }
}

console.log("");
if (fail) {
  console.log("!! %d 处问题。**提交前必须过这个脚本**——" +
    "node --check 对 ESM 是假通过，别再拿它当闸门。", fail);
  process.exit(1);
}
console.log("全部通过（%d 个 js 文件）", files.length);
