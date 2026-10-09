/**
 * 宿主半端到端测试：用假的 DSH ctx 装载 lib/index.js，把注册进来的 webServer
 * handler 挂到真 http 服务上，逐个打面板 API（含 sidecar 拉起、向量检索、SSE 聊天）。
 *
 * 跑法（在 dsh-apple-read 目录）：
 *   APPLE_READ_INDEX="<repo>/.index" node test-host.mjs
 */
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 存档指向临时文件：这个测试会打 /api/chat，那会顺手记「最近在读」，
// 绝不能写到用户真实的 ~/.dsh/storages/apple-read/data.json
const STORE_TMP = join(tmpdir(), `apple-read-host-test-${process.pid}.json`);
process.env.APPLE_READ_STORE = STORE_TMP;

const BASE = "http://127.0.0.1:";

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? " — " + d : "")); };

// ---------- 假 ctx ----------
// 真 Cordis Context 提供 effect / inject / logger 与各服务。这里按需最小实现——
// 漏掉 effect 这类核心 API 会让插件在测试里「假失败」，所以宁可多给一点。
let routeHandler = null;
let skillProvider = null;
let registeredContext = null;
const webCtx = {
  webServer: {
    register(opts) { routeHandler = opts.handler; return () => {}; },
  },
  effect(fn) { return fn(); },
};
const promptCtx = {
  systemPrompt: { context(c) { registeredContext = c; return () => {}; } },
  effect(fn) { return fn(); },
};
const ctx = {
  logger: { warn() {}, info() {} },
  effect(fn) { return fn(); },
  skills: { registerProvider(factory) { skillProvider = factory(); } },
  inject(deps, fn) {
    if (deps.includes("webServer")) fn(webCtx);
    if (deps.includes("systemPrompt")) fn(promptCtx);
  },
};

const { apply } = await import("./lib/index.js");
apply(ctx);

console.log("\n[1] 注册结果");
routeHandler ? ok("webServer handler 已注册") : bad("webServer handler 未注册");
skillProvider ? ok("skills provider 已注册") : bad("skills provider 未注册");

if (skillProvider) {
  const list = await skillProvider.list();
  const s = list[0];
  s && s.name === "apple-read" ? ok(`技能列表: ${s.name}`) : bad("技能名不对", JSON.stringify(list));
  const got = await skillProvider.get(s, {});
  /^#\s|DSH-apple-Read/u.test(got.content) ? ok(`技能正文 ${got.content.length} 字`) : bad("技能正文为空");
  typeof s.description === "string" && s.description.length > 40
    ? ok("技能 description 长度 OK") : bad("技能 description 太短");
}

// ---------- 挂到真 http ----------
const server = createServer((req, res) => {
  Promise.resolve(routeHandler(req, res)).catch((e) => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("handler error: " + e.message);
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
console.log(`\n[2] 面板服务已起在 ${BASE}${PORT}/apple-read/`);

const get = async (p) => {
  const r = await fetch(`${BASE}${PORT}${p}`);
  const text = await r.text();
  let j = null; try { j = JSON.parse(text); } catch { /* html */ }
  return { status: r.status, text, json: j, type: r.headers.get("content-type") || "" };
};
const post = async (p, body) => {
  const r = await fetch(`${BASE}${PORT}${p}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};

// ---------- 静态资源 ----------
console.log("\n[3] 静态资源");
const html = await get("/apple-read/");
html.status === 200 && html.type.includes("text/html") && html.text.includes("DSH-apple-Read")
  ? ok(`index.html ${html.text.length}B`) : bad("index.html", `${html.status} ${html.type}`);
const css = await get("/apple-read/style.css");
css.status === 200 && css.text.includes(".booklist") ? ok(`style.css ${css.text.length}B`) : bad("style.css", String(css.status));
const js = await get("/apple-read/app.js");
js.status === 200 && js.text.includes("/apple-read/api") ? ok(`app.js ${js.text.length}B`) : bad("app.js", String(js.status));
const trav = await get("/apple-read/../lib/index.js");
trav.status === 404 || trav.status === 403 ? ok("目录穿越被挡") : bad("目录穿越没挡住", String(trav.status));

// ---------- API ----------
console.log("\n[4] 配置与书库（会拉起 sidecar）");
const cfg = await get("/apple-read/api/config");
cfg.json?.providers?.length ? ok(`config: ${cfg.json.providers.map((p) => `${p.id}${p.hasKey ? "✓key" : "✗key"}`).join(", ")}`)
  : bad("config", JSON.stringify(cfg.json).slice(0, 200));

const t0 = Date.now();
const books = await get("/apple-read/api/books");
const bootMs = Date.now() - t0;
books.json?.books?.length
  ? ok(`books: ${books.json.books.length} 本（sidecar 冷启动 ${bootMs}ms），标注可用=${books.json.annotations_available}`)
  : bad("books", JSON.stringify(books.json).slice(0, 300));

console.log("\n[5] 标注");
const anns = await get("/apple-read/api/annotations?limit=3");
anns.json?.annotations ? ok(`annotations: ${anns.json.annotations.length} 条`) : bad("annotations", JSON.stringify(anns.json).slice(0, 200));
const annId = anns.json?.annotations?.[0]?.id;
if (annId) {
  const ctxRes = await post("/apple-read/api/context", { id: annId, before: 120, after: 120 });
  ctxRes.json?.context ? ok(`context #${annId}: 章节「${ctxRes.json.chapter}」精确=${ctxRes.json.exact} ${ctxRes.json.context.length}字`)
    : bad("context", JSON.stringify(ctxRes.json).slice(0, 200));
}

// ---------- 选一本书：不写死书名，各人书库不一样 ----------
let BOOK = (process.env.APPLE_READ_TEST_BOOK || "").trim();
if (!BOOK) {
  const bl = await get("/apple-read/api/books");
  const bs = bl.json?.books || [];
  BOOK = bs[0]?.title || bs[0]?.name || "";
}
const QUERY = (process.env.APPLE_READ_TEST_QUERY || "").trim() || "这本书讲了什么";
const QUERY2 = (process.env.APPLE_READ_TEST_QUERY2 || "").trim() || "这本书的核心观点是什么";
console.log(BOOK ? `\n测试用书：《${BOOK}》` : "\n⏭  书库里没有书（可用 APPLE_READ_TEST_BOOK 指定）");

console.log("\n[6] 向量检索（已索引的书，走预热模型）");
const t1 = Date.now();
const srch = await post("/apple-read/api/search", { book: BOOK, query: QUERY, k: 3 });
const hits = srch.json?.hits || [];
hits.length ? ok(`search: ${hits.length} 段，用时 ${Date.now() - t1}ms，top1=${hits[0].score}`) : bad("search", JSON.stringify(srch.json).slice(0, 300));
hits[0] && console.log(`      「${hits[0].chapter}」 ${hits[0].text.slice(0, 70).replace(/\n/g, " ")}…`);

console.log("\n[7] 语义召回验证（换个说法，字面检索不易命中）");
const srch2 = await post("/apple-read/api/search", { book: BOOK, query: QUERY2, k: 2 });
(srch2.json?.hits || []).length ? ok(`语义检索 top1=${srch2.json.hits[0].score} 章节「${srch2.json.hits[0].chapter}」`)
  : bad("语义检索", JSON.stringify(srch2.json).slice(0, 200));

console.log("\n[8] SSE 聊天（真实调用模型）");
// 凭证：优先 ARK_API_KEY 环境变量，其次 ~/.dsh/.credentials.yaml 里的 ARK_API_KEY
const apiKey = (process.env.ARK_API_KEY || "").trim() || (() => {
  let cred = "";
  try { cred = readFileSync(join(process.env.HOME, ".dsh/.credentials.yaml"), "utf8"); } catch { /* ignore */ }
  const km = cred.match(/^\s{2}(ARK_API_KEY):\s*(\S+)/m);
  return km ? km[2].replace(/^["']|["']$/g, "") : "";
})();
if (!apiKey) {
  console.log("  · 跳过：没找到 ARK_API_KEY（设环境变量，或写进 ~/.dsh/.credentials.yaml）");
} else {
  const r = await fetch(`${BASE}${PORT}/apple-read/api/chat`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ book: BOOK, providerId: "volc", apiKey, k: 4,
                           messages: [{ role: "user", content: "用一句话概括这段内容。" }] }),
  });
  if (!r.ok) {
    bad("chat HTTP " + r.status, (await r.text()).slice(0, 200));
  } else {
    const text = await r.text();
    const events = text.split("\n\n").filter((c) => c.startsWith("data:"));
    const kinds = {};
    let answer = "";
    let errMsg = "";
    for (const ev of events) {
      try {
        const o = JSON.parse(ev.slice(5).trim());
        kinds[o.type] = (kinds[o.type] || 0) + 1;
        if (o.type === "text") answer += o.text;
        if (o.type === "error") errMsg = o.message;
      } catch { /* ignore */ }
    }
    console.log(`      事件: ${JSON.stringify(kinds)}`);
    if (errMsg) bad("chat 上游报错", errMsg.slice(0, 250));
    else if (answer) ok(`chat 回答 ${answer.length} 字：${answer.slice(0, 90).replace(/\n/g, " ")}…`);
    else bad("chat 没有正文", text.slice(0, 250));
  }
}

// ---------- 新接口：设置 / 阅读上下文 / prepare-chat ----------
console.log("\n[9] 面板设置与原生会话接口");
const jpost = async (p, body) => {
  const r = await fetch(`${BASE}${PORT}/apple-read${p}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const jget = async (p) => {
  const r = await fetch(`${BASE}${PORT}/apple-read${p}`);
  return { status: r.status, json: await r.json().catch(() => null) };
};

registeredContext
  ? ok(`systemPrompt 上下文已注册（name=${registeredContext.name}, order=${registeredContext.order}）`)
  : bad("systemPrompt 上下文未注册");

const s0 = await jget("/api/settings");
s0.json?.settings ? ok("GET /api/settings 可用") : bad("GET /api/settings 失败", JSON.stringify(s0.json).slice(0, 120));

const s1 = await jpost("/api/settings", { k: 99, bogus: 1, withMarks: false });
s1.json?.settings?.k !== 99 ? ok("越界设置被拒绝") : bad("越界设置没拦住");
!(s1.json?.settings && Object.hasOwn(s1.json.settings, "bogus"))
  ? ok("未知设置键被丢弃") : bad("未知设置键写进去了");

const Q9 = "这本书讲了什么";
const PASSAGE = "这是一段用于测试的原文片段。";
const rc = await jpost("/api/reading-context", { sessionId: "host-test", book: BOOK, question: Q9 });
rc.json?.ok ? ok(`阅读上下文登记（${rc.json.markCount} 标注 · ${rc.json.hits} 段原文）`)
  : bad("阅读上下文登记失败", JSON.stringify(rc.json).slice(0, 150));
if (registeredContext) {
  const injected = registeredContext.text({ agent: { session: { id: "host-test" } } });
  injected.includes(BOOK) ? ok("注入文本带上了书名") : bad("注入文本没带书名");
  !injected.includes("{{") ? ok("注入文本已中和 {{（不会让提示词组装抛错）") : bad("注入文本里有裸 {{");
}

const pc = await jpost("/api/prepare-chat", { sessionId: "host-test-2", book: BOOK, question: Q9 });
pc.json?.prompt === Q9
  ? ok("prepare-chat 默认只返回用户那句话（材料走上下文快照）")
  : bad("prepare-chat prompt 不对", JSON.stringify(pc.json).slice(0, 150));

// 「在书里找」点某段问 AI：整段原文走 passage，宿主收窄作用域到这一段
const pch = await jpost("/api/prepare-chat", {
  sessionId: "host-passage", book: BOOK,
  passage: { chapter: "第一章", text: PASSAGE },
  question: "这段在讲什么？",
});
pch.json?.passage === true
  ? ok("prepare-chat 接受 passage") : bad("prepare-chat 没接受 passage", JSON.stringify(pch.json).slice(0, 150));
if (registeredContext) {
  const injP = registeredContext.text({ agent: { session: { id: "host-passage" } } });
  injP.includes(PASSAGE) && injP.includes("正在问的这段")
    ? ok("passage 原文与作用域纪律都进了注入文本") : bad("passage 没进注入文本");
}

const del = await fetch(`${BASE}${PORT}/apple-read/api/reading-context?sessionId=host-test`, { method: "DELETE" });
del.ok ? ok("DELETE /api/reading-context 可用") : bad("DELETE 失败", String(del.status));

/* -------------------------------------------------------------------------- */
/* [10] 伴读会话归拢：专用工作区目录                                            */
/* -------------------------------------------------------------------------- */
// 用户反馈「对话都堆在默认工作区里很乱」。修法是宿主提供一个专用目录、客户端把它
// 登记成 Harness 工作区。这里验宿主这一半：目录真的建出来、路径能被设置项/环境变量
// 覆盖、相对路径被拒绝（相对路径会随进程 cwd 飘，当不了工作区）。
console.log("\n[10] 伴读会话目录 /api/reading-workspace");

const rdTmp = mkdtempSync(join(tmpdir(), "ab-reading-"));
const rdWanted = join(rdTmp, "读书会话");

process.env.APPLE_READ_READING_DIR = rdWanted;
try {
  const r = await fetch(`${BASE}${PORT}/apple-read/api/reading-workspace`);
  const j = await r.json();
  j.ok === true && j.path === rdWanted
    ? ok(`reading-workspace 返回专用目录（${j.path}）`) : bad("reading-workspace 路径不对", JSON.stringify(j));
  existsSync(rdWanted) ? ok("目录已真的建出来") : bad("目录没建出来");

  // 幂等：再打一次不能抛（mkdir recursive）
  const r2 = await fetch(`${BASE}${PORT}/apple-read/api/reading-workspace`);
  const j2 = await r2.json();
  j2.ok === true && j2.path === rdWanted ? ok("重复调用幂等") : bad("重复调用失败", JSON.stringify(j2));
} catch (e) {
  bad("reading-workspace 请求抛错", e.message);
}

// 环境变量去掉后应回落到设置项 readingDir
delete process.env.APPLE_READ_READING_DIR;
const rdSetting = join(rdTmp, "从设置来的");
try {
  const put = await jpost("/api/settings", { readingDir: rdSetting });
  put.status === 200 && put.json?.settings?.readingDir === rdSetting
    ? ok("readingDir 设置项可写入") : bad("readingDir 写不进", JSON.stringify(put.json).slice(0, 150));

  const r = await fetch(`${BASE}${PORT}/apple-read/api/reading-workspace`);
  const j = await r.json();
  j.ok === true && j.path === rdSetting
    ? ok("目录跟随设置项变化") : bad("目录没跟随设置项", JSON.stringify(j));

  // 相对路径必须被拒（会随 cwd 飘，当不了工作区）
  const rel = await jpost("/api/settings", { readingDir: "relative/path" });
  rel.json?.settings?.readingDir === rdSetting
    ? ok("相对路径被拒绝（保留原值）") : bad("相对路径被写进去了", JSON.stringify(rel.json).slice(0, 150));

  // 清空 = 回到默认目录
  const clr = await jpost("/api/settings", { readingDir: "" });
  clr.json?.settings?.readingDir === ""
    ? ok("readingDir 可清空（回到默认）") : bad("readingDir 清不掉", JSON.stringify(clr.json).slice(0, 150));
} catch (e) {
  bad("readingDir 设置流程抛错", e.message);
}

// 默认目录：不能是 default-workspace（那正是要摆脱的地方）
try {
  const r = await fetch(`${BASE}${PORT}/apple-read/api/reading-workspace`);
  const j = await r.json();
  j.ok === true && /读书会话$/.test(j.path) && !/default-workspace/.test(j.path)
    ? ok(`默认目录 = ${j.path}`) : bad("默认目录不对", JSON.stringify(j));
} catch (e) {
  bad("默认目录请求抛错", e.message);
}

try { rmSync(rdTmp, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(`\n===== 通过 ${pass} · 失败 ${fail} =====`);
try { unlinkSync(STORE_TMP); } catch { /* ignore */ }
server.close();
process.exit(fail ? 1 : 0);
