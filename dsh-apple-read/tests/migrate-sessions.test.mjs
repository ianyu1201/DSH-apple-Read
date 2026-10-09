#!/usr/bin/env node
/**
 * migrate-sessions.test.mjs — 会话搬迁/删除工具的端到端测试。
 *
 * 这个工具会动用户的会话历史，所以每个路径都要有测试兜着：
 *   · 搬迁：目录/头部 cwd/投影缓存/workspace.json 四处一起改，事件字节不变
 *   · 搬迁失败：自动回滚，逐字节还原
 *   · 删除：只删空壳，有内容的会话默认拒删
 *   · 删除失败：自动回滚，逐字节还原
 *   · 编码器自检：拿真实目录名验证推算规则
 *
 * 全程在临时目录里跑，不碰真实 ~/.dsh。
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync,
  readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

// 注意：不能用 URL.pathname —— 路径里有中文和空格，pathname 会保留 %XX 转义
const TOOL = fileURLToPath(new URL("../tools/migrate-sessions.mjs", import.meta.url));
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log("  ✓ " + m); };
const bad = (m) => { fail++; console.log("  ✗ " + m); };
const A = (c, m) => (c ? ok(m) : bad(m));

/* ---------------------------------------------------------------- 工具函数 */

const FROM = "/Users/example/Documents/harness/default-workspace";
const TO = "/Users/example/Documents/harness/读书会话";

/** 和工具里的规则一致：把 cwd 编码成项目目录名。 */
function enc(p) {
  let body = p.replace(/^\//, "").replace(/\//g, "-");
  body = body.replace(/[^A-Za-z0-9._-]/g, (c) => "~" + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"));
  if (/[^A-Za-z0-9._-]$/.test(body)) body += "~";
  return "--" + body + "--";
}

function frames(buf) {
  const offs = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) offs.push(i);
  }
  return offs.map((s, k) => buf.subarray(s, k + 1 < offs.length ? offs[k + 1] : buf.length));
}
const decode = (b) => frames(b).map((f) => zstdDecompressSync(f).toString("utf8")).join("");

