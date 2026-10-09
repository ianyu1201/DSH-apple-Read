"use strict";
/* DSH-apple-Read · 面板前端（同源 iframe，直接打 /apple-read/api/*） */

const API = "/apple-read/api";
const $ = (s) => document.querySelector(s);

const state = {
  books: [],
  annotations: [],
  current: null,
  providerId: null,
  history: [],
  sending: false,
  filter: "",
  withMarks: true,   // 聊天时是否把「我划的重点」一起喂给模型
  rerank: false,     // 是否用 cross-encoder 精排（boot 时按模型是否已下载决定）
  focusId: null,     // 点了「问 AI」的那条标注，会排到最前面
  hits: [],          // 「在书里找」的检索结果
};

// --------------------------------------------------------------------------- //
// 与父窗口（DSH 插件面板）通信
// --------------------------------------------------------------------------- //
// 面板被插件内嵌成左侧书库栏时，父窗口会发 `embed: true`：隐藏这里自带的聊天栏，
// 把「选书」和「问 AI」转交给父窗口 —— 对话交给右侧的 Harness 原生会话。
const embed = { on: false };

function toParent(message) {
  try {
    window.parent.postMessage(message, window.location.origin);
  } catch { /* 不在 iframe 里（直接打开 /apple-read/ 时） */ }
}

window.addEventListener("message", (ev) => {
  // 同源校验：父窗口就是提供这个页面的 Harness webServer
  if (ev.origin !== window.location.origin) return;
  const d = ev.data;
  if (d && typeof d === "object" && d.type === "apple-read:embed") {
    embed.on = d.value !== false;
    document.body.classList.toggle("embed", embed.on);
  }
});

// --------------------------------------------------------------------------- //
// 小工具
// --------------------------------------------------------------------------- //

async function api(path, opts) {
  const r = await fetch(API + path, opts);
  const text = await r.text();
  let j = null;
  try { j = JSON.parse(text); } catch { /* 非 JSON */ }
  if (!r.ok) {
    throw new Error((j && (j.error || j.detail)) || text.slice(0, 200) || ("HTTP " + r.status));
  }
  if (j === null) throw new Error("响应不是 JSON");
  return j;
}

/**
 * 把面板上的选择写回存档，并**读回确认**。
 *
 * 设置存在宿主侧 data.json（GET/POST /api/settings）。面板以前只改内存里的
 * state，刷新页面就被 config 默认值冲掉——provider 选择看起来「不保存」就是这个原因。
 * 保存失败只提示，不打断阅读。
 */
async function persistSettings(patch) {
  try {
    const r = await api("/settings", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    });
    const s = r && r.settings;
    if (s) {
      // 以服务端读回的值回填：万一被白名单校验挡掉，UI 不会显示一个其实没存上的值。
      if (typeof s.withMarks === "boolean") state.withMarks = s.withMarks;
      if (typeof s.rerank === "boolean") state.rerank = s.rerank;
      if (typeof s.providerId === "string") state.providerId = s.providerId;
    }
    return s || null;
  } catch (e) {
    toast("保存设置失败：" + e.message, true);
    return null;
  }
}

let toastTimer = null;
function toast(msg, isErr) {
  const el = $("#toast");
  el.textContent = msg;
  el.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = "toast"; }, isErr ? 5200 : 2600);
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

/**
 * 极简 markdown：标题、无序/有序列表、引用、行内代码、**加粗**。
 * 模型回答基本是「**小标题** + 列表 + 引原文」这个结构，只处理加粗的话读起来是一坨。
 * 内容来自书，不做富文本猜测——没匹配上的一律当纯文本。
 */
