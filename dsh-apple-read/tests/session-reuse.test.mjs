/**
 * session-reuse.test.mjs — 「伴读会话开在哪个工作区」+「一本书一个会话」。
 *
 * 为什么单独测这两件事：
 *   1. 以前客户端写死优先 `default-workspace`，每开一次面板就在「默认工作区」里新建
 *      一个会话，用户的实际反馈是「都放到默认里面很乱」。所以工作区的三级解析
 *      （专用目录 → 建出来 → 退回默认）必须有回归保护。
 *   2. 会话要按「工作区 + 书名」复用，不能每次开面板都 create。复用的键写错、
 *      或者 forceNew 没生效，都会静默地把会话列表搞乱——这种 bug 很难靠肉眼发现。
 *
 * 这些接口（sessions / uiSession / uiWorkspace）都是 Harness 未文档化的内部接口，
 * 所以这里全部用假实现，只验协议与分支，不碰真 Harness。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "..", "lib", "client.js");

let pass = 0;
let fail = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m) => { fail++; console.log("  ✗ " + m); };
const assert = (c, m) => (c ? ok(m) : bad(m));

/* ---------- React / JSX 运行时替身（bundle 是 CJS + external react） ---------- */
const el = (type, props, ...children) => ({
  __el: true, type, props: props || {}, children: children.flat(9),
});
const REACT = {
  createElement: el,
  Fragment: Symbol("Fragment"),
  useState: (v) => [typeof v === "function" ? v() : v, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
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

/* ---------- 浏览器替身：localStorage + fetch ---------- */
function makeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    __map: map,
  };
}

/** fetch 替身：只认 /apple-read/api/reading-workspace，其余返回 404。 */
function makeFetch(reply) {
  const calls = [];
  const fn = async (url) => {
    calls.push(String(url));
    if (String(url).endsWith("/reading-workspace")) {
      const r = typeof reply === "function" ? reply() : reply;
      if (r instanceof Error) throw r;
      return { ok: true, json: async () => r };
    }
    return { ok: false, status: 404, json: async () => ({ ok: false }) };
  };
  fn.calls = calls;
  return fn;
}

const READING_DIR = "/Users/example/Documents/deepseek-harness/读书会话";

/* ---------- 装载 bundle ---------- */
console.log("\n[1] 装载 lib/client.js");
let spec = null;
const fakeWindow = { __ModuleLoader__: { load: (s) => { spec = s; } } };
try {
  new Function("window", readFileSync(BUNDLE, "utf8"))(fakeWindow);
} catch (e) {
  bad("执行 bundle 抛错：" + e.message);
  process.exit(1);
}
let mod = null;
try {
  mod = spec.factory(requireShim);
  ok("factory 物化成功");
} catch (e) {
  bad("factory 抛错：" + e.message);
  process.exit(1);
}

/**
 * 造一个完整的 ctx + scope，拿到 bridge。
 *
 * `opts.workspaces` 是初始工作区列表；`opts.fetchReply` 控制宿主接口的回复；
 * `opts.deadSessions` 里的 sessionId 在 retain 时会抛（模拟「会话已被删」）。
 */
function mount(opts = {}) {
  const storage = makeStorage();
  globalThis.localStorage = storage;
  const fetchMock = makeFetch(
    opts.fetchReply !== undefined ? opts.fetchReply : { ok: true, path: READING_DIR }
  );
  globalThis.fetch = fetchMock;

  const workspaces = opts.workspaces || [];
  const created = [];
  const createdSessions = [];
  const retained = [];
  const released = [];
  let sessionSeq = 0;

  const list = {
    getSnapshot: () => ({ items: workspaces }),
    subscribe: () => () => {},
  };

  const ctl = {
    list,
    create: opts.createWorkspace === null
      ? undefined
      : async ({ path }) => {
          created.push(path);
          if (opts.createThrows) throw new Error("create 失败");
          const w = { workspaceId: "ws-new-" + created.length, title: path.split("/").pop(), path };
          workspaces.push(w); // 建完列表里就有了，模拟真实 store 的 upsert
          // 真实实现返回 Remote 结果 { ok, value: { workspace } }。
          // 用 createShape 覆盖成别的形状，验客户端两种都认。
          if (opts.createShape === "direct") return { workspace: w };
          if (opts.createShape === "opaque") return { ok: true, value: {} };
          return { ok: true, value: { workspace: w } };
        },
  };

  const dead = new Set(opts.deadSessions || []);
  const scope = {
    sessions: {
      async create({ workspaceId }) {
        createdSessions.push(workspaceId);
        return "sess-" + (++sessionSeq);
      },
      retain(sessionId, o) {
        if (dead.has(sessionId)) throw new Error("no such session");
        retained.push({ sessionId, o });
        return { sessionId, __ref: true, release: () => released.push(sessionId) };
      },
    },
    uiSession: {
      bindingSource(reference) {
        if (opts.noInputActions) return { value: { props: {} } };
        return {
          value: {
            props: { inputActions: { setDraft() {}, submit() {} } },
            hooks: { input: { getSnapshot: () => ({ phase: "plain", draft: "" }) } },
          },
        };
      },
    },
    uiWorkspace: { workspaces: ctl },
  };

  const regs = [];
  const ctx = {
    slots: {
      inject(name, fn) { fn(); },
      register(opts2, comp) { regs.push({ opts: opts2, comp }); },
    },
    layout: { selectPanel: () => {} },
    inject(deps, fn) { fn(scope); return () => {}; },
  };

  mod.apply(ctx);
  const main = regs.find((r) => r.opts.name === "main");
  return {
    bridge: main.opts.inject().bridge,
    storage, fetchMock, workspaces, created, createdSessions, retained, released, scope,
  };
}

