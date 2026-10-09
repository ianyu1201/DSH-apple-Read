# DSH-apple-Read · dsh-apple-read

把 macOS「**图书**」App 的书库接进 DeepSeek Harness：**真向量语义检索**全书、读高亮与笔记、
一键跳回「图书」App 继续读。

一句话分工：**原生 App 负责读和划重点，DSH 负责检索、追问、看笔记、跳回原文。**

---

## 为什么是这个形态

「图书」是 macOS 原生 App，**没法 iframe 嵌进 DSH 的网页面板**（任何声称能嵌的方案都是假的）。
所以这里不假装做阅读器，而是做「陪读」：

- 你想读书 → 点一下，直接在「图书」App 里读，体验最好；
- 你想问、想找、想回顾 → 在 DSH 里问，答案带原文和章节，方便回去对位置。

## 和 books-ai-reader 的区别

`ianyu1201/books-ai-reader` 那套是 **BM25 关键词检索**（README 里自己写明「全文检索是关键词
（BM25）而非语义」），换个说法就搜不到。这里是 **真向量检索**：

| | books-ai-reader | 本项目 |
|---|---|---|
| 检索 | BM25 字面匹配 | bge-small-zh-v1.5 向量 + 字面加权（0.75 / 0.25） |
| 换说法能搜到吗 | 不能 | 能 |
| 费用 | 本地 | 本地（**检索不花 API 钱**） |
| 数据来源 | 自备 EPUB | 直接读「图书」App 的书库 + 高亮库 |
| 高亮/笔记 | 无 | 有（AEAnnotation） |

实测：拿一个**书里不会这么写**的问法去搜（比如「一个人老了以后靠什么支撑着活下去」），
向量召回 0.68/0.62/0.62，全是贴切段落——BM25 不可能命中这种问法。

---

## 组成

```
books_rag.py                 引擎（PEP 723，uv 自动装依赖）
  ├─ list / index / search / annotations / context / open   CLI
  ├─ serve                    MCP stdio server  → 模型工具 mcp__apple_read__*
  └─ serve-http               本地 HTTP         → 面板后端（常驻，复用模型）

dsh-apple-read/             DSH 插件包（bundle）
  ├─ cordis.patch.yml        一次插入两行：MCP 连接 + 插件本体
  ├─ lib/index.js            宿主半：技能 + /apple-read 面板路由 + 存档 + 阅读上下文注入
  ├─ lib/client.js           客户端半（esbuild 产物）：侧边栏「图书」入口 + 主面板
  ├─ assets/panel/           面板前端（书库 / 高亮 / 检索），嵌在主面板左栏
  ├─ assets/apple-read/SKILL.md   给模型的使用说明
  └─ assets/config.json      默认模型与系统提示词（可被面板设置覆盖）
```

**面板形态**：左栏是上面的 `assets/panel/`（iframe，同源），右栏是**嵌入的 Harness 原生会话**。
对话不再由插件自己实现——不自己写 SSE、不自己抠 API Key，因此天然共享 session 日志、
模型选择、附件与工具。嵌入方式是声明一个 session 作用域子槽，再用 `SessionProvider`
把会话绑给子树，最后 `renderFactorySlot("conversation.content", { variant: "embedded", … })`。

```
宿主（lib/index.js）                            客户端（lib/client.js）
  /api/reading-context  ← 登记「在读哪本 + 划了哪些」      左栏 iframe ──postMessage──┐
  systemPrompt.context  → 按 session 注入给模型                                   │
  /api/search           → 转发给引擎做向量检索（左栏「在书里找」）                  │
  /api/prepare-chat     → 返回要放进输入框的那句话        右栏原生会话 ← 驱动 composer
  /api/reading-workspace→ 建好专用会话目录，供客户端登记成工作区
```

三层数据来源（**全部只读**）：

| 数据 | 位置 | 需要授权 |
|---|---|---|
| 全书正文 | `~/Library/Mobile Documents/iCloud~com~apple~iBooks/Documents/*.epub/` | 否 |
| 书目/进度 | `.../com.apple.iBooksX/.../BKLibrary*.sqlite` | 完全磁盘访问 |
| 高亮/笔记 | `.../com.apple.iBooksX/.../AEAnnotation*.sqlite` | 完全磁盘访问 |

