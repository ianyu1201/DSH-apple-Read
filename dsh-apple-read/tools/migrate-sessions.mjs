#!/usr/bin/env node
/**
 * migrate-sessions.mjs — 把会话从一个工作区搬到另一个工作区。
 *
 * 为什么需要它：Harness **没有**「把会话移到别的工区」的 API（session controller 只有
 * create / fork / rename / prompt / search / list…）。而工作区只是磁盘上的一个目录，
 * 会话的归属由四处共同决定，缺一处就会「会话打不开」：
 *
 *   1. 会话日志头部的 `cwd`            ~/.dsh/sessions/<proj>/<id>/session.vN.jsonl.zstd
 *   2. 会话目录名 `--<normalized-cwd>--` （由 cwd 推导，所以 cwd 变了目录也得挪）
 *   3. 投影缓存 identity.cwd            ~/.dsh/storages/session_projcache/sessions/<id>.json
 *   4. 工作区登记 sessionIds            ~/.dsh/storages/workspace.json
 *
 * 目录名到路径的映射是**有损**的（`-` 既表示 `/` 也可能是真实字符，比如
 * `deepseek-harness`），所以本脚本**不猜**目录名，而是从每个会话日志头部的 cwd
 * 反查「哪个目录对应哪个工作区」。因此目标工作区里必须**已经有至少一个会话**
 * （在面板里打开一次就会建一个），否则脚本会明确报错而不是瞎猜。
 *
 * 安全设计：
 *   · 默认 dry-run，只打印计划；真正动手要加 --apply
 *   · Harness 在跑就拒绝执行（它把 workspace.json 装在内存里，退出时可能回写，
 *     会把改动冲掉，而文件已经挪走 —— 会话就打不开了）
 *   · 动手前把要改的文件整份备份到 <backup>/，任何一步失败立刻回滚
 *   · 只重写日志的**第 0 帧**（那一帧里只有头部一行），其余帧按字节原样复制，
 *     保证「已提交的事件永不被重写」
 *
 * 用法：
 *   # 搬迁（默认 from = 名字以 default-workspace 结尾的工作区，to = ~/Documents/deepseek-harness/读书会话）
 *   node tools/migrate-sessions.mjs                          # dry-run，只看计划
 *   node tools/migrate-sessions.mjs --apply                   # 真搬
 *   node tools/migrate-sessions.mjs --ids a,b,c --apply        # 只搬指定的几个会话
 *   node tools/migrate-sessions.mjs --from X --to Y --apply    # 显式指定源和目标
 *
 *   # 删除（收拾空壳）
 *   node tools/migrate-sessions.mjs --delete                  # dry-run：只挑没有任何用户消息的空壳
 *   node tools/migrate-sessions.mjs --delete --apply           # 真删
 *   node tools/migrate-sessions.mjs --delete --ids a,b --apply # 删指定会话（有内容时会被拒绝）
 *   node tools/migrate-sessions.mjs --delete --ids a --force --apply  # 明知有内容也要删
 *
 * 删除模式会同时清掉：会话目录、投影缓存、workspace.json 的登记（含 archived/pinned）、
 * 以及插件存档 apple-read/data.json 里对应的 companionContexts。
 */

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync,
  renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const SESSIONS_ROOT = join(DSH_HOME, "sessions");
const PROJCACHE_DIR = join(DSH_HOME, "storages", "session_projcache", "sessions");
const WORKSPACE_JSON = join(DSH_HOME, "storages", "workspace.json");
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const value = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};

