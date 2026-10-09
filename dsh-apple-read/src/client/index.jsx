/**
 * dsh-apple-read · 客户端半
 *
 * 布局：左侧 iframe 内嵌书库/标注面板（宿主半挂在 Harness 自己的 webServer 的
 * /apple-read 上，同源），右侧**嵌入 Harness 原生会话**。
 *
 * 为什么右侧要嵌原生会话，而不是继续用 iframe 里那个自建聊天：
 * 自建聊天是「插件里的一次性会话」——不写进 session 日志、不共享模型选择、
 * 用不了工具与附件，还得自己去 ~/.dsh/.credentials.yaml 里手抠 API Key。
 * 嵌入原生会话后，「在插件里问」和「在 Harness 里问」就是同一件事。
 *
 * 机关（借自 qiaomu-rss，已在 0.2.0-rc.2 上验证）：
 *   1. `main` 注册时声明一个 session 作用域子槽；
 *   2. 父组件用 `<SessionProvider session={reference}>` 把会话绑给子树；
 *   3. 子树里 `renderFactorySlot("conversation.content", {variant:"embedded",…})`。
 *
 * 尺寸约定（踩过的坑，必须遵守）：主面板根元素要是 height:100% 的 flex 列，
 * **不能**用 position:absolute —— 否则会溢出主区域盖住整个窗口，连左侧栏都点不到，
 * 就回不去 Harness 了。顶部再给一条工具条带「返回对话」按钮做保险。
 *
 * 注意：原生会话相关的客户端 API（sessions / uiSession / inputActions /
 * renderFactorySlot）是 Harness 的**未文档化内部接口**，没有 .d.ts。所以这里
 * 处处做能力探测：版本不匹配时给一句人话，而不是白屏。
 */
import * as React from "react";

const PANEL_ID = "apple-read";
const PANEL_PATH = "/apple-read/";
/** 本插件私有的 session 作用域子槽：原生会话挂在这里。 */
const CHAT_SLOT = "apple-read.chat";
const API = "/apple-read/api";

/**
 * 伴读会话归拢目录的**目录名**（宿主侧 `DEFAULT_READING_DIR` 的 basename）。
 *
 * 正常情况这个路径由宿主 `/api/reading-workspace` 给（它会先 `mkdir -p`，并且能被
 * 设置项覆盖）。这里留一份是为了**宿主还没重启、还是旧版本**时也能工作：
 * `workspaces.create` 是「create or resolve」，目录已存在就能采纳。
 * 路径从 `default-workspace` 的**父目录**推导（两者是兄弟目录），这样不用去猜 home。
 */
const READING_DIR_NAME = "读书会话";

const ROOT_STYLE = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  width: "100%",
  minWidth: 0,
  minHeight: 0,
  overflow: "hidden",
  background: "var(--dsw-alias-bg-base, #fff)",
};

const BAR_STYLE = {
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
  userSelect: "none",
};

const TITLE_STYLE = { fontWeight: 600, whiteSpace: "nowrap" };

const HINT_STYLE = {
  flex: "1 1 auto",
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 11,
  color: "var(--dsw-alias-label-secondary, #888)",
};

const BUTTON_STYLE = {
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
  cursor: "pointer",
};

const BODY_STYLE = {
  display: "flex",
  flex: "1 1 auto",
  minHeight: 0,
  minWidth: 0,
};

/** 左栏固定宽：书库 + 标注，够看标题与两行高亮。 */
const LEFT_STYLE = {
  flex: "0 0 340px",
  width: 340,
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  borderRight: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1))",
};

const FRAME_STYLE = {
  flex: "1 1 auto",
  minHeight: 0,
  width: "100%",
  border: "none",
  display: "block",
  background: "#fff",
};

const RIGHT_STYLE = {
  flex: "1 1 auto",
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
};

const NOTICE_STYLE = {
  flex: "0 0 auto",
  margin: "8px 10px 0",
  padding: "6px 10px",
  fontSize: 12,
  lineHeight: 1.5,
  color: "var(--dsw-alias-label-secondary, #666)",
  background: "var(--dsw-alias-bg-layer-1, #fafafa)",
  border: "1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1))",
  borderRadius: 6,
};