读不到后两个会自动降级：**全文检索照常可用**。

### 窄栏里怎么排：三段 Tab

嵌进侧边栏时 iframe 只有 **340px 宽**，所以面板在这个宽度下换成**三段 Tab**，一次只显示一个区：

```
┌─ 书库 │ 重点 │ 在书里找 ─┐   ← Tab 栏 41px
│                          │
│   当前 Tab 的内容区        │   ← 679px，占满剩余高度
│                          │
└──────────────────────────┘
```

之前是上下堆叠：书库被压到 40%（288px），再扣掉筛选栏和底部状态栏，列表只剩 **193px、一屏约 3 本**。
改成 Tab 后每个区都拿到整高（实测，340×720）：

| | 改前 | 改后 |
|---|---|---|
| 书库区高 | 288px | **679px** |
| 书库列表高 | 193px（一屏 ~3 本） | **584px（一屏 ~10 本）** |
| 「重点」「在书里找」 | 和书库挤在同一个滚动流里 | 各自独立整高 613px |

细节：

- **选完书自动跳到「重点」**——选书的下一步几乎总是看这本书的标注。开机自动落在「最近在读」
  那本时不算手动选，会停在「书库」，方便你直接翻列表。
- 切换靠 `body[data-tab]` 驱动 CSS，`setTab()` 负责展开对应的 `<details>`（Tab 模式下折叠头被隐藏）。
- **宽屏**（直接打开 `/apple-read/`）时 Tab 栏自动隐藏，恢复原来的左右两栏 + 可折叠的「重点 / 在书里找」。
- 窄栏里工具栏分两行（书名一行、按钮一行），超长书名用省略号截断，高度稳定在 66px。

### 伴读会话归到哪儿：一个专用工作区

DSH 里**每个会话都属于一个「工作区」**（工作区 = 磁盘上的一个目录）。早期版本的面板图省事，
写死「优先 `default-workspace`」，于是：

- 每打开一次面板就 `sessions.create()` **新建一个会话**——翻十次面板就在「默认工作区」里多十个；
- 这些会话和别的杂项混在一起，列表很快就没法看了。

现在两处都改了：

| | 以前 | 现在 |
|---|---|---|
| 开在哪个工作区 | 写死优先 `default-workspace` | 专用目录 `~/Documents/deepseek-harness/读书会话`（宿主负责建出来，客户端登记成工作区） |
| 会话复用 | 每次打开都新建 | 按「工作区 + 书名」记住 sessionId，**同一本书接着上次聊** |

```
宿主 GET /api/reading-workspace
  → mkdir -p ~/Documents/deepseek-harness/读书会话
  → { ok: true, path: "…/读书会话" }

客户端 resolveWorkspaceId()
  ① 工作区列表里已经有这个 path  → 直接用
  ② 没有                        → uiWorkspace.workspaces.create({ path })
  ③ 建不出来（老版本 / 没权限）  → 退回 default-workspace（不报错、不影响使用）
```

> **宿主半是旧版本时也能工作。** 客户端拿不到宿主给的路径时（宿主还没重启），会从
> `default-workspace` 的**父目录**推导出兄弟目录 `读书会话`——两者本来就在同一个父目录下。
> 目录存在就能被 `workspaces.create` 采纳（它是「create or resolve」，只采纳**已存在**的
> 绝对路径），所以这一条不需要等宿主重启。想完全按设置项走，重启 Harness 即可。

复用键是 `apple-read.chat.<工作区id>.<书名>`（存在 localStorage）。所以：

- 同一本书反复打开面板 → **同一个会话**，上下文不断。
- 换一本书 → 换一个会话；换回来还是原来那个。
- 工具栏上的「**新对话**」会丢掉当前这本书的会话记录、另起一个（原来那个仍在会话列表里，不会丢数据）。

> 一个边角情况：iframe 加载慢时书名还没到，会话会先按空书名开出来。书名一到，
> 这个兜底会话会被**改挂**到书上，而不是再建一个——否则每打开一次面板就多一个孤儿会话，
> 又回到「乱」的老问题。改挂只在没有这本书的既有会话、且不是「新对话」时发生。

想换地方就在设置里改 `readingDir`（只接受绝对路径或 `~/` 开头——相对路径会随进程 cwd 飘，
当不了工作区），或者设环境变量 `APPLE_READ_READING_DIR`。清空则回到默认的 `读书会话`。