const APPLY = flag("--apply");
const DELETE = flag("--delete");   // 删除模式：删掉选中的会话（默认只允许删空壳）
const FORCE = flag("--force");     // 删除模式下，允许删有内容的会话
const DEFAULT_READING_DIR = join(homedir(), "Documents", "deepseek-harness", "读书会话");
// 不传 --from/--to 时的默认值：源 = 名字以 default-workspace 结尾的工作区，
// 目标 = 插件默认的伴读会话目录。这样常规情况直接 `--apply` 就行。
const FROM = value("--from") || inferDefaultFrom();
const TO = value("--to") || process.env.APPLE_READ_READING_DIR || DEFAULT_READING_DIR;
const ONLY_IDS = (value("--ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
const BACKUP = value("--backup") || join(DSH_HOME, `session-migrate-backup-${Date.now()}`);

function inferDefaultFrom() {
  try {
    const ws = JSON.parse(readFileSync(WORKSPACE_JSON, "utf8"));
    const list = Object.values(ws?.tables?.workspaces ?? {});
    const hit = list.find((w) => /(?:^|\/)default-workspace$/.test(w.path || ""));
    return hit?.path || "";
  } catch {
    return "";
  }
}

let failures = 0;
const info = (m) => console.log("  " + m);
const warn = (m) => console.log("  ⚠️  " + m);
const die = (m) => { console.error("\n❌ " + m + "\n"); process.exit(2); };

/* -------------------------------------------------------------------------- */
/* zstd 多帧读写                                                               */
/* -------------------------------------------------------------------------- */

/** 找出所有 zstd 帧的起始偏移。 */
function frameOffsets(buf) {
  const offs = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf.compare(ZSTD_MAGIC, 0, 4, i, i + 4) === 0) offs.push(i);
  }
  return offs;
}

/** 按帧解码成一个字符串（每帧单独解，拼起来）。 */
function decodeAll(buf) {
  const offs = frameOffsets(buf);
  if (offs.length === 0) throw new Error("不是 zstd 文件");
  let out = "";
  for (let k = 0; k < offs.length; k++) {
    const start = offs[k];
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    out += zstdDecompressSync(buf.subarray(start, end)).toString("utf8");
  }
  return out;
}

/**
 * 只替换头部那一行，其余帧按字节原样保留。
 *
 * 这是刻意的：日志是追加式的，「已提交的事件永不被重写」。头部单独占第 0 帧
 * （已实测：所有会话的第 0 帧都恰好只有一行 header），所以改它最安全。
 */
function rewriteHeaderCwd(buf, newCwd) {
  const offs = frameOffsets(buf);
  const end0 = offs.length > 1 ? offs[1] : buf.length;
  const first = zstdDecompressSync(buf.subarray(0, end0)).toString("utf8");
  const lines = first.split("\n").filter(Boolean);
  if (lines.length !== 1) {
    throw new Error(`第 0 帧有 ${lines.length} 行，不是纯头部，拒绝改写`);
  }
  const header = JSON.parse(lines[0]);
  if (header.type !== "session") throw new Error("第 0 帧不是 session 头");
  header.cwd = newCwd;
  const newFrame0 = zstdCompressSync(Buffer.from(JSON.stringify(header) + "\n", "utf8"));
  const rest = buf.subarray(end0);
  return { buf: Buffer.concat([newFrame0, rest]), header };
}

/* -------------------------------------------------------------------------- */
/* 扫描：目录 ↔ 工作区路径                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 按 DSH 的规则把 cwd 编码成项目目录名：`--<normalized-cwd>--`。
 *
 * 规则是从磁盘上已有的真实目录名反推出来的，**并且每次运行都会拿现有目录自检**
 * （见 validateEncoder）。自检不过就绝不使用推算结果 —— 宁可报错让人去开一次面板。
 *
 *   /a/b-c            → --a-b-c--            （/ 变 -，安全字符原样）
 *   /x/AI 伴读        → --x-AI~0020~4F34~8BFB--
 *                        空格和 CJK 变 ~<UTF-16 码元大写十六进制>，连续转义共用 ~
 */
