# Apple Books RAG · 让 DeepSeek Harness 给你的「图书」App 当伴读

继续用 macOS 原生的「图书」App 读书（高亮、笔记、阅读进度都不变），
让 [DeepSeek Harness](https://github.com/) 在旁边当陪读：**全书向量语义检索**、
**读你的高亮和笔记**、**围绕你划的那句聊**、**一键把书在「图书」App 里打开**。

- 检索完全在本地跑（`bge-small-zh-v1.5` 向量 + 字面加权），**不花 API 钱**，书稿不出本机。
- 只有最后「让模型组织答案」那一步走你自己配的模型。
- 不需要把书导成 EPUB、不需要上传任何东西 —— 直接读「图书」App 自己的书库。

---

## 能做什么

| 场景 | 说法 |
|---|---|
| 围绕你划的重点聊 | 「我标的这句什么意思？」→ 它读你划的那句 + 所在章节 + 前后原文，而不是复述整本书 |
| 换说法也能搜到 | 「一个人老了以后靠什么支撑着活下去」——字面匹配一条都召回不了，向量能 |
| 问全书内容 | 「《书名》里这一段为什么这么写？」 |
| 看你的标注 | 「我最近在书上划了什么？」 |
| 跳回原书 | 「打开《书名》」→ 在「图书」App 里打开 |

接入方式：引擎以 **MCP** 挂进 Harness，模型侧工具名是 `mcp__apple_read__*`（7 个）；
插件另外注册 `apple-read` 技能和一个侧边栏面板。

---

## 仓库结构

```
DSH-apple-Read/
├── books_rag.py              # 引擎：抽取 / 分片 / 向量 / 索引 / 检索 + CLI + MCP server
│                             #   PEP 723 内联依赖，uv 自动装，不用建虚拟环境
├── eval_rerank.py            # 精排 A/B 评测（hit@1 / hit@3 / MRR）
├── eval_questions.example.json  # 评测问题集示例（你自己的那份是 eval_questions.json，不入库）
├── test_rerank.py            # 精排行为测试
├── test_eviction.py          # 模型空闲回收测试
├── mcp_test.py               # MCP stdio 冒烟测试
├── dsh-apple-read/          # DSH 插件包（宿主半 + 客户端半 + 技能 + 面板）
│   ├── cordis.patch.yml      # bundle patch：插入 MCP 行 + 插件行（无可移植性负担，见下）
│   ├── lib/index.js          # 宿主半
│   ├── lib/client.js         # 客户端半（已构建好）
│   ├── assets/apple-read/SKILL.md
│   └── tests/                # 插件侧测试
├── LICENSE                   # MIT
└── .gitignore
```

> **引擎在仓库根目录，插件在 `dsh-apple-read/` 子目录。** 插件启动时会从 profile 目录
> 反解出自己的安装位置，再取同级的 `books_rag.py` —— 所以请**从克隆下来的整个
> `DSH-apple-Read` 目录安装插件**，不要只拷 `dsh-apple-read/` 这一层。

---

## 前置条件

- macOS，且用「图书」App 读书（数据源就是它自己的书库）
- [DeepSeek Harness](https://github.com/) 桌面版
- [`uv`](https://docs.astral.sh/uv/)（引擎靠它跑 PEP 723 脚本，自动装 Python 依赖，无需 venv）
- **可选**：给 Harness 开「完全磁盘访问权限」——不开也能用全文检索，只是读不到高亮和准确书名

> `uv` 在 `PATH` 里就行。插件会依次在 `PATH`、`~/.local/bin`、`/opt/homebrew/bin`、
> `/usr/local/bin` 里找它；都没有的话用 `APPLE_READ_UV` 指定绝对路径。

---

## 安装

### 0. 授权（可选，但强烈建议）

「系统设置」→「隐私与安全性」→「完全磁盘访问权限」→ 点 `+` 添加 **DeepSeek Harness.app**
（如果你从终端启动 Harness，把那个终端也加进去）→ **完全退出并重启 Harness**。

高亮库在 `~/Library/Containers/com.apple.iBooksX/Data/...`，属于 macOS 隐私保护目录，
不给权限读不到。全文在 iCloud 容器里，**不需要授权**。

### 1. 克隆

```bash
git clone https://github.com/ianyu1201/DSH-apple-Read.git DSH-apple-Read
cd DSH-apple-Read
```

### 2. 先建索引（可选，一次就好）

```bash
uv run books_rag.py list          # 看看书库认得几本
uv run books_rag.py index --all   # 全量建索引（增量，没变动的书会跳过）
```

不建也能用，只是第一次问某本书时要等几十秒。首次运行会下载 91 MB 的
`bge-small-zh-v1.5` 模型（一次性，之后完全离线）。索引默认落在 `~/DSH-apple-Read/index/`。

### 3. 装插件

在 DSH 的**插件页**选「从本地目录安装」，目录填**克隆下来的插件目录**：

```
/path/to/DSH-apple-Read/dsh-apple-read
```

装完**重启 Harness**。`cordis.patch.yml` 会在启动时插入两行（MCP 连接 + 插件本体）。

### 4. 验收

新会话里问一句「我最近在书上划了什么？」或者「《你的书名》讲了什么？」，
能看到模型调用 `mcp__apple_read__*` 工具就通了。

---

## 配置

### 环境变量

| 变量 | 默认 | 作用 |
|---|---|---|
| `APPLE_READ_DIR` | iCloud 里的「图书」书库目录 | 换书库位置 |
| `APPLE_READ_INDEX` | `~/DSH-apple-Read/index` | 索引目录 |
| `APPLE_READ_MODEL` | `BAAI/bge-small-zh-v1.5` | 嵌入模型 |
| `FASTEMBED_CACHE_PATH` | `~/.cache/fastembed` | 模型缓存 |
| `APPLE_READ_UV` | 自动查找 | `uv` 可执行文件路径 |
| `APPLE_READ_ENGINE` | 自动反解 | `books_rag.py` 路径（一般不用设） |
| `APPLE_READ_READING_DIR` | `~/Documents/deepseek-harness/读书会话` | 伴读会话的专用工作区 |
| `APPLE_READ_STORE` | `~/.dsh/storages/apple-read/data.json` | 面板设置存档 |
| `APPLE_READ_EMBED_TTL` / `APPLE_READ_RERANK_TTL` | `900` / `180` 秒 | 模型空闲多久回收；设 `0` 常驻 |
| `ARK_API_KEY` / `DEEPSEEK_API_KEY` | — | 面板聊天用的 key（也可以在面板里填） |

### 模型

`dsh-apple-read/assets/config.json` 提供默认的两个 provider（火山方舟 / DeepSeek 官方）。
`apiKeyEnv` 是**环境变量名**，不是 key 本身。改默认值请用面板设置（存在 `APPLE_READ_STORE`
里），`assets/config.json` 只作为出厂默认。

> 面板聊天需要 key。优先级：面板里填的 → 同名环境变量 → `~/.dsh/.credentials.yaml` 里
> 形如 `  ARK_API_KEY: xxx` 的条目。

---

## 命令行（不装插件也能用）

```bash
uv run books_rag.py list
uv run books_rag.py search --book <书名> "<问题>" -k 5
uv run books_rag.py annotations --limit 20
uv run books_rag.py annotations --context --limit 5   # 带上所在章节和前后原文
uv run books_rag.py context --id <标注 id>
uv run books_rag.py open --book <书名>
uv run books_rag.py index --all
uv run books_rag.py serve                             # MCP stdio server
```

加 `--json` 拿机器可读输出。

---

## 测试

```bash
# 引擎侧
uv run test_eviction.py
uv run test_rerank.py
uv run mcp_test.py

# 精排评测（需要自己的问题集，见下）
cp eval_questions.example.json eval_questions.json   # 改成你自己的书和问题
uv run eval_rerank.py

# 插件侧（在 dsh-apple-read/ 目录）
node tests/md.test.mjs                # 纯逻辑，不需要书库
APPLE_READ_INDEX="../.index" node test-host.mjs
APPLE_READ_INDEX="../.index" node tests/annotation-chat.test.mjs
```

测试**不写死书名**：默认取你书库里的第一本，也可以用
`APPLE_READ_TEST_BOOK` / `APPLE_READ_TEST_QUERY` / `APPLE_READ_TEST_KEYS` 指定。
书库为空或模型没下载时，相关用例会**跳过**而不是失败。

---

## 隐私

- 索引、向量、缓存、模型**全部在本地**：`.index/`（约 50 MB）、
  `.cache/`（模型 + uv 缓存，1–3 GB 量级，随时可删）、`~/DSH-apple-Read/index/`。
- 检索不联网、不调用任何 API。书稿不出本机。
- 唯一的外发是你自己触发的「让模型组织答案」那一步 —— 发给你在面板里选的 provider，
  内容包含检索到的原文片段和你的高亮。
- 仓库里**不含**任何索引、缓存、模型权重、个人书单或凭据；`.gitignore` 已覆盖这些。

---

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 读不到高亮、书名不准 | 没给 Harness「完全磁盘访问权限」；加完必须**重启 Harness** |
| MCP 工具在对话里不出现 | 装完没重启；或 `uv` 不在 `PATH` 里（用 `APPLE_READ_UV`）；或插件不是从克隆的 `DSH-apple-Read` 目录装的 |
| 问「我标的这句」却答成整本书 | 装了新版但没重启 Harness |
| 首次提问等很久 | 正在下载模型（91 MB）或给这本书建索引，之后就快了 |
| 某本书搜不到内容 | 带 DRM 的书（App Store 购买）读不到全文；或没有本地文件 |
| 扫描版图书 | 整本图片、没有文字层，引擎会明确报错并跳过，不会建一个满是噪音的索引 |
| 面板设置改了没生效 | 宿主半改动要重启 Harness；客户端半刷新页面即可 |
| 电脑变卡 | 排查 sidecar 残留：`ps -eo pid,ppid,rss,command \| grep "books_rag.py serve-http"` |

---

## 已知限制

- **只读非 DRM 的 EPUB。** App Store 购买的带 DRM 书拿不到全文。
- **扫描版（纯图片）图书无法检索**，会明确报错并跳过。
- **高亮库是 Apple 的非公开 schema**，系统升级可能失效。失效时降级为纯全文检索，不影响主要功能。
- **spine 损坏的 EPUB 有兜底**：spine 正文少得不像一本书时，引擎会自动从 manifest 补齐其余 HTML。
- 面板嵌入 Harness 原生会话用到的 `sessions` / `uiSession` / `inputActions` / `renderFactorySlot`
  是**未文档化的内部接口**，所以客户端处处做能力探测：版本不匹配时给一句人话并保留左栏功能。

---

## 许可

[MIT](./LICENSE) © 2026 ianyu1201

引擎里的高亮读取依赖 Apple 未公开的数据库 schema；「图书」App 本身的版权归 Apple。
