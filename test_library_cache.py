#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.10"
# dependencies = ["fastembed>=0.4.0", "numpy", "jieba"]
# ///
"""书库缓存失效测试（2026-10 功能审计的 P2-3 回归）。

原缺陷：`load_library()` 一旦缓存就永不失效 —— 「图书」App 里新加的书、
刚更新的阅读进度，在常驻的引擎进程里**永远看不到**，只能重启插件。
`find_books()` 也只在「BKLibrary 一本书都没有」时才去扫目录，
所以只存在于目录里的新书同样看不到。

这个测试用一个临时的假 BKLibrary 把两种失效路径都钉住：
    1. 主库新增一行      → 下一次 load_library() 就能读到
    2. WAL 里新增（未 checkpoint）→ 同样能读到
    3. 阅读进度更新      → 下一次读到新值
    4. 目录里有、库里没有的书 → find_books() 要合并进来
    5. 读失败不留缓存    → 下次重试（不把空结果永久缓存）

跑法：uv run test_library_cache.py
"""
import importlib.util
import sqlite3
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("books_rag", HERE / "books_rag.py")
B = importlib.util.module_from_spec(spec)
sys.modules["books_rag"] = B
spec.loader.exec_module(B)

pass_n = 0
fail_n = 0


def ok(m):
    global pass_n
    pass_n += 1
    print("  \u2713 " + m)


def bad(m, d=""):
    global fail_n
    fail_n += 1
    print("  \u2717 " + m + (" \u2014 " + str(d) if d else ""))


def check(cond, m, d=""):
    ok(m) if cond else bad(m, d)


SCHEMA = """
create table ZBKLIBRARYASSET (
    Z_PK integer primary key,
    ZASSETID text,
    ZTITLE text,
    ZAUTHOR text,
    ZPATH text,
    ZREADINGPROGRESS real,
    ZLASTOPENDATE real,
    ZISFINISHED integer,
    ZGENRE text
);
"""


def insert(db_path, pk, aid, title, path, progress=0.0, finished=0, genre=""):
    con = sqlite3.connect(db_path)
    con.execute(
        "insert or replace into ZBKLIBRARYASSET"
        " (Z_PK, ZASSETID, ZTITLE, ZAUTHOR, ZPATH, ZREADINGPROGRESS,"
        "  ZLASTOPENDATE, ZISFINISHED, ZGENRE) values (?,?,?,?,?,?,?,?,?)",
        (pk, aid, title, "某作者", str(path), progress, None, finished, genre),
    )
    con.commit()
    con.close()


tmp = Path(tempfile.mkdtemp(prefix="apple-read-libcache-"))
lib_dir = tmp / "BKLibrary"
books_dir = tmp / "books"
index_dir = tmp / "index"
for d in (lib_dir, books_dir, index_dir):
    d.mkdir(parents=True, exist_ok=True)

db_path = lib_dir / "BKLibrary.sqlite"

# 两本书的目录（find_books 要求 path 是个真实目录）
book_a = books_dir / "活着.epub"
book_b = books_dir / "人类简史.epub"
book_c = books_dir / "只存在于目录.epub"   # 库里没有，只在目录里
for d in (book_a, book_b, book_c):
    d.mkdir()

con = sqlite3.connect(db_path)
con.executescript(SCHEMA)
# 用 WAL：真实「图书」App 也是 WAL，新数据常先进 WAL 不落主库
con.execute("pragma journal_mode=wal")
con.commit()
con.close()

insert(db_path, 1, "ASSET-A", "活着", book_a, 0.25)

# 指向临时库
B.LIBRARY_DB = lib_dir
B.BOOKS_DIR = books_dir
B.INDEX_DIR = index_dir
B._library_cache = None
B._library_stamp = None

print("\n[1] 首次读取")
lib = B.load_library()
check("ASSET-A" in lib, "读到 ASSET-A")
check(abs(lib["ASSET-A"]["progress"] - 0.25) < 1e-9, f"进度 0.25（实际 {lib['ASSET-A']['progress']}）")
check("ASSET-B" not in lib, "此时还没有 ASSET-B")

print("\n[2] 主库新增一行后，缓存必须失效")
time.sleep(0.02)
insert(db_path, 2, "ASSET-B", "人类简史", book_b, 0.0)
lib = B.load_library()          # 不传 force，走正常路径
check("ASSET-B" in lib, "不重启就看到了新加的书（原缺陷：看不到）")
check("ASSET-A" in lib, "旧书还在")

