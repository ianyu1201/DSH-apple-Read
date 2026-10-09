#!/usr/bin/env -S uv run --quiet
# /// script
# requires-python = ">=3.10"
# dependencies = ["fastembed>=0.4.0", "numpy", "jieba"]
# ///
"""精排（rerank）A/B 评测：证明「加 cross-encoder 到底有没有用」，而不是凭感觉说有用。

指标：对每个问题预先写好「正确答案必须包含的关键词」，
      看命中段落排在第几 —— hit@1 / hit@3 / MRR。

问题集从外部 JSON 读，不写死在代码里 —— 各人读的书不一样，评测集本来就该是自己的：

  eval_questions.json          你自己的问题集（已被 .gitignore 忽略，不会进仓库）
  eval_questions.example.json  随仓库发布的示例，说明这个 JSON 长什么样

找不到 eval_questions.json 时自动回退到示例；也可以用 EVAL_QUESTIONS=<路径> 指定。

跑法：
  cd DSH-apple-Read
  cp eval_questions.example.json eval_questions.json   # 然后改成你自己的书和问题
  APPLE_READ_INDEX="$PWD/.index" uv run eval_rerank.py
"""
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
os.environ.setdefault("APPLE_READ_INDEX", str(Path(__file__).parent / ".index"))

import books_rag as B  # noqa: E402

# --------------------------------------------------------------------------- #
# 问题集
# --------------------------------------------------------------------------- #
# 分三组，因为「简单组全中」会掩盖问题 —— 简单问句本来就能对，精排的价值要在
# **换说法**和**关键词遍地都是**的问句上才看得出来；而抽象问题（问意义/感受/主题）
# 恰恰是「伴读」的主场景，必须单独量化。三组的含义见 eval_questions.example.json。

_HERE = Path(__file__).parent


def _questions_path() -> Path:
    """EVAL_QUESTIONS → eval_questions.json → eval_questions.example.json。"""
    env = os.environ.get("EVAL_QUESTIONS", "").strip()
    if env:
        return Path(env).expanduser()
    local = _HERE / "eval_questions.json"
    return local if local.exists() else _HERE / "eval_questions.example.json"


def load_questions(path: Path):
    """读问题集，返回 [(组名, 书名, 问题, 期望关键词), ...]。"""
    if not path.exists():
        raise SystemExit(
            f"找不到问题集：{path}\n"
            f"  先复制一份再改成你自己的书：cp eval_questions.example.json eval_questions.json\n"
            f"  或用 EVAL_QUESTIONS=<路径> 指定别的位置。")
    data = json.loads(path.read_text(encoding="utf-8"))
    out = []
    for group in data.get("groups", []):
        name = group.get("name") or "未分组"
        for q in group.get("questions", []):
            out.append((name, q["book"], q["query"], list(q.get("keywords") or [])))
    if not out:
        raise SystemExit(f"问题集是空的：{path}")
    return out


QUESTIONS_PATH = _questions_path()
EVAL = load_questions(QUESTIONS_PATH)
GROUPS = tuple(dict.fromkeys(g for g, *_ in EVAL))


def first_hit_rank(hits, keys):
    """第一个含有关键词的段落排第几（1-based）；没有则 None。"""
    for h in hits:
        if any(k in h["text"] for k in keys):
            return h["rank"]
    return None


def run(rerank, k=5, pool=None, conf=None):
    rows = []
    total = 0.0
    old = (B.RERANK_POOL, B.RERANK_MIN_CONF)
    if pool is not None:
        B.RERANK_POOL = pool
    if conf is not None:
        B.RERANK_MIN_CONF = conf
    try:
        for group, book_q, query, keys in EVAL:
            book = B.resolve_book(book_q)
            if not book:
                rows.append({"group": group, "query": query, "rank": None,
                             "dt": 0.0, "err": f"书没找到：{book_q}"})
                continue
            t0 = time.time()
            try:
                res = B.search(book, query, k=k, rerank=rerank, auto_index=False)
            except RuntimeError as e:
                # 没建索引时不要崩栈，记成一行错误继续跑
                rows.append({"group": group, "query": query, "rank": None,
                             "dt": 0.0, "err": str(e)})
                continue
            dt = time.time() - t0
            total += dt
            rows.append({"group": group, "query": query, "rank": first_hit_rank(res["hits"], keys),
                         "dt": dt, "err": None})
    finally:
        B.RERANK_POOL, B.RERANK_MIN_CONF = old
    return rows, total


def metrics(rows, group):
    """某一组的指标。整组都没有有效样本时返回全 0，而不是 None —— 免得报表直接崩。"""
    sel = [r for r in rows if r["group"] == group and not r["err"]]
    n = len(sel)
    if not n:
        return {"n": 0, "h1": 0, "h3": 0, "mrr": 0.0, "miss": 0, "ms": 0.0}
    return {
        "n": n,
        "h1": sum(1 for r in sel if r["rank"] == 1),
        "h3": sum(1 for r in sel if r["rank"] and r["rank"] <= 3),
        "mrr": sum((1 / r["rank"]) if r["rank"] else 0 for r in sel) / n,
        "miss": sum(1 for r in sel if r["rank"] is None),
        "ms": sum(r["dt"] for r in sel) / n * 1000,
    }


