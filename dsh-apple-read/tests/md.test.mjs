/**
 * 面板 markdown 渲染的单元测试。
 *
 * md() 是面板里唯一有「解析逻辑」的纯函数（标题/列表/引用/代码/加粗），
 * 而它渲染的是模型回答 —— 一旦出错，要么显示成一坨，要么把内容吃掉。
 * 所以直接从 app.js 里把 esc()/md() 抠出来跑，不依赖 DOM。
 *
 * 跑法：node tests/md.test.mjs
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "..", "assets", "panel", "app.js"), "utf8");

/** 从源码里按大括号配平抠出一个函数（比正则可靠，能处理嵌套）。 */
function grab(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`app.js 里找不到 ${name}()`);
  let depth = 0, seen = false;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") { depth++; seen = true; }
    else if (src[i] === "}") { depth--; if (seen && depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error(`${name}() 大括号不配平`);
}

const { md } = new Function(grab("esc") + "\n" + grab("md") + "\nreturn { md };")();

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? " — " + d : "")); };
const is = (label, got, want) =>
  got === want ? ok(label) : bad(label, `\n      得到: ${JSON.stringify(got)}\n      期望: ${JSON.stringify(want)}`);
const has = (label, got, needle) =>
  got.includes(needle) ? ok(label) : bad(label, `输出里没有 ${JSON.stringify(needle)}：${JSON.stringify(got)}`);

console.log("\n[1] 行内");
is("**加粗**", md("这是**重点**。"), "<p>这是<strong>重点</strong>。</p>");
is("`代码`", md("用 `md()` 渲染"), "<p>用 <code>md()</code> 渲染</p>");

console.log("\n[2] 块级");
is("标题", md("## 它在说什么"), "<h4>它在说什么</h4>");
has("无序列表", md("- 甲\n- 乙"), "<ul><li>甲</li><li>乙</li></ul>");
has("有序列表", md("1. 甲\n2. 乙"), "<ol><li>甲</li><li>乙</li></ol>");
has("引用", md("> 原文一句"), "<blockquote>原文一句</blockquote>");
is("空行分段", md("甲\n\n乙"), "<p>甲</p><p>乙</p>");

console.log("\n[3] 真实形状的模型回答");
// 内容本身不重要（这是 markdown 解析测试），但要保持「模型真实会输出的形状」：
// 书名/章节 + 加粗小标题 + 列表 + 引用。
const real = [
  "你划的这段在「第三章 示例章节名」。",
  "",
  "**它在说什么**",
  "",
  "作者在这里列了一张清单：",
  "",
  "- 第一点",
  "- 第二点",
  "",
  "> 这是一句被引用的原文。",
].join("\n");
const out = md(real);
has("段落保留", out, "<p>你划的这段在「第三章 示例章节名」。</p>");
// 模型实际上是用 **加粗** 当小标题的，不是 ## —— 所以这里要断言 strong，不是 h4
has("加粗小标题", out, "<strong>它在说什么</strong>");
has("列表成块", out, "<ul><li>第一点</li><li>第二点</li></ul>");
has("引用成块", out, "<blockquote>这是一句被引用的原文。</blockquote>");
out.includes("<p>**") ? bad("加粗没被解析") : ok("加粗全部解析掉了");

console.log("\n[4] 安全性（内容来自书，不能当 HTML 执行）");
const evil = '<img src=x onerror="alert(1)"> & <script>bad()</script>';
const safe = md(evil);
safe.includes("<img") || safe.includes("<script>")
  ? bad("HTML 没被转义！", safe)
  : ok("HTML 被转义，不会执行");
has("转义了 &", safe, "&amp;");

console.log("\n[5] 列表状态不串台");
const mix = md("- 甲\n\n正文\n\n1. 乙");
mix.includes("</ul>") && mix.includes("</ol>") ? ok("无序/有序列表各自正确闭合") : bad("列表没闭合", mix);

console.log(`\n===== 通过 ${pass} · 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