### 已经堆在「默认工作区」里的旧会话怎么办

修好之后新会话不会再乱跑了，但**以前攒下的**还在原地。清理工具：

```bash
node tools/migrate-sessions.mjs                    # dry-run：看要搬哪些（默认源=default-workspace，目标=读书会话）
node tools/migrate-sessions.mjs --apply            # 真搬

node tools/migrate-sessions.mjs --delete           # dry-run：看要删哪些（默认只挑没有任何用户消息的「空壳」）
node tools/migrate-sessions.mjs --delete --apply   # 真删
```

**为什么不能一边用一边跑。** 会话的归属由四处共同决定，缺一处就会「会话打不开」：

| # | 位置 | 作用 |
|---|---|---|
| 1 | `~/.dsh/sessions/<项目目录>/<id>/session.vN.jsonl.zstd` 的**头部 `cwd`** | 决定它属于哪个项目目录 |
| 2 | 会话所在的项目目录名 `--<normalized-cwd>--` | 由 cwd 推导，所以 cwd 变了目录也得挪 |
| 3 | `~/.dsh/storages/session_projcache/sessions/<id>.json` 的 `identity.cwd` | 投影缓存 |
| 4 | `~/.dsh/storages/workspace.json` 的 `sessionIds` | 决定它显示在哪个工作区下面 |

Harness 把 `workspace.json` 装在内存里，退出时可能回写——运行中改文件会被冲掉，
而会话文件已经挪走，结果就是会话打不开。所以 **`--apply` 会先检查 Harness 是否在跑，在跑就拒绝执行**
（`--dry-run` 不改文件，随便跑）。正确姿势：退出 Harness → 跑 `--apply` → 重新打开。

工具的安全设计：

- **默认 dry-run**，真要动手必须显式 `--apply`；
- 动手前把要改的每个文件整份备份到 `~/.dsh/session-migrate-backup-<时间戳>/`，
  **任何一步失败立刻回滚**（测试里逐字节比对过，回滚是无损的）；
- 搬会话时**只重写日志的第 0 帧**（实测那一帧里只有头部一行），其余帧按字节原样复制——
  尊重「已提交的事件永不被重写」这条存储约定；
- 删除模式**默认拒绝删有内容的会话**（判据是「存在一条真正来自用户的消息」，
  插件注入的 `<reading_context>` 不算），要删得显式加 `--force`；
- 目录名编码规则**每次运行都拿磁盘上已有的目录名自检**，自检不过就拒绝推算目标目录名——
  宁可报错让你先去开一次面板，也不瞎猜。

> 目录名到路径的映射是**有损**的（`-` 既表示 `/`，也可能是路径里真实的字符，比如
> `deepseek-harness`），所以工具不靠「反解目录名」认路径，而是**读会话头部自己的 cwd**。
> 目标工作区还没有任何会话时，才退一步用「自检通过的编码器」推算。

---

## 安装

### 0. 前置

- 已给 DeepSeek Harness 授予**「完全磁盘访问权限」**（系统设置 → 隐私与安全性 → 完全磁盘访问权限）。
  没授权也能用全文检索，只是读不到高亮和准确书名。
- `uv` 在 `PATH` 里（常见位置 `~/.local/bin/uv`；插件自己也会去 `~/.local/bin`、
  `/opt/homebrew/bin`、`/usr/local/bin` 找一遍，所以通常不用管）。

### 1. 客户端产物（**已经构建好了，通常跳过这步**）

`lib/client.js` 已构建并随包放在目录里，直接进第 2 步即可。

只有改过 `src/client/index.jsx` 之后才需要重建：

```bash
cd /path/to/DSH-apple-Read/dsh-apple-read
pnpm install          # pnpm-workspace.yaml 已关掉 peer 自动安装，只会装 esbuild
pnpm run build        # 生成 lib/client.js
```

