#!/usr/bin/env python3
"""模型空闲回收的单测：不需要真模型、不联网，秒级跑完。

跑法：python3 test_eviction.py
"""
import os
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

# 必须在 import 之前设，EMBED_TTL / RERANK_TTL 是模块级常量
os.environ.pop("APPLE_READ_EMBED_TTL", None)
os.environ.pop("APPLE_READ_RERANK_TTL", None)

import books_rag as b  # noqa: E402

passed = 0
failed = 0


def ok(msg):
    global passed
    passed += 1
    print("  ✓ " + msg)


def bad(msg, detail=""):
    global failed
    failed += 1
    print("  ✗ " + msg + (" — " + str(detail) if detail else ""))


def reset(model=None, reranker=None, model_use=1000.0, rerank_use=1000.0):
    b._model = model
    b._reranker = reranker
    b._model_last_use = model_use
    b._reranker_last_use = rerank_use


print("\n[1] 默认 TTL 合理")
b.RERANK_TTL == 180 and b.EMBED_TTL == 900 and b.RERANK_TTL < b.EMBED_TTL
ok(f"精排 {b.RERANK_TTL}s / 嵌入 {b.EMBED_TTL}s（大的先回收）")
if not (b.RERANK_TTL == 180 and b.EMBED_TTL == 900 and b.RERANK_TTL < b.EMBED_TTL):
    bad("默认 TTL 不对", f"rerank={b.RERANK_TTL} embed={b.EMBED_TTL}")

print("\n[2] 刚用过 → 不回收")
reset("E", "R", 1000.0, 1000.0)
freed = b.evict_idle_models(1010.0)
freed == [] and b._model == "E" and b._reranker == "R"
ok("10s 内用过，两个模型都留着")
if not (freed == [] and b._model == "E" and b._reranker == "R"):
    bad("不该回收", freed)

print("\n[3] 只超精排 TTL → 只回收精排（1.1GB 那个）")
reset("E", "R", 1000.0, 1000.0)
freed = b.evict_idle_models(1200.0)   # 闲置 200s：>180 但 <900
freed == ["reranker"] and b._reranker is None and b._model == "E"
ok("闲置 200s：只丢精排，嵌入模型留着")
if not (freed == ["reranker"] and b._reranker is None and b._model == "E"):
    bad("回收结果不对", f"freed={freed} model={b._model} reranker={b._reranker}")

print("\n[4] 两个都超时 → 都回收")
reset("E", "R", 1000.0, 1000.0)
freed = b.evict_idle_models(2000.0)   # 闲置 1000s
set(freed) == {"reranker", "embedding"} and b._model is None and b._reranker is None
ok("闲置 1000s：两个都丢，内存还给系统")
if not (set(freed) == {"reranker", "embedding"} and b._model is None and b._reranker is None):
    bad("回收结果不对", freed)

print("\n[5] TTL=0 → 永不回收（想常驻换速度）")
old_r, old_e = b.RERANK_TTL, b.EMBED_TTL
try:
    b.RERANK_TTL = 0
    b.EMBED_TTL = 0
    reset("E", "R", 0.0, 0.0)
    freed = b.evict_idle_models(999999.0)
    freed == [] and b._model == "E" and b._reranker == "R"
    ok("TTL=0 时闲置再久也不动")
    if not (freed == [] and b._model == "E" and b._reranker == "R"):
        bad("TTL=0 不该回收", freed)
finally:
    b.RERANK_TTL, b.EMBED_TTL = old_r, old_e

print("\n[6] 未加载过的模型不会被误判")
reset(None, None, 0.0, 0.0)
freed = b.evict_idle_models(999999.0)
freed == []
ok("从没加载过 → 回收列表为空（不会去动 None）")
if freed != []:
    bad("不该回收", freed)

print("\n[7] get_model / get_reranker 会刷新 last_use")
b._model = "FAKE"
b._model_last_use = 0.0
b.get_model()
b._model_last_use > 0 and b._model == "FAKE"
ok("get_model 复用时刷新了 _model_last_use")
if not (b._model_last_use > 0 and b._model == "FAKE"):
    bad("get_model 没刷新 last_use", b._model_last_use)

b._reranker = "FAKER"
b._reranker_failed = False
b._reranker_last_use = 0.0
b.get_reranker()
b._reranker_last_use > 0 and b._reranker == "FAKER"
ok("get_reranker 复用时刷新了 _reranker_last_use")
if not (b._reranker_last_use > 0 and b._reranker == "FAKER"):
    bad("get_reranker 没刷新 last_use", b._reranker_last_use)

print("\n[8] 回收线程只起一次（幂等）")
before = sum(1 for t in threading.enumerate() if t.name == "model-evictor")
b.start_model_evictor()
b.start_model_evictor()
b.start_model_evictor()
after = sum(1 for t in threading.enumerate() if t.name == "model-evictor")
after == before + 1
ok(f"调用 3 次只新增 1 个回收线程（{before} → {after}）")
if after != before + 1:
    bad("线程数不对", f"{before} → {after}")

print("\n[9] 环境变量可覆盖 TTL")
os.environ["APPLE_READ_RERANK_TTL"] = "7"
os.environ["APPLE_READ_EMBED_TTL"] = "13"
b.RERANK_TTL = b._env_ttl("APPLE_READ_RERANK_TTL", 180)
b.EMBED_TTL = b._env_ttl("APPLE_READ_EMBED_TTL", 900)
b.RERANK_TTL == 7 and b.EMBED_TTL == 13
ok("APPLE_READ_RERANK_TTL=7 / EMBED_TTL=13 生效")
if not (b.RERANK_TTL == 7 and b.EMBED_TTL == 13):
    bad("环境变量没生效", f"rerank={b.RERANK_TTL} embed={b.EMBED_TTL}")

b._env_ttl("APPLE_READ_RERANK_TTL", 180) == 7
os.environ["APPLE_READ_RERANK_TTL"] = "abc"
b._env_ttl("APPLE_READ_RERANK_TTL", 180) == 180
ok("非法值退回默认，不炸")
if b._env_ttl("APPLE_READ_RERANK_TTL", 180) != 180:
    bad("非法值处理不对")
del os.environ["APPLE_READ_RERANK_TTL"]
del os.environ["APPLE_READ_EMBED_TTL"]

print(f"\n结果：{passed} 通过 / {failed} 失败")
sys.exit(1 if failed else 0)