const ERROR_STYLE = { ...NOTICE_STYLE, color: "var(--dsw-alias-label-error, #c0392b)" };

const PLACEHOLDER_STYLE = {
  flex: "1 1 auto",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  textAlign: "center",
  fontSize: 12,
  lineHeight: 1.6,
  color: "var(--dsw-alias-label-secondary, #888)",
};

/* -------------------------------------------------------------------------- */
/* 对话区开场页                                                                */
/* -------------------------------------------------------------------------- */
/**
 * 新建的会话在首轮之前，Harness 只渲染 composer，正文区是空的。
 * 直接留白有两个问题：看起来像坏了；而且整个右栏就是一块「裸的 Harness 对话框」，
 * 没有任何属于「读书」这件事的东西。所以补一块自己的开场页 —— 说明这里是干什么的，
 * 再给三个点一下就能问的开场问题（借 qiaomu-rss 的做法）。
 *
 * 数据怎么传进来：子槽是 session 作用域，拿不到父组件的 props，所以用一个模块级
 * 的 `heroBridge` 由 BooksPage 每次渲染时写入。这是安全的，因为换书会换会话引用，
 * SessionProvider 一变 NativeConversation 就会重渲染，读到的永远是新值。
 */
const heroBridge = { book: "", onAsk: null };

const HERO_STYLE = {
  flex: "1 1 auto",
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 9,
  padding: "20px 24px",
  textAlign: "center",
};

const HERO_ICON_STYLE = {
  width: 74,
  height: 58,
  color: "var(--dsw-alias-label-tertiary, #c2c2c8)",
};

const HERO_LABEL_STYLE = {
  fontSize: 11,
  letterSpacing: ".14em",
  color: "var(--dsw-alias-label-tertiary, #a0a0a6)",
};

const HERO_TITLE_STYLE = {
  margin: 0,
  fontSize: 17,
  fontWeight: 600,
  lineHeight: 1.4,
  color: "var(--dsw-alias-label-primary, #111)",
};

const HERO_TEXT_STYLE = {
  margin: 0,
  maxWidth: 400,
  fontSize: 12,
  lineHeight: 1.75,
  color: "var(--dsw-alias-label-secondary, #777)",
};

const CHIPS_STYLE = {
  display: "flex",
  flexWrap: "wrap",
  justifyContent: "center",
  gap: 6,
  marginTop: 6,
  maxWidth: 440,
};

const CHIP_STYLE = {
  ...BUTTON_STYLE,
  height: 28,
  padding: "0 12px",
  borderRadius: 14,
  fontSize: 12,
};

function BookIcon() {
  return React.createElement(
    "svg",
    { viewBox: "0 0 112 88", fill: "none", style: HERO_ICON_STYLE, "aria-hidden": "true" },
    React.createElement("path", {
      d: "M56 72c-10-7-21-10-37-9V19c16-1 27 2 37 9 10-7 21-10 37-9v44c-16-1-27 2-37 9Z",
      stroke: "currentColor",
      strokeWidth: 2.5,
      strokeLinejoin: "round",
    }),
    React.createElement("path", {
      d: "M56 28v44M25 29c9 .3 17 2.5 24 6M25 38c9 .3 17 2.5 24 6M63 35c7-3.5 15-5.7 24-6M63 44c7-3.5 15-5.7 24-6",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
    })
  );
}

/** 开场问题：覆盖「这本书讲什么」「我的标注」「深入一点」三种最常见的起手式。 */
const QUICK_ASKS = [
  "这本书的核心主张是什么？",
  "我划的重点里，哪几条最关键？",
  "挑一个反直觉的观点展开讲讲",
];