> ⚠️ **构建完请务必删掉 `node_modules`**：
> ```bash
> rm -rf node_modules
> ```
> 插件在 profile 里是以 `link:`（软链）方式安装的，Node 会从插件目录往上找模块。
> 如果插件目录里留着一份 `@deepseek-ai/cordis`，就会加载出**第二份 cordis**，
> 服务注册直接乱掉（表现为面板打不开、技能不出现、甚至整个 Harness 起不来）。
> 本目录的 `pnpm-workspace.yaml` 已把 peer 自动安装关掉，正常 `pnpm install` 也只会装 esbuild，
> 但删掉最保险。
>
> ⚠️ pnpm 10 起，`auto-install-peers` 要从 `pnpm-workspace.yaml` 读；写在 `.npmrc` 里
> **pnpm 12 不认**，会真的把 `@deepseek-ai/cordis` 装进来。两处都保留了：`.npmrc` 兼容 pnpm 9 及更早。

### 2. 安装插件

在 DSH 的**插件页**里选「从本地目录安装」，目录填：

```
/path/to/DSH-apple-Read/dsh-apple-read
```

装完**重启 Harness**（bundle patch 在启动时生效，会插入 MCP 连接和插件本体两行）。

### 3. 先建索引（强烈建议，一次就好）

不建也能用，只是第一次问某本书时要等几十秒自动建索引。一次性建完最省心：

```bash
cd /path/to/DSH-apple-Read
uv run books_rag.py index --all
```

全量实测约 **4 分钟**（扫描版会被跳过），索引约 **50 MB**、
1.5 万个片段，落在 `~/DSH-apple-Read/index/`。重跑会自动跳过没变动的书（增量）。
首次运行会下载 91 MB 的 embedding 模型到 `~/.cache/fastembed`（一次性，之后完全离线）。

---

## 怎么用

### 在对话里（主场景：围绕你划的重点聊）

**你在「图书」App 里划一句 → 回到 DSH 直接问。** 模型会先调 `recent_annotations`，
拿到你划的原文 + 所在章节 + 前后原文，再回答。

> 「我标的这句什么意思？」 ← 它会读你划的那句，而不是复述整本书
> 「我刚划的那句，跟前面那段什么关系？」
> 「我最近在书上划了什么？」
> 「《书名》里这一段为什么这么写？」 ← 问全书内容时才走向量检索
> 「打开《书名》」

背后是 7 个 MCP 工具：`mcp__apple_read__list_books` / `recent_annotations` / `search_book` /
`list_annotations` / `get_annotation_context` / `index_book` / `open_in_books_app`。

### 在侧边栏面板里

点左侧栏的「**图书**」→ 面板打开，**左栏选书与标注、右栏直接聊**。
打开时会自动落在你**最近在读**的那本书上。

**左栏（书库与标注）**

- 书名筛选、全量索引、书库统计；底部是引擎状态。
- **我划的重点**：你在「图书」App 里划的高亮与笔记，按时间倒序。
  每条右边有「**问 AI**」，点一下就以那条为锚点开聊；「看上下文」展开前后原文。
- **在书里找**：输入一句话，在整本书里做**向量语义检索**——换个说法也能召回，
  不必和原文用词一致。结果标出章节名与相关度，每段右边同样有「问 AI」；
  点了会把**整段原文**交给模型，并把本轮作用域收窄到这一段。

**右栏（Harness 原生会话）**

- 这就是普通的 DSH 对话：写进 session 日志、共享模型选择、能用工具与附件。
- 你在左栏选的书、划的重点会自动作为**当前阅读上下文**注入，
  所以可以直接在原生输入框里打字问「我标的这句什么意思」，不必先贴原文。
- **还没开始聊的时候**，右栏不是一片空白，而是一块开场页：书名 + 三个可以直接点的
  开场问题（「这本书的核心主张是什么？」「我划的重点里，哪几条最关键？」
  「挑一个反直觉的观点展开讲讲」）。点了就走和「问 AI」同一条路：先备料再替你发进原生会话。
  这样即使你不知道从哪儿问起，也有个抓手。
- 点左栏的「问 AI」会把问题**替你发进原生会话**。如果输入框里已有草稿或待发附件，
  会先提示你处理，**不会覆盖**你正在写的东西。
- 回答会标出章节名，方便你回「图书」App 对位置。
- 工具栏右侧的「**新对话**」丢掉这本书当前的会话、另起一个。

> 面板**没有自己的标题栏**。DSH 已经给了一条原生标题栏（含「返回对话」），
> 面板再放一个 brand 就会变成左上角两个标题、右上角两个「打开图书」——之前就是这个毛病，已去掉。