/** 造一个会话日志：第 0 帧只有头部（和真实布局一致），之后每批事件一帧。 */
function makeLog(id, cwd, batches, headerOverride) {
  const header = headerOverride ?? {
    type: "session", version: 4, id, createdAt: 1, cwd,
    isSeeded: false, delegationDepth: 0, agentPreset: "standard",
  };
  const out = [zstdCompressSync(Buffer.from(JSON.stringify(header) + "\n", "utf8"))];
  for (const b of batches) {
    out.push(zstdCompressSync(Buffer.from(b.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8")));
  }
  return Buffer.concat(out);
}

const EMPTY_BATCHES = [
  [{ type: "permission/preset", seq: 0, time: 1, data: { preset: "workspace-write" } }],
  [{ type: "approval/policy", seq: 1, time: 2, data: { policy: "ask" } }],
];

/**
 * 真实事件格式（从真日志里抄的，别凭印象写）：
 *   type = "user/message"，source.kind = "user" 才表示用户真的发了话。
 * 同一个 type 下 source.kind 还可能是 "runtime-context" / "skill-catalog" 等注入内容。
 *
 * 这里刻意**同时**造注入内容和真实消息：只有 source.kind==="user" 的那条才算数。
 * 之前用「type==="message" + role==="user"」这套臆想的 schema 写测试，
 * 结果代码和测试一起错，全绿但真跑会把所有会话当空壳 —— 所以 fixture 必须照抄真实格式。
 */
const realBatches = (txt) => [
  [{ type: "permission/preset", seq: 0, time: 1, data: { preset: "workspace-write" } }],
  [{ type: "user/message", seq: 1, time: 2, data: {
    content: [{ type: "text", text: "Current runtime context. This snapshot supersedes earlier ones." }],
    source: { kind: "runtime-context", form: "snapshot" },
    role: "user", id: "inj-1",
  } }],
  [{ type: "user/message", seq: 2, time: 3, data: {
    content: [{ type: "text", text: txt }],
    source: { kind: "user", rpcId: "rpc-1", clientTimeZone: "Asia/Shanghai" },
    role: "user", id: "u-1",
  } }],
  [{ type: "assistant/message", seq: 3, time: 4, data: { content: [{ type: "text", text: "回答" }], role: "assistant" } }],
];

/** 只有注入内容、没有真实用户消息 —— 工具应当把它当空壳。 */
const injectedOnlyBatches = () => [
  [{ type: "user/message", seq: 0, time: 1, data: {
    content: [{ type: "text", text: "<system-reminder>skills…</system-reminder>" }],
    source: { kind: "skill-catalog", form: "catalog" },
    role: "user", id: "inj-1",
  } }],
];

/** 在临时目录里搭一个假 DSH_HOME。 */
function fixture({ withTarget = true, sessions = [], workspaceTitle = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-mig-test-"));
  const fromDir = enc(FROM), toDir = enc(TO);
  mkdirSync(join(root, "sessions", fromDir), { recursive: true });
  mkdirSync(join(root, "storages", "session_projcache", "sessions"), { recursive: true });
  mkdirSync(join(root, "storages", "apple-read"), { recursive: true });

  const ids = [];
  for (const s of sessions) {
    ids.push(s.id);
    const d = join(root, "sessions", fromDir, s.id);
    mkdirSync(d, { recursive: true });
    const batches = s.batches ?? (s.empty ? EMPTY_BATCHES : realBatches(s.text || "问题"));
    writeFileSync(join(d, "session.v4.jsonl.zstd"), makeLog(s.id, FROM, batches));
    writeFileSync(join(root, "storages", "session_projcache", "sessions", s.id + ".json"),
      JSON.stringify({ version: 7, record: { identity: { cwd: FROM } } }));
  }

  let targetId = null;
  if (withTarget) {
    mkdirSync(join(root, "sessions", toDir), { recursive: true });
    targetId = "session-target-0000-0000-0000-000000000000";
    const d = join(root, "sessions", toDir, targetId);
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "session.v4.jsonl.zstd"), makeLog(targetId, TO, realBatches("新书第一问")));
  }

  const tables = {
    "ws-from": {
      path: FROM, title: workspaceTitle.from || "default-workspace",
      sessionIds: [...ids], createdAt: "x", updatedAt: "x",
    },
  };
  if (withTarget) {
    tables["ws-to"] = {
      path: TO, title: workspaceTitle.to || "读书会话",
      sessionIds: [targetId], createdAt: "x", updatedAt: "x",
    };
  }
  writeFileSync(join(root, "storages", "workspace.json"), JSON.stringify({
    unit: { name: "workspace", version: 2 },
    global: { initialized: true, defaultWorkspaceId: "ws-from", workspaceIds: Object.keys(tables), archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: tables },
  }, null, 2));

  writeFileSync(join(root, "storages", "apple-read", "data.json"),
    JSON.stringify({ version: 1, settings: {}, companionContexts: {} }));

  return { root, ids, targetId, fromDir, toDir };
}

/** 跑工具。用假 ps 绕过「Harness 在跑」检查（测试环境里本来就没跑）。 */
function run(root, args) {
  const fakeBin = mkdtempSync(join(tmpdir(), "dsh-fakebin-"));
  writeFileSync(join(fakeBin, "ps"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(fakeBin, "ps"), 0o755);
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], {
      encoding: "utf8",
      env: { ...process.env, DSH_HOME: root, PATH: fakeBin + ":" + process.env.PATH },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: (e.stdout || "") + (e.stderr || "") };
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
}

/** 给整个 DSH_HOME 做哈希快照（跳过备份目录）。 */
function snapshot(root) {
  const out = {};
  const walk = (p) => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      if (e.name.startsWith("session-migrate-backup")) continue;
      const full = join(p, e.name);
      if (e.isDirectory()) walk(full);
      else {
        try { out[full.replace(root, "")] = createHash("sha256").update(readFileSync(full)).digest("hex"); }
        catch { out[full.replace(root, "")] = "<unreadable>"; }
      }
    }
  };
  walk(root);
  return out;
}

function sameSnapshot(a, b) {
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  const diffs = keys.filter((k) => a[k] !== b[k]);
  return diffs;
}

const backupOf = (root, id) => {
  const bk = readdirSync(root).find((d) => d.startsWith("session-migrate-backup"));
  if (!bk) return null;
  const d = readdirSync(join(root, bk)).find((x) => x.endsWith("__" + id));
  return d ? join(root, bk, d) : null;
};