function ReadingHero(props) {
  const book = props.book || "";
  const onAsk = props.onAsk;
  return React.createElement(
    "div",
    { style: HERO_STYLE },
    React.createElement(BookIcon, null),
    React.createElement("span", { style: HERO_LABEL_STYLE }, "与书对坐片刻"),
    React.createElement(
      "h2",
      { style: HERO_TITLE_STYLE },
      book ? `《${book}》` : "翻开一本书，从这里问起"
    ),
    React.createElement(
      "p",
      { style: HERO_TEXT_STYLE },
      book
        ? "直接问这本书的任何问题。你在「图书」App 里划的重点会一起带进来，答案会标出章节，方便回「图书」对位置。"
        : "先在左边选一本书。划过的重点会自动带进来，也能让它在整本书里检索。"
    ),
    React.createElement(
      "div",
      { style: CHIPS_STYLE },
      QUICK_ASKS.map((q) =>
        React.createElement(
          "button",
          {
            key: q,
            type: "button",
            style: CHIP_STYLE,
            disabled: !book || !onAsk,
            title: book ? q : "先在左边选一本书",
            onClick: () => { if (book && onAsk) onAsk(q); },
          },
          q
        )
      )
    )
  );
}

/* -------------------------------------------------------------------------- */
/* 原生会话：适配层                                                            */
/* -------------------------------------------------------------------------- */

/**
 * `conversation.content` 需要一个「局部 Component」来渲染真正的会话正文。
 * 我们只提供这一个：把 chat 视图转出来。
 */
function NativeChatView(props) {
  return props.renderSlot("conversation.session", { view: "chat" });
}

/**
 * 嵌入原生会话。
 *
 * 这些 hook 是 Harness 通过「session 作用域」注入进来的标准 props。缺任何一个
 * 就说明当前版本不兼容——那时**不能**调用不存在的 hook，所以用同形的空实现顶上，
 * 保证 hook 调用次数恒定（React 的硬性要求）。
 */