---

## 关于「建索引」

**「建索引」= 把这本书全文做成向量库**，是的，整本。

它做的事：读 EPUB → 按 480 字切成片段 → 每个片段用本地 bge-small-zh-v1.5 算一个
512 维向量 → 存到 `~/DSH-apple-Read/index/<书id>.json` + `.npy`。

| | |
|---|---|
| 花多久 | 一本普通书 5~15 秒；30 本合计实测约 4 分钟 |
| 花多少钱 | **0**。全在本地 CPU 算，不调 API（只有「回答」那一步才用模型） |
| 什么时候要点 | **通常不用**。第一次问某本书时会自动建，只是要等几十秒 |
| 「重建索引」是什么 | 无视缓存，把这本书**重新**算一遍（书更新了、或怀疑索引坏了时用） |
| 重复点会浪费吗 | 不会。没变动的书按目录 mtime 自动跳过 |
| 占多大 | 一本书约 1 MB；30 本量级约 50 MB（1.5 万个片段） |

一句话：**它是本地缓存，不是必需操作**。先点一次「全量索引」把书库做掉，以后基本不用管。

---

## 关于「精排」（rerank）

向量检索只能告诉你「这两段文字**长得像**」；精排（cross-encoder）是把问题和正文
**放在一起**读一遍，能分辨「字面像」和「真的在回答这个问题」。开启后检索更准。

**需要一次性下载 1 GB 的模型**（`BAAI/bge-reranker-base`），所以**不会自动下载**：

```bash
cd /path/to/DSH-apple-Read
uv run books_rag.py rerank-setup     # 约 30 秒（实测）
```

下载完就自动生效（面板里「精排」开关会亮起来，回答上会标「全书检索（已精排）」）。
没下载也能用，只是退回「向量 + 字面」混合排序。

### 它到底有没有用：实测数据

32 个问题分三组 A/B（唯一变量是精排开关，指标是「正确答案排第几名」）：

| 问题类型 | 例子 | hit@1 关 → 开 | MRR 关 → 开 |
|---|---|---|---|
| 简单（字面能对上） | 「他为什么把家产败光了」 | 11/13 → 12/13 | 0.865 → 0.938 |
| 困难（换说法） | 「人为什么会随大流」（书里写的是「从众」） | 7/11 → **10/11** | 0.803 → **0.955** |
| 抽象（问意义/感受） | 「这本书到底想说什么」 | 7/8 → 7/8 | 0.875 → 0.875 |
| **合计** | | **25/32 → 29/32** | **0.846 → 0.928** |

代价：每次检索 **0.22 秒 → 1.9 秒**（对聊天没影响，回答本身要好几秒）。

### 一个必须说的坑：闸门

一开始直接开精排，**抽象问题反而变差了**（MRR 0.875 → 0.823，
「这本书到底想说什么」从第 1 名掉到第 4 名）—— 而这类问题恰恰是伴读的主场景。

原因是 cross-encoder 在「整本书里没有哪一段真的直接回答这个抽象问题」时，
分数全都很低，此时它的排序基本是噪声，却把原本正确的混合排序顶掉了。

修法是加一道**置信度闸门**：只有当精排的最高分 ≥ 0.5（等价于 logit > 0，
也就是它**正面认定**某段相关）才允许重排，否则保持混合排序。加闸门后：

| 闸门 | 简单 | 困难 | 抽象 | 合计 hit@1 | 合计 MRR |
|---|---|---|---|---|---|
| 关（无精排） | 11/13 | 7/11 | 7/8 | 25/32 | 0.846 |
| 不设闸门 | 12/13 | 9/11 | **6/8** | 27/32 | 0.890 |
| **0.4 ~ 0.6** | 12/13 | **10/11** | **7/8** | **29/32** | **0.928** |
| 0.7 | 12/13 | 9/11 | 7/8 | 28/32 | 0.907 |

0.4~0.6 是一片平台（不是卡在某个点上），取 0.5 既好解释又稳。

复现：
```bash
cd /path/to/DSH-apple-Read
uv run eval_rerank.py     # 完整 A/B + 闸门扫描
uv run test_rerank.py     # 精排行为测试（含闸门回归保护）
```

### 命令行（不依赖插件）