/* ------------------------------------------------------------------- [1] */

console.log("\n[1] 搬迁：四处一起改，事件字节不变");
{
  const S1 = "session-aaaa1111-0000-0000-0000-000000000001";
  const S2 = "session-bbbb2222-0000-0000-0000-000000000002";
  const f = fixture({
    sessions: [
      { id: S1, text: "《人类简史》讲了什么" },
      { id: S2, text: "这句为什么值得划" },
    ],
  });
  const r = run(f.root, ["--from", FROM, "--to", TO, "--apply"]);
  A(r.code === 0, "退出码 0");

  for (const id of [S1, S2]) {
    const nf = join(f.root, "sessions", f.toDir, id, "session.v4.jsonl.zstd");
    A(existsSync(nf), id.slice(0, 16) + " 已挪到目标");
    A(!existsSync(join(f.root, "sessions", f.fromDir, id)), id.slice(0, 16) + " 源位置已清空");

    const h = JSON.parse(zstdDecompressSync(frames(readFileSync(nf))[0]).toString("utf8").split("\n")[0]);
    A(h.cwd === TO, id.slice(0, 16) + " 头部 cwd 已更新");
    A(h.id === id, id.slice(0, 16) + " id 没变");

    const bak = backupOf(f.root, id);
    if (!bak) { bad(id.slice(0, 16) + " 找不到备份目录"); continue; }
    const oldBuf = readFileSync(join(bak, "session.v4.jsonl.zstd"));
    const of = frames(oldBuf), nfr = frames(readFileSync(nf));
    A(of.length === nfr.length, id.slice(0, 16) + " 帧数不变");
    A(of.slice(1).every((x, i) => x.equals(nfr[i + 1])), id.slice(0, 16) + " 第1帧起逐字节不变");
    A(decode(oldBuf).split("\n").filter(Boolean).slice(1).join("\n")
      === decode(readFileSync(nf)).split("\n").filter(Boolean).slice(1).join("\n"),
      id.slice(0, 16) + " 头部之外逐行相同");

    const c = JSON.parse(readFileSync(join(f.root, "storages", "session_projcache", "sessions", id + ".json"), "utf8"));
    A(c.record.identity.cwd === TO, id.slice(0, 16) + " 投影缓存已更新");
  }

  const ws = JSON.parse(readFileSync(join(f.root, "storages", "workspace.json"), "utf8"));
  const fw = Object.values(ws.tables.workspaces).find((w) => w.path === FROM);
  const tw = Object.values(ws.tables.workspaces).find((w) => w.path === TO);
  A(fw.sessionIds.length === 0, "源工作区已清空");
  A([S1, S2].every((i) => tw.sessionIds.includes(i)), "目标工作区含 2 个会话");
  A(tw.sessionIds.includes(f.targetId), "目标原有会话未丢");
  rmSync(f.root, { recursive: true, force: true });
}

/* ------------------------------------------------------------------- [2] */

console.log("\n[2] 搬迁失败：自动回滚，逐字节还原");
{
  const S1 = "session-aaaa1111-0000-0000-0000-000000000001";
  const S2 = "session-cccc3333-0000-0000-0000-000000000003";
  const f = fixture({ sessions: [{ id: S1, text: "问题一" }, { id: S2, text: "问题三" }] });
  // 把 S2 的第 0 帧做成「头部 + 多一行」→ rewriteHeaderCwd 会拒绝，迁移中途失败。
  // 真实日志里第 0 帧只放头部，这里是刻意造一个工具必须拒绝的坏输入。
  const badHeader = { type: "session", version: 4, id: S2, createdAt: 1, cwd: FROM, isSeeded: false };
  writeFileSync(join(f.root, "sessions", f.fromDir, S2, "session.v4.jsonl.zstd"),
    zstdCompressSync(Buffer.from(JSON.stringify(badHeader) + "\n" + JSON.stringify({ type: "junk", seq: 0 }) + "\n", "utf8")));
  const before = snapshot(f.root);
  const r = run(f.root, ["--from", FROM, "--to", TO, "--apply"]);
  A(r.code === 1, "退出码 1");
  A(/回滚/.test(r.out), "输出了回滚");
  const diffs = sameSnapshot(before, snapshot(f.root));
  A(diffs.length === 0, "回滚后逐字节还原" + (diffs.length ? "（差异 " + diffs.slice(0, 3).join(", ") + "）" : ""));
  A(existsSync(join(f.root, "sessions", f.fromDir, S1)), "S1 回到源位置");
  A(!existsSync(join(f.root, "sessions", f.toDir, S1)), "目标位置的副本已清掉（不留重复）");
  rmSync(f.root, { recursive: true, force: true });
}