/* ---------- 工作区解析 ---------- */
console.log("\n[2] 工作区解析：优先专用目录");

// 2.1 专用目录已经有对应工作区 → 直接用，不新建
{
  const m = mount({
    workspaces: [
      { workspaceId: "ws-default", title: "default-workspace", path: "/Users/example/Documents/deepseek-harness/default-workspace" },
      { workspaceId: "ws-read", title: "读书会话", path: READING_DIR },
    ],
  });
  await m.bridge.openReadingSession("人类简史");
  assert(m.createdSessions[0] === "ws-read", `会话开在专用工作区（实际 ${m.createdSessions[0]}）`);
  assert(m.created.length === 0, "已有工作区时不再新建");
}

// 2.2 专用目录没有对应工作区 → 用 workspaces.create({path}) 建出来
{
  const m = mount({
    workspaces: [
      { workspaceId: "ws-default", title: "default-workspace", path: "/Users/example/Documents/deepseek-harness/default-workspace" },
    ],
  });
  await m.bridge.openReadingSession("人类简史");
  assert(m.created.length === 1 && m.created[0] === READING_DIR, `按路径新建工作区（${m.created[0]}）`);
  assert(m.createdSessions[0] === "ws-new-1", `会话开在新建的工作区（实际 ${m.createdSessions[0]}）`);
}

// 2.3 宿主接口挂了（旧版本还没重启）→ 从 default-workspace 的父目录推导兄弟目录，
//     目录存在就能被 create 采纳
{
  const m = mount({
    fetchReply: () => new Error("boom"),
    workspaces: [
      { workspaceId: "ws-other", title: "别的项目", path: "/tmp/other" },
      { workspaceId: "ws-default", title: "default-workspace", path: "/Users/example/Documents/deepseek-harness/default-workspace" },
    ],
  });
  await m.bridge.openReadingSession("人类简史");
  assert(m.created.length === 1 && m.created[0] === READING_DIR,
    `宿主挂了时推导兄弟目录并新建（${m.created[0]}）`);
  assert(m.createdSessions[0] === "ws-new-1", `会话开在推导出的工作区（实际 ${m.createdSessions[0]}）`);
}

// 2.3b 宿主挂了、又没有 default-workspace 可以推导 → 退回列表第一个
{
  const m = mount({
    fetchReply: () => new Error("boom"),
    workspaces: [
      { workspaceId: "ws-other", title: "别的项目", path: "/tmp/other" },
      { workspaceId: "ws-second", title: "第二个", path: "/tmp/second" },
    ],
  });
  await m.bridge.openReadingSession("人类简史");
  assert(m.created.length === 0, "推导不出来时不硬建");
  assert(m.createdSessions[0] === "ws-other", `退回列表第一个（实际 ${m.createdSessions[0]}）`);
}

// 2.4 宿主说建不出目录（ok:false，比如没权限）→ 目录不存在，create 也会失败
//     → 退回 default-workspace，不硬来
{
  const m = mount({
    fetchReply: { ok: false, path: READING_DIR, error: "权限不足" },
    createThrows: true, // 目录建不出来时 create 必然失败（create 只采纳已存在的路径）
    workspaces: [
      { workspaceId: "ws-default", title: "default-workspace", path: "/Users/example/Documents/deepseek-harness/default-workspace" },
    ],
  });
  await m.bridge.openReadingSession("人类简史");
  assert(m.createdSessions[0] === "ws-default", `目录建不出来时退回 default-workspace（实际 ${m.createdSessions[0]}）`);
}