```bash
cd /path/to/DSH-apple-Read
uv run books_rag.py list
uv run books_rag.py search --book <书名> "<问题>" -k 5
uv run books_rag.py annotations --limit 20
uv run books_rag.py annotations --context --limit 5   # 带上所在章节和前后原文
uv run books_rag.py context --id <标注 id>
uv run books_rag.py open --book <书名>
```

加 `--json` 拿机器可读输出。

---

## 内存与进程：为什么不会越跑越卡

精排模型（cross-encoder）**一个就占 1 GB 以上**，嵌入模型约 94 MB，两者都是按需加载。
所以真正要防的是两件事：**进程堆积**和**模型永不释放**。两件都已修掉。

### 1. sidecar 单例化（宿主侧）

`serve-http` 是 `uv run …` 两层进程。以前插件只在内存里存了个 Promise，**没有任何退出清理**：
Harness 崩溃、插件重载、测试脚本退出……外层没了，python 子进程就变成孤儿（`ppid=1`）留在系统里。
而每个孤儿只要被查过一次，就各自攥着最多 1 GB 的模型不放。实测曾堆积到 **7 个 sidecar**
（其中 6 个是孤儿），合计约 1.2 GB 常驻内存。

| 机制 | 做什么 |
|---|---|
| pidfile | `~/.dsh/storages/apple-read/sidecar.json` 记 `{pid, port}` |
| `/health` 探活 | 起新实例前先问旧的在不在、能不能用；能用就**直接复用**，连模型都不必重新加载 |
| 启动回收 | 探活失败就把残留的 `serve-http` 全清掉（`SIGTERM`，1.5s 后 `SIGKILL` 兜底） |
| 退出清理 | 插件 dispose 时杀掉自己起的 sidecar 并删 pidfile，正常退出**不留孤儿** |

> 回收只匹配 `books_rag.py serve-http`——MCP 那个是 `books_rag.py serve`，**不会被误杀**。

### 2. 模型空闲回收（引擎侧）

模型以前是模块级全局、**永不释放**。现在记 `last_use`，后台线程每 30 秒扫一次，
超时就丢掉并 `gc.collect()` 把内存还给系统：

| 模型 | 大小 | 默认 TTL | 环境变量 |
|---|---|---|---|
| 精排 cross-encoder | ~1.1 GB | **180s** | `APPLE_READ_RERANK_TTL` |
| 嵌入 bge-small-zh | ~94 MB | **900s** | `APPLE_READ_EMBED_TTL` |

设 `0` 表示永不回收（想拿常驻换速度就这么设）。安全性靠 Python 引用计数：正在推理的调用
持有自己的引用，把全局置空只会让**下一个**请求重新加载，不会打断在飞的调用。

代价：精排闲置超过 3 分钟后再用，要重新加载约 1 GB（几秒）。检索本身不受影响。

---

## 验证

```bash
cd /path/to/DSH-apple-Read/dsh-apple-read
npm run check                        # 构建客户端 + 264 项离线测试（不调模型，最快）
npm run test:host                    # 宿主半端到端：静态资源 + 全部 API + SSE 聊天（35 项，真调模型）
npm run test:sidecar                 # sidecar 单例/复用/孤儿回收/退出清理（14 项，假 uv，离线）
npm run test:panel                   # 面板一致性：id 引用、Tab 映射、CSS 切换规则（26 项，纯静态）
node tests/md.test.mjs               # 面板 markdown 渲染 + HTML 转义（15 项）
node tests/client-bundle.test.mjs    # 客户端产物：真跑一遍 bundle，查槽位/子槽/适配层/降级（54 项）
node tests/session-reuse.test.mjs    # 会话归拢：工作区三级解析 + 一本书一个会话 + 兜底改挂（42 项）
node tests/annotation-chat.test.mjs  # 伴读核心：上下文注入 + 设置校验 + 面板接线（55 项）
node tests/migrate-sessions.test.mjs # 会话搬迁/删除工具：四处同步 + 事件字节不变 + 失败回滚（58 项）
python3 ../test_eviction.py          # 模型空闲回收（11 项，不需要真模型）
python3 ../mcp_test.py               # MCP stdio：initialize → tools/list → tools/call（7 工具）
cd .. && uv run test_rerank.py       # 精排行为 + 置信度闸门回归保护（17 项）
```

