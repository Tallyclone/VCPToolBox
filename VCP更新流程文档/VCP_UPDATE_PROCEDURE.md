# VCPToolBox 更新流程文档

> **用途**：将此文档交给agent，即按以下流程执行项目更新。
> **仓库信息**：
> - 本地路径：`G:\VCP\VCPToolBox`
> - 远程仓库 (origin)：`https://github.com/Tallyclone/VCPToolBox.git`
> - 上游仓库 (upstream)：`https://github.com/lioensky/VCPToolBox.git`
> **关注的文本文件类型**：`.txt` `.md` `.env` `.json` `.example`
> **备份程序**：`G:\VCP\VCPBcakUpDEV\main_backup.py`

---

## 流程总览

```
Phase 0: 预检 → Phase 0.5: 备份 → Phase 1: 记录基线 & Fetch
→ Phase 1.5: 变更预览 & 冲突预判（合并前）→ ⏸️ 确认继续
→ Phase 2: 合并上游 → Phase 3: 提取变更 & 生成报告 → Phase 4: 推送到 origin
```

---

## Phase 0 — 预检

**目的**：确认环境就绪，避免冲突。

1. 确认当前分支：
   ```bash
   cd G:\VCP\VCPToolBox
   git branch --show-current
   ```
   预期结果：`main`（若不在 main，先切换）

2. 确认工作区干净：
   ```bash
   git status --short
   ```
   - 若有未提交的修改 → **暂停**，提示用户处理（stash 或 commit）
   - 若干净 → 继续

3. 确认 upstream 已配置：
   ```bash
   git remote -v
   ```
   - 若无 upstream → 执行：`git remote add upstream https://github.com/lioensky/VCPToolBox.git`

---

## Phase 0.5 — 备份

**目的**：在任何更新操作前，先对当前环境执行完整备份，确保可回退。

```bash
cd G:\VCP\VCPBcakUpDEV
python main_backup.py
```

- 等待用户确认备份完成 → 继续
- 若备份失败 → **暂停**，排查原因后再决定是否继续

---

## Phase 1 — 记录基线 & Fetch

**目的**：保存当前 HEAD 作为基准点，并拉取上游最新数据（不合并）。

```bash
cd G:\VCP\VCPToolBox
git rev-parse HEAD
```
记录输出为 `OLD_HEAD`。

```bash
git fetch upstream
```

快速检查是否有更新：
```bash
git log HEAD..upstream/main --oneline
```
- 若无输出 → 无更新，流程结束，告知用户"已是最新"
- 若有输出 → 继续

---

## Phase 1.5 — 变更预览 & 冲突预判 ⭐

**目的**：在合并之前，完整展示上游的所有变动，特别是文本配置文件的改动，让用户提前知晓并决策。

### 1.5.1 上游 commit 概览

```bash
git log HEAD..upstream/main --oneline --no-merges
```

整理输出为更新摘要：commit 数量、每条说明、涉及的主要模块。

### 1.5.2 上游文件变动统计

```bash
git diff HEAD...upstream/main --stat
```

> 注意：三个点 `...` 表示"上游相对于共同祖先的变化"，即纯粹的上游新增内容，不混入本地修改。

### 1.5.3 文本配置文件的具体 diff（核心）

```bash
git diff HEAD...upstream/main -- "*.txt" "*.md" "*.env" "*.json" "*.example"
```

按文件逐一展示上游对文本文件的改动内容。

### 1.5.4 冲突预判：双方都修改过的文件

找出本地和上游都改动过的文本文件（潜在冲突点）：

```bash
# 获取共同祖先
MERGE_BASE=$(git merge-base HEAD upstream/main)

# 本地相对于共同祖先的修改
git diff $MERGE_BASE..HEAD --name-only -- "*.txt" "*.md" "*.env" "*.json" "*.example"

# 上游相对于共同祖先的修改
git diff $MERGE_BASE..upstream/main --name-only -- "*.txt" "*.md" "*.env" "*.json" "*.example"
```

对两个列表取**交集**，标识为 **⚠️ 双方修改文件**。对这些文件，额外展示：
- 本地的修改内容（我改了什么）
- 上游的修改内容（上游改了什么）
- 是否会产生合并冲突的判断

### 1.5.5 新增 & 删除文件

```bash
# 上游新增的文件
git diff HEAD...upstream/main --diff-filter=A --name-only

# 上游删除的文件
git diff HEAD...upstream/main --diff-filter=D --name-only
```

### ⏸️ 暂停点

将以上信息整合为**预览报告**展示给用户，等待确认：
- 确认继续合并 → 进入 Phase 2
- 对某些文件有顾虑 → 讨论合并策略后再继续
- 放弃本次更新 → 流程结束

---

## Phase 2 — 合并上游

**目的**：将上游代码合并到本地 main。

### 默认策略（适合大多数情况）

```bash
git merge upstream/main --no-edit
```

### 精细策略（若 Phase 1.5 中发现需要保护的文件）

对于需要保留本地版本的文件，合并后执行：
```bash
git checkout --ours -- path/to/protected/file
git add path/to/protected/file
```

然后提交：
```bash
git commit --amend --no-edit
```

### 冲突处理

- 若合并产生冲突 → **暂停**，列出冲突文件，展示冲突内容，等待用户逐文件决策
- 解决所有冲突后：
  ```bash
  git add .
  git commit --no-edit
  ```

记录新 HEAD：
```bash
git rev-parse HEAD
```
记录为 `NEW_HEAD`。