// 2.5 老版本 Harness 没有 workspaces.create → 退回 default-workspace，不抛
{
  const m = mount({
    createWorkspace: null,
    workspaces: [
      { workspaceId: "ws-default", title: "default-workspace", path: "/Users/example/Documents/deepseek-harness/default-workspace" },
    ],
  });
  await m.bridge.openReadingSession("人类简史");
  assert(m.createdSessions[0] === "ws-default", `没有 create 接口时退回 default（实际 ${m.createdSessions[0]}）`);
}

// 2.6 workspaces.create 抛错 → 不冒泡，退回 default-workspace
{
  const m = mount({
    createThrows: true,
    workspaces: [
      { workspaceId: "ws-default", title: "default-workspace", path: "/Users/example/Documents/deepseek-harness/default-workspace" },
    ],
  });
  let threw = null;
  try { await m.bridge.openReadingSession("人类简史"); } catch (e) { threw = e; }
  assert(threw === null, "create 抛错时不冒泡");
  assert(m.createdSessions[0] === "ws-default", `create 抛错时退回 default（实际 ${m.createdSessions[0]}）`);
}

// 2.7 一个工作区都没有 → 正好该把专用工作区建出来（这是最该走通的路径）
{
  const m = mount({ workspaces: [] });
  await m.bridge.openReadingSession("人类简史");
  assert(m.created.length === 1, `空列表时新建专用工作区（实际 ${m.created.length}）`);
  assert(m.createdSessions[0] === "ws-new-1", `会话开在新建的工作区（实际 ${m.createdSessions[0]}）`);
}

// 2.7b 返回 Remote 结果 { ok, value: { workspace } }（真实形状）也要认出来
{
  const m = mount({ workspaces: [], createShape: "remote" });
  await m.bridge.openReadingSession("人类简史");
  assert(m.createdSessions[0] === "ws-new-1", `认 Remote 结果形状（实际 ${m.createdSessions[0]}）`);
}

// 2.7c 返回 { workspace }（另一种形状）也要认出来
{
  const m = mount({ workspaces: [], createShape: "direct" });
  await m.bridge.openReadingSession("人类简史");
  assert(m.createdSessions[0] === "ws-new-1", `认直接形状（实际 ${m.createdSessions[0]}）`);
}

// 2.7d 返回里什么都没有 → 回列表按 path 找（create 内部会 upsert）
{
  const m = mount({ workspaces: [], createShape: "opaque" });
  await m.bridge.openReadingSession("人类简史");
  assert(m.createdSessions[0] === "ws-new-1", `认不出来时回列表找（实际 ${m.createdSessions[0]}）`);
}

// 2.8 既没有工作区、也没有 create 接口 → 报一句人话，不抛奇怪错误
{
  const m = mount({ workspaces: [], createWorkspace: null });
  let msg = "";
  try { await m.bridge.openReadingSession("人类简史"); } catch (e) { msg = String(e.message || e); }
  assert(/选择一个工作区/.test(msg), `没有工作区时给人话（实际「${msg}」）`);
}

console.log("\n[3] 会话复用：一本书一个会话");

// 3.1 同一本书开两次 → 第二次复用，不再 create
{
  const m = mount({
    workspaces: [{ workspaceId: "ws-read", title: "读书会话", path: READING_DIR }],
  });
  const a = await m.bridge.openReadingSession("人类简史");
  const b = await m.bridge.openReadingSession("人类简史");
  assert(m.createdSessions.length === 1, `只 create 了一次（实际 ${m.createdSessions.length}）`);
  assert(a.sessionId === b.sessionId, `复用同一个会话（${a.sessionId}）`);
  assert(m.retained.length === 2, "两次都 retain（引用计数各自持有）");
}

// 3.2 换一本书 → 另开一个会话
{
  const m = mount({
    workspaces: [{ workspaceId: "ws-read", title: "读书会话", path: READING_DIR }],
  });
  const a = await m.bridge.openReadingSession("人类简史");
  const b = await m.bridge.openReadingSession("另一本书");
  assert(a.sessionId !== b.sessionId, "换书换会话");
  assert(m.createdSessions.length === 2, `两本书两个会话（实际 ${m.createdSessions.length}）`);
}

// 3.3 复用键带工作区：换工作区不该串会话
{
  const m = mount({
    workspaces: [
      { workspaceId: "ws-read", title: "读书会话", path: READING_DIR },
    ],
  });
  await m.bridge.openReadingSession("人类简史");
  const keys = [...m.storage.__map.keys()];
  assert(
    keys.length === 1 && keys[0].startsWith("apple-read.chat.ws-read."),
    `复用键含工作区与书名（${keys[0]}）`
  );
}

