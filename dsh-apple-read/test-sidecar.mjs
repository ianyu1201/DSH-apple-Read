/**
 * sidecar 单例化 / 孤儿回收 / 退出清理的端到端测试。
 *
 * 为什么单独一个文件：UV_BIN 和 SIDECAR_FILE 都是模块级常量，在 `import` 那一刻就读
 * process.env，所以必须「先设环境变量，再 import」，塞不进 test-host.mjs。
 *
 * 这里用一个假的 uv（fake-uv.sh → node fake-uv.mjs）冒充
 * `uv run books_rag.py serve-http --port 0`，于是 spawn / 复用 / 回收整条链路都能
 * 离线、秒级跑完——不需要真模型、不需要联网、不需要 uv。
 *
 * 跑法（在 dsh-apple-read 目录）：node test-sidecar.mjs
 *
 * 注意：孤儿回收靠 `ps -eo pid,command` 找 serve-http 进程。在禁止 ps 的环境里
 * （沙箱、部分 CI）[4] 那条会失败——那是 findSidecarPids() 的既定降级行为
 * （找不到就不回收，不影响主流程），不是插件坏了。想在无 ps 环境跑全绿，
 * 就把 [4] 的孤儿断言跳过。
 */
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TMP = join(tmpdir(), `apple-read-sidecar-test-${process.pid}`);
const FAKE = join(TMP, "fake-uv.mjs");
const FAKE_SH = join(TMP, "fake-uv.sh");
const SPAWN_LOG = join(TMP, "spawns.log");
const PIDFILE = join(TMP, "sidecar.json");
const STORE = join(TMP, "store.json");

mkdirSync(TMP, { recursive: true });

// ---------- 假 uv：冒充 books_rag.py serve-http ----------
// 命令行里保留 "books_rag.py serve-http"，这样插件按 ps 回收时能匹配到它，
// 回收逻辑才算真的被覆盖到。
writeFileSync(FAKE, `
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";
const log = process.env.FAKE_UV_LOG;
if (log) appendFileSync(log, process.pid + "\\n");
const srv = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, annotations: 0, rerank: false, rerank_model: null }));
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ fake: true, hits: [], title: "FAKE" }));
});
srv.listen(0, "127.0.0.1", () => console.log(JSON.stringify({ port: srv.address().port })));
`);
writeFileSync(FAKE_SH, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
chmodSync(FAKE_SH, 0o755);

process.env.APPLE_READ_UV = FAKE_SH;
process.env.APPLE_READ_SIDECAR = PIDFILE;
process.env.APPLE_READ_STORE = STORE;
process.env.FAKE_UV_LOG = SPAWN_LOG;
process.env.APPLE_READ_INDEX = join(TMP, "index");

// ---------- 断言工具 ----------
let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m, d) => { fail++; console.log("  ✗ " + m + (d ? " — " + d : "")); };

const spawnCount = () => (existsSync(SPAWN_LOG) ? readFileSync(SPAWN_LOG, "utf8").trim().split("\n").filter(Boolean).length : 0);
const pidAlive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; } };
const readPidfile = () => { try { return JSON.parse(readFileSync(PIDFILE, "utf8")); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await fn()) return true; await sleep(60); }
  return false;
}

// ---------- 假 ctx（照抄 test-host.mjs 的形状） ----------
const disposers = [];
function makeCtx() {
  return {
    logger: { warn() {}, info() {} },
    effect(fn) { const d = fn(); if (typeof d === "function") disposers.push(d); return d; },
    skills: { registerProvider() {} },
    inject(deps, fn) {
      if (deps.includes("webServer")) {
        fn({ webServer: { register(o) { routeHandler = o.handler; return () => {}; } }, effect(f) { return f(); } });
      }
      if (deps.includes("systemPrompt")) {
        fn({ systemPrompt: { context() { return () => {}; } }, effect(f) { return f(); } });
      }
    },
  };
}
let routeHandler = null;