function encodeProjDir(cwd) {
  let body = cwd.replace(/^\//, "").replace(/\//g, "-");
  body = body.replace(/[^A-Za-z0-9._-]/g, (c) => "~" + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"));
  // 转义序列以 ~ 收尾；若结尾不是转义就不加
  if (/[^A-Za-z0-9._-]$/.test(body)) body += "~";
  return "--" + body + "--";
}

/**
 * 用磁盘上已有的目录给编码器做自检。
 * 只要有一个已有目录对不上，就认为规则没被完全搞明白，禁用推算。
 */
function validateEncoder(dirToPath) {
  let checked = 0;
  const mismatches = [];
  for (const [dir, cwd] of dirToPath) {
    checked++;
    const guess = encodeProjDir(cwd);
    if (guess !== dir) mismatches.push({ dir, cwd, guess });
  }
  return { checked, mismatches, ok: checked > 0 && mismatches.length === 0 };
}

function sessionLogPath(dir) {
  for (const name of readdirSync(dir)) {
    if (/^session(\.v\d+)?\.jsonl\.zstd$/.test(name)) return join(dir, name);
  }
  return null;
}

/**
 * 扫出所有会话，并顺带建立「项目目录 → 工作区路径」的映射。
 * 映射来自日志头部自己的 cwd —— 不靠猜目录名编码。
 */
function scanSessions() {
  const sessions = [];
  const dirToPath = new Map();
  if (!existsSync(SESSIONS_ROOT)) return { sessions, dirToPath };

  for (const projDir of readdirSync(SESSIONS_ROOT)) {
    const projPath = join(SESSIONS_ROOT, projDir);
    if (!statSync(projPath).isDirectory()) continue;
    for (const sessionDir of readdirSync(projPath)) {
      const sPath = join(projPath, sessionDir);
      if (!statSync(sPath).isDirectory()) continue;
      const log = sessionLogPath(sPath);
      if (!log) continue;
      let header;
      try {
        const text = decodeAll(readFileSync(log));
        header = JSON.parse(text.split("\n").filter(Boolean)[0]);
      } catch (e) {
        warn(`跳过读不懂的会话 ${sessionDir}：${e.message}`);
        continue;
      }
      if (header.type !== "session") continue;
      sessions.push({
        id: header.id,
        cwd: header.cwd,
        projDir,
        sessionDir,
        dir: sPath,
        log,
        bytes: statSync(log).size,
      });
      // 同一项目目录里的会话 cwd 相同，取到一次就够
      if (header.cwd) dirToPath.set(projDir, header.cwd);
    }
  }
  return { sessions, dirToPath };
}

/** 从「目录 → 路径」映射反查某个工作区路径对应的项目目录。 */
function projDirForPath(dirToPath, path) {
  for (const [dir, p] of dirToPath) if (p === path) return dir;
  return null;
}

/* -------------------------------------------------------------------------- */
/* 主流程                                                                      */
/* -------------------------------------------------------------------------- */

console.log("\n=== 会话迁移" + (APPLY ? "（--apply 真动手）" : "（dry-run，只看计划）") + " ===");

if (!FROM || !TO) die("必须同时给 --from <源工作区路径> 和 --to <目标工作区路径>");

// 1) 真正动手时 Harness 必须在关闭状态（dry-run 无害，允许在运行时看计划）
try {
  const ps = execFileSync("ps", ["-eo", "pid,command"], { encoding: "utf8" });
  const running = ps.split("\n").filter(
    (l) => /DeepSeek Harness\.app\/Contents\/MacOS\/DeepSeek Harness/.test(l) && !/grep/.test(l)
  );
  if (running.length > 0) {
    const pids = running.map((l) => l.trim().split(/\s+/)[0]).join(", ");
    if (APPLY) {
      die(
        `Harness 正在运行（pid ${pids}）。\n` +
        "   它把 workspace.json 装在内存里，退出时可能回写，会把这里的改动冲掉；\n" +
        "   而会话文件已经挪走 —— 结果就是会话打不开。\n" +
        "   请先完全退出 DeepSeek Harness，再跑 --apply。\n" +
        "   （只看计划的话去掉 --apply 即可，dry-run 不改任何东西。）"
      );
    }
    warn(`Harness 正在运行（pid ${pids}）—— dry-run 不改文件，但 --apply 会被拒绝`);
  } else {
    info("Harness 没在跑 ✓");
  }
} catch (e) {
  if (e.status === 2) throw e;
  warn("查不到进程列表，跳过「Harness 是否在跑」检查");
}

// 2) 扫描现状
const { sessions, dirToPath } = scanSessions();
info(`扫到 ${sessions.length} 个会话，${dirToPath.size} 个项目目录`);

console.log("\n--- 项目目录 ↔ 工作区路径（从会话头部读出，不是猜的）---");
for (const [dir, p] of dirToPath) info(`${dir}  →  ${p}`);

// 编码器自检：拿磁盘上已有的目录名验证推算规则
const enc = validateEncoder(dirToPath);
if (enc.ok) {
  info(`目录名编码规则自检通过（${enc.checked} 个真实样本全部吻合）`);
} else if (enc.checked === 0) {
  warn("没有任何样本可以校验目录名编码规则");
} else {
  warn(`目录名编码规则自检未通过（${enc.mismatches.length}/${enc.checked} 个对不上），已禁用推算`);
  for (const m of enc.mismatches.slice(0, 3)) {
    warn(`  ${m.dir}\n      推算 ${m.guess}  ← 来自 ${m.cwd}`);
  }
}

const fromProjDir = projDirForPath(dirToPath, FROM);
if (!fromProjDir) die(`找不到源工作区对应的项目目录（${FROM}）。它下面一个会话都没有？`);

/* -------------------------------------------------------------------------- */
/* 备份 / 回滚基础设施（删除模式和搬迁模式共用）                                */
/* -------------------------------------------------------------------------- */

mkdirSync(BACKUP, { recursive: true });
const rollback = [];

function backupFile(p) {
  if (!existsSync(p)) return;
  const dest = join(BACKUP, p.replace(/^\/+/, "").replace(/\//g, "__"));
  copyFileSync(p, dest);
  rollback.push({ kind: "file", path: p, backup: dest });
}
/** 备份一个「即将被移走」的目录，并记下它会去哪 —— 回滚时两处都要处理。 */
function backupMovedDir(p, to) {
  const dest = join(BACKUP, p.replace(/^\/+/, "").replace(/\//g, "__"));
  cpSync(p, dest, { recursive: true });
  rollback.push({ kind: "moved", from: p, to, backup: dest });
}
/** 备份一个「即将被删掉」的目录。 */
function backupDeletedDir(p) {
  const dest = join(BACKUP, p.replace(/^\/+/, "").replace(/\//g, "__"));
  cpSync(p, dest, { recursive: true });
  rollback.push({ kind: "deleted", path: p, backup: dest });
}

function doRollback() {
  console.log("\n=== 回滚 ===");
  for (const r of rollback.reverse()) {
    try {
      if (r.kind === "file") {
        copyFileSync(r.backup, r.path);
        info("已还原 " + basename(r.path));
      } else if (r.kind === "deleted") {
        rmSync(r.path, { recursive: true, force: true });
        cpSync(r.backup, r.path, { recursive: true });
        info("已还原被删的 " + basename(r.path));
      } else if (r.kind === "moved") {
        // 先把目标位置的副本删掉，再把备份还原回源位置。
        // 少删这一步就会留下重复的会话目录 —— 这个坑踩过。
        rmSync(r.to, { recursive: true, force: true });
        rmSync(r.from, { recursive: true, force: true });
        cpSync(r.backup, r.from, { recursive: true });
        info("已还原 " + basename(r.from) + "（并清掉目标位置）");
      } else if (r.kind === "createdProjDir") {
        // 空的项目目录直接删掉；里面还有东西就不动
        if (existsSync(r.path) && readdirSync(r.path).length === 0) {
          rmSync(r.path, { recursive: true, force: true });
          info("已删掉新建的空项目目录 " + basename(r.path));
        }
      } else if (r.kind === "createdWorkspace") {
        // workspace.json 会被整份还原，这里只需提示
        info("新建的工作区登记会随 workspace.json 一起还原");
      }
    } catch (e) { warn("还原失败 " + (r.path || r.from) + "：" + e.message); failures++; }
  }
}

/* -------------------------------------------------------------------------- */
/* 删除模式：收拾空壳                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 这个会话里有没有「用户真的说过话」。
 *
 * 真实事件格式（实测，不是猜的）：
 *   {"type":"user/message","data":{"content":[{"type":"text","text":"…"}],
 *                                 "source":{"kind":"user","rpcId":"…"},"role":"user","id":"…"}}
 *
 * 关键是 `source.kind`：只有 `"user"` 才是用户自己发的。同一个 type 下还有
 * `runtime-context` / `skill-catalog` 等**注入**内容，那些不算用户说话
 * （踩过的坑：按 `type==="message"` 判断，结果把每个会话都当成空壳，差点全删掉）。
 */
function isSubstantive(s) {
  let lines;
  try {
    lines = decodeAll(readFileSync(s.log)).split("\n").filter(Boolean);
  } catch {
    return true; // 读不懂就当有内容，宁可少删
  }
  for (const l of lines) {
    let e;
    try { e = JSON.parse(l); } catch { continue; }
    if (e.type !== "user/message") continue;
    if (e.data?.source?.kind !== "user") continue; // 注入的内容不算
    const c = e.data.content;
    const text = Array.isArray(c) ? c.map((x) => x.text || "").join("") : (c?.text || "");
    if (String(text).trim()) return true;
  }
  return false;
}

/** 取首条「用户真的发的」消息文本，用来在计划里给人看。 */
function firstUserText(s) {
  try {
    for (const l of decodeAll(readFileSync(s.log)).split("\n").filter(Boolean)) {
      let e;
      try { e = JSON.parse(l); } catch { continue; }
      if (e.type !== "user/message" || e.data?.source?.kind !== "user") continue;
      const c = e.data.content;
      const text = Array.isArray(c) ? c.map((x) => x.text || "").join("") : (c?.text || "");
      const t = String(text).trim().replace(/\s+/g, " ");
      if (t) return t.slice(0, 80);
    }
  } catch { /* 读不懂就算了 */ }
  return "";
}

if (DELETE) {
  console.log("\n--- 删除模式 ---");
  let targets = sessions.filter((s) => s.projDir === fromProjDir);
  if (ONLY_IDS.length) {
    const want = new Set(ONLY_IDS);
    targets = targets.filter((s) => want.has(s.id));
    const missing = ONLY_IDS.filter((id) => !sessions.some((s) => s.id === id));
    if (missing.length) warn(`有 ${missing.length} 个 id 没找到，忽略：${missing.join(", ")}`);
  } else {
    warn("没给 --ids，默认只挑「空壳」（没有任何用户消息的会话）");
    targets = targets.filter((s) => !isSubstantive(s));
  }
  if (targets.length === 0) die("没有匹配到要删的会话");

  // 安全性：默认拒绝删有内容的会话
  const substantive = targets.filter((s) => isSubstantive(s));
  if (substantive.length > 0 && !FORCE) {
    console.error("\n❌ 拒绝执行：选中的会话里有 " + substantive.length + " 个是有内容的：");
    for (const s of substantive) console.error(`     ${s.id}  ${(s.bytes / 1024).toFixed(0)}K`);
    console.error("\n   删会话是不可逆的。确认要删就加 --force。\n");
    process.exit(2);
  }

  console.log(`\n--- 要删的会话（${targets.length} 个）---`);
  for (const s of targets) {
    info(`${s.id}  ${(s.bytes / 1024).toFixed(0)}K  ${isSubstantive(s) ? "【有内容】" : "空壳"}`);
  }

  if (!APPLY) {
    console.log("\n这是 dry-run，什么都没删。确认无误后加 --apply。\n");
    process.exit(0);
  }

  console.log(`\n=== 开始删除（备份到 ${BACKUP}）===`);
  try {
    backupFile(WORKSPACE_JSON);
    const ws = JSON.parse(readFileSync(WORKSPACE_JSON, "utf8"));
    const tables = ws.tables?.workspaces ?? {};
    const delSet = new Set(targets.map((s) => s.id));

    // 插件自己的存档里也记了这些会话的阅读上下文，一并清掉
    const dataJson = join(DSH_HOME, "storages", "apple-read", "data.json");
    let pluginData = null;
    if (existsSync(dataJson)) {
      backupFile(dataJson);
      pluginData = JSON.parse(readFileSync(dataJson, "utf8"));
    }

    for (const s of targets) {
      // 备份整个会话目录，然后删
      backupDeletedDir(s.dir);

      const cacheFile = join(PROJCACHE_DIR, `${s.id}.json`);
      if (existsSync(cacheFile)) {
        backupFile(cacheFile);
        rmSync(cacheFile, { force: true });
      }
      rmSync(s.dir, { recursive: true, force: true });
      info(`已删 ${s.id}`);

      if (pluginData?.companionContexts && s.id in pluginData.companionContexts) {
        delete pluginData.companionContexts[s.id];
      }
    }

    // 从所有工作区登记里摘掉
    let removed = 0;
    for (const w of Object.values(tables)) {
      const before = (w.sessionIds || []).length;
      w.sessionIds = (w.sessionIds || []).filter((id) => !delSet.has(id));
      removed += before - w.sessionIds.length;
      if (before !== w.sessionIds.length) w.updatedAt = new Date().toISOString();
    }
    for (const key of ["archivedSessionIds", "pinnedSessionIds"]) {
      if (Array.isArray(ws.global?.[key])) {
        ws.global[key] = ws.global[key].filter((id) => !delSet.has(id));
      }
    }
    writeFileSync(WORKSPACE_JSON, JSON.stringify(ws, null, 2));
    info(`workspace.json：摘掉 ${removed} 条会话登记`);

    if (pluginData) {
      writeFileSync(dataJson, JSON.stringify(pluginData));
      info("插件存档：清掉对应的阅读上下文");
    }

    console.log(`\n✅ 删除完成：${targets.length} 个会话\n   备份留在：${BACKUP}\n`);
    process.exit(0);
  } catch (e) {
    console.error("\n❌ 删除失败：" + e.message);
    doRollback();
    console.error("已回滚。备份仍在：" + BACKUP + "\n");
    process.exit(1);
  }
}

let toProjDir = projDirForPath(dirToPath, TO);

// 目标目录还没有会话时，退一步用「已自检通过的编码器」推算。
// 自检没过就绝不推算 —— 宁可报错让人去开一次面板。
if (!toProjDir) {
  if (!enc.ok) {
    die(
      `找不到目标工作区对应的项目目录（${TO}），而且目录名编码规则没能自检通过，不敢推算。\n` +
      "   请在 Harness 里打开一次「图书」面板（或手动新建一个会话），让目标工作区里\n" +
      "   先有一个会话，然后再跑本脚本 —— 那样就能从会话头部直接读出目录名。"
    );
  }
  toProjDir = encodeProjDir(TO);
  info(`目标目录还没有会话，用自检通过的规则推算：${toProjDir}`);
}

if (fromProjDir === toProjDir) die("源和目标解析到了同一个项目目录，没什么可搬的");

// 3) 挑出要搬的会话
let targets = sessions.filter((s) => s.projDir === fromProjDir);
if (ONLY_IDS.length) {
  const want = new Set(ONLY_IDS);
  targets = targets.filter((s) => want.has(s.id));
}
if (targets.length === 0) die("没有匹配到要搬的会话");

console.log(`\n--- 要搬的会话（${targets.length} 个）---`);
for (const s of targets) {
  info(`${s.id}  ${(s.bytes / 1024).toFixed(0)}K  ${isSubstantive(s) ? "" : "（空壳）"}`);
  const title = firstUserText(s);
  if (title) info(`     首条用户消息：${title}`);
}
console.log(`\n  源项目目录：${fromProjDir}`);
console.log(`  目标项目目录：${toProjDir}`);

if (!APPLY) {
  console.log("\n这是 dry-run。确认无误后加 --apply 真正执行。\n");
  process.exit(0);
}

/* -------------------------------------------------------------------------- */
/* 执行（先备份，失败回滚）                                                     */
/* -------------------------------------------------------------------------- */

console.log(`\n=== 开始迁移（备份到 ${BACKUP}）===`);

try {
  // 3.1 备份
  backupFile(WORKSPACE_JSON);
  const ws = JSON.parse(readFileSync(WORKSPACE_JSON, "utf8"));

  // 3.2 逐个搬会话
  const destProjDir = join(SESSIONS_ROOT, toProjDir);
  const projDirExisted = existsSync(destProjDir);
  mkdirSync(destProjDir, { recursive: true });
  if (!projDirExisted) {
    // 回滚时要把它删掉，否则会留下一个空的项目目录
    rollback.push({ kind: "createdProjDir", path: destProjDir });
    info(`新建目标项目目录：${toProjDir}`);
  }

  const moved = [];
  for (const s of targets) {
    const destDir = join(destProjDir, s.sessionDir);
    if (existsSync(destDir)) throw new Error(`目标已存在，拒绝覆盖：${destDir}`);

    backupMovedDir(s.dir, destDir);
    const cacheFile = join(PROJCACHE_DIR, `${s.id}.json`);
    backupFile(cacheFile);

    // (a) 改日志头部 cwd（只重写第 0 帧）
    const { buf } = rewriteHeaderCwd(readFileSync(s.log), TO);
    // 先写同目录临时文件，再 rename —— 保证不出现「写了一半」的日志
    const tmp = s.log + ".migrate-tmp";
    writeFileSync(tmp, buf);
    renameSync(tmp, s.log);
    info(`改头部 cwd：${s.id}`);

    // (b) 挪目录
    renameSync(s.dir, destDir);
    info(`挪目录：${s.sessionDir.slice(0, 24)} → ${toProjDir.slice(0, 24)}`);

    // (c) 投影缓存
    if (existsSync(cacheFile)) {
      const c = JSON.parse(readFileSync(cacheFile, "utf8"));
      if (c?.record?.identity) c.record.identity.cwd = TO;
      writeFileSync(cacheFile, JSON.stringify(c));
      info(`改投影缓存：${s.id}`);
    }

    moved.push(s.id);
  }

  // 3.3 更新 workspace.json：把 id 从源工作区挪到目标工作区
  const tables = ws.tables?.workspaces ?? {};
  let fromWs = null, toWs = null;
  for (const [id, w] of Object.entries(tables)) {
    if (w.path === FROM) fromWs = { id, w };
    if (w.path === TO) toWs = { id, w };
  }
  if (!fromWs) throw new Error(`workspace.json 里没有路径为 ${FROM} 的工作区`);

  // 目标工作区可能还没登记（插件还没被打开过）—— 那就照现有条目的形状补一个，
  // 插件之后按 path 就能认出来，不会重复建。
  if (!toWs) {
    const sample = Object.values(tables)[0] ?? {};
    const newId = randomUUID();
    const nowIso = new Date().toISOString();
    const entry = { path: TO, title: basename(TO) };
    for (const k of Object.keys(sample)) if (!(k in entry)) entry[k] = undefined;
    entry.sessionIds = [];
    entry.createdAt = nowIso;
    entry.updatedAt = nowIso;
    // 删掉值为 undefined 的占位键，保持文件干净
    for (const k of Object.keys(entry)) if (entry[k] === undefined) delete entry[k];
    tables[newId] = entry;
    ws.global = ws.global ?? {};
    ws.global.workspaceIds = Array.isArray(ws.global.workspaceIds) ? ws.global.workspaceIds : [];
    if (!ws.global.workspaceIds.includes(newId)) ws.global.workspaceIds.push(newId);
    toWs = { id: newId, w: entry };
    rollback.push({ kind: "createdWorkspace", id: newId });
    info(`workspace.json 里补登工作区「${entry.title}」（id ${newId.slice(0, 8)}）`);
  }

  const movedSet = new Set(moved);
  fromWs.w.sessionIds = (fromWs.w.sessionIds || []).filter((id) => !movedSet.has(id));
  const already = new Set(toWs.w.sessionIds || []);
  for (const id of moved) if (!already.has(id)) toWs.w.sessionIds.unshift(id);
  fromWs.w.updatedAt = toWs.w.updatedAt = new Date().toISOString();

  writeFileSync(WORKSPACE_JSON, JSON.stringify(ws, null, 2));
  info(`workspace.json：${moved.length} 个会话从「${fromWs.w.title}」挪到「${toWs.w.title}」`);

  // 3.4 校验：重新扫一遍，确认会话现在挂在目标项目目录下
  const after = scanSessions();
  let bad = 0;
  for (const id of moved) {
    const s = after.sessions.find((x) => x.id === id);
    if (!s || s.cwd !== TO || s.projDir !== toProjDir) {
      warn(`校验失败：${id}（cwd=${s?.cwd} projDir=${s?.projDir}）`);
      bad++;
    }
  }
  if (bad > 0) throw new Error(`${bad} 个会话校验失败`);

  console.log(`\n✅ 迁移完成：${moved.length} 个会话已挪到 ${TO}`);
  console.log(`   备份留在：${BACKUP}（确认没问题后可以删掉）\n`);
} catch (e) {
  console.error("\n❌ 迁移失败：" + e.message);
  doRollback();
  console.error("已回滚。备份仍在：" + BACKUP + "\n");
  process.exit(1);
}
