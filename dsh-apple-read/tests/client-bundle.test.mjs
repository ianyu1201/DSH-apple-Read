/**
 * 客户端产物测试：不需要真的 react，用内联 stub 把 lib/client.js 真跑一遍。
 *
 * 验的是「产物能不能用」而不是「构建成不成功」：
 *   · factory 形态正确（window.__ModuleLoader__.load + id）
 *   · apply(ctx) 注册了两个槽位，参数对不对
 *   · 组件函数真能被调用、返回的元素树结构对（iframe 指向 /apple-read/）
 *   · 「返回对话」按钮的 onClick 接的是 layout.selectPanel(null)
 *   · 根样式没有 position:absolute（这个坑会让面板盖住整个窗口）
 *
 * 跑法：node tests/client-bundle.test.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUNDLE = join(HERE, "..", "lib", "client.js");

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? " — " + d : "")); };
const assert = (cond, m, d) => (cond ? ok(m) : bad(m, d));

// ---------- 内联 stub react ----------
const el = (type, props, ...children) => ({ __el: true, type, props: props || {}, children: children.flat(9) });
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
  jsx: (type, props) => el(type, props, props && props.children),
  jsxs: (type, props) => el(type, props, props && props.children),
  jsxDEV: (type, props) => el(type, props, props && props.children),
  Fragment: Symbol("Fragment"),
};

const MODULES = { react: REACT, "react/jsx-runtime": JSX_RUNTIME, "react-dom": {}, "react-dom/client": {} };
const requireShim = (id) => {
  if (id in MODULES) return MODULES[id];
  if (id.startsWith("@deepseek-ai/")) return {};
  throw new Error("意外的外部依赖: " + id);
};

// ---------- 装载 bundle ----------
console.log("\n[1] 装载 lib/client.js");
let spec = null;
const fakeWindow = { __ModuleLoader__: { load: (s) => { spec = s; } } };
try {
  // eslint-disable-next-line no-new-func
  new Function("window", readFileSync(BUNDLE, "utf8"))(fakeWindow);
  assert(!!spec, "调用到了 window.__ModuleLoader__.load");
} catch (e) {
  bad("执行 bundle 抛错", e.message);
  process.exit(1);
}
assert(spec && spec.id === "dsh-apple-read", `id = ${spec && spec.id}`);
assert(typeof spec.factory === "function", "factory 是函数");

let mod = null;
try {
  mod = spec.factory(requireShim);
  ok("factory 物化成功");
} catch (e) {
  bad("factory 抛错", e.message);
  process.exit(1);
}
assert(typeof mod.apply === "function", "导出 apply()");
assert(Array.isArray(mod.inject), `导出 inject = [${mod.inject}]`);
assert(mod.inject.includes("slots") && mod.inject.includes("layout"), "inject 含 slots + layout");

// ---------- 调用 apply ----------
console.log("\n[2] apply(ctx) 注册槽位");
const regs = [];
const ctx = {
  slots: {
    inject(name, fn) { assert(typeof name === "string", `slots.inject("${name}")`); fn(); },
    register(opts, comp) { regs.push({ opts, comp }); },
  },
  layout: { selectPanel: (v) => { ctx.__panel = v; } },
  // 客户端服务（sessions/uiSession/uiWorkspace）在测试里不提供。桥接层必须容错：
  // 服务没就绪时不回调，也不能让 apply() 抛错（否则整个面板都加载不出来）。
  inject(deps, _fn) { ctx.__injected = deps; },
};
try {
  mod.apply(ctx);
  ok("apply() 未抛错");
} catch (e) {
  bad("apply() 抛错", e.message);
  process.exit(1);
}
assert(regs.length === 3, `注册了 3 个槽位（实际 ${regs.length}）`);

const side = regs.find((r) => r.opts.name === "sidebar.panellist");
const main = regs.find((r) => r.opts.name === "main");
assert(!!side, "侧边栏槽位 sidebar.panellist");
assert(!!main, "主区域槽位 main");
if (side) {
  assert(side.opts.id === "apple-read", `侧边栏 id = ${side.opts.id}`);
  assert(side.opts.label === "图书", `侧边栏 label = ${side.opts.label}`);
  assert(Number.isFinite(side.opts.order), `侧边栏 order = ${side.opts.order}`);
  assert(typeof side.comp === "function", "侧边栏有图标组件");
  try { side.comp(); ok("图标组件可渲染"); } catch (e) { bad("图标组件抛错", e.message); }
}
if (main) {
  assert(main.opts.key === "apple-read", `主面板 key = ${main.opts.key}`);
  assert(typeof main.opts.inject === "function", "主面板有 inject()");

  // 原生会话靠「父条目声明 session 作用域子槽」挂进来。
  // 没声明的话 register 会在加载时直接抛错——这是最容易漏的一步。
  const declared = main.opts.children && main.opts.children["apple-read.chat"];
  assert(!!declared, "父条目声明了子槽 apple-read.chat");
  if (declared) {
    assert(declared.kind === "single", `子槽 kind = ${declared.kind}`);
    assert(declared.scope === "session", `子槽 scope = ${declared.scope}（原生会话必须绑在 session 作用域）`);
  }
}

const chat = regs.find((r) => r.opts.name === "apple-read.chat");
assert(!!chat, "原生会话子槽 apple-read.chat 已注册");
assert(!!(ctx.__injected && ctx.__injected.includes("sessions")), "惰性注入了 sessions 服务（不写进模块级 inject，避免卡住加载）");

// ---------- 渲染主面板 ----------
console.log("\n[3] 渲染主面板组件");
if (main) {
  let props = null;
  try { props = main.opts.inject(); ok("inject() 返回 " + JSON.stringify(Object.keys(props))); }
  catch (e) { bad("inject() 抛错", e.message); }

  let tree = null;
  try { tree = main.comp(props); ok("组件渲染未抛错"); }
  catch (e) { bad("组件渲染抛错", e.message); }

  if (tree) {
    // 根样式检查
    const rootStyle = tree.props.style || {};
    assert(rootStyle.position !== "absolute",
      "根样式没有 position:absolute（这个坑会盖住整个窗口）",
      JSON.stringify(rootStyle.position));
    assert(rootStyle.height === "100%", `根高度 = ${rootStyle.height}`);
    assert(rootStyle.display === "flex", `根 display = ${rootStyle.display}`);

    // 找 iframe
    const walk = (n, out = []) => {
      if (!n || typeof n !== "object") return out;
      if (n.__el) { out.push(n); (n.children || []).forEach((c) => walk(c, out)); }
      return out;
    };
    const nodes = walk(tree);
    const iframe = nodes.find((n) => n.type === "iframe");
    assert(!!iframe, "树里有 iframe");
    if (iframe) assert(iframe.props.src === "/apple-read/", `iframe src = ${iframe.props.src}`);

    // 找返回按钮。注意：工具条上不止一个按钮（还有「新对话」），
    // 所以按文案找，不能按「第一个 button」找。
    const labelOf = (n) => ((n.children || []).flat(9).join("") || n.props.children || "");
    const buttons = nodes.filter((n) => n.type === "button");
    assert(buttons.length >= 2, `工具条按钮数 = ${buttons.length}（至少「新对话」+「返回对话」）`);

    const btn = buttons.find((n) => labelOf(n) === "← 返回对话");
    assert(!!btn, "树里有返回按钮");
    if (btn) {
      assert(labelOf(btn) === "← 返回对话", `按钮文案 = ${labelOf(btn)}`);
      try {
        btn.props.onClick();
        assert(ctx.__panel === null, "点返回 → layout.selectPanel(null)（回到对话）");
      } catch (e) { bad("返回按钮 onClick 抛错", e.message); }
    }

    // 「新对话」按钮：丢掉这本书当前的会话，另起一个
    const fresh = buttons.find((n) => labelOf(n) === "新对话");
    assert(!!fresh, "树里有「新对话」按钮");
    if (fresh) {
      // 没选书之前必须禁用，否则会为一个空书名建会话
      assert(fresh.props.disabled === true, "没选书时「新对话」禁用");
      try {
        fresh.props.onClick();
        assert(ctx.__panel === undefined || ctx.__panel === null, "点「新对话」不会误触返回");
      } catch (e) { bad("「新对话」onClick 抛错", e.message); }
    }
  }
}

// ---------- 原生会话适配层 ----------
// 这是本次迁移的核心机关：把 conversation.content 这个 factory 以 embedded 形态
// 渲染出来，并提供一个只转 chat 视图的局部组件。这里用假 props 直接验协议——
// 这些是 Harness 未文档化的内部接口，协议写错只会静默不显示，很难查。
console.log("\n[4] 原生会话适配层");
if (chat) {
  const calls = { factory: null, slot: null };
  const fakeSession = { blank: true, openState: "open", running: false, awaitingFirstTurn: false };
  const props = {
    sessionId: "session-x",
    useSession: (sel) => sel(fakeSession),
    useConversation: (sel) => sel({ activeTargets: new Set() }),
    useSessions: (sel) => sel({ byId: { "session-x": { blank: true } } }),
    renderFactorySlot: (name, input, opts) => {
      calls.factory = { name, input, opts };
      return el("div", {}, null);
    },
    renderSlot: (key, owner) => {
      calls.slot = { key, owner };
      return el("div", {}, null);
    },
  };

  try { chat.comp(props); ok("NativeConversation 渲染未抛错"); }
  catch (e) { bad("NativeConversation 渲染抛错", e.message); }

  if (calls.factory) {
    assert(calls.factory.name === "conversation.content", `factory 名 = ${calls.factory.name}`);
    assert(calls.factory.input.variant === "embedded", `variant = ${calls.factory.input.variant}`);
    assert(
      ["settling", "hero", "active"].includes(calls.factory.input.phase),
      `phase = ${calls.factory.input.phase}`
    );
    assert(typeof calls.factory.input.hero === "boolean", `hero = ${calls.factory.input.hero}`);

    const views = calls.factory.opts && calls.factory.opts.slots && calls.factory.opts.slots.views;
    assert(typeof views === "function", "提供了 views 局部组件");
    if (typeof views === "function") {
      views({ renderSlot: props.renderSlot });
      assert(
        calls.slot && calls.slot.key === "conversation.session",
        `views → renderSlot(${calls.slot && calls.slot.key})`
      );
      assert(
        calls.slot && calls.slot.owner && calls.slot.owner.view === "chat",
        `views 指定 view = ${calls.slot && calls.slot.owner && calls.slot.owner.view}`
      );
    }
  } else {
    bad("没有调用 renderFactorySlot");
  }

  // Harness 版本不匹配时必须优雅降级成一句人话，而不是白屏或抛错。
  let degraded = null;
  try { degraded = chat.comp({ sessionId: "x" }); ok("缺接口时渲染未抛错（优雅降级）"); }
  catch (e) { bad("缺接口时抛错", e.message); }
  if (degraded) assert(degraded.__el === true, "降级时返回了提示元素");
}

// ---------- 版本不匹配时的降级 ----------
// 这些是 Harness 未文档化的内部接口，版本一变 register 就可能抛。
// 一次抛错不该让整个插件加载失败——最差也要保住「书库与标注」这条主线。
console.log("\n[5] 版本不匹配时的降级");
{
  const regs2 = [];
  const ctx2 = {
    slots: {
      inject(name, fn) { fn(); },
      register(opts) {
        if (opts.name === "apple-read.chat") throw new Error("unknown slot");
        regs2.push(opts.name);
      },
    },
    layout: { selectPanel: () => {} },
    inject() {},
    logger: { warn() {} },
  };

  try {
    mod.apply(ctx2);
    ok("子槽注册抛错时 apply() 仍不抛（插件能加载）");
  } catch (e) {
    bad("子槽注册抛错把 apply() 带崩了（插件会整体加载失败）", e.message);
  }
  assert(
    regs2.includes("sidebar.panellist") && regs2.includes("main"),
    "其它槽位照常注册（书库与标注这条主线保住了）"
  );

  // 服务缺失时主面板仍要能渲染出 iframe，而不是白屏。
  let tree2 = null;
  try {
    tree2 = main.comp(main.opts.inject());
    ok("服务缺失时主面板仍可渲染");
  } catch (e) {
    bad("服务缺失时主面板抛错", e.message);
  }
  if (tree2) {
    const walk2 = (n, out = []) => {
      if (!n || typeof n !== "object") return out;
      if (n.__el) { out.push(n); (n.children || []).forEach((c) => walk2(c, out)); }
      return out;
    };
    walk2(tree2).some((n) => n.type === "iframe")
      ? ok("降级后 iframe（书库）仍在树里") : bad("降级后 iframe 不见了");
  }
}

console.log(`\n===== 通过 ${pass} · 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