// 3.4 forceNew → 丢掉旧会话，另开一个
{
  const m = mount({
    workspaces: [{ workspaceId: "ws-read", title: "读书会话", path: READING_DIR }],
  });
  const a = await m.bridge.openReadingSession("人类简史");
  const b = await m.bridge.openReadingSession("人类简史", true);
  assert(a.sessionId !== b.sessionId, `forceNew 换新会话（${a.sessionId} → ${b.sessionId}）`);
  assert(m.createdSessions.length === 2, `forceNew 会 create（实际 ${m.createdSessions.length}）`);
  const keys = [...m.storage.__map.keys()];
  assert(m.storage.getItem(keys[0]) === b.sessionId, "forceNew 后存的是新会话 id");
}

// 3.5 存的会话已经没了 → 清掉记录、新建，不抛
{
  const m = mount({
    workspaces: [{ workspaceId: "ws-read", title: "读书会话", path: READING_DIR }],
  });
  await m.bridge.openReadingSession("人类简史");
  const key = [...m.storage.__map.keys()][0];
  // 让这个已存的 id 变成「死会话」
  const deadId = m.storage.getItem(key);
  m.scope.sessions.retain = ((orig) => (sessionId, o) => {
    if (sessionId === deadId) throw new Error("no such session");
    return orig(sessionId, o);
  })(m.scope.sessions.retain);
  const again = await m.bridge.openReadingSession("人类简史");
  assert(again.sessionId !== deadId, `死会话不复用，另开一个（${again.sessionId}）`);
  assert(m.storage.getItem(key) === again.sessionId, "死会话记录被换成新会话");
}

// 3.6 输入框接口缺失 → 释放引用并报错（不能泄漏 session 作用域）
{
  const m = mount({
    noInputActions: true,
    workspaces: [{ workspaceId: "ws-read", title: "读书会话", path: READING_DIR }],
  });
  let msg = "";
  try { await m.bridge.openReadingSession("人类简史"); } catch (e) { msg = String(e.message || e); }
  assert(/不支持原生伴读/.test(msg), `缺输入框接口时给人话（实际「${msg}」）`);
  assert(m.released.length === 1, `失败时释放了引用（实际 ${m.released.length}）`);
}

// 3.7 兜底会话改挂：书名还没到时先开了会话，书名一到必须复用那一个，不能另建
//     （否则每次打开面板都会多一个孤儿会话 —— 那正是要消灭的「乱」）
{
  const m = mount({
    workspaces: [{ workspaceId: "ws-read", title: "读书会话", path: READING_DIR }],
  });
  // 模拟 iframe 还没报书名：book = ""
  const fallback = await m.bridge.openReadingSession("");
  assert(m.createdSessions.length === 1, "书名未知时先开一个兜底会话");
  const fallbackKey = [...m.storage.__map.keys()][0];
  assert(fallbackKey.endsWith("."), `兜底键以 . 结尾（${fallbackKey}）`);

  // 书名到了
  const real = await m.bridge.openReadingSession("人类简史");
  assert(real.sessionId === fallback.sessionId, `改挂到同一会话（${fallback.sessionId}）`);
  assert(m.createdSessions.length === 1, `没有多建会话（实际 ${m.createdSessions.length}）`);

  const keys = [...m.storage.__map.keys()];
  assert(keys.length === 1 && keys[0] === "apple-read.chat.ws-read.人类简史",
    `兜底键被换成书名键（${keys.join(", ")}）`);
  assert(m.storage.getItem(keys[0]) === fallback.sessionId, "新键指向同一个会话");
}

// 3.8 已经有这本书的会话时，不能被兜底键抢走
{
  const m = mount({
    workspaces: [{ workspaceId: "ws-read", title: "读书会话", path: READING_DIR }],
  });
  const first = await m.bridge.openReadingSession("人类简史");
  const fallback = await m.bridge.openReadingSession("");
  const again = await m.bridge.openReadingSession("人类简史");
  assert(again.sessionId === first.sessionId, `仍复用这本书原有的会话（${first.sessionId}）`);
  assert(fallback.sessionId !== first.sessionId, "兜底会话是另一个");
}

// 3.9 forceNew 之后不应把兜底会话又捞回来
{
  const m = mount({
    workspaces: [{ workspaceId: "ws-read", title: "读书会话", path: READING_DIR }],
  });
  await m.bridge.openReadingSession("");
  const fresh = await m.bridge.openReadingSession("人类简史", true);
  assert(m.createdSessions.length === 2, `forceNew 确实新建了（实际 ${m.createdSessions.length}）`);
  assert(fresh.sessionId !== "sess-1", `forceNew 不用兜底会话（${fresh.sessionId}）`);
}

console.log(`\n===== 通过 ${pass} · 失败 ${fail} =====`);
process.exit(fail === 0 ? 0 : 1);
