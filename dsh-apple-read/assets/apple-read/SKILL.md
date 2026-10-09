---
name: apple-read
description: DSH-apple-Read / macOS「图书」App 向量检索。当用户提到 Apple Books、图书 App、我的书库、我在读的书、我的高亮/标注/笔记，或者要在某本本地书里找内容、总结、提问、精读时使用。能力：书库列表、全书向量语义检索（换个说法也能召回，不只是字面匹配）、高亮与笔记读取、高亮前后原文还原、在「图书」App 中打开某本书。Use when 用户说「图书 App / Apple Books / 我的书库 / 我在读 / 我的高亮 / 我的笔记 / 我划的线 / 帮我读这本书 / 在书里找 / 这本书讲了什么」。
---

# DSH-apple-Read

用户的主力阅读器是 macOS 的**「图书」App**，不是 DSH 里的阅读器。分工是：
**原生 App 负责读和划重点，DSH 负责检索、追问、看笔记、跳回原文。**

## 优先用 MCP 工具（插件装好时）

本插件通过 `dsh-mcp-client` 暴露了一组 `mcp__apple_read__*` 工具，直接调用即可，**不要**自己去读 EPUB：

| 工具 | 什么时候用 |
|---|---|
| `mcp__apple_read__list_books` | 用户说的书名不确定时，先拿准确书名（库里标题常带副标题/标点，和目录名不一致） |
| `mcp__apple_read__recent_annotations` | **用户说「我标的」「我划的线」「我的高亮」「我的笔记」「刚标记的那句」时的首选**。一次拿到标注原文 + 所在章节 + 前后原文 |
| `mcp__apple_read__search_book` | 问「书里怎么讲 X」「找关于 Y 的段落」时，检索全书拿原文依据 |
| `mcp__apple_read__list_annotations` | 只要标注清单（不含上下文） |
| `mcp__apple_read__get_annotation_context` | 单独看某一条的前后原文；id 从上面两个工具拿 |
| `mcp__apple_read__index_book` | 某本书还没索引、或刚导入新书时 |
| `mcp__apple_read__open_in_books_app` | 用户说「打开这本书」「我要接着读」 |

## 陪读怎么聊（这是重点）

用户的工作流是：**在「图书」App 里读和划线 → 回到 DSH 跟你聊他划的地方。**

所以：

- 用户说「我标的这句」「我划的那句」「这条什么意思」→ **先调 `recent_annotations`**，
  拿到他划的原文 + 上下文，再回答。不要只调 `search_book`——那样会答成「这本书讲了什么」，
  而他想要的是「我划的这句」。
- 回答时**先正面回应他划的这句本身**：它在说什么、为什么值得划、和他的处境有什么关系。
  再联系前后文和全书。别把整本书复述一遍。
- 如果他划的那句正好需要全书其他部分来对照，再用 `search_book` 补。
- 顺带可以提一句这句话在书里的位置（章节名），方便他回去看。
- 他划得多的时候（`recent_annotations` 会按时间倒序），可以问他想聊哪一条，或按主题帮他串起来。

## 回答纪律

- **先检索再回答**。凡是关于书里内容的问题，都先用 `search_book` 拿原文，答案要有原文依据，
  不要凭印象编。检索不到就直说「书里没有相关段落」。
  检索默认带**精排**（cross-encoder 重排，命中更准；模型没下载时会退回向量+字面混合排序，
  返回值里会说明）。精排会让单次检索慢约 1.8 秒，这是正常的，不用跟用户解释成卡住。
- **给位置**。引用时带上章节名（工具返回值里有），方便用户回「图书」App 对位置。
- **区分「书里说的」和「我的标注」**。前者来自 `search_book`，后者来自 `list_annotations`，
  不要混为一谈。
- 未建索引的书首次检索会自动建索引（几十秒），提前跟用户说一声，别让它以为卡住了。

## 授权与降级

- 全文检索只需要读 EPUB，**不需要任何授权**。
- 高亮/笔记在 `~/Library/Containers/com.apple.iBooksX/.../AEAnnotation/*.sqlite`，
  需要给 DeepSeek Harness 授予**「完全磁盘访问权限」**。工具会返回明确的授权提示，
  遇到时把提示原样转告用户，并说明「全文检索不受影响」。

## 没装插件时的兜底（CLI）

插件未安装或 MCP 未连通时，用 bash 直接跑引擎。引擎是本仓库根目录的 `books_rag.py`，
就在插件目录 `dsh-apple-read/` 的同级，先定位再调用：

```bash
# 定位引擎：优先 APPLE_READ_ENGINE；否则从插件安装位置反推（link: 安装会指向克隆目录）
ENGINE="${APPLE_READ_ENGINE:-$(dirname "$(readlink -f ~/.dsh/profiles/*/node_modules/dsh-apple-read/package.json | head -1)")/../books_rag.py}"

uv run "$ENGINE" list
uv run "$ENGINE" search --book <书名> "<问题>" -k 5
uv run "$ENGINE" annotations --limit 20
uv run "$ENGINE" context --id <标注 id>
uv run "$ENGINE" open --book <书名>
uv run "$ENGINE" index --all          # 全量建索引（增量，未变动会跳过）
```

加 `--json` 拿机器可读输出。索引默认落在 `~/DSH-apple-Read/index/`，
可用环境变量 `APPLE_READ_INDEX` 改。

## 边界

- 只读**非 DRM** 的 EPUB。App Store 购买的带 DRM 的书读不到全文。
- 高亮库是 Apple 的非公开 schema，系统升级后可能失效；失效时降级为纯全文检索即可。
- 高亮文字与正文可能存在全角/半角标点差异，引擎已用折叠匹配处理；
  万一定位失败会退回按 CFI 定位到章节。