print("\n[3] 阅读进度更新后，缓存必须失效")
time.sleep(0.02)
insert(db_path, 1, "ASSET-A", "活着", book_a, 0.80)
lib = B.load_library()
check(abs(lib["ASSET-A"]["progress"] - 0.80) < 1e-9,
      f"进度更新为 0.80（实际 {lib['ASSET-A']['progress']}）")

print("\n[4] WAL 里新增（未 checkpoint）也要能看到")
time.sleep(0.02)
con = sqlite3.connect(db_path)
con.execute("pragma journal_mode=wal")
con.execute(
    "insert into ZBKLIBRARYASSET (Z_PK, ZASSETID, ZTITLE, ZAUTHOR, ZPATH, ZREADINGPROGRESS, ZISFINISHED, ZGENRE)"
    " values (3, 'ASSET-W', 'WAL里的书', '某作者', ?, 0.1, 0, '')",
    (str(books_dir / "WAL里的书.epub"),),
)
con.commit()
# 刻意不 checkpoint：数据只活在 -wal 里
check((lib_dir / "BKLibrary.sqlite-wal").exists(), "WAL 文件存在（数据尚未落主库）")
lib = B.load_library()
check("ASSET-W" in lib, "只存在于 WAL 的书也能读到（指纹把 -wal 算进去了）")
con.close()

print("\n[5] find_books()：目录里有的书要合并进来")
books = B.find_books()
titles = {b["title"] for b in books}
check("活着" in titles, "库里登记的书在列表里")
check("只存在于目录" in titles, "只在目录里的书也合并进来了（原缺陷：库里非空就不扫目录）")
check(len(books) >= 3, f"至少 3 本（实际 {len(books)}：{sorted(titles)}）")
dir_only = next((b for b in books if b["title"] == "只存在于目录"), None)
check(dir_only is not None and dir_only["asset_id"] is None, "目录书 asset_id 为空")
check(any(b["asset_id"] == "ASSET-A" for b in books), "库里的书仍带 asset_id")

print("\n[6] force=True 可强制重读")
B._library_cache = {"__stale__": True}      # 塞一个假缓存，指纹不动
lib = B.load_library(force=True)
check("__stale__" not in lib, "force 绕过了缓存")

print("\n[7] 读失败不留下空缓存")
B._library_cache = None
B._library_stamp = None
B.LIBRARY_DB = tmp / "不存在的目录"          # 模拟库目录不见了
lib = B.load_library()
check(lib == {}, "读不到时返回空字典")
# 目录不存在 → 指纹是空元组（已缓存），但**库一出现指纹就变**，所以会自愈
check(B._library_stamp == (), f"库不存在时指纹为空元组（实际 {B._library_stamp!r}）")
B.LIBRARY_DB = lib_dir
lib = B.load_library()
check("ASSET-A" in lib, "库恢复后立刻又能读到（指纹变化触发重读）")

print("\n[7b] 真正读失败（文件在但不是 sqlite）不留指纹")
bad_dir = tmp / "坏库"
bad_dir.mkdir(exist_ok=True)
(bad_dir / "BKLibrary.sqlite").write_bytes(b"this is not a sqlite database at all" * 8)
B.LIBRARY_DB = bad_dir
B._library_cache = None
B._library_stamp = None
lib = B.load_library()
check(lib == {}, "坏库返回空字典")
check(B._library_stamp is None,
      f"失败不留指纹，下次会重试（而不是永久缓存空结果）实际 {B._library_stamp!r}")
B.LIBRARY_DB = lib_dir

print("\n[8] 只读操作不能让指纹变化（否则缓存永远不命中）")
# -shm 是 WAL 的索引，SQLite 每次读都会动它的 mtime。指纹若把它算进去，
# 缓存就永远不会命中，等于每次都重读整个库 —— 这是实测出来的坑。
B._library_cache = None
B._library_stamp = None
B.load_library()
fp_a = B._library_fingerprint()
B.load_library()
B.load_library()
fp_b = B._library_fingerprint()
check(fp_a == fp_b, "连续只读后指纹不变（-shm 的 mtime 抖动不会污染指纹）")
check((lib_dir / "BKLibrary.sqlite-shm").exists(), "-shm 确实被 SQLite 建出来了")

print("\n[9] 缓存命中时不重复读库（指纹不变就复用）")
first = B.load_library()
second = B.load_library()
check(first is second, "指纹不变时返回同一个对象（确实走了缓存）")
check(B._library_stamp is not None, "成功读取后留下指纹")

print(f"\n===== 通过 {pass_n} · 失败 {fail_n} =====")
sys.exit(1 if fail_n else 0)