const EMPTY_SESSION = { blank: true, openState: "open", running: false, awaitingFirstTurn: false };
const EMPTY_CONVERSATION = { activeTargets: new Set() };
const EMPTY_SESSIONS = { byId: {} };
const pickSession = (sel) => (typeof sel === "function" ? sel(EMPTY_SESSION) : EMPTY_SESSION);
const pickConversation = (sel) => (typeof sel === "function" ? sel(EMPTY_CONVERSATION) : EMPTY_CONVERSATION);
const pickSessions = (sel) => (typeof sel === "function" ? sel(EMPTY_SESSIONS) : EMPTY_SESSIONS);

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
      "当前 Harness 版本不支持原生伴读（缺少 renderFactorySlot）。左侧书库与标注仍可正常使用。"
    );
  }

  // 阶段判定逐字沿用 Harness 主面板的算法，保证嵌入版与原生版表现一致。
  const active =
    (conversation.activeTargets?.size ?? 0) > 0 ||
    (!session.blank && !session.awaitingFirstTurn) ||
    session.running;
  const settling = !active && session.openState === "loading" && blank !== true;
  const hero = !active && (session.openState === "open" || blank === true);

  const content = renderFactorySlot(
    "conversation.content",
    { variant: "embedded", phase: settling ? "settling" : hero ? "hero" : "active", hero },
    { slots: { views: NativeChatView } }
  );

  // 首轮之前 Harness 的正文区是空的，只渲染 composer。这里换成自己的开场页：
  // 一句说明 + 三个能直接点的开场问题，右栏就不再是「一块裸的原生对话框」。
  const showHero = blank === true && hero;

  return React.createElement(
    "div",
    { style: { flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column" } },
    showHero
      ? React.createElement(ReadingHero, { book: heroBridge.book, onAsk: heroBridge.onAsk })
      : null,
    content
  );
}

/* -------------------------------------------------------------------------- */
/* 宿主桥：建会话 + 驱动原生输入框                                             */
/* -------------------------------------------------------------------------- */

/**
 * 会话桥。
 *
 * 服务是惰性注入的：`sessions` / `uiSession` / `uiWorkspace` 都是 Harness 的
 * 客户端服务，晚于插件加载就绪，所以用 ctx.inject 等它们出现，而不是写进
 * 模块级 inject 里把插件卡在加载阶段。
 */
function createBridge(ctx) {
  let scope;
  let workspaceCache;

  // ctx.inject 是 Cordis 的核心 API；万一 ctx 形状不对，也不该让整个面板加载失败
  // ——槽位注册在后面，注册成功至少书库与标注还能用。
  if (typeof ctx.inject === "function") {
    ctx.inject(["sessions", "uiSession", "uiWorkspace"], (child) => {
      scope = child;
      return () => {
        scope = undefined;
      };
    });
  }

  /**
   * 解析「伴读会话开在哪个工作区」。
   *
   * 以前这里写死优先 `default-workspace`，于是每开一次面板就在「默认工作区」里多一个
   * 会话，很快和别的杂项混成一团。现在改成三级：
   *   1. 宿主给的专用目录（`/api/reading-workspace`，默认 ~/Documents/deepseek-harness/读书会话）
   *      —— 已经有这个工作区就直接用，没有就用 `workspaces.create({ path })` 建一个；
   *      宿主没给（旧版本还没重启）就从 `default-workspace` 的父目录推导兄弟目录；
   *   2. 建不出来（目录不存在 / 老版本 Harness 没这个接口）就退回 `default-workspace`；
   *   3. 再不行就用列表里第一个。
   *
   * 结果缓存在 `workspaceCache`，一次面板生命周期只解析一次。
   */
  async function resolveWorkspaceId() {
    if (workspaceCache) return workspaceCache;
    const ctl = scope?.uiWorkspace?.workspaces;
    const items = ctl?.list?.getSnapshot?.()?.items ?? [];

    let want = "";
    try {
      const r = await fetch(`${API}/reading-workspace`);
      const j = await r.json();
      if (j && j.ok && j.path) want = String(j.path);
    } catch { /* 宿主旧版本 / 没起来：走下面的兄弟目录推导 */ }

    // 宿主没给路径（旧版本宿主还没重启）时，从 default-workspace 的父目录推导：
    //   <父目录>/default-workspace  →  <父目录>/读书会话
    // 目录存在就能被 create 采纳；不存在就 create 失败，照旧退回 default-workspace。
    if (!want) {
      const dw = items.find((w) => /(?:^|\/)default-workspace$/.test(w.path || ""));
      if (dw?.path) want = dw.path.replace(/\/default-workspace$/, `/${READING_DIR_NAME}`);
    }

    if (want) {
      const hit = items.find((w) => w.path === want);
      if (hit?.workspaceId) return (workspaceCache = hit.workspaceId);
      if (typeof ctl?.create === "function") {
        try {
          // `create` 是「create or resolve」：路径已存在就采纳它。宿主已经先 mkdir 过了。
          // 返回值是 Remote 结果 `{ ok, value: { workspace } }`，但也见过直接给
          // `{ workspace }` 的形状，所以两种都认；都认不出来就回列表按 path 找一遍
          // —— create 内部会 upsert，所以列表此时已经更新了。
          const created = await ctl.create({ path: want });
          const fresh = ctl.list?.getSnapshot?.()?.items ?? [];
          const id = created?.value?.workspace?.workspaceId
            || created?.workspace?.workspaceId
            || fresh.find((w) => w.path === want)?.workspaceId;
          if (id) return (workspaceCache = id);
        } catch { /* 建不出来就退回默认工作区 */ }
      }
    }

    const preferred =
      items.find((w) => w.title === "default-workspace") ||
      items.find((w) => /(?:^|\/)default-workspace$/.test(w.path || ""));
    return (workspaceCache = (preferred || items[0])?.workspaceId);
  }

  /* --- 「一本书 = 一个会话」的持久化 -------------------------------------- */

  const chatKey = (workspaceId, book) => `apple-read.chat.${workspaceId}.${book || ""}`;

  function readSavedSession(key) {
    try { return localStorage.getItem(key) || ""; } catch { return ""; }
  }
  function saveSession(key, sessionId) {
    try { localStorage.setItem(key, sessionId); } catch { /* 隐私模式下写不了，忽略 */ }
  }
  function dropSession(key) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  }

  /** 把一个 sessionId 绑成可用的 chat（输入框接口不全就当不可用）。 */
  function bindSession(sessionId) {
    const reference = scope.sessions.retain(sessionId, { source: PANEL_ID });
    try {
      const source = scope.uiSession.bindingSource(reference);
      const actions = source?.value?.props?.inputActions;
      if (typeof actions?.setDraft !== "function" || typeof actions?.submit !== "function") {
        throw new Error("当前 Harness 版本不支持原生伴读（输入框接口缺失）");
      }
      return { reference, sessionId, source };
    } catch (error) {
      reference.release(); // 失败必须释放，否则泄漏一个会话作用域
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
      if (!scope) throw new Error("Harness 会话服务尚未就绪");
      const workspaceId = await resolveWorkspaceId();
      if (!workspaceId) throw new Error("请先在 Harness 里选择一个工作区");

      const key = chatKey(workspaceId, book);
      if (forceNew) dropSession(key);

      let saved = forceNew ? "" : readSavedSession(key);

      // 书名还没到就开的那个「兜底会话」（iframe 加载慢时会发生），书名一到就把它
      // **改挂**到这本书上，而不是另建一个。否则每打开一次面板就会多出一个孤儿会话
      // —— 那正是这次要消灭的「乱」。用户若在书名到达前就打了字，对话也顺理成章地
      // 归到这本书下面，不丢上下文。
      // forceNew（用户点了「新对话」）时必须跳过：否则刚被丢掉的东西又被捞回来。
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
          // 会话被删了、或已经不属于这个工作区：清掉记录，下面新建一个
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
      if (!actions || !input) throw new Error("输入框还没就绪，请稍后重试");

      const before = input.getSnapshot();
      if (before.phase !== "plain") throw new Error("输入框正在处理消息，请稍后重试");
      if (before.attachmentIds?.length) throw new Error("输入框里还有待发送的附件，先处理掉");
      if ((before.draft || "").trim()) throw new Error("输入框里已经有草稿了，先清空再试");

      actions.setDraft(prompt);

      // setDraft 是异步 store 写入：等它真的落进输入框再提交，否则会发出空消息。
      const deadline = Date.now() + 1200;
      let landed = false;
      while (Date.now() < deadline) {
        if ((input.getSnapshot().draft || "").length >= prompt.length) {
          landed = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      if (!landed) throw new Error("没能把内容写进输入框（Harness 版本可能不兼容）");

      // 落盘后状态可能又变了（比如用户手动发了），再确认一次。
      if (input.getSnapshot().phase !== "plain") throw new Error("输入框状态已变化，已取消发送");

      actions.submit();
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 面板                                                                        */
/* -------------------------------------------------------------------------- */

/** 给 iframe 发消息（同源）。iframe 还没加载完时静默忽略。 */
function postToFrame(frame, message) {
  try {
    frame?.contentWindow?.postMessage(message, window.location.origin);
  } catch {
    /* iframe 还没加载完 */
  }
}

function BooksIcon() {
  return React.createElement("span", { style: { fontSize: 15, lineHeight: 1 } }, "📚");
}

function BooksPage(props) {
  const onBack = props && props.onBack;
  const bridge = props && props.bridge;
  const renderSlot = props && props.renderSlot;
  const SessionProvider = props && props.SessionProvider;

  const [chat, setChat] = React.useState(null);
  const [error, setError] = React.useState("");
  const [status, setStatus] = React.useState("读在「图书」App · 问在这里");
  const [book, setBook] = React.useState("");
  const [bookSettled, setBookSettled] = React.useState(false);
  const [nonce, setNonce] = React.useState(0);
  const forceNewRef = React.useRef(false);
  const frameRef = React.useRef(null);
  const askRef = React.useRef(null);

  // 等 iframe 报出「在读哪本」再开会话。否则会先为一个空书名建一个会话，
  // 书名到了再为这本书建第二个 —— 每次打开面板就白多一个会话，这正是会话列表变乱的原因之一。
  // 5 秒还没报（比如书库是空的）才用兜底会话；书名随后到达时会被「改挂」过去，
  // 所以即使等超时了也不会留下孤儿（见 openReadingSession）。
  React.useEffect(() => {
    if (bookSettled) return undefined;
    const t = setTimeout(() => setBookSettled(true), 5000);
    return () => clearTimeout(t);
  }, [bookSettled]);

  // ---- 打开（或复用）这本书的伴读会话；换书就换会话，卸载时释放 ----
  // 依赖 book：切书时会重新解析「这本书上次的会话」，接不回去才新建。
  React.useEffect(() => {
    if (!bridge || !bookSettled) return undefined;
    let stale = false;
    let acquired = null;
    let timer = undefined;
    let tries = 0;

    // 换书时先把旧 chat 摘掉：它在 cleanup 里已经 release 了，留着会让「问 AI」
    // 往一个已释放的会话里写。
    setChat(null);
    forceNewRef.current = false; // 只在「新对话」那一次生效

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
          // 阅读上下文必须**在这里**登记：此刻 (book, ref.sessionId) 才是配对的。
          // 放到消息处理器里、用闭包里的 chat 去发，会拿旧书的会话配新书 —— 也就是串书。
          if (book && ref.sessionId) {
            void fetch(`${API}/reading-context`, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ sessionId: ref.sessionId, book }),
            }).catch(() => {});
          }
        },
        (e) => {
          if (stale) return;
          const message = String((e && e.message) || e);
          // 服务是异步就绪的，头几秒失败很正常——退避重试，别一上来就报错吓人。
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
      if (timer !== undefined) clearTimeout(timer);
      if (acquired) acquired.reference.release();
      acquired = null;
    };
  }, [bridge, book, bookSettled, nonce]);

  // ---- 左侧 iframe：告诉它进入「只读书库」模式，并接住它发来的动作 ----
  React.useEffect(() => {
    function onMessage(event) {
      // 同源校验：面板由 Harness 自己的 webServer 提供，必须同源才认。
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || typeof data !== "object") return;

      if (data.type === "apple-read:ready") {
        // iframe 就绪后隐藏它自带的聊天栏：对话已经交给右侧原生会话了。
        postToFrame(frameRef.current, { type: "apple-read:embed", value: true });
        return;
      }
      if (data.type === "apple-read:book") {
        setStatus(data.book ? `在读《${data.book}》` : "读在「图书」App · 问在这里");
        // 书名到了就定下来：上面的 effect 会按这本书去复用（或新建）会话。
        if (data.book) {
          setBook(String(data.book));
          setBookSettled(true);
        }
        // 阅读上下文不在这里登记：新会话由上面的 effect 异步打开，此刻闭包里的 chat
        // 很可能还是**旧书**的会话，会把新书登记进旧会话（串书回答的直接原因）。
        // 登记改到 effect 里拿到 ref 之后做，保证 (book, sessionId) 是配对的。
        return;
      }
      if (data.type === "apple-read:ask") {
        void askRef.current?.(data);
      }
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
    // 不再依赖 chat：处理器只用稳定的 setter 和 ref，避免每次换会话都重挂监听。
  }, []);

  // ---- 「问 AI」：准备材料 → 送进原生输入框 ----
  askRef.current = async (data) => {
    if (!bridge || !chat) {
      setError("会话还没就绪，请稍候再试");
      return;
    }
    const book = String(data.book || "");
    const question = String(data.question || "这句在讲什么？为什么值得划？");
    setStatus("正在准备材料…");
    let payload;
    try {
      const res = await fetch(`${API}/prepare-chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sessionId: chat.sessionId,
          book,
          annotationId: data.annotationId ?? null,
          // 「在书里找」点某段问 AI 时带上整段原文：
          // 宿主会把它标成「用户正在问的这段」，并用它本身去检索。
          passage: data.passage && data.passage.text
            ? { chapter: String(data.passage.chapter || ""), text: String(data.passage.text) }
            : null,
          question,
        }),
      });
      payload = await res.json();
      if (!res.ok || !payload || payload.ok !== true) {
        throw new Error((payload && payload.error) || `HTTP ${res.status}`);
      }
    } catch (e) {
      setError(`准备阅读材料失败：${String((e && e.message) || e)}`);
      setStatus("");
      return;
    }

    setError(payload.focusError ? `你点的那条标注没取到：${payload.focusError}` : "");
    setStatus(`${payload.markCount} 条标注 · ${payload.hits} 段原文 · ${payload.reranked ? "已精排" : "未精排"}`);
    try {
      await bridge.sendPrompt(chat, payload.prompt);
    } catch (e) {
      setError(String((e && e.message) || e));
    }
  };

  // 嵌入原生会话用的是 Harness 未文档化的内部接口。父条目一旦声明了 children
  // 却没有对应的子槽注册上（版本不匹配），renderSlot 会在**渲染期**抛
  // SlotAssemblyError。这里兜住它：降级成一句人话，别让整个面板白屏。
  const NOT_SUPPORTED = "当前 Harness 版本不支持把原生会话嵌进插件面板。左侧书库与标注仍可正常使用。";
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
      chat ? NOT_SUPPORTED : "正在准备 Harness 会话…"
    );
  }

  // 把「当前书 + 开场问题处理器」交给子槽里的开场页。
  // 子槽是 session 作用域，拿不到这里的 props，所以走模块级桥。
  heroBridge.book = book;
  heroBridge.onAsk = (q) => { void askRef.current({ book, question: q }); };

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
      React.createElement("span", { style: TITLE_STYLE }, "📚 DSH-apple-Read"),
      React.createElement("span", { style: HINT_STYLE, title: status }, status),
      React.createElement(
        "button",
        {
          type: "button",
          style: BUTTON_STYLE,
          disabled: !chat || !book,
          title: book ? `丢掉《${book}》当前的对话，另起一个` : "先在左边选一本书",
          onClick: () => { forceNewRef.current = true; setNonce((n) => n + 1); },
        },
        "新对话"
      ),
      React.createElement(
        "button",
        { type: "button", style: BUTTON_STYLE, title: "返回 DeepSeek Harness 对话", onClick: onBack },
        "← 返回对话"
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
          title: "DSH-apple-Read · 书库与标注",
          style: FRAME_STYLE,
          // 双向握手：iframe 加载完主动发一次，它也有一条 ready 主动发一次。
          // 只靠一边的话，先加载完的那一侧消息会丢掉。
          onLoad: () => postToFrame(frameRef.current, { type: "apple-read:embed", value: true }),
        })
      ),
      conversation
    )
  );
}

export const inject = ["slots", "layout"];

export function apply(ctx) {
  const bridge = createBridge(ctx);

  // 注册动作必须逐个兜住：这些是 Harness 未文档化的内部接口，版本一变就可能抛。
  // 一次抛错不该让整个插件加载失败——最差也要保住「书库与标注」这条主线。
  // 注意：slots.inject 的回调是**延迟**执行的（等槽位出现），所以 try 必须包在回调里面。
  const warn = (what, e) => {
    try { ctx.logger?.warn?.(`apple-read: 注册「${what}」失败，已跳过：${e && e.message}`); }
    catch { /* logger 不可用就算了 */ }
  };

  ctx.slots.inject("sidebar.panellist", () => {
    try {
      ctx.slots.register(
        { name: "sidebar.panellist", id: PANEL_ID, order: 21, label: "图书" },
        BooksIcon
      );
    } catch (e) { warn("侧边栏入口", e); }
  });

  // 父条目：把原生会话要挂的 session 作用域子槽声明出来。
  // 声明即认领——没在这里声明，下面那步 register 会在加载时直接抛错。
  ctx.slots.inject("main", () => {
    try {
      ctx.slots.register(
        {
          name: "main",
          key: PANEL_ID,
          children: { [CHAT_SLOT]: { kind: "single", scope: "session" } },
          inject: () => ({ onBack: () => ctx.layout.selectPanel(null), bridge }),
        },
        BooksPage
      );
    } catch (e) { warn("主面板", e); }
  });

  // 子条目：真正渲染原生会话。
  ctx.slots.inject(CHAT_SLOT, () => {
    try {
      ctx.slots.register({ name: CHAT_SLOT }, NativeConversation);
    } catch (e) { warn("原生会话子槽", e); }
  });
}

export { PANEL_ID };