// ---------- 挂到真 http ----------
const server = createServer((req, res) => {
  Promise.resolve(routeHandler(req, res)).catch((e) => {
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end(String(e));
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* 非 JSON */ }
  return { status: r.status, json };
}

// ---------- 装载插件 ----------
// 加 query 强制新模块实例，用来模拟「插件重载」
let modSeq = 0;
async function loadPlugin() {
  const mod = await import(`./lib/index.js?t=${++modSeq}`);
  mod.apply(makeCtx());
}

try {
  // ================= [1] pidfile 指向死进程 → 不采纳，重新拉起 =================
  console.log("\n[1] 残留 pidfile（死进程）不采纳，重新拉起");
  writeFileSync(PIDFILE, JSON.stringify({ pid: 999999, port: 1, startedAt: 0 }));
  await loadPlugin();

  const r1 = await post("/apple-read/api/search", { book: "x", query: "y" });
  r1.status === 200 && r1.json?.fake === true
    ? ok("请求打通了 sidecar（走的是假 uv）")
    : bad("请求没打通 sidecar", `status=${r1.status} body=${JSON.stringify(r1.json)}`);
  spawnCount() === 1 ? ok("死 pidfile 被拒绝，拉起了 1 个新 sidecar") : bad(`spawn 次数应为 1，实际 ${spawnCount()}`);

  const pf1 = readPidfile();
  pf1 && pf1.port > 0 && pidAlive(pf1.pid)
    ? ok(`pidfile 写好了（pid=${pf1.pid} port=${pf1.port}）`)
    : bad("pidfile 没写好", JSON.stringify(pf1));

  // ================= [2] 单例：第二次请求复用，不再 spawn =================
  console.log("\n[2] 单例：同实例内复用，不再 spawn");
  const r2 = await post("/apple-read/api/search", { book: "x", query: "y" });
  r2.status === 200 ? ok("第二次请求正常") : bad("第二次请求失败", String(r2.status));
  spawnCount() === 1 ? ok("没有重复 spawn（仍是 1 个进程）") : bad(`重复 spawn 了：${spawnCount()} 个`);

  // ================= [3] 插件重载：采纳已有 sidecar，不 spawn =================
  console.log("\n[3] 插件重载后采纳已有 sidecar（不清不重建）");
  const before = spawnCount();
  await loadPlugin();
  const r3 = await post("/apple-read/api/search", { book: "x", query: "y" });
  r3.status === 200 ? ok("重载后请求正常") : bad("重载后请求失败", String(r3.status));
  spawnCount() === before
    ? ok("复用了已有 sidecar（没有新 spawn）——插件重载不再重载模型")
    : bad(`重载后又 spawn 了：${before} → ${spawnCount()}`);

  // ================= [4] dispose：杀掉 sidecar + 删 pidfile =================
  console.log("\n[4] dispose 清理：不留孤儿进程");
  const livePid = readPidfile()?.pid;
  disposers.forEach((d) => { try { d(); } catch { /* ignore */ } });
  disposers.length = 0;

  const dead = await waitFor(() => !pidAlive(livePid), 5000);
  dead ? ok(`sidecar 进程 ${livePid} 已退出`) : bad(`sidecar 进程 ${livePid} 还活着（孤儿）`);
  !existsSync(PIDFILE) ? ok("pidfile 已删除") : bad("pidfile 没删掉");

  // ================= [5] 清理后能自愈：重新拉起 =================
  console.log("\n[5] 清理之后还能重新拉起（自愈）");
  await loadPlugin();
  const r5 = await post("/apple-read/api/search", { book: "x", query: "y" });
  r5.status === 200 ? ok("清理后请求正常") : bad("清理后请求失败", String(r5.status));
  spawnCount() === before + 1 ? ok("重新拉起了 1 个 sidecar") : bad(`spawn 次数应 +1，实际 ${spawnCount()}`);

  // ================= [6] 回收范围：只认「引擎绝对路径 + serve-http」 =================
  console.log("\n[6] 回收范围：精确匹配，不误伤别的进程");
  const src = readFileSync(new URL("./lib/index.js", import.meta.url), "utf8");
  // 必须用绝对路径拼，而不是裸的 `books_rag.py serve-http`：
  // 裸串会匹配到 grep / tail / 编辑器（实测：一条 grep 命令把自己 SIGTERM 掉了）。
  /ENGINE_MARK\s*=\s*`\$\{ENGINE\} serve-http`/.test(src)
    ? ok("匹配串是「引擎绝对路径 + serve-http」")
    : bad("匹配串没绑定引擎绝对路径（可能误伤 grep/tail 之类的进程）");
  src.includes("ancestorPids") && src.includes("self.has(")
    ? ok("排除自身与祖先进程，不会回收自己这条链")
    : bad("没有排除自身/祖先进程");
  !/line\.includes\("books_rag\.py serve-http"\)/.test(src)
    ? ok("不再用裸串 `books_rag.py serve-http` 匹配")
    : bad("还在用裸串匹配（会误伤无关进程）");
  !/books_rag\.py serve"\)/.test(src) ? ok("没有用 `serve` 做匹配（不会误杀 MCP）") : bad("匹配串可能误伤 MCP");
  src.includes("SIGTERM") && src.includes("SIGKILL")
    ? ok("先 SIGTERM 再兜底 SIGKILL")
    : bad("缺少兜底强杀");
} finally {
  // 收尾：只清掉**这一轮自己起的**假 sidecar。
  //
  // 以前这里除了 FAKE 还兜了一句 `books_rag.py serve-http`，那是个真事故：
  // 用户正在用的真 sidecar 命令行里同样含这个串，于是「跑一次测试」就会把它
  // SIGKILL 掉（插件会自己重启，所以表现为「测试完第一次提问特别慢」）。
  // 真 sidecar 的生命周期归插件管，测试只该收自己拉起来的那几个。
  const selfPids = new Set([process.pid, process.ppid]);
  const logPids = existsSync(SPAWN_LOG)
    ? readFileSync(SPAWN_LOG, "utf8").trim().split("\n").filter(Boolean).map(Number).filter(Boolean)
    : [];
  for (const pid of logPids) {
    if (selfPids.has(pid)) continue;
    try { process.kill(pid, "SIGKILL"); } catch { /* 已经没了 */ }
  }
  // 兜底：命令行里带 FAKE 路径的（假 uv 包装脚本自己也可能残留）
  try {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("ps", ["-eo", "pid,command"], { encoding: "utf8" });
    for (const line of out.split("\n")) {
      if (!line.includes(FAKE)) continue;              // ← 只认自己的假 uv，不碰真的
      const pid = Number(line.trim().match(/^(\d+)/)?.[1]);
      if (pid && !selfPids.has(pid) && !logPids.includes(pid)) {
        try { process.kill(pid, "SIGKILL"); } catch { /* ignore */ }
      }
    }
  } catch { /* ps 不可用就算了 */ }
  await new Promise((r) => server.close(r));
  rmSync(TMP, { recursive: true, force: true });
  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}