> `migrate-sessions.test.mjs` 全程在临时目录里跑，不碰真实 `~/.dsh`：搬迁后**逐字节**确认
> 除头部外的事件没被重写，回滚后**逐字节**确认整个 DSH_HOME 与动手前一致
> （包括「目标位置不留重复目录」这个踩过的坑），以及自检不通过时拒绝推算目录名。

> `session-reuse.test.mjs` 用假 `sessions` / `uiSession` / `uiWorkspace` 验协议与分支：
> 专用目录优先、没有就 `workspaces.create({path})`、建不出来退回默认、相对路径被拒；
> 以及复用键、换书换会话、`forceNew`、死会话自愈、兜底会话改挂、失败时释放引用。
> 这些接口没有 `.d.ts`，写错只会**静默**把会话列表搞乱，所以值得单独钉住。

> `test:panel` 是纯静态解析：把 `index.html` / `style.css` / `app.js` 三份文件对一遍，
> 抓「JS 引用了不存在的 id」「Tab 名字和内容区对不上」「CSS 少写一条切换规则」这类
> 在浏览器里只表现为「点了没反应」的错。

> `npm run build` / `npm run check` 需要 `esbuild`。本包**故意不常驻 `node_modules`**
> （`pnpm-workspace.yaml` 关掉了 peer 自动安装；多出一份 `@deepseek-ai/cordis` 会让整个 profile 起不来）。
> 要构建时临时装一份即可，装完把 `node_modules` 删掉：
> ```bash
> pnpm install --prefer-offline && npm run check && rm -rf node_modules
> ```
> `lib/client.js` 是**已构建好并提交的产物**，日常只是用面板的话不需要重新构建。
>
> `test-host.mjs` 需要指向测试索引：
> ```bash
> APPLE_READ_INDEX="$PWD/../.index" node test-host.mjs
> ```

> 如果这两个脚本是在**被沙箱限制的终端**里跑的（比如从 DSH 的 bash 工具里跑），
> 需要把 uv 的缓存指到可写位置，否则 `uv` 会因为打不开 `~/.cache/uv` 而失败：
> ```bash
> export UV_CACHE_DIR="$PWD/../.cache/.uvcache" FASTEMBED_CACHE_PATH="$PWD/../.cache/.fastembed" HF_HOME="$PWD/../.cache/.hf"
> ```
> 正常从 GUI 启动的 Harness 没有这个限制，不需要设。

---

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 面板显示「引擎没起来」 | sidecar 起不来。看返回里的 `detail`。最常见是 `uv` 路径不对或依赖没装好 |
| 面板能开、检索报错 | 点「建索引」，或先在命令行跑 `index --book <书名>` |
| 读不到高亮 / 书名不准 | 没给 Harness「完全磁盘访问权限」。系统设置里加的是**启动 Harness 的那个 App**，加完必须重启 |
| 问「我标的这句」却答成整本书 | 装的是新版但**没重启 Harness**，`recent_annotations` 这个新工具还没注册进去。重启即可 |
| 面板说「这本书还没有高亮或笔记」 | 你在「图书」App 里还没划过这本书；或没给 Harness 完全磁盘访问权限 |
| 首次提问等很久 | 正在下载模型（91 MB）或给这本书建索引。之后就快了 |
| 某本书搜不到内容 | 带 DRM 的书（App Store 购买）读不到全文；或者这本书还没有本地文件 |
| MCP 工具在对话里不出现 | 装完没重启；或 `uv` 不在 Harness 进程的 `PATH` 里（用 `APPLE_READ_UV` 指定绝对路径）；或插件不是从克隆下来的 `DSH-apple-Read` 目录装的（引擎 `books_rag.py` 就在插件目录的同级） |
| 电脑变卡 / 内存被吃光 | 旧版是 sidecar 孤儿堆积导致（现已修）。排查残留：`ps -eo pid,ppid,rss,command \| grep "books_rag.py serve-http"`，多出来的用 `kill <pid>` 清掉；升级后重启 Harness 即生效 |
| 伴读会话还是开在「默认工作区」 | 宿主半改了要**重启 Harness**（客户端半刷新页面即可，宿主半不会热加载）。重启后首次打开面板会自动建出 `~/Documents/deepseek-harness/读书会话` 并登记成工作区 |
| 工作区列表里没有「读书会话」 | 同上，宿主没重启 → `/api/reading-workspace` 还是 404 → 客户端静默退回默认工作区（这是有意的兜底，不会报错）。重启即可；也可以手动画一个同名工作区 |
| 每打开一次面板就多一个会话 | 旧版行为（每次 `sessions.create`）。新版按「工作区 + 书名」复用；如果还在新建，说明 `lib/client.js` 没更新——重建产物并刷新页面 |
| 「新对话」点了没反应 | 它只在**选了书**且会话已就绪时可用（未就绪时是灰的）。先从左栏选一本书 |