/* ------------------------------------------------------------------- [3] */

console.log("\n[3] 搬迁：目标工作区还没有会话时用自检通过的规则推算");
{
  const S1 = "session-aaaa1111-0000-0000-0000-000000000001";
  const f = fixture({ withTarget: false, sessions: [{ id: S1, text: "问题" }] });
  const r = run(f.root, ["--from", FROM, "--to", TO, "--apply"]);
  A(r.code === 0, "退出码 0");
  A(/自检通过/.test(r.out), "编码器自检通过（拿真实目录名验的）");
  A(existsSync(join(f.root, "sessions", f.toDir, S1)), "会话挪到了推算出的目录");
  const ws = JSON.parse(readFileSync(join(f.root, "storages", "workspace.json"), "utf8"));
  const tw = Object.values(ws.tables.workspaces).find((w) => w.path === TO);
  A(!!tw, "workspace.json 里补登了目标工作区");
  A(tw.sessionIds.includes(S1), "补登的工作区里含该会话");
  rmSync(f.root, { recursive: true, force: true });
}

/* ------------------------------------------------------------------- [4] */

console.log("\n[4] 删除：默认只挑空壳，有内容的默认拒删");
{
  const E1 = "session-eeee0001-0000-0000-0000-000000000001";
  const E2 = "session-eeee0002-0000-0000-0000-000000000002";
  const R1 = "session-rrrr0001-0000-0000-0000-000000000001";
  // I1：只有注入内容（runtime-context / skill-catalog），没有任何真实用户消息
  const I1 = "session-iiii0001-0000-0000-0000-000000000001";
  const f = fixture({ sessions: [
    { id: E1, empty: true },
    { id: E2, empty: true },
    { id: I1, batches: injectedOnlyBatches() },
    { id: R1, text: "这个 http 请求的入参帮我分析" },
  ] });

  // 4.1 dry-run 只挑空壳（含「只有注入内容」的那个）
  const dry = run(f.root, ["--delete", "--from", FROM]);
  A(dry.code === 0, "dry-run 退出码 0");
  A(dry.out.includes(E1) && dry.out.includes(E2), "选中了两个真·空壳");
  A(dry.out.includes(I1), "只有注入内容的会话也算空壳（注入不算用户说话）");
  A(!dry.out.includes(R1), "没有选中那个有内容的会话");
  A(existsSync(join(f.root, "sessions", f.fromDir, E1)), "dry-run 什么都没删");

  // 4.2 显式指定有内容的会话 → 拒绝
  const refuse = run(f.root, ["--delete", "--from", FROM, "--ids", R1]);
  A(refuse.code === 2, "拒删有内容的会话（退出码 2）");
  A(existsSync(join(f.root, "sessions", f.fromDir, R1)), "有内容的会话还在");

  // 4.3 真删空壳
  const r = run(f.root, ["--delete", "--from", FROM, "--apply"]);
  A(r.code === 0, "删除退出码 0");
  A(!existsSync(join(f.root, "sessions", f.fromDir, E1)), "空壳 E1 已删");
  A(!existsSync(join(f.root, "sessions", f.fromDir, E2)), "空壳 E2 已删");
  A(!existsSync(join(f.root, "sessions", f.fromDir, I1)), "只有注入内容的 I1 已删");
  A(existsSync(join(f.root, "sessions", f.fromDir, R1)), "有内容的会话没被碰");
  A(!existsSync(join(f.root, "storages", "session_projcache", "sessions", E1 + ".json")), "空壳的投影缓存已清");
  A(existsSync(join(f.root, "storages", "session_projcache", "sessions", R1 + ".json")), "有内容会话的缓存保留");
  const ws = JSON.parse(readFileSync(join(f.root, "storages", "workspace.json"), "utf8"));
  const w = Object.values(ws.tables.workspaces).find((x) => x.path === FROM);
  A(!w.sessionIds.includes(E1) && !w.sessionIds.includes(E2), "workspace.json 已摘登记");
  A(w.sessionIds.includes(R1), "有内容的会话登记还在");
  rmSync(f.root, { recursive: true, force: true });
}

