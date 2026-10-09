window.__ModuleLoader__.load({
	id: "dsh-apple-read",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client/index.jsx
var index_exports = {};
__export(index_exports, {
  PANEL_ID: () => PANEL_ID,
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(index_exports);
var React = __toESM(require("react"), 1);
var PANEL_ID = "apple-read";
var PANEL_PATH = "/apple-read/";
var CHAT_SLOT = "apple-read.chat";
var API = "/apple-read/api";
var READING_DIR_NAME = "\u8BFB\u4E66\u4F1A\u8BDD";
var ROOT_STYLE = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  width: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  background: "var(--dsw-alias-bg-base, #fff)"
};
var BAR_STYLE = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  flex: "0 0 auto",
  height: 38,
  padding: "0 10px 0 14px",
  borderBottom: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1))",
  background: "var(--dsw-alias-bg-layer-1, #fafafa)",
  color: "var(--dsw-alias-label-primary, #111)",
  fontSize: 13,
  userSelect: "none"
};
var TITLE_STYLE = { fontWeight: 600, whiteSpace: "nowrap" };
var HINT_STYLE = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 11,
  color: "var(--dsw-alias-label-secondary, #888)"
};
var BUTTON_STYLE = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  flex: "0 0 auto",
  height: 26,
  padding: "0 10px",
  font: "inherit",
  fontSize: 12,
  color: "var(--dsw-alias-label-primary, #111)",
  background: "var(--dsw-alias-bg-overlay, rgba(0,0,0,.04))",
  border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12))",
  borderRadius: 6,
  cursor: "pointer"
};
var BODY_STYLE = {
  display: "flex",
  flex: "1 1 auto",
  minHeight: 0,
  minWidth: 0
};
var LEFT_STYLE = {
  flex: "0 0 340px",
  width: 340,
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  borderRight: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1))"
};
var FRAME_STYLE = {
  flex: "1 1 auto",
  minHeight: 0,
  width: "100%",
  border: "none",
  display: "block",
  background: "#fff"
};
var RIGHT_STYLE = {
  flex: "1 1 auto",
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column"
};
var NOTICE_STYLE = {
  flex: "0 0 auto",
  margin: "8px 10px 0",
  padding: "6px 10px",
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--dsw-alias-label-secondary, #666)",
  background: "var(--dsw-alias-bg-layer-1, #fafafa)",
  border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1))",
  borderRadius: 6
};
var ERROR_STYLE = { ...NOTICE_STYLE, color: "var(--dsw-alias-label-error, #c0392b)" };
var PLACEHOLDER_STYLE = {
  flex: "1 1 auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  textAlign: "center",
  fontSize: 12,
  lineHeight: 1.6,
  color: "var(--dsw-alias-label-secondary, #888)"
};
var heroBridge = { book: "", onAsk: null };
var HERO_STYLE = {
  flex: "1 1 auto",
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 9,
  padding: "20px 24px",
  textAlign: "center"
};
var HERO_ICON_STYLE = {
  width: 74,
  height: 58,
  color: "var(--dsw-alias-label-tertiary, #c2c2c8)"
};
var HERO_LABEL_STYLE = {
  fontSize: 11,
  letterSpacing: ".14em",
  color: "var(--dsw-alias-label-tertiary, #a0a0a6)"
};
var HERO_TITLE_STYLE = {
  margin: 0,
  fontSize: 17,
  fontWeight: 600,
  lineHeight: 1.4,
  color: "var(--dsw-alias-label-primary, #111)"
};
var HERO_TEXT_STYLE = {
  margin: 0,
  maxWidth: 400,
  fontSize: 12,
  lineHeight: 1.75,
  color: "var(--dsw-alias-label-secondary, #777)"
};
var CHIPS_STYLE = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "center",
  gap: 6,
  marginTop: 6,
  maxWidth: 440
};
var CHIP_STYLE = {
  ...BUTTON_STYLE,
  height: 28,
  padding: "0 12px",
  borderRadius: 14,
  fontSize: 12
};
function BookIcon() {
  return React.createElement(
    "svg",
    { viewBox: "0 0 112 88", fill: "none", style: HERO_ICON_STYLE, "aria-hidden": "true" },
    React.createElement("path", {
      d: "M56 72c-10-7-21-10-37-9V19c16-1 27 2 37 9 10-7 21-10 37-9v44c-16-1-27 2-37 9Z",
      stroke: "currentColor",
      strokeWidth: 2.5,
      strokeLinejoin: "round"
    }),
    React.createElement("path", {
      d: "M56 28v44M25 29c9 .3 17 2.5 24 6M25 38c9 .3 17 2.5 24 6M63 35c7-3.5 15-5.7 24-6M63 44c7-3.5 15-5.7 24-6",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round"
    })
  );
}
var QUICK_ASKS = [
  "\u8FD9\u672C\u4E66\u7684\u6838\u5FC3\u4E3B\u5F20\u662F\u4EC0\u4E48\uFF1F",
  "\u6211\u5212\u7684\u91CD\u70B9\u91CC\uFF0C\u54EA\u51E0\u6761\u6700\u5173\u952E\uFF1F",
  "\u6311\u4E00\u4E2A\u53CD\u76F4\u89C9\u7684\u89C2\u70B9\u5C55\u5F00\u8BB2\u8BB2"
];
function ReadingHero(props) {
  const book = props.book || "";
  const onAsk = props.onAsk;
  return React.createElement(
    "div",
    { style: HERO_STYLE },
    React.createElement(BookIcon, null),
    React.createElement("span", { style: HERO_LABEL_STYLE }, "\u4E0E\u4E66\u5BF9\u5750\u7247\u523B"),
    React.createElement(
      "h2",
      { style: HERO_TITLE_STYLE },
      book ? `\u300A${book}\u300B` : "\u7FFB\u5F00\u4E00\u672C\u4E66\uFF0C\u4ECE\u8FD9\u91CC\u95EE\u8D77"
    ),
    React.createElement(
      "p",
      { style: HERO_TEXT_STYLE },
      book ? "\u76F4\u63A5\u95EE\u8FD9\u672C\u4E66\u7684\u4EFB\u4F55\u95EE\u9898\u3002\u4F60\u5728\u300C\u56FE\u4E66\u300DApp \u91CC\u5212\u7684\u91CD\u70B9\u4F1A\u4E00\u8D77\u5E26\u8FDB\u6765\uFF0C\u7B54\u6848\u4F1A\u6807\u51FA\u7AE0\u8282\uFF0C\u65B9\u4FBF\u56DE\u300C\u56FE\u4E66\u300D\u5BF9\u4F4D\u7F6E\u3002" : "\u5148\u5728\u5DE6\u8FB9\u9009\u4E00\u672C\u4E66\u3002\u5212\u8FC7\u7684\u91CD\u70B9\u4F1A\u81EA\u52A8\u5E26\u8FDB\u6765\uFF0C\u4E5F\u80FD\u8BA9\u5B83\u5728\u6574\u672C\u4E66\u91CC\u68C0\u7D22\u3002"
    ),
    React.createElement(
      "div",
      { style: CHIPS_STYLE },
      QUICK_ASKS.map(
        (q) => React.createElement(
          "button",
          {
            key: q,
            type: "button",
            style: CHIP_STYLE,
            disabled: !book || !onAsk,
            title: book ? q : "\u5148\u5728\u5DE6\u8FB9\u9009\u4E00\u672C\u4E66",
            onClick: () => {
              if (book && onAsk) onAsk(q);
            }
          },
          q
        )
      )
    )
  );
}
function NativeChatView(props) {
  return props.renderSlot("conversation.session", { view: "chat" });
}
var EMPTY_SESSION = { blank: true, openState: "open", running: false, awaitingFirstTurn: false };
var EMPTY_CONVERSATION = { activeTargets: /* @__PURE__ */ new Set() };
var EMPTY_SESSIONS = { byId: {} };
var pickSession = (sel) => typeof sel === "function" ? sel(EMPTY_SESSION) : EMPTY_SESSION;
var pickConversation = (sel) => typeof sel === "function" ? sel(EMPTY_CONVERSATION) : EMPTY_CONVERSATION;
var pickSessions = (sel) => typeof sel === "function" ? sel(EMPTY_SESSIONS) : EMPTY_SESSIONS;
function NativeConversation(props) {
  const { sessionId, useSession, useConversation, useSessions, renderFactorySlot } = props;
  const usable = typeof renderFactorySlot === "function";
  const session = (typeof useSession === "function" ? useSession : pickSession)((s) => s) || EMPTY_SESSION;
  const conversation = (typeof useConversation === "function" ? useConversation : pickConversation)((s) => s) || EMPTY_CONVERSATION;
  const blank = (typeof useSessions === "function" ? useSessions : pickSessions)((s) => s.byId[sessionId]?.blank);
  if (!usable) {
    return React.createElement(
      "div",
      { style: PLACEHOLDER_STYLE },
      "\u5F53\u524D Harness \u7248\u672C\u4E0D\u652F\u6301\u539F\u751F\u4F34\u8BFB\uFF08\u7F3A\u5C11 renderFactorySlot\uFF09\u3002\u5DE6\u4FA7\u4E66\u5E93\u4E0E\u6807\u6CE8\u4ECD\u53EF\u6B63\u5E38\u4F7F\u7528\u3002"
    );
  }
  const active = (conversation.activeTargets?.size ?? 0) > 0 || !session.blank && !session.awaitingFirstTurn || session.running;
  const settling = !active && session.openState === "loading" && blank !== true;
  const hero = !active && (session.openState === "open" || blank === true);
  const content = renderFactorySlot(
    "conversation.content",
    { variant: "embedded", phase: settling ? "settling" : hero ? "hero" : "active", hero },
    { slots: { views: NativeChatView } }
  );
  const showHero = blank === true && hero;
  return React.createElement(
    "div",
    { style: { flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" } },
    showHero ? React.createElement(ReadingHero, { book: heroBridge.book, onAsk: heroBridge.onAsk }) : null,
    content
  );
}
function createBridge(ctx) {
  let scope;
  let workspaceCache;
  if (typeof ctx.inject === "function") {
    ctx.inject(["sessions", "uiSession", "uiWorkspace"], (child) => {
      scope = child;
      return () => {
        scope = void 0;
      };
    });
  }
  async function resolveWorkspaceId() {
    if (workspaceCache) return workspaceCache;
    const ctl = scope?.uiWorkspace?.workspaces;
    const items = ctl?.list?.getSnapshot?.()?.items ?? [];
    let want = "";
    try {
      const r = await fetch(`${API}/reading-workspace`);
      const j = await r.json();
      if (j && j.ok && j.path) want = String(j.path);
    } catch {
    }
    if (!want) {
      const dw = items.find((w) => /(?:^|\/)default-workspace$/.test(w.path || ""));
      if (dw?.path) want = dw.path.replace(/\/default-workspace$/, `/${READING_DIR_NAME}`);
    }
    if (want) {
      const hit = items.find((w) => w.path === want);
      if (hit?.workspaceId) return workspaceCache = hit.workspaceId;
      if (typeof ctl?.create === "function") {
        try {
          const created = await ctl.create({ path: want });
          const fresh = ctl.list?.getSnapshot?.()?.items ?? [];
          const id = created?.value?.workspace?.workspaceId || created?.workspace?.workspaceId || fresh.find((w) => w.path === want)?.workspaceId;
          if (id) return workspaceCache = id;
        } catch {
        }
      }
    }
    const preferred = items.find((w) => w.title === "default-workspace") || items.find((w) => /(?:^|\/)default-workspace$/.test(w.path || ""));
    return workspaceCache = (preferred || items[0])?.workspaceId;
  }
  const chatKey = (workspaceId, book) => `apple-read.chat.${workspaceId}.${book || ""}`;
  function readSavedSession(key) {
    try {
      return localStorage.getItem(key) || "";
    } catch {
      return "";
    }
  }
  function saveSession(key, sessionId) {
    try {
      localStorage.setItem(key, sessionId);
    } catch {
    }
  }
  function dropSession(key) {
    try {
      localStorage.removeItem(key);
    } catch {
    }
  }
  function bindSession(sessionId) {
    const reference = scope.sessions.retain(sessionId, { source: PANEL_ID });
    try {
      const source = scope.uiSession.bindingSource(reference);
      const actions = source?.value?.props?.inputActions;
      if (typeof actions?.setDraft !== "function" || typeof actions?.submit !== "function") {
        throw new Error("\u5F53\u524D Harness \u7248\u672C\u4E0D\u652F\u6301\u539F\u751F\u4F34\u8BFB\uFF08\u8F93\u5165\u6846\u63A5\u53E3\u7F3A\u5931\uFF09");
      }
      return { reference, sessionId, source };
    } catch (error) {
      reference.release();
      throw error;
    }
  }
  return {
    get ready() {
      return !!scope;
    },
    /**
     * 打开（或复用）这本书的伴读会话，并持有它。
     *
     * **复用**是关键：以前每次打开面板都 `sessions.create` 一个新会话，会话列表很快就乱了。
     * 现在按「工作区 + 书名」把 sessionId 存进 localStorage，下次打开同一本书接着上次聊。
     * `forceNew` 为真时丢掉旧的、另起一个（界面上的「新对话」）。
     *
     * 返回 `{ reference, sessionId, source }`。调用方必须在卸载时 `reference.release()`，
     * 否则会话作用域不会卸载（引用计数不归零）。
     */
    async openReadingSession(book, forceNew) {
      if (!scope) throw new Error("Harness \u4F1A\u8BDD\u670D\u52A1\u5C1A\u672A\u5C31\u7EEA");
      const workspaceId = await resolveWorkspaceId();
      if (!workspaceId) throw new Error("\u8BF7\u5148\u5728 Harness \u91CC\u9009\u62E9\u4E00\u4E2A\u5DE5\u4F5C\u533A");
      const key = chatKey(workspaceId, book);
      if (forceNew) dropSession(key);
      let saved = forceNew ? "" : readSavedSession(key);
      if (!saved && book && !forceNew) {
        const fallbackKey = chatKey(workspaceId, "");
        const fallbackId = readSavedSession(fallbackKey);
        if (fallbackId) {
          dropSession(fallbackKey);
          saveSession(key, fallbackId);
          saved = fallbackId;
        }
      }
      if (saved) {
        try {
          return bindSession(saved);
        } catch {
          dropSession(key);
        }
      }
      const sessionId = await scope.sessions.create({ workspaceId });
      const chat = bindSession(sessionId);
      saveSession(key, sessionId);
      return chat;
    },
    /** 当前伴读会话开在哪个工作区（给界面显示用）。 */
    async currentWorkspace() {
      const id = await resolveWorkspaceId();
      const items = scope?.uiWorkspace?.workspaces?.list?.getSnapshot?.()?.items ?? [];
      const w = items.find((x) => x.workspaceId === id);
      return w ? { workspaceId: id, title: w.title, path: w.path } : { workspaceId: id };
    },
    /**
     * 把一段提示词送进原生输入框并发送。
     *
     * 三道前置检查是为了**不冲掉用户正在写的草稿**——这个输入框是用户自己的，
     * 插件往里塞东西必须格外小心。
     */
    async sendPrompt(chat, prompt) {
      const source = chat?.source;
      const actions = source?.value?.props?.inputActions;
      const input = source?.value?.hooks?.input;
      if (!actions || !input) throw new Error("\u8F93\u5165\u6846\u8FD8\u6CA1\u5C31\u7EEA\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
      const before = input.getSnapshot();
      if (before.phase !== "plain") throw new Error("\u8F93\u5165\u6846\u6B63\u5728\u5904\u7406\u6D88\u606F\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
      if (before.attachmentIds?.length) throw new Error("\u8F93\u5165\u6846\u91CC\u8FD8\u6709\u5F85\u53D1\u9001\u7684\u9644\u4EF6\uFF0C\u5148\u5904\u7406\u6389");
      if ((before.draft || "").trim()) throw new Error("\u8F93\u5165\u6846\u91CC\u5DF2\u7ECF\u6709\u8349\u7A3F\u4E86\uFF0C\u5148\u6E05\u7A7A\u518D\u8BD5");
      actions.setDraft(prompt);
      const deadline = Date.now() + 1200;
      let landed = false;
      while (Date.now() < deadline) {
        if ((input.getSnapshot().draft || "").length >= prompt.length) {
          landed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      if (!landed) throw new Error("\u6CA1\u80FD\u628A\u5185\u5BB9\u5199\u8FDB\u8F93\u5165\u6846\uFF08Harness \u7248\u672C\u53EF\u80FD\u4E0D\u517C\u5BB9\uFF09");
      if (input.getSnapshot().phase !== "plain") throw new Error("\u8F93\u5165\u6846\u72B6\u6001\u5DF2\u53D8\u5316\uFF0C\u5DF2\u53D6\u6D88\u53D1\u9001");
      actions.submit();
    }
  };
}
function postToFrame(frame, message) {
  try {
    frame?.contentWindow?.postMessage(message, window.location.origin);
  } catch {
  }
}
function BooksIcon() {
  return React.createElement("span", { style: { fontSize: 15, lineHeight: 1 } }, "\u{1F4DA}");
}
function BooksPage(props) {
  const onBack = props && props.onBack;
  const bridge = props && props.bridge;
  const renderSlot = props && props.renderSlot;
  const SessionProvider = props && props.SessionProvider;
  const [chat, setChat] = React.useState(null);
  const [error, setError] = React.useState("");
  const [status, setStatus] = React.useState("\u8BFB\u5728\u300C\u56FE\u4E66\u300DApp \xB7 \u95EE\u5728\u8FD9\u91CC");
  const [book, setBook] = React.useState("");
  const [bookSettled, setBookSettled] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);
  const forceNewRef = React.useRef(false);
  const frameRef = React.useRef(null);
  const askRef = React.useRef(null);
  React.useEffect(() => {
    if (bookSettled) return void 0;
    const t = setTimeout(() => setBookSettled(true), 5e3);
    return () => clearTimeout(t);
  }, [bookSettled]);
  React.useEffect(() => {
    if (!bridge || !bookSettled) return void 0;
    let stale = false;
    let acquired = null;
    let timer = void 0;
    let tries = 0;
    setChat(null);
    forceNewRef.current = false;
    const attempt = () => {
      bridge.openReadingSession(book, forceNewRef.current).then(
        (ref) => {
          if (stale) {
            ref.reference.release();
            return;
          }
          acquired = ref;
          setChat(ref);
          setError("");
        },
        (e) => {
          if (stale) return;
          const message = String(e && e.message || e);
          if (/尚未就绪/.test(message) && tries < 20) {
            tries += 1;
            timer = setTimeout(attempt, 250);
            return;
          }
          setError(message);
        }
      );
    };
    attempt();
    return () => {
      stale = true;
      if (timer !== void 0) clearTimeout(timer);
      if (acquired) acquired.reference.release();
      acquired = null;
    };
  }, [bridge, book, bookSettled, nonce]);
  React.useEffect(() => {
    function onMessage(event) {
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;
      if (data.type === "apple-read:ready") {
        postToFrame(frameRef.current, { type: "apple-read:embed", value: true });
        return;
      }
      if (data.type === "apple-read:book") {
        setStatus(data.book ? `\u5728\u8BFB\u300A${data.book}\u300B` : "\u8BFB\u5728\u300C\u56FE\u4E66\u300DApp \xB7 \u95EE\u5728\u8FD9\u91CC");
        if (data.book) {
          setBook(String(data.book));
          setBookSettled(true);
        }
        if (chat?.sessionId && data.book) {
          void fetch(`${API}/reading-context`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId: chat.sessionId, book: data.book })
          }).catch(() => {
          });
        }
        return;
      }
      if (data.type === "apple-read:ask") {
        void askRef.current?.(data);
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [chat]);
  askRef.current = async (data) => {
    if (!bridge || !chat) {
      setError("\u4F1A\u8BDD\u8FD8\u6CA1\u5C31\u7EEA\uFF0C\u8BF7\u7A0D\u5019\u518D\u8BD5");
      return;
    }
    const book2 = String(data.book || "");
    const question = String(data.question || "\u8FD9\u53E5\u5728\u8BB2\u4EC0\u4E48\uFF1F\u4E3A\u4EC0\u4E48\u503C\u5F97\u5212\uFF1F");
    setStatus("\u6B63\u5728\u51C6\u5907\u6750\u6599\u2026");
    let payload;
    try {
      const res = await fetch(`${API}/prepare-chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: chat.sessionId,
          book: book2,
          annotationId: data.annotationId ?? null,
          // 「在书里找」点某段问 AI 时带上整段原文：
          // 宿主会把它标成「用户正在问的这段」，并用它本身去检索。
          passage: data.passage && data.passage.text ? { chapter: String(data.passage.chapter || ""), text: String(data.passage.text) } : null,
          question
        })
      });
      payload = await res.json();
      if (!res.ok || !payload || payload.ok !== true) {
        throw new Error(payload && payload.error || `HTTP ${res.status}`);
      }
    } catch (e) {
      setError(`\u51C6\u5907\u9605\u8BFB\u6750\u6599\u5931\u8D25\uFF1A${String(e && e.message || e)}`);
      setStatus("");
      return;
    }
    setError("");
    setStatus(`${payload.markCount} \u6761\u6807\u6CE8 \xB7 ${payload.hits} \u6BB5\u539F\u6587 \xB7 ${payload.reranked ? "\u5DF2\u7CBE\u6392" : "\u672A\u7CBE\u6392"}`);
    try {
      await bridge.sendPrompt(chat, payload.prompt);
    } catch (e) {
      setError(String(e && e.message || e));
    }
  };
  const NOT_SUPPORTED = "\u5F53\u524D Harness \u7248\u672C\u4E0D\u652F\u6301\u628A\u539F\u751F\u4F1A\u8BDD\u5D4C\u8FDB\u63D2\u4EF6\u9762\u677F\u3002\u5DE6\u4FA7\u4E66\u5E93\u4E0E\u6807\u6CE8\u4ECD\u53EF\u6B63\u5E38\u4F7F\u7528\u3002";
  let conversationBody;
  if (chat && SessionProvider && renderSlot) {
    try {
      conversationBody = React.createElement(
        SessionProvider,
        { session: chat.reference },
        renderSlot(CHAT_SLOT, {})
      );
    } catch {
      conversationBody = React.createElement("div", { style: PLACEHOLDER_STYLE }, NOT_SUPPORTED);
    }
  } else {
    conversationBody = React.createElement(
      "div",
      { style: PLACEHOLDER_STYLE },
      chat ? NOT_SUPPORTED : "\u6B63\u5728\u51C6\u5907 Harness \u4F1A\u8BDD\u2026"
    );
  }
  heroBridge.book = book;
  heroBridge.onAsk = (q) => {
    void askRef.current({ book, question: q });
  };
  const conversation = React.createElement(
    "div",
    { style: RIGHT_STYLE },
    error ? React.createElement("div", { style: ERROR_STYLE }, error) : null,
    conversationBody
  );
  return React.createElement(
    "div",
    { style: ROOT_STYLE },
    React.createElement(
      "div",
      { style: BAR_STYLE },
      React.createElement("span", { style: TITLE_STYLE }, "\u{1F4DA} DSH-apple-Read"),
      React.createElement("span", { style: HINT_STYLE, title: status }, status),
      React.createElement(
        "button",
        {
          type: "button",
          style: BUTTON_STYLE,
          disabled: !chat || !book,
          title: book ? `\u4E22\u6389\u300A${book}\u300B\u5F53\u524D\u7684\u5BF9\u8BDD\uFF0C\u53E6\u8D77\u4E00\u4E2A` : "\u5148\u5728\u5DE6\u8FB9\u9009\u4E00\u672C\u4E66",
          onClick: () => {
            forceNewRef.current = true;
            setNonce((n) => n + 1);
          }
        },
        "\u65B0\u5BF9\u8BDD"
      ),
      React.createElement(
        "button",
        { type: "button", style: BUTTON_STYLE, title: "\u8FD4\u56DE DeepSeek Harness \u5BF9\u8BDD", onClick: onBack },
        "\u2190 \u8FD4\u56DE\u5BF9\u8BDD"
      )
    ),
    React.createElement(
      "div",
      { style: BODY_STYLE },
      React.createElement(
        "div",
        { style: LEFT_STYLE },
        React.createElement("iframe", {
          ref: frameRef,
          src: PANEL_PATH,
          title: "DSH-apple-Read \xB7 \u4E66\u5E93\u4E0E\u6807\u6CE8",
          style: FRAME_STYLE,
          // 双向握手：iframe 加载完主动发一次，它也有一条 ready 主动发一次。
          // 只靠一边的话，先加载完的那一侧消息会丢掉。
          onLoad: () => postToFrame(frameRef.current, { type: "apple-read:embed", value: true })
        })
      ),
      conversation
    )
  );
}
var inject = ["slots", "layout"];
function apply(ctx) {
  const bridge = createBridge(ctx);
  const warn = (what, e) => {
    try {
      ctx.logger?.warn?.(`apple-read: \u6CE8\u518C\u300C${what}\u300D\u5931\u8D25\uFF0C\u5DF2\u8DF3\u8FC7\uFF1A${e && e.message}`);
    } catch {
    }
  };
  ctx.slots.inject("sidebar.panellist", () => {
    try {
      ctx.slots.register(
        { name: "sidebar.panellist", id: PANEL_ID, order: 21, label: "\u56FE\u4E66" },
        BooksIcon
      );
    } catch (e) {
      warn("\u4FA7\u8FB9\u680F\u5165\u53E3", e);
    }
  });
  ctx.slots.inject("main", () => {
    try {
      ctx.slots.register(
        {
          name: "main",
          key: PANEL_ID,
          children: { [CHAT_SLOT]: { kind: "single", scope: "session" } },
          inject: () => ({ onBack: () => ctx.layout.selectPanel(null), bridge })
        },
        BooksPage
      );
    } catch (e) {
      warn("\u4E3B\u9762\u677F", e);
    }
  });
  ctx.slots.inject(CHAT_SLOT, () => {
    try {
      ctx.slots.register({ name: CHAT_SLOT }, NativeConversation);
    } catch (e) {
      warn("\u539F\u751F\u4F1A\u8BDD\u5B50\u69FD", e);
    }
  });
}

		return module.exports;
	}
});

