#!/usr/bin/env python3
"""MCP stdio 冒烟测试：拉起 books_rag.py serve，走一遍 initialize → tools/list → tools/call。"""
import json
import os
import queue
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "books_rag.py")


def find_uv() -> str:
    """找到 uv：APPLE_READ_UV → PATH → ~/.local/bin → /opt/homebrew/bin → /usr/local/bin。

    不写死绝对路径：换台机器、换个安装位置都得能跑。
    """
    explicit = os.environ.get("APPLE_READ_UV", "").strip()
    if explicit:
        return explicit
    exe = "uv.exe" if os.name == "nt" else "uv"
    dirs = os.environ.get("PATH", "").split(os.pathsep)
    dirs += [os.path.expanduser("~/.local/bin"), "/opt/homebrew/bin", "/usr/local/bin"]
    for d in dirs:
        if not d:
            continue
        cand = os.path.join(d, exe)
        if os.path.isfile(cand) and os.access(cand, os.X_OK):
            return cand
    return exe  # 交给 PATH 兜底


UV = find_uv()

env = dict(os.environ)
env.setdefault("APPLE_READ_INDEX", os.path.join(HERE, ".index"))
env.setdefault("UV_CACHE_DIR", os.path.join(HERE, ".cache/.uvcache"))
env.setdefault("FASTEMBED_CACHE_PATH", os.path.join(HERE, ".cache/.fastembed"))
env.setdefault("HF_HOME", os.path.join(HERE, ".cache/.hf"))

print("启动 MCP server …", flush=True)
proc = subprocess.Popen(
    [UV, "run", SCRIPT, "serve"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, bufsize=1, cwd=HERE, env=env,
)

lines: "queue.Queue[str]" = queue.Queue()
threading.Thread(target=lambda: [lines.put(l) for l in proc.stdout], daemon=True).start()
errbuf: list[str] = []
threading.Thread(target=lambda: [errbuf.append(l) for l in proc.stderr], daemon=True).start()


def send(obj):
    proc.stdin.write(json.dumps(obj) + "\n")
    proc.stdin.flush()


def wait_for(req_id, timeout=240):
    end = time.time() + timeout
    while time.time() < end:
        try:
            raw = lines.get(timeout=1)
        except queue.Empty:
            continue
        raw = raw.strip()
        if not raw.startswith("{"):
            continue
        try:
            msg = json.loads(raw)
        except json.JSONDecodeError:
            continue
        if msg.get("id") == req_id:
            return msg
    return None


def call(req_id, method, params=None, timeout=240):
    send({"jsonrpc": "2.0", "id": req_id, "method": method, "params": params or {}})
    return wait_for(req_id, timeout)


# 1) initialize
init = call(1, "initialize", {
    "protocolVersion": "2025-06-18",
    "capabilities": {},
    "clientInfo": {"name": "smoke", "version": "1"},
}, timeout=180)
if not init:
    print("✗ initialize 无响应")
    print("stderr:", "".join(errbuf)[-1500:])
    sys.exit(1)
print("✓ initialize:", json.dumps(init.get("result", {}).get("serverInfo", {}), ensure_ascii=False))
print("  protocolVersion:", init.get("result", {}).get("protocolVersion"))

send({"jsonrpc": "2.0", "method": "notifications/initialized"})

# 2) tools/list
tl = call(2, "tools/list", timeout=60)
tools = (tl or {}).get("result", {}).get("tools", [])
print(f"✓ tools/list: {len(tools)} 个工具")
for t in tools:
    print(f"    - {t['name']}: {t.get('description','')[:70]}")

# 3) tools/call list_books
r3 = call(3, "tools/call", {"name": "list_books", "arguments": {}}, timeout=120)
content = (r3 or {}).get("result", {}).get("content", [])
text = content[0]["text"] if content else json.dumps(r3)[:400]
print("\n✓ list_books 前 4 行：")
for ln in text.splitlines()[:4]:
    print("   ", ln)

# 4) tools/call search_book（会触发向量检索）
# 书名不写死：优先 APPLE_READ_TEST_BOOK，否则取书库里的第一本。
def first_book() -> str:
    try:
        p = subprocess.run([UV, "run", SCRIPT, "--json", "list"],
                           capture_output=True, text=True, cwd=HERE, env=env, timeout=180)
        books = (json.loads(p.stdout) or {}).get("books") or []
        if books:
            return str(books[0].get("title") or books[0].get("name") or "")
    except Exception as e:  # noqa: BLE001
        print(f"  （取书名失败：{e}）", flush=True)
    return ""


BOOK = os.environ.get("APPLE_READ_TEST_BOOK", "").strip() or first_book()
if BOOK:
    r4 = call(4, "tools/call", {"name": "search_book",
                                "arguments": {"book": BOOK, "query": "这本书讲了什么", "top_k": 2}},
              timeout=300)
    content = (r4 or {}).get("result", {}).get("content", [])
    text = content[0]["text"] if content else json.dumps(r4)[:400]
    print(f"\n✓ search_book《{BOOK}》结果（前 3 行）：")
    for ln in text.splitlines()[:3]:
        print("   ", ln[:150])
else:
    print("\n⏭  跳过 search_book：书库里没有书（可用 APPLE_READ_TEST_BOOK=<书名> 指定）")

# 5) tools/call list_annotations
r5 = call(5, "tools/call", {"name": "list_annotations", "arguments": {"limit": 2}}, timeout=120)
content = (r5 or {}).get("result", {}).get("content", [])
text = content[0]["text"] if content else json.dumps(r5)[:400]
print("\n✓ list_annotations 前 3 行：")
for ln in text.splitlines()[:3]:
    print("   ", ln[:150])

# 6) tools/call recent_annotations（伴读主工具：标注原文 + 章节 + 前后原文）
r6 = call(6, "tools/call", {"name": "recent_annotations",
                            "arguments": {"limit": 2}}, timeout=180)
content = (r6 or {}).get("result", {}).get("content", [])
text = content[0]["text"] if content else json.dumps(r6)[:400]
print("\n✓ recent_annotations（前 8 行）：")
for ln in text.splitlines()[:8]:
    print("   ", ln[:150])

proc.terminate()
try:
    proc.wait(timeout=5)
except subprocess.TimeoutExpired:
    proc.kill()
print("\n完成。")