/* ------------------------------------------------------------------ [4b] */

console.log("\n[4b] 回归：真实 schema 下不能把所有会话都当空壳");
{
  // 这一条是为「按 type==='message' 判断导致全部误判为空壳」那个 bug 钉的
  const R1 = "session-rrrr0001-0000-0000-0000-000000000001";
  const R2 = "session-rrrr0002-0000-0000-0000-000000000002";
  const f = fixture({ sessions: [
    { id: R1, text: "这个 http 请求的入参帮我分析" },
    { id: R2, text: "你使用的是什么模型" },
  ] });
  const dry = run(f.root, ["--delete", "--from", FROM]);
  A(dry.code === 2, "两个都有内容 → dry-run 也应拒绝（退出码 2）");
  A(!dry.out.includes("session-rrrr0001") || /有内容/.test(dry.out), "识别出它们有内容");
  A(existsSync(join(f.root, "sessions", f.fromDir, R1)), "没被删");
  A(existsSync(join(f.root, "sessions", f.fromDir, R2)), "没被删");
  rmSync(f.root, { recursive: true, force: true });
}

/* ------------------------------------------------------------------- [5] */

console.log("\n[5] 删除失败：自动回滚，逐字节还原");
{
  const E1 = "session-ffff0001-0000-0000-0000-000000000001";
  const E2 = "session-ffff0002-0000-0000-0000-000000000002";
  const E3 = "session-ffff0003-0000-0000-0000-000000000003";
  const f = fixture({ sessions: [{ id: E1, empty: true }, { id: E2, empty: true }, { id: E3, empty: true }] });
  // 第 3 个里放一个读不了的文件 → 备份它时 EACCES，删到一半失败
  writeFileSync(join(f.root, "sessions", f.fromDir, E3, "locked.bin"), "secret");
  chmodSync(join(f.root, "sessions", f.fromDir, E3, "locked.bin"), 0o000);

  const before = snapshot(f.root);
  const r = run(f.root, ["--delete", "--from", FROM, "--apply"]);
  A(r.code === 1, "退出码 1");
  A(/回滚/.test(r.out), "输出了回滚");
  const diffs = sameSnapshot(before, snapshot(f.root));
  A(diffs.length === 0, "回滚后逐字节还原" + (diffs.length ? "（差异 " + diffs.slice(0, 3).join(", ") + "）" : ""));
  A(existsSync(join(f.root, "sessions", f.fromDir, E1)), "先删的 E1 已还原");
  A(existsSync(join(f.root, "sessions", f.fromDir, E2)), "先删的 E2 已还原");
  rmSync(f.root, { recursive: true, force: true });
}

/* ------------------------------------------------------------------- [6] */

console.log("\n[6] 编码器自检：拿真实目录名验证推算规则");
{
  // 造一个「目录名和规则不一致」的场景：手写一个错的目录名，
  // 自检应当不通过，并且拒绝推算目标目录
  const S1 = "session-aaaa1111-0000-0000-0000-000000000001";
  const f = fixture({ withTarget: false, sessions: [{ id: S1, text: "问题" }] });
  // 把项目目录改成规则推不出来的名字（模拟「没搞懂编码」）
  const bogus = join(f.root, "sessions", "--bogus-dir-name--");
  cpSync(join(f.root, "sessions", f.fromDir), bogus, { recursive: true });
  rmSync(join(f.root, "sessions", f.fromDir), { recursive: true, force: true });

  const r = run(f.root, ["--from", FROM, "--to", TO, "--apply"]);
  A(r.code === 2, "自检不通过时拒绝执行（退出码 2）");
  A(/自检未通过|不敢推算/.test(r.out), "明确说明不敢推算");
  A(!existsSync(join(f.root, "sessions", f.toDir)), "没有瞎建目录");
  rmSync(f.root, { recursive: true, force: true });
}

console.log(`\n===== 通过 ${pass} · 失败 ${fail} =====`);
process.exit(fail ? 1 : 0);