**关于路径**：`cordis.patch.yml` 里**没有**写死的绝对路径。`uv` 走 `PATH`（可用环境变量
`APPLE_READ_UV` 覆盖），`books_rag.py` 在插件启动时从 profile 目录反解出来
（`createRequire(baseUrl).resolve('dsh-apple-read/package.json')` 再取同级）。
所以项目目录搬家、换台机器克隆下来，都**不需要改配置**。
唯一的前提是：插件要从**克隆下来的 `DSH-apple-Read` 目录**安装——引擎就在插件目录的同级。

---

## 边界与已知问题

- **只读非 DRM 的 EPUB。** 带 DRM 的书拿不到全文。
- **扫描版（图片）图书无法检索。** 整本都是图片、没有文字层，引擎会明确报
  「这是扫描版（图片）图书：N 张图片、正文只有 M 字」并跳过，而不是建一个满是噪音的索引。
  实测有 2 本属于这种情况（一本 305 张 jpg；另一本 68 张图片、正文仅 666 字）。
- **spine 损坏的 EPUB 有兜底。** 有些书的 OPF spine 只列一个占位文件或一堆空壳
  （实测某本 spine 只有 1 项而 manifest 有 307 项）。引擎在 spine 正文少得不像一本书时，
  会自动把 manifest 里其余的 HTML 补上，并把过短的文档合并成章节，
  避免「整本书一个字都搜不到」。
- **高亮库是 Apple 的非公开 schema**，系统升级可能失效。失效时降级为纯全文检索，不影响主要功能。
- **高亮文字与正文标点可能不一致**（标注库里存全角「，」，正文是半角「,」）。引擎用
  「NFKC + 去空白」折叠匹配两边，实测能精确定位；万一定位失败会退回按 CFI 定位到章节。
- 面板的**对话就是 Harness 的原生会话**（右栏），所以它写进 session 日志、共享模型选择、
  能用工具与附件——不再是插件里的一次性会话。左栏 iframe 只负责书库 / 标注 / 检索。
- 阅读上下文按 session 注入：登记「当前在读哪本 + 你划了哪些」后，模型每一轮都能看到；
  没有登记的会话读到空串，不会互相串味。
- `systemPrompt.context()` 注册的文本**总会被变量插值**（`interpolate: false` 对它无效），
  而插值遇到残缺的 `{{…}}` 会直接抛错、让这一轮对话失败。注入的是书里的原文，
  完全不可信，所以落库前会把 `{{` 拆开中和掉（`escapePromptBraces`）。
- 面板设置（模型、是否带标注、是否精排、检索条数、系统提示词）存在
  `~/.dsh/storages/apple-read/data.json`，写入前做白名单与范围校验；
  `assets/config.json` 只提供默认值。改设置优先用面板，不必手改文件。
- 嵌入原生会话用到的 `sessions` / `uiSession` / `inputActions` / `renderFactorySlot`
  是 Harness 的**未文档化内部接口**（该版本产物里没有任何 `.d.ts`）。所以客户端处处做
  能力探测：版本不匹配时给一句人话并保留左栏功能，而不是白屏。
- **改了宿主半要重启 Harness**才生效（客户端半刷新页面即可）。
- **sidecar 是单例**（pidfile + `/health` 复用）。如果同时开两个 Harness 实例，它们会共用同一个
  sidecar；后退出的一方会把它收掉，另一方下次请求会自动重新拉起——能自愈，但会多一次冷启动。
- **模型会空闲回收**（精排 180s / 嵌入 900s，见上文）。想让它常驻就设
  `APPLE_READ_RERANK_TTL=0`、`APPLE_READ_EMBED_TTL=0`。
- 索引是「书的目录 mtime 变了才重建」，增量跳过。