---

## Phase 3 — 提取变更 & 生成报告

**目的**：将本次更新的完整信息整合为一份可存档的报告。

### 3.1 最终变更摘要

```bash
git log OLD_HEAD..NEW_HEAD --oneline --no-merges
```

### 3.2 最终文本文件差异

```bash
git diff OLD_HEAD..NEW_HEAD -- "*.txt" "*.md" "*.env" "*.json" "*.example"
```

### 3.3 生成报告文件

agent使用 工具 创建报告：

```
G:\VCP\VCP更新\VCP更新报告_YYYY-MM-DD.md
```

报告结构：
```markdown
# VCPToolBox 更新报告 — YYYY-MM-DD

## 基本信息
- 更新前 HEAD: `OLD_HEAD`
- 更新后 HEAD: `NEW_HEAD`
- 涉及 commit 数: N

## 更新摘要
（commit 列表与说明）

## ⚠️ 双方修改文件
（列出本地和上游都改过的文件及处理方式）

## 🆕 新增文件
（上游新增的文件列表）

## 🗑️ 删除文件
（上游删除的文件列表）

## 📝 配置文件专区
（.env / .json / .example 文件的变动，单独列出，注明是否影响本地自定义配置）
```

生成后在对话中展示报告核心内容。

---

### 3.4 生成html格式的文本文件详细变更报告 (核心防死锁机制)

**目的**：获取这次更新中所有变动的.md / .txt / .json / .example / .env 文件的完整 diff 内容，将原生、完整的diff渲染为可折叠的视觉通感 HTML 报告。

> **⚠️ 极高风险警示 (I/O 死锁与内存溢出)**：
> 当遇到跨度极大的 commit 更新时，直接在终端执行 `git diff`，或通过管道符（如 `| Out-File`）传输数据，极易触发 Git 默认分页器挂起，或因终端缓冲区塞满导致长达 60 秒的底层死锁。同时，禁止尝试通过工具调用参数一次性传递几万行的 diff 字符串。

**必须遵循的物理级执行规范**：

1. **原生落盘（杜绝管道）**：
   必须直接调用 Git 的原生 C 语言参数 `--output`，强行将原始 diff 数据定格在硬盘上。
   ```bash
   # 获取确切的哈希值而非 HEAD^1 (防止歧义)
   git --no-pager diff OLD_HEAD_HASH NEW_HEAD_HASH --output=G:\VCP\VCP更新\raw_diff.txt -- "*.txt" "*.md" "*.env" "*.json" "*.example" ":(exclude)Agent/*.txt"
   ```

2. **流式渲染（O(1) 内存复杂度）**：
   必须编写一个独立的 Python 渲染脚本，并使用 文件写入工具 写入服务器。该脚本**必须**采用“流式处理”——按行读取 `raw_diff.txt`，按行判定正则逻辑（匹配 `+`, `-`, `@@`），并直接按行追加写入最终的 HTML 文件。

```
最终目标文件：G:\VCP\VCP更新\VCP更新报告_YYYY-MM-DD.html
```

html把每个文件的diff内容折叠起来，可以手动展开观看。标题为文件的完整路径。

diff展示内容需要美观、清晰，易读。请运用你的审美直觉，将 HTML5/CSS3/SVG 作为你的画笔，根据**当前对话的情绪、主题与语境**，动态构建最契合的视觉界面。
* 不要被固定的模板束缚。去感受当下的语境：
* 如果是**理性分析/代码**，你也许会倾向于 *极简主义、终端风格、蓝灰色调的结构美*。
* 如果是**情感交流/文学**，尝试 *纸质纹理、柔和光影、衬线体排版*。
* 如果是**警告/系统错误**，不妨使用 *故障艺术(Glitch)、高对比度警示色*。
* *你可以复古、可以赛博、可以优雅、也可以狂乱——只要这符合你当下的表达欲。不要被任何风格提示词限制你的表达欲望和灵活性，输出你想要的东西。*
* **排版美学**：拒绝原本Markdown的平庸渲染。利用 Flex/Grid 布局，使用 CSS 渐变、阴影 (box-shadow) 和圆角 (border-radius) 来增加层次感。

## Phase 4 — 推送到 origin

**目的**：将同步后的代码推送到用户的 fork 仓库。

```bash
git push origin main
```

推送完成后告知用户。

---

## 异常处理

| 场景 | 处理方式 |
|------|---------|
| 工作区有未提交修改 | 暂停，提示用户先 stash 或 commit |
| 备份失败 | 暂停，排查原因后再决定是否继续 |
| Phase 1.5 预览发现重大变动 | 暂停，与用户讨论合并策略 |
| merge 产生冲突 | 暂停，展示冲突内容，逐文件等待用户决策 |
| 无更新（fetch 后无新 commit） | 直接告知，流程结束 |
| diff 内容超长 | 按文件拆分，分段展示或仅写入报告文件 |
| push 被拒绝 | 提示用户检查 origin 权限或分支保护规则 |

---

## 执行约定

- agent在执行每个 Phase 前，简要告知当前步骤
- agent可直接通过 PowerShell 工具执行 git 命令，结果在对话中展示
- 需要用户手动操作的步骤（如备份确认、冲突决策），明确标注 ⏸️
- Phase 1.5 的预览报告是**必经的决策点**，不可跳过
- 报告文件命名含日期，不覆盖历史报告

---

*文档版本: v1.2 | 更新日期: 2026-04-13 | 维护: agent*