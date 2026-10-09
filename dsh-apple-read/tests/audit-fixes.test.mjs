/**
 * audit-fixes.test.mjs — 2026-10 功能审计里 4 个复现缺陷的回归测试（JS 侧 3 个）。
 *
 * 为什么单独一个文件：这三条都不是「算错了」，而是**流程错位**——
 * 换书时拿旧会话登记新书、点了很旧的标注却只取最近 12 条、面板选择不落盘。
 * 单测原有的纯函数/静态检查都覆盖不到，必须把真实流程跑起来。
 *
 *   [1] 换书时 (book, sessionId) 必须配对        —— 迷你 React 驱动真组件
 *   [2] 被点击的旧标注必须进 prompt              —— 真插件 HTTP + 假 sidecar
 *   [3] 面板的 provider / 开关必须写回存档        —— 真函数 + fetch 替身
 *
 * 跑法（在 dsh-apple-read 目录）：
 *   node tests/audit-fixes.test.mjs
 */
import { createServer } from "node:http";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? " — " + d : "")); };
const assert = (c, m, d) => (c ? ok(m) : bad(m, d));

// 后面几节都要替换 globalThis.fetch；先留一份真的，
// 否则 [1] 的替身会连 [2] 里测试自己的 HTTP 请求一起吞掉。
const REAL_FETCH = globalThis.fetch;

// =========================================================================== //
// [1] 换书时阅读上下文不能串书
// =========================================================================== //
// 原缺陷：消息处理器里用闭包中的旧 `chat.sessionId` 去 POST /reading-context，
// 而新书的会话是由另一个 effect 异步开的 —— 于是「旧会话 + 新书」配对成功，
// 用户切书后提问，拿到的是上一本书的上下文。

console.log("\n[1] 换书时阅读上下文不串书（迷你 React 驱动真组件）");

const ORIGIN = "http://127.0.0.1:19387";

/* ---------- 迷你 React：真跑 useState / useEffect / useRef ---------- */
const el = (type, props, ...children) => ({ __el: true, type, props: props || {}, children: children.flat(9) });
let currentInst = null;
const REACT = {
  createElement: el,
  Fragment: Symbol("Fragment"),
  useState(init) {
    const inst = currentInst;
    const i = inst.hookIndex++;
    if (!(i in inst.hooks)) inst.hooks[i] = typeof init === "function" ? init() : init;
    return [inst.hooks[i], (v) => {
      const prev = inst.hooks[i];
      const next = typeof v === "function" ? v(prev) : v;
      if (Object.is(next, prev)) return;
      inst.hooks[i] = next;
      inst.dirty = true;
    }];
  },
  useRef(init) {
    const inst = currentInst;
    const i = inst.hookIndex++;
    if (!(i in inst.hooks)) inst.hooks[i] = { current: init };
    return inst.hooks[i];
  },
  useEffect(fn, deps) {
    const inst = currentInst;
    const i = inst.hookIndex++;
    inst.pending.push({ i, fn, deps });
  },
  useMemo: (f) => f(),
};
REACT.default = REACT;
const JSX_RUNTIME = {
  jsx: (t, p) => el(t, p, p && p.children),
  jsxs: (t, p) => el(t, p, p && p.children),
  jsxDEV: (t, p) => el(t, p, p && p.children),
  Fragment: Symbol("Fragment"),
};
const MODULES = { react: REACT, "react/jsx-runtime": JSX_RUNTIME, "react-dom": {}, "react-dom/client": {} };
const requireShim = (id) => {
  if (id in MODULES) return MODULES[id];
  if (id.startsWith("@deepseek-ai/")) return {};
  throw new Error("意外的外部依赖: " + id);
};

function renderOnce(inst) {
  inst.hookIndex = 0;
  inst.pending = [];
  currentInst = inst;
  inst.tree = inst.Comp(inst.props);
  currentInst = null;
}

function runPendingEffects(inst) {
  for (const { i, fn, deps } of inst.pending) {
    const slot = inst.effects[i];
    const prev = slot && slot.deps;
    const changed = !prev || !deps || deps.length !== prev.length
      || deps.some((d, k) => !Object.is(d, prev[k]));
    if (!changed) continue;
    if (slot && slot.cleanup) slot.cleanup();
    const cleanup = fn();
    inst.effects[i] = { deps, cleanup: typeof cleanup === "function" ? cleanup : null };
  }
}

/** 反复「渲染 → 跑 effect → 让 then 回调落地」，直到没有新的 setState。 */
async function flush(inst, rounds = 30) {
  for (let r = 0; r < rounds; r++) {
    inst.dirty = false;
    renderOnce(inst);
    runPendingEffects(inst);
    await new Promise((res) => setTimeout(res, 0));
    if (!inst.dirty) return;
  }
  throw new Error("flush 未收敛（可能 effect 里 setState 死循环）");
}

// ---------- 装载 bundle（同一个 window 替身既能收 load，也能收 message） ----------
const listeners = {};
let spec = null;
const fakeWindow = {
  __ModuleLoader__: { load: (s) => { spec = s; } },
  location: { origin: ORIGIN },
  addEventListener: (t, fn) => { (listeners[t] ||= []).push(fn); },
  removeEventListener: (t, fn) => { listeners[t] = (listeners[t] || []).filter((f) => f !== fn); },
};
const fireMessage = (data) => {
  for (const fn of listeners.message || []) fn({ origin: ORIGIN, data });
};

// 组件会 POST /reading-context；把每次调用记下来
const fetchCalls = [];
globalThis.localStorage = {
  getItem: () => null, setItem: () => {}, removeItem: () => {},
};
globalThis.fetch = async (url, init) => {
  const rec = {
    url: String(url),
    method: (init && init.method) || "GET",
    body: init && init.body ? JSON.parse(init.body) : null,
  };
  fetchCalls.push(rec);
  return { ok: true, json: async () => ({ ok: true, path: "/tmp/读书会话" }) };
};

try {
  new Function("window", readFileSync(join(ROOT, "lib", "client.js"), "utf8"))(fakeWindow);
} catch (e) {
  bad("执行 bundle 抛错：" + e.message);
  process.exit(1);
}
const mod = spec.factory(requireShim);

let mainComp = null;
const scope = {
  sessions: { async create() { return "sess-x"; }, retain: (id) => ({ sessionId: id, reference: {}, release() {} }) },
  uiSession: { bindingSource: () => ({ value: { props: {} } }) },
  uiWorkspace: { workspaces: { list: { getSnapshot: () => ({ items: [] }) } } },
};
const ctx = {
  slots: { inject(n, fn) { fn(); }, register(o, c) { if (o.name === "main") mainComp = c; } },
  layout: { selectPanel: () => {} },
  inject(deps, fn) { fn(scope); return () => {}; },
};
mod.apply(ctx);

if (!mainComp) {
  bad("没拿到 main 槽组件");
  process.exit(1);
}

// ---------- 驱动：A 书 → B 书，看登记用的 sessionId 是谁 ----------
{
  const opened = [];
  const bridge = {
    async openReadingSession(book) {
      const sessionId = "sess-" + book;          // 一本书一个固定会话，便于断言
      opened.push({ book, sessionId });
      return { sessionId, reference: { sessionId, release() {} } };
    },
    async sendPrompt() {},
  };

  const inst = { Comp: mainComp, props: { bridge }, hooks: [], effects: {}, pending: [], hookIndex: 0, dirty: false };

  await flush(inst);                             // 首屏：book 还没到，不应开会话
  assert(opened.length === 0, "书名未到达时不提前开会话");

  fireMessage({ type: "apple-read:book", book: "书A" });
  await flush(inst);
  assert(opened.length === 1 && opened[0].book === "书A", `为书A开了会话（${opened.map((o) => o.book).join(",")}）`);

  const regA = fetchCalls.filter((c) => c.url.endsWith("/reading-context"));
  assert(regA.length === 1 && regA[0].body.sessionId === "sess-书A" && regA[0].body.book === "书A",
    `书A 的上下文登记为 (sess-书A, 书A)`,
    JSON.stringify(regA.map((c) => c.body)));

  fireMessage({ type: "apple-read:book", book: "书B" });
  await flush(inst);

  const reg = fetchCalls.filter((c) => c.url.endsWith("/reading-context"));
  const cross = reg.filter((c) => c.body.book === "书B" && c.body.sessionId === "sess-书A");
  const good = reg.filter((c) => c.body.book === "书B" && c.body.sessionId === "sess-书B");

  assert(cross.length === 0, "没有把「书B」登记进书A的旧会话（原缺陷）",
    JSON.stringify(cross.map((c) => c.body)));
  assert(good.length === 1, "书B 登记进了它自己的新会话 (sess-书B, 书B)",
    JSON.stringify(reg.map((c) => c.body)));

  // 每条登记都必须自洽：(book, sessionId) 是同一本书
  const selfConsistent = reg.every((c) => c.body.sessionId === "sess-" + c.body.book);
  assert(selfConsistent, "所有登记都满足 sessionId 与 book 同源",
    JSON.stringify(reg.map((c) => c.body)));
}

globalThis.fetch = REAL_FETCH;   // [1] 的替身退场，[2] 要用真 fetch 起服务

// =========================================================================== //
// [2] 被点击的旧标注必须进 prompt
// =========================================================================== //
// 原缺陷：材料只取「最近 12 条」再在 12 条里重排 focusAnnotationId。
// 用户点的那条若更旧，它的原文根本不在材料里 —— 模型不知道用户在问哪一句。

console.log("\n[2] 被点击的旧标注必须进 prompt（真插件 + 假 sidecar）");

const SIDECAR_TMP = join(tmpdir(), `apple-read-audit-sidecar-${process.pid}.json`);
const STORE_TMP = join(tmpdir(), `apple-read-audit-store-${process.pid}.json`);
process.env.APPLE_READ_SIDECAR = SIDECAR_TMP;
process.env.APPLE_READ_STORE = STORE_TMP;

const OLD_TEXT = "很久以前划的那句关键原文-ZZZ-OLD";
const OLD_CTX = "前后原文-ZZZ-CTX";
const OLD_ID = 999;

// 「最近 12 条」里**没有** OLD_ID —— 这正是原缺陷的触发条件
const RECENT = Array.from({ length: 12 }, (_, i) => ({
  id: 100 + i, book: "测试书", text: `近期标注-${i}`, note: "",
  chapter: `第${i}章`, context: `近期上下文-${i}`, exact: true,
}));

const sidecarCalls = [];
const sidecar = createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const url = new URL(req.url, "http://127.0.0.1");
    sidecarCalls.push({ method: req.method, path: url.pathname, query: url.search, body: raw });
    const send = (obj) => {
      const b = Buffer.from(JSON.stringify(obj));
      res.writeHead(200, { "content-type": "application/json", "content-length": String(b.length) });
      res.end(b);
    };
    if (url.pathname === "/health") return send({ ok: true });
    if (url.pathname === "/annotations") return send({ annotations: RECENT });
    if (url.pathname === "/search") return send({ hits: [], reranked: false });
    if (url.pathname === "/context") {
      const id = Number(JSON.parse(raw || "{}").id);
      if (id !== OLD_ID) return send({ error: `找不到 id=${id} 的标注` });
      return send({
        annotation: { id: OLD_ID, book: "测试书", text: OLD_TEXT, note: "我当时的想法-NOTE", chapter: "第三章" },
        book: "测试书", chapter: "第三章", offset: 42, context: OLD_CTX, exact: true,
      });
    }
    res.writeHead(404); res.end("{}");
  });
});
await new Promise((r) => sidecar.listen(0, "127.0.0.1", r));
const sidecarPort = sidecar.address().port;
// pid 用本进程：sidecarHealthy 只探 /health，不看 pid 是否活着
writeFileSync(SIDECAR_TMP, JSON.stringify({ pid: process.pid, port: sidecarPort }));

// 假 ctx 装载真插件
let routeHandler = null;
const webCtx = { webServer: { register(o) { routeHandler = o.handler; return () => {}; } }, effect(fn) { return fn(); } };
const promptCtx = { systemPrompt: { context() { return () => {}; } }, effect(fn) { return fn(); } };
const pluginCtx = {
  logger: { warn() {}, info() {} },
  effect(fn) { return fn(); },
  skills: { registerProvider() {} },
  inject(deps, fn) {
    if (deps.includes("webServer")) fn(webCtx);
    if (deps.includes("systemPrompt")) fn(promptCtx);
  },
};
const { apply } = await import("../lib/index.js");
apply(pluginCtx);

const host = createServer((req, res) => {
  Promise.resolve(routeHandler(req, res)).catch((e) => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("handler error: " + e.message);
  });
});
await new Promise((r) => host.listen(0, "127.0.0.1", r));
const hostPort = host.address().port;

const post = async (p, body) => {
  const r = await REAL_FETCH(`http://127.0.0.1:${hostPort}/apple-read/api${p}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const get = async (p) => {
  const r = await REAL_FETCH(`http://127.0.0.1:${hostPort}/apple-read/api${p}`);
  return { status: r.status, json: await r.json().catch(() => null) };
};
/** 取回登记给某个会话的阅读上下文正文（客户端拿到的就是这段）。 */
const registeredText = async (sessionId) => {
  const r = await get(`/reading-context?sessionId=${encodeURIComponent(sessionId)}`);
  return (r.json && r.json.entry && r.json.entry.text) || "";
};

{
  const r = await post("/prepare-chat", {
    book: "测试书", sessionId: "sess-audit", annotationId: OLD_ID,
    question: "我划的这句是什么意思？",
  });
  // 默认走「上下文快照」：材料登记进 session，不塞进输入框。按客户端的方式读回来。
  const text = await registeredText("sess-audit");

  assert(r.status === 200 && r.json && r.json.ok === true, `prepare-chat 成功（HTTP ${r.status}）`);
  assert(text.includes(OLD_TEXT), "旧标注的原文进了上下文（原缺陷：最近 12 条里没有它）",
    text.slice(0, 300));
  assert(text.includes("【用户正在问的那条标注】"), "旧标注被标成锚点");
  assert(text.includes("前后原文-ZZZ-CTX"), "锚点带上了前后原文");
  assert(r.json.focused === true, `响应标记 focused=true（实际 ${r.json.focused}）`);

  // 独立取锚点的证据：确实 POST 了 /context，而不是靠 /annotations 的 12 条
  const ctxCalls = sidecarCalls.filter((c) => c.path === "/context" && c.method === "POST");
  assert(ctxCalls.length === 1 && JSON.parse(ctxCalls[0].body).id === OLD_ID,
    "确实按 id 单独请求了 /context",
    JSON.stringify(ctxCalls.map((c) => c.body)));

  // 背景列表照常，但锚点不应重复出现（避免同一句进 prompt 两次）
  const occurrences = text.split(OLD_TEXT).length - 1;
  assert(occurrences === 1, `锚点原文只出现 1 次（实际 ${occurrences}）`);

  // 默认问法（没点标注）时不应去取 /context
  sidecarCalls.length = 0;
  await post("/prepare-chat", { book: "测试书", sessionId: "sess-plain", question: "这本书讲了什么？" });
  assert(sidecarCalls.every((c) => c.path !== "/context"), "没点标注时不请求 /context");
  const plainText = await registeredText("sess-plain");
  assert(plainText.includes("【用户自己划的重点】"), "没点标注时仍带上最近的重点作背景");
  assert(!plainText.includes("【用户正在问的那条标注】"), "没点标注时不出现锚点段");
}

{
  // 取不到那条标注时必须明确提示，而不是静默当成「没有重点」
  const r = await post("/prepare-chat", {
    book: "测试书", sessionId: "sess-miss", annotationId: 424242, question: "这句什么意思？",
  });
  assert(r.status === 200 && r.json.focusError, `取不到标注时返回 focusError（${r.json && r.json.focusError}）`);
  assert(!r.json.focused, "取不到时 focused=false");
  const text = await registeredText("sess-miss");
  assert(text.includes("没能取到"), "上下文里如实说明取不到，而不是假装有");
}

{
  // 跨书防护：面板传的 id 属于另一本书
  const r = await post("/prepare-chat", {
    book: "另一本书", sessionId: "sess-cross", annotationId: OLD_ID, question: "这句什么意思？",
  });
  assert(r.json.focusError && /不在/.test(r.json.focusError),
    `跨书标注被拒并说明（${r.json && r.json.focusError}）`);
}

// =========================================================================== //
// [3] 面板的 provider / 开关必须写回存档
// =========================================================================== //
// 原缺陷：boot() 无条件用 config.defaultProviderId，change 只改内存 state，
// 刷新页面选择就丢 —— 用户看到的是「选了不保存」。

console.log("\n[3] 面板设置持久化（真 app.js + fetch 替身）");

const panelSrc = readFileSync(join(ROOT, "assets", "panel", "app.js"), "utf8");

// app.js 是「挂 DOM 就跑」的脚本，用替身环境把它整体加载进来
function loadPanel(initialSettings = {}) {
  const saved = [];
  const handlers = {};
  const nodes = new Map();
  const makeNode = (id) => ({
    id, value: "", checked: false, disabled: false, textContent: "", innerHTML: "",
    title: "", dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    addEventListener(type, fn) { (handlers[id + ":" + type] ||= []).push(fn); },
    appendChild() {}, insertBefore() {}, remove() {}, focus() {},
    querySelector: () => null, querySelectorAll: () => [],
    parentNode: { insertBefore() {} }, scrollHeight: 0,
  });
  const $ = (sel) => {
    const id = sel.replace(/^#/, "");
    if (!nodes.has(id)) nodes.set(id, makeNode(id));
    return nodes.get(id);
  };
  const document = {
    querySelector: $,
    querySelectorAll: () => [],
    createElement: () => makeNode("created"),
    body: { dataset: {}, classList: { add() {}, remove() {}, toggle() {} } },
    addEventListener() {},
  };

  let settings = {
    providerId: "", withMarks: true, rerank: true, k: 6, systemPrompt: "", readingDir: "",
    ...initialSettings,
  };
  const fetchStub = async (url, init) => {
    const u = String(url);
    const json = (obj) => ({ ok: true, json: async () => obj, text: async () => JSON.stringify(obj) });
    if (u.endsWith("/config")) {
      return json({
        providers: [
          { id: "volc", displayName: "火山", hasKey: true },
          { id: "deepseek", displayName: "DeepSeek", hasKey: true },
        ],
        defaultProviderId: "volc", rerank: true, rerankModel: "BAAI/bge-reranker-base",
      });
    }
    if (u.endsWith("/settings")) {
      if ((init && init.method) === "POST") {
        const patch = JSON.parse(init.body);
        saved.push(patch);
        settings = { ...settings, ...patch };
        return json({ ok: true, settings, applied: Object.keys(patch) });
      }
      return json({ settings, defaults: {}, providers: [] });
    }
    if (u.endsWith("/books")) return json({ books: [], annotations_available: true });
    if (u.includes("/annotations")) return json({ annotations: [] });
    return json({ ok: true });
  };

  globalThis.window = {
    location: { origin: "http://127.0.0.1:19387" },
    addEventListener() {}, parent: { postMessage() {} },
  };
  globalThis.document = document;
  globalThis.fetch = fetchStub;
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

  new Function("window", "document", "fetch", "localStorage", "setTimeout", "clearTimeout",
    panelSrc + "\n//# sourceURL=panel-app.js")(globalThis.window, document, fetchStub, globalThis.localStorage, setTimeout, clearTimeout);

  return { saved, handlers, nodes, $, getSettings: () => settings };
}

const settle = () => new Promise((r) => setTimeout(r, 40));

{
  // 存档里存的是 deepseek → 面板必须显示 deepseek，而不是 config 的默认 volc
  const p = loadPanel({ providerId: "deepseek" });
  await settle();
  const shown = p.$("#provider").value;
  assert(shown === "deepseek", `按存档回填 provider（期望 deepseek，实际 ${shown}）`);

  // 改选 → 必须写回存档
  const onChange = (p.handlers["provider:change"] || [])[0];
  assert(typeof onChange === "function", "provider 有 change 处理器");
  onChange({ target: { value: "volc" } });
  await settle();
  assert(p.saved.some((s) => s.providerId === "volc"),
    `provider 变更写回了存档（${JSON.stringify(p.saved)}）`);

  // 两个开关同样要落盘
  const mk = (p.handlers["withMarks:change"] || [])[0];
  const rr = (p.handlers["withRerank:change"] || [])[0];
  assert(typeof mk === "function" && typeof rr === "function", "两个开关都有 change 处理器");
  mk({ target: { checked: false } });
  rr({ target: { checked: false } });
  await settle();
  assert(p.saved.some((s) => s.withMarks === false), `withMarks 写回存档（${JSON.stringify(p.saved)}）`);
  assert(p.saved.some((s) => s.rerank === false), `rerank 写回存档（${JSON.stringify(p.saved)}）`);
}

{
  // 存档里 providerId 为空（首次使用）→ 回退 config 默认值 volc
  const p = loadPanel({ providerId: "" });
  await settle();
  assert(p.$("#provider").value === "volc", `存档为空时回退 config 默认（实际 ${p.$("#provider").value}）`);
}

{
  // 存档里是个已经不存在的 provider（插件换过 provider 列表）→ 同样回退默认，
  // 否则 <select> 会停在空值，看起来像「没选」
  const p = loadPanel({ providerId: "已经删掉的-provider" });
  await settle();
  assert(p.$("#provider").value === "volc",
    `存档里的 provider 不合法时回退默认（实际 ${p.$("#provider").value}）`);
}

{
  // 存档里的开关要回填到控件上（否则刷新后 UI 与真实行为不一致）
  const p = loadPanel({ withMarks: false, rerank: false });
  await settle();
  assert(p.$("#withMarks").checked === false, "withMarks=false 回填到控件");
  assert(p.$("#withRerank").checked === false, "rerank=false 回填到控件");
}

// ---------- 收尾 ----------
sidecar.close();
host.close();
for (const f of [SIDECAR_TMP, STORE_TMP]) { try { unlinkSync(f); } catch { /* ignore */ } }

console.log(`\n===== 通过 ${pass} · 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