def main():
    print(f"reranker 可用：{B.rerank_available()}   模型：{B.RERANK_MODEL}")
    print(f"问题集：{QUESTIONS_PATH}")
    print(f"问题数：" + " · ".join(f"{g} {sum(1 for r in EVAL if r[0]==g)}" for g in GROUPS) + "\n")

    # 先确认问题集里的书真在书库里 —— 否则后面全是「书没找到」，报表没有意义
    known = {b for _, b, _, _ in EVAL if B.resolve_book(b)}
    if not known:
        print("⚠️  问题集里的书一本都没在书库里找到。")
        print("    · 随仓库发布的示例问题集用的是占位书名，先改成你自己的书：")
        print("        cp eval_questions.example.json eval_questions.json")
        print("    · 或者书名和「图书」App 里对不上（支持子串匹配）")
        print(f"    · 问题集路径：{QUESTIONS_PATH}")
        return

    print("跑 A/B（同一批问题，唯一变量是精排开关）…\n")
    off, t_off = run(False)
    on, t_on = run(True)

    for group in GROUPS:
        print(f"===== {group} =====")
        print(f"{'问题':<30}{'关精排':>8}{'开精排':>8}   变化")
        print("-" * 58)
        for a, b in zip([r for r in off if r["group"] == group],
                        [r for r in on if r["group"] == group]):
            if a["err"]:
                print(f"{a['query'][:28]:<30}{'—':>8}{'—':>8}   {a['err']}")
                continue
            f = lambda r: "未命中" if r is None else f"第{r}名"
            if a["rank"] is None and b["rank"] is not None:
                mark = "变好"
            elif a["rank"] is not None and b["rank"] is None:
                mark = "变差"
            elif a["rank"] != b["rank"]:
                mark = "↑ 变好" if b["rank"] < a["rank"] else "↓ 变差"
            else:
                mark = "="
            print(f"{a['query'][:28]:<30}{f(a['rank']):>8}{f(b['rank']):>8}   {mark}")
        print()

    hdr = "".join(f"{g+'-关':>9}{g+'-开':>9}" for g in GROUPS)
    print("=" * (16 + 18 * len(GROUPS)))
    print(f"{'指标':<16}{hdr}")
    print("-" * (16 + 18 * len(GROUPS)))
    ms = {g: (metrics(off, g), metrics(on, g)) for g in GROUPS}
    for label, key in (("hit@1", "h1"), ("hit@3", "h3"), ("未命中", "miss")):
        cells = "".join(f"{ms[g][0][key]}/{ms[g][0]['n']:>7}{ms[g][1][key]}/{ms[g][1]['n']:>7}"
                        for g in GROUPS)
        print(f"{label:<16}{cells}")
    cells = "".join(f"{ms[g][0]['mrr']:>9.3f}{ms[g][1]['mrr']:>9.3f}" for g in GROUPS)
    print(f"{'MRR':<16}{cells}")
    cells = "".join(f"{ms[g][0]['ms']:>8.0f}ms{ms[g][1]['ms']:>8.0f}ms" for g in GROUPS)
    print(f"{'每次耗时':<14}{cells}")
    print(f"\n总耗时：关 {t_off:.1f}s · 开 {t_on:.1f}s")

    tot_n = sum(ms[g][0]["n"] for g in GROUPS)
    tot_off = sum(ms[g][0]["h1"] for g in GROUPS)
    tot_on = sum(ms[g][1]["h1"] for g in GROUPS)
    print(f"合计 hit@1：关 {tot_off}/{tot_n} → 开 {tot_on}/{tot_n}")

    if os.environ.get("EVAL_NO_SWEEP"):
        return

    # 置信度闸门扫描：精排在「没找到真正相关段落」时排序不可信，
    # 尤其会搞坏抽象问题。看闸门能否只保留收益、去掉副作用。
    print("\n\n### 置信度闸门扫描（池大小固定 20）###\n")
    print(f"{'闸门':>6}" + "".join(f"{g+'hit@1':>11}" for g in GROUPS)
          + f"{'合计hit@1':>11}{'合计MRR':>10}{'抽象MRR':>10}")
    print("-" * (6 + 11 * len(GROUPS) + 31))
    base = [metrics(off, g) for g in GROUPS]
    n_all = sum(b["n"] for b in base) or 1
    print(f"{'关':>6}" + "".join(f"{b['h1']:>8}/{b['n']}" for b in base)
          + f"{sum(b['h1'] for b in base):>8}/{n_all}"
          + f"{sum(b['mrr']*b['n'] for b in base)/n_all:>10.3f}"
          + f"{metrics(off,'抽象')['mrr']:>10.3f}")
    for gate in (0.0, 0.3, 0.4, 0.5, 0.6, 0.7):
        rows, _ = run(True, pool=20, conf=gate)
        st = [metrics(rows, g) for g in GROUPS]
        n = sum(s["n"] for s in st) or 1
        label = "0(不设闸门)" if gate == 0 else f"{gate}"
        print(f"{label:>6}" + "".join(f"{s['h1']:>8}/{s['n']}" for s in st)
              + f"{sum(s['h1'] for s in st):>8}/{n}"
              + f"{sum(s['mrr']*s['n'] for s in st)/n:>10.3f}"
              + f"{metrics(rows,'抽象')['mrr']:>10.3f}")


if __name__ == "__main__":
    main()
