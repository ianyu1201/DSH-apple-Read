/**
 * 面板前端的一致性测试（纯静态解析，不需要浏览器）。
 *
 * 面板是「HTML 结构 + CSS 布局 + app.js 事件」三份文件拼起来的，
 * 最容易出的错是：JS 里 $("#xxx") 引用了 HTML 里不存在的 id、Tab 的名字和
 * 它要显示的那块对不上、CSS 少写了某条切换规则 —— 这些在浏览器里表现为
 * 「点了没反应」或「一片空白」，很难靠肉眼发现。这里用静态解析把它们钉住。
 *
 * 跑法：node tests/panel-dom.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PANEL = join(HERE, "..", "assets", "panel");
const html = readFileSync(join(PANEL, "index.html"), "utf8");
const css = readFileSync(join(PANEL, "style.css"), "utf8");
const js = readFileSync(join(PANEL, "app.js"), "utf8");

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? " — " + d : "")); };

// ---------- 从 HTML 里抽 id / class ----------
const htmlIds = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const htmlClasses = new Set();
for (const m of html.matchAll(/\bclass="([^"]+)"/g)) {
  for (const c of m[1].split(/\s+/)) if (c) htmlClasses.add(c);
}

// ---------- [1] app.js 里 $("#id") 引用的 id 必须存在 ----------
console.log("\n[1] app.js 的 #id 引用");
const refs = new Set();
for (const m of js.matchAll(/\$\(\s*"#([A-Za-z0-9_-]+)"\s*\)/g)) refs.add(m[1]);
for (const m of js.matchAll(/querySelector(?:All)?\(\s*"#([A-Za-z0-9_-]+)"/g)) refs.add(m[1]);
const missing = [...refs].filter((id) => !htmlIds.has(id));
missing.length === 0
  ? ok(`引用的 ${refs.size} 个 id 在 index.html 里都存在`)
  : bad("有 id 在 HTML 里找不到", missing.join(", "));

// ---------- [2] HTML 里出现的选择器类名，CSS 里应该有对应规则 ----------
console.log("\n[2] 关键类名在 CSS 里有样式");
for (const cls of ["tabs", "tab", "library", "reader", "booklist", "bookbar", "annlist"]) {
  htmlClasses.has(cls) && css.includes("." + cls)
    ? ok(`.${cls} 有 CSS 规则`)
    : bad(`.${cls} 缺 CSS 规则`, `html=${htmlClasses.has(cls)} css=${css.includes("." + cls)}`);
}

// ---------- [3] Tab 名字：HTML 的 data-tab 与 app.js 的 TABS 必须一致 ----------
console.log("\n[3] Tab 定义一致");
const htmlTabs = [...html.matchAll(/class="tab[^"]*"\s+data-tab="([^"]+)"/g)].map((m) => m[1]);
const jsTabs = (js.match(/const TABS = \[([^\]]+)\]/) || [])[1];
const jsTabList = jsTabs ? [...jsTabs.matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
htmlTabs.length === 3 ? ok(`HTML 里有 3 个 Tab：${htmlTabs.join(" / ")}`) : bad("Tab 数量不是 3", htmlTabs.join(","));
JSON.stringify(htmlTabs) === JSON.stringify(jsTabList)
  ? ok(`HTML 的 data-tab 与 app.js 的 TABS 完全一致`)
  : bad("两边对不上", `html=[${htmlTabs}] js=[${jsTabList}]`);

// ---------- [4] 每个 Tab 对应的那块内容必须存在 ----------
console.log("\n[4] Tab → 内容区映射");
const PANES = { books: ".library", marks: "#annbox", search: "#searchbox" };
for (const [tab, sel] of Object.entries(PANES)) {
  const found = sel.startsWith("#") ? htmlIds.has(sel.slice(1)) : htmlClasses.has(sel.slice(1));
  found ? ok(`${tab} → ${sel} 存在`) : bad(`${tab} → ${sel} 找不到`);
}

// ---------- [5] CSS 必须有「按 Tab 切换显示」的规则 ----------
console.log("\n[5] CSS 的 Tab 切换规则");
const need = [
  ['body[data-tab="books"] .reader', "书库 Tab 下藏掉 reader"],
  ['body[data-tab="marks"] .library', "重点 Tab 下藏掉书库"],
  ['body[data-tab="search"] .library', "在书里找 Tab 下藏掉书库"],
  ['body[data-tab="marks"] #searchbox', "重点 Tab 下藏掉检索区"],
  ['body[data-tab="search"] #annbox', "在书里找 Tab 下藏掉标注区"],
];
for (const [rule, desc] of need) {
  css.includes(rule) ? ok(desc) : bad("缺 CSS 规则：" + rule);
}

// ---------- [6] 窄栏用 grid 让每个区拿满高度，而不是旧的比例切分 ----------
console.log("\n[6] 窄栏布局不再用固定比例切分");
/@media\s*\(max-width:\s*720px\)[\s\S]*?grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)/.test(css)
  ? ok("窄栏用 grid（auto + 1fr）让内容区占满剩余高度")
  : bad("窄栏没有用 grid 满高布局");
!css.includes("flex: 0 0 40%") && !css.includes("flex: 0 0 42%")
  ? ok("旧的 40%/42% 高度切分已移除")
  : bad("还留着旧的高度切分");

// ---------- [7] details 在 Tab 模式下必须被展开（否则内容是空的） ----------
console.log("\n[7] Tab 模式下 details 会被展开");
/#annbox > summary/.test(css) && /#searchbox > summary/.test(css)
  ? ok("CSS 藏掉了折叠头（Tab 已经负责切换）")
  : bad("折叠头没藏，窄栏里会多出一行");
/if \(name === "marks"\) \$\("#annbox"\)\.open = true/.test(js) &&
/js\.includes('$("#searchbox").open = true')/
  ? ok("setTab 会显式展开对应的 details")
  : bad("setTab 没展开 details，内容区会是空的");

// ---------- [8] 手动选书后自动跳到「重点」（仅窄栏） ----------
console.log("\n[8] 选书后的引导");
/selectBook\(id, userPicked\)/.test(js) ? ok("selectBook 能区分「手动选」和「开机自动选」") : bad("selectBook 签名没更新");
/selectBook\(node\.dataset\.id, true\)/.test(js) ? ok("点击书目时标记为手动选") : bad("点击没标记手动选");
/userPicked && narrow\(\)/.test(js) ? ok("窄栏里手动选完书才跳「重点」") : bad("自动跳转条件不对");

// ---------- [9] 两处旧文案（「左栏」）已跟着布局改掉 ----------
console.log("\n[9] 文案与布局一致");
!js.includes("先从左栏选一本书")
  ? ok("不再说「左栏」（窄栏里没有左右栏了）")
  : bad("还留着「先从左栏选一本书」");

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