function md(s) {
  const out = [];
  let list = null; // "ul" | "ol" | null
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of esc(s).split("\n")) {
    const line = raw
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`([^`]+)`/g, "<code>$1</code>");
    const h = line.match(/^(#{1,5})\s+(.+)$/);
    const ul = line.match(/^\s*[-*•]\s+(.+)$/);
    const ol = line.match(/^\s*\d+[.、)]\s+(.+)$/);
    const bq = line.match(/^&gt;\s?(.*)$/);
    if (h) {
      closeList();
      const lv = Math.min(h[1].length + 2, 5);
      out.push(`<h${lv}>${h[2]}</h${lv}>`);
    } else if (ul) {
      if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
      out.push(`<li>${ul[1]}</li>`);
    } else if (ol) {
      if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
      out.push(`<li>${ol[1]}</li>`);
    } else if (bq) {
      closeList();
      out.push(`<blockquote>${bq[1]}</blockquote>`);
    } else if (!line.trim()) {
      closeList();
    } else {
      closeList();
      out.push(`<p>${line}</p>`);
    }
  }
  closeList();
  return out.join("");
}

function setStatus(msg) { $("#libstatus").textContent = msg || ""; }

// --------------------------------------------------------------------------- //
// 启动
// --------------------------------------------------------------------------- //

async function boot() {
  try {
    const cfg = await api("/config");
    // 存档读不到不是致命错误：退回 config 默认值继续可用。
    const st = await api("/settings").catch(() => null);
    const saved = (st && st.settings) || null;

    // provider：优先用存过的，其次才是 config 的默认值。
    // （以前无条件用 defaultProviderId，用户选完一刷新就回到默认。）
    const ids = cfg.providers.map((p) => p.id);
    state.providerId = saved && ids.includes(saved.providerId) ? saved.providerId : cfg.defaultProviderId;
    $("#provider").innerHTML = cfg.providers.map((p) =>
      `<option value="${esc(p.id)}">${esc(p.displayName)}${p.hasKey ? "" : "（未配置 Key）"}</option>`).join("");
    $("#provider").value = state.providerId;

    // 「带上我划的重点」：存档优先
    if (saved && typeof saved.withMarks === "boolean") {
      state.withMarks = saved.withMarks;
      $("#withMarks").checked = saved.withMarks;
    }

    // 精排开关：模型没下载就灰掉并说明，避免「勾了却没效果」
    const rr = $("#withRerank");
    if (cfg.rerank) {
      // 存过就按存档，没存过就用控件当前默认勾选态
      state.rerank = saved && typeof saved.rerank === "boolean" ? saved.rerank : rr.checked;
      rr.checked = state.rerank;
      $("#rrwrap").title = `精排已启用（${cfg.rerankModel}）：检索到的段落会被 cross-encoder 重新打分，命中更准，慢约 1.8 秒`;
    } else {
      rr.checked = false;
      rr.disabled = true;
      state.rerank = false;
      $("#rrwrap").classList.add("off");
      $("#rrwrap").title = "精排模型还没下载（约 1GB，一次性）。"
        + "在终端跑：cd DSH-apple-Read && uv run books_rag.py rerank-setup";
    }
  } catch (e) {
    toast("读取配置失败：" + e.message, true);
  }

  $("#provider").addEventListener("change", (e) => {
    state.providerId = e.target.value;
    void persistSettings({ providerId: state.providerId });
  });

  await loadLibrary();

  // 告诉父窗口「我准备好了」：它会回一条 embed 指令，把这里切成书库栏模式。
  toParent({ type: "apple-read:ready" });
}

async function loadLibrary() {
  $("#books").innerHTML = '<div class="empty">正在读取书库…</div>';
  try {
    const data = await api("/books");
    state.books = data.books || [];
    $("#engine").textContent = "引擎就绪";
    $("#engine").className = "engine ok";
  } catch (e) {
    $("#engine").textContent = "引擎启动失败";
    $("#engine").className = "engine bad";
    $("#books").innerHTML = `<div class="empty">读不到书库：${esc(e.message)}</div>`;
    setStatus("检查 uv 路径与 books_rag.py 依赖");
    return;
  }

  try {
    const a = await api("/annotations?limit=200");
    state.annotations = a.annotations || [];
  } catch {
    state.annotations = [];
  }

  const counts = {};
  for (const a of state.annotations) counts[a.book] = (counts[a.book] || 0) + 1;
  for (const b of state.books) b.ann_count = counts[b.title] || 0;

  const indexed = state.books.filter((b) => b.indexed).length;
  setStatus(`${state.books.length} 本 · 已索引 ${indexed} · 标注 ${state.annotations.length} 条`);
  renderBooks();

  // 打开面板直接落在「最近在读」那本上，省得每次都要去左栏翻。
  // last_opened 是 "YYYY-MM-DD HH:MM" 字符串，字典序即时间序。
  if (!state.current && state.books.length) {
    const recent = state.books
      .filter((b) => b.last_opened)
      .sort((a, b) => String(b.last_opened).localeCompare(String(a.last_opened)))[0];
    selectBook((recent || state.books[0]).id);
  }
}

// --------------------------------------------------------------------------- //
// 书库列表
// --------------------------------------------------------------------------- //

function renderBooks() {
  const q = state.filter.trim().toLowerCase();
  const list = state.books.filter((b) =>
    !q || b.title.toLowerCase().includes(q) || (b.author || "").toLowerCase().includes(q));
  const el = $("#books");
  $("#nBooks").textContent = list.length ? String(list.length) : "";
  if (!list.length) {
    el.innerHTML = '<div class="empty">没有匹配的书。</div>';
    return;
  }
  el.innerHTML = list.map((b) => `
    <div class="book${state.current && state.current.id === b.id ? " active" : ""}" data-id="${esc(b.id)}">
      <div class="t">${esc(b.title)}</div>
      <div class="m">
        ${b.author ? `<span>${esc(b.author)}</span>` : ""}
        ${b.indexed ? '<span class="badge idx">已索引</span>' : '<span class="badge">未索引</span>'}
        ${b.progress ? `<span>${b.progress}%</span>` : ""}
        ${b.ann_count ? `<span>${b.ann_count} 标注</span>` : ""}
      </div>
    </div>`).join("");
  el.querySelectorAll(".book").forEach((node) => {
    node.addEventListener("click", () => selectBook(node.dataset.id, true));
  });
}

function selectBook(id, userPicked) {
  const b = state.books.find((x) => x.id === id);
  if (!b) return;
  if (!state.current || state.current.id !== b.id) {
    state.history = [];
    state.focusId = null;
    $("#chat").innerHTML = '<div class="hint">已切到这本书，对话重新开始。</div>';
  }
  state.current = b;
  const t = $("#booktitle");
  t.textContent = b.title + (b.author ? ` — ${b.author}` : "");
  t.title = b.title;
  t.classList.remove("placeholder");
  $("#openBook").disabled = false;
  const ib = $("#indexBook");
  ib.disabled = false;
  ib.textContent = b.indexed ? "重建索引" : "建索引";
  renderBooks();
  renderAnnotations();
  resetHits();   // 换了书，旧的检索结果就不成立了
  // 告诉父窗口在读哪本：它会把这个登记成当前会话的阅读上下文，
  // 这样用户直接在右边原生输入框里打字提问，模型也知道在读什么。
  toParent({ type: "apple-read:book", book: b.title });

  // 窄栏里手动选完书就跳到「重点」：选书的下一步几乎总是看这本书的标注。
  // 开机自动选中「最近在读」那本时不算手动（userPicked 为空），会停在书库 Tab。
  if (userPicked && narrow()) setTab("marks");
}

// --------------------------------------------------------------------------- //
// 高亮 / 笔记
// --------------------------------------------------------------------------- //

function renderAnnotations() {
  const el = $("#annlist");
  if (!state.current) {
    $("#annsum").textContent = "我划的重点";
    el.innerHTML = '<div class="empty">选中书籍后显示。</div>';
    return;
  }
  const mine = state.annotations.filter((a) => a.book === state.current.title);
  $("#annsum").textContent = `我划的重点（${mine.length}）`;
  $("#nMarks").textContent = mine.length ? String(mine.length) : "";
  $("#markhint").textContent = state.withMarks && mine.length ? `会带上这 ${mine.length} 条` : "";
  if (!mine.length) {
    el.innerHTML = state.annotations.length
      ? '<div class="empty">这本书还没有高亮或笔记。去「图书」App 里划一句，回来就能问。</div>'
      : '<div class="empty">读不到标注库。要给 DeepSeek Harness 授予「完全磁盘访问权限」并重启；全文问答不受影响。</div>';
    return;
  }
  el.innerHTML = mine.map((a) => `
    <div class="ann" data-id="${a.id}">
      <div class="q">${esc(a.text || a.note || "(无正文)")}</div>
      ${a.note && a.text ? `<div class="meta">笔记：${esc(a.note)}</div>` : ""}
      <div class="meta">
        <span>${esc(a.color)} · ${esc(a.modified || "")}</span>
        <button class="askbtn" data-ask="${a.id}">问 AI</button>
        <button class="linkbtn" data-ctx="${a.id}">看上下文</button>
      </div>
    </div>`).join("");
  el.querySelectorAll("[data-ask]").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const a = state.annotations.find((x) => x.id === Number(btn.dataset.ask));
      if (a) askAbout(a);
    });
  });
  el.querySelectorAll("[data-ctx]").forEach((btn) => {
    btn.addEventListener("click", async (ev) => {
      ev.stopPropagation();
      const id = Number(btn.dataset.ctx);
      const holder = btn.closest(".ann");
      const old = holder.querySelector(".ctx");
      if (old) { old.remove(); return; }
      btn.textContent = "载入中…";
      try {
        const res = await api("/context", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, before: 400, after: 400 }),
        });
        if (res.error) throw new Error(res.error);
        const div = document.createElement("div");
        div.className = "ctx";
        div.textContent = `章节「${res.chapter || "?"}」${res.exact ? "" : "（近似定位）"}\n\n${res.context || ""}`;
        holder.appendChild(div);
        btn.textContent = "收起";
      } catch (e) {
        toast("取上下文失败：" + e.message, true);
        btn.textContent = "看上下文";
      }
    });
  });
}

// --------------------------------------------------------------------------- //
// 在书里找（向量语义检索 + 可选精排）
// --------------------------------------------------------------------------- //
// 宿主早就暴露了 /api/search，面板一直没接。它和「我划的重点」是同一类东西
// ——都关于当前这本书，所以放在同一个区域，点某段的「问 AI」走同一条原生会话通道。

async function doSearch() {
  const q = $("#q").value.trim();
  if (!q) return;
  if (!state.current) { toast("先在「书库」里选一本书", true); return; }

  const btn = $("#doSearch");
  btn.disabled = true;
  $("#hits").innerHTML = '<div class="empty">检索中…（首次问某本书会自动建索引，可能要几十秒）</div>';
  try {
    const res = await api("/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ book: state.current.title, query: q, k: 6, rerank: state.rerank }),
    });
    state.hits = res.hits || [];
    $("#searchsum").textContent = `在书里找（${state.hits.length}）`;
    renderHits(res.reranked);
  } catch (e) {
    state.hits = [];
    $("#searchsum").textContent = "在书里找";
    $("#hits").innerHTML = `<div class="empty">检索失败：${esc(e.message)}</div>`;
  } finally {
    btn.disabled = false;
  }
}

function renderHits(reranked) {
  const el = $("#hits");
  if (!state.hits.length) {
    el.innerHTML = '<div class="empty">没找到相关段落。换个说法再试——这是语义检索，不必和原文用词一致。</div>';
    return;
  }
  el.innerHTML = state.hits.map((h, i) => {
    const text = h.text || "";
    return `<div class="hit">
      <div class="meta">
        <span class="ch">${i + 1}. 章节「${esc(h.chapter || "?")}」</span>
        <span class="sc">${esc(String(h.score ?? ""))}</span>
        <button class="askbtn" data-askhit="${i}">问 AI</button>
      </div>
      <div class="q">${esc(text.slice(0, 400))}${text.length > 400 ? "…" : ""}</div>
    </div>`;
  }).join("") + (reranked ? '<div class="empty">已用 cross-encoder 精排</div>' : "");

  el.querySelectorAll("[data-askhit]").forEach((b) => {
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const h = state.hits[Number(b.dataset.askhit)];
      if (h) askAboutPassage(h);
    });
  });
}

/** 就检索到的某一段开聊。 */
function askAboutPassage(h) {
  const question = "这段在讲什么？";
  // 嵌入模式：交给右侧原生会话。原文整段随 passage 一起走，
  // 宿主的阅读上下文会把它标成「用户正在问的这段」。
  if (embed.on) {
    toParent({
      type: "apple-read:ask",
      book: state.current ? state.current.title : "",
      passage: { chapter: h.chapter || "", text: h.text || "" },
      question,
    });
    return;
  }
  $("#input").value = `「${(h.text || "").slice(0, 80)}…」这段在讲什么？`;
  send();
}

function resetHits() {
  state.hits = [];
  $("#searchsum").textContent = "在书里找";
  $("#hits").innerHTML = '<div class="empty">输入一句话，在整本书里找相关段落。</div>';
}

// --------------------------------------------------------------------------- //
// 聊天
// --------------------------------------------------------------------------- //

function scrollChat() { const c = $("#chat"); c.scrollTop = c.scrollHeight; }

function addMsg(role, text) {
  const wrap = document.createElement("div");
  wrap.className = "msg " + role;
  wrap.innerHTML = `<div class="who">${role === "user" ? "我" : "AI"}</div><div class="body"></div>`;
  const body = wrap.querySelector(".body");
  body.textContent = text || "";
  $("#chat").appendChild(wrap);
  scrollChat();
  return wrap;
}

/** 就某条高亮一键开聊：把那条排到最前面，并问一个具体的开场问题。 */
function askAbout(a) {
  const snippet = (a.text || a.note || "").slice(0, 60);
  state.focusId = a.id;

  // 嵌入模式：这里没有自己的聊天栏，把这条交给右侧的 Harness 原生会话。
  // 问题只问「这句」，标注原文、章节、前后原文和全书检索依据由宿主组装后
  // 按 session 注入，不需要塞进这句话里。
  if (embed.on) {
    toParent({
      type: "apple-read:ask",
      book: state.current ? state.current.title : "",
      annotationId: a.id,
      question: "这句在讲什么？为什么值得划？",
    });
    return;
  }

  $("#input").value = `我划了这句：「${snippet}${(a.text || "").length > 60 ? "…" : ""}」这句在讲什么？为什么值得划？`;
  send();
}

async function send() {
  const input = $("#input");
  const q = input.value.trim();
  if (!q || state.sending) return;
  if (!state.current) { toast("先在「书库」里选一本书", true); return; }

  input.value = "";
  input.style.height = "auto";
  state.history.push({ role: "user", content: q });
  addMsg("user", q);

  state.sending = true;
  $("#send").disabled = true;
  const asst = addMsg("assistant", "");
  const bodyEl = asst.querySelector(".body");
  let thinkBox = null;
  let thinkBody = null;

  const focus = state.focusId;
  state.focusId = null;
  try {
    const resp = await fetch(API + "/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        book: state.current.title,
        providerId: state.providerId,
        messages: state.history,
        k: 6,
        includeAnnotations: state.withMarks,
        focusAnnotationId: focus,
        rerank: state.rerank,
      }),
    });
    if (!resp.ok) {
      const j = await resp.json().catch(() => ({}));
      throw new Error(j.error || ("HTTP " + resp.status));
    }

    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let answer = "";
    let failed = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (obj.type === "text") {
          answer += obj.text;
          bodyEl.innerHTML = md(answer);
          scrollChat();
        } else if (obj.type === "thinking") {
          if (!thinkBox) {
            thinkBox = document.createElement("details");
            thinkBox.className = "think";
            thinkBox.innerHTML = "<summary>推理过程</summary>";
            thinkBody = document.createElement("div");
            thinkBox.appendChild(thinkBody);
            asst.parentNode.insertBefore(thinkBox, asst);
          }
          thinkBody.textContent += obj.text;
          scrollChat();
        } else if (obj.type === "context") {
          const bits = [];
          if (obj.marks) bits.push(`你划的 ${obj.marks} 条重点`);
          if (obj.hits) bits.push(obj.reranked ? "全书检索（已精排）" : "全书检索");
          if (bits.length) {
            const note = document.createElement("div");
            note.className = "ctxnote";
            note.textContent = "依据：" + bits.join(" + ");
            asst.parentNode.insertBefore(note, asst);
          }
          // 点了某条标注却取不到它的原文时，明确提示——否则用户以为问了，
          // 模型其实没拿到那一句，只能凭印象答。
          if (obj.focusError) toast("你点的那条标注没取到：" + obj.focusError, true);
        } else if (obj.type === "error") {
          failed = obj.message;
        }
      }
    }
    if (failed) throw new Error(failed);
    if (answer) state.history.push({ role: "assistant", content: answer });
  } catch (e) {
    asst.classList.add("err");
    bodyEl.textContent = "出错：" + e.message;
  } finally {
    state.sending = false;
    $("#send").disabled = false;
    input.focus();
  }
}

// --------------------------------------------------------------------------- //
// 动作
// --------------------------------------------------------------------------- //

async function openBook() {
  if (!state.current) return;
  try {
    const r = await api("/open", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ book: state.current.title }),
    });
    toast(r.message || "已打开");
  } catch (e) { toast("打开失败：" + e.message, true); }
}

async function indexBook(book, quiet) {
  // 已经索引过的书再点就是「重建」，必须显式 force，
  // 否则后端发现索引还在、书也没变，会直接跳过 —— 按钮就成了骗人的。
  const r = await api("/index", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ book: book.title, force: !!book.indexed }),
  });
  if (r.error) throw new Error(r.error);
  book.indexed = true;
  if (!quiet) toast(`《${book.title}》索引完成：${r.chunks} 段`);
  return r;
}

async function indexAll() {
  const todo = state.books.filter((b) => !b.indexed);
  if (!todo.length) { toast("所有书都已建索引"); return; }
  const btn = $("#indexAll");
  btn.disabled = true;
  let done = 0, failed = 0;
  for (const b of todo) {
    setStatus(`建索引 ${done + failed + 1}/${todo.length}：《${b.title}》`);
    try { await indexBook(b, true); done++; }
    catch { failed++; }
  }
  btn.disabled = false;
  setStatus(`${state.books.length} 本 · 已索引 ${state.books.filter((b) => b.indexed).length} · 标注 ${state.annotations.length} 条`);
  renderBooks();
  toast(`索引完成：成功 ${done}${failed ? `，失败 ${failed}` : ""}`);
}

// --------------------------------------------------------------------------- //
// 窄栏 Tab（书库 / 重点 / 在书里找）
// --------------------------------------------------------------------------- //
// 340px 宽的嵌入栏里，三个区上下堆叠会互相抢高度：书库被压到 42%，列表只露五六本。
// 改成一次只显示一个，每个区都拿到完整高度。宽屏下 Tab 栏被 CSS 隐藏，
// 这里的逻辑照跑但不会影响左右两栏布局。

const TABS = ["books", "marks", "search"];
const narrow = () => window.matchMedia("(max-width: 720px)").matches;

function setTab(name, opts) {
  if (!TABS.includes(name)) name = "books";
  document.body.dataset.tab = name;
  document.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("on", b.dataset.tab === name);
  });
  // Tab 模式下折叠头被 CSS 藏了，details 必须显式展开，否则内容区是空的
  if (name === "marks") $("#annbox").open = true;
  if (name === "search") {
    $("#searchbox").open = true;
    if (opts && opts.focus) setTimeout(() => $("#q").focus(), 0);
  }
}

// --------------------------------------------------------------------------- //
// 事件绑定
// --------------------------------------------------------------------------- //

$("#send").addEventListener("click", send);
$("#input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$("#input").addEventListener("input", (e) => {
  const t = e.target;
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 160) + "px";
});
$("#filter").addEventListener("input", (e) => { state.filter = e.target.value; renderBooks(); });
$("#doSearch").addEventListener("click", doSearch);
$("#q").addEventListener("keydown", (e) => {
  // isComposing：中文输入法选词时的回车不能当成提交
  if (e.key === "Enter" && !e.isComposing) { e.preventDefault(); doSearch(); }
});
$("#withMarks").addEventListener("change", (e) => {
  state.withMarks = e.target.checked;
  renderAnnotations();
  void persistSettings({ withMarks: state.withMarks });
});
$("#withRerank").addEventListener("change", (e) => {
  state.rerank = e.target.checked;
  void persistSettings({ rerank: state.rerank });
});
$("#openBook").addEventListener("click", openBook);
$("#clearChat").addEventListener("click", () => {
  state.history = [];
  state.focusId = null;
  $("#chat").innerHTML = '<div class="hint">已清空。接着问吧。</div>';
  toast("对话已清空");
});
$("#indexBook").addEventListener("click", async () => {
  if (!state.current) return;
  const btn = $("#indexBook");
  btn.disabled = true;
  btn.textContent = "建索引中…";
  toast("正在建索引，可能要几十秒…");
  try {
    await indexBook(state.current, false);
    renderBooks();
    renderAnnotations();
  } catch (e) {
    toast("建索引失败：" + e.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = state.current.indexed ? "重建索引" : "建索引";
  }
});
$("#indexAll").addEventListener("click", indexAll);

// Tab 切换（只在窄栏有意义；宽屏下 Tab 栏被 CSS 隐藏，点了也看不到）
$("#tabs").addEventListener("click", (ev) => {
  const btn = ev.target.closest(".tab");
  if (btn) setTab(btn.dataset.tab, { focus: btn.dataset.tab === "search" });
});
// 窗口在「窄 / 宽」之间变化时，若此刻正停在某个 Tab，重新对齐一次
window.addEventListener("resize", () => {
  if (narrow()) setTab(document.body.dataset.tab || "books");
});
setTab("books");

boot();
