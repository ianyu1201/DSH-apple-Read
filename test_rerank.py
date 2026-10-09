#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.10"
# dependencies = ["fastembed>=0.4.0", "numpy", "jieba"]
# ///
"""精排（rerank）行为测试。

验证四件事：
  1. rerank_available() 如实反映模型是否在本地缓存（不触发下载）
  2. rerank=False 时不做精排，且结果与「未启用」一致
  3. rerank=True 且模型可用时，确实重排了，并标 reranked=True
  4. 置信度闸门：cross-encoder 不自信时**退回混合排序**，不把结果排乱
     （这条最关键 —— 没有它，抽象问题会变差，实测 MRR 0.875→0.823）

跳过而不是失败的情况：书库为空、这本书还没建索引、精排模型没下载。
新克隆下来第一次跑，通常就是「还没建索引」—— 先跑
`uv run books_rag.py index --all` 再回来。

不写死书名 —— 各人书库不一样。默认取书库里的第一本，也可以指定：

  APPLE_READ_TEST_BOOK    书名（支持子串）
  APPLE_READ_TEST_QUERY   用来检索的问题
  APPLE_READ_TEST_KEYS    正确答案段落里应该出现的词，逗号分隔
                           （设了才会跑「第一名确实命中」这类内容断言）

跑法：cd DSH-apple-Read && uv run test_rerank.py
"""
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("APPLE_READ_INDEX", str(Path(__file__).parent / ".index"))

import books_rag as B  # noqa: E402

PASS = FAIL = 0

BOOK_Q = os.environ.get("APPLE_READ_TEST_BOOK", "").strip()
QUERY = os.environ.get("APPLE_READ_TEST_QUERY", "").strip() or "这本书讲了什么"
KEYS = tuple(k.strip() for k in os.environ.get("APPLE_READ_TEST_KEYS", "").split(",") if k.strip())


def ok(m):
    global PASS
    PASS += 1
    print("  ✓ " + m)


def bad(m, d=""):
    global FAIL
    FAIL += 1
    print("  ✗ " + m + (f" — {d}" if d else ""))


def check(label, cond, detail=""):
    ok(label) if cond else bad(label, detail)


def search(book, query, **kw):
    """没建索引时返回 None 并说明，而不是把 traceback 打给用户看。"""
    try:
        return B.search(book, query, auto_index=False, **kw)
    except RuntimeError as e:
        print(f"  ⏭  跳过：{e}")
        return None


def pick_book():
    """优先 APPLE_READ_TEST_BOOK，否则取书库里的第一本。"""
    if BOOK_Q:
        return B.resolve_book(BOOK_Q)
    try:
        books = B.find_books()
    except Exception:  # noqa: BLE001
        return None
    return books[0] if books else None


def main():
    print(f"\n精排模型：{B.RERANK_MODEL}   池大小：{B.RERANK_POOL}   闸门：{B.RERANK_MIN_CONF}")
    avail = B.rerank_available()
    print(f"本地缓存可用：{avail}\n")

    book = pick_book()
    if not book:
        hint = f"（APPLE_READ_TEST_BOOK={BOOK_Q}）" if BOOK_Q else "（书库是空的？）"
        print(f"⏭  跳过：找不到可测的书 {hint}")
        return 0
    title = book.get("title") or book.get("name") or "?"
    print(f"测试用书：《{title}》\n")
    q = QUERY

    print("[1] rerank_available() 的行为")
    check("返回 bool（不触发下载）", isinstance(avail, bool))
    env_cache = os.environ.get("FASTEMBED_CACHE_PATH", "").strip()
    if env_cache:
        check("缓存路径基于 FASTEMBED_CACHE_PATH",
              str(B._fastembed_cache()) == env_cache, str(B._fastembed_cache()))
    else:
        print("  ⏭  跳过缓存路径检查：未设置 FASTEMBED_CACHE_PATH")

    print("\n[2] rerank=False：不做精排")
    r_off = search(book, q, k=5, rerank=False)
    if r_off is None:
        print("     （先跑 `uv run books_rag.py index --all` 再回来测）")
        print(f"\n===== 通过 {PASS} · 失败 {FAIL} =====")
        return 0
    check("reranked=False", r_off["reranked"] is False)
    check("每条 hit 都带 reranked 字段", all("reranked" in h for h in r_off["hits"]))
    check("没有 rerank_score", all("rerank_score" not in h for h in r_off["hits"]))
    check("名次连续 1..5", [h["rank"] for h in r_off["hits"]] == [1, 2, 3, 4, 5])

    print("\n[3] rerank=True：确实精排（需模型已缓存）")
    if not avail:
        print("  ⏭  跳过：模型未下载。跑 books_rag.py rerank-setup 启用。")
    else:
        r_on = search(book, q, k=5, rerank=True)
        if r_on is None:
            pass
        else:
            check("返回结构完整", len(r_on["hits"]) == 5)
            check("名次连续 1..5", [h["rank"] for h in r_on["hits"]] == [1, 2, 3, 4, 5])
            if r_on["reranked"]:
                check("每条都带 rerank_score", all("rerank_score" in h for h in r_on["hits"]))
                check("每条都带 hybrid_score", all("hybrid_score" in h for h in r_on["hits"]))
                top = max(h["score"] for h in r_on["hits"])
                check(f"最高置信度 {top:.3f} ≥ 闸门 {B.RERANK_MIN_CONF}", top >= B.RERANK_MIN_CONF)
                if KEYS:
                    check("第一名确实是相关段落",
                          any(k in r_on["hits"][0]["text"] for k in KEYS),
                          r_on["hits"][0]["text"][:60])
                else:
                    print("  ⏭  跳过「第一名是相关段落」：未指定 APPLE_READ_TEST_KEYS。")
            else:
                print(f"  ⏭  这次没触发重排（reranked={r_on['reranked']}），"
                      "可能是闸门判定不自信；换个 APPLE_READ_TEST_QUERY 再试。")

    print("\n[4] 置信度闸门：不自信时必须退回混合排序")
    if not avail:
        print("  ⏭  跳过：模型未下载。")
    else:
        # 用一个几乎不可能有相关段落的乱码查询，逼出「精排不自信」的分支
        weird = "紫色独角兽骑着微波炉在月球上烤面包"
        r_w = search(book, weird, k=5, rerank=True)
        if r_w is not None:
            check("乱码查询 reranked=False（闸门拦住了）", r_w["reranked"] is False,
                  f"reranked={r_w['reranked']}")
            # 闸门拦住时，顺序必须与纯混合排序完全一致
            r_w_off = search(book, weird, k=5, rerank=False)
            if r_w_off is not None:
                same = [h["text"] for h in r_w["hits"]] == [h["text"] for h in r_w_off["hits"]]
                check("顺序与混合排序完全一致（没被排乱）", same)
                if not same:
                    for a, b in zip(r_w["hits"], r_w_off["hits"]):
                        print(f"      精排[{a['rank']}] {a['text'][:40]}")
                        print(f"      混合[{b['rank']}] {b['text'][:40]}")

    print("\n[5] 精排确实提升了命中（回归保护）")
    if not avail:
        print("  ⏭  跳过：模型未下载。")
    elif not KEYS:
        print("  ⏭  跳过：未指定 APPLE_READ_TEST_KEYS（期望关键词）。")
    else:
        r = search(book, q, k=3, rerank=True)
        if r is not None:
            hit1 = any(k in r["hits"][0]["text"] for k in KEYS)
            check(f"「{q[:14]}」第一名命中", hit1, r["hits"][0]["text"][:60])

    print(f"\n===== 通过 {PASS} · 失败 {FAIL} =====")
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
