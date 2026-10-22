---
name: cnb-issue
description: >
  从当前 git 变更中提取需求信息，生成结构化 Issue 单（标题 + 目标 + 实施内容 + 验收标准），
  展示给用户确认后上传到 CNB 仓库。当用户说"cnb-issue / 生成 issue / 提 issue 单 /
  把这次改动提个需求单"时使用。需要已安装 CNB MCP（cnb CLI 可用），否则提示安装。
argument-hint: "[<cnb-repo-path>] [--dry-run]"
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(git show:*), Bash(cnb:*), Read, Grep, Glob
license: MIT
---

# CNB Issue 单生成与上传（cnb-issue）

从当前代码提交中提炼需求信息，按固定模板生成 Issue 单，确认后上传到 CNB。

## 第 0 步：前置检查——CNB CLI 是否可用

执行：

```
cnb --help
```

- **成功**：继续下一步。
- **失败（command not found / 未安装）**：停止流程，向用户输出安装提示：

  > CNB MCP 未安装或 `cnb` 命令不可用。请先安装 CNB MCP：
  > 1. 在 WorkBuddy 的「设置 → MCP 服务」中添加 CNB MCP 服务
  > 2. 或参考 CNB 官方文档配置 cnb CLI：https://docs.cnb.cool
  > 安装完成后重新运行 `/cnb-issue`。

  不继续执行后续步骤。

## 第 1 步：确定目标仓库与模式

解析用户参数 `{{args}}`：

| 参数形式 | 含义 |
|---|---|
| 无参数 | 目标仓库 = `genie/genie`（默认） |
| `owner/repo` | 指定目标仓库，如 `myteam/myrepo` |
| `--dry-run` | 只生成 Issue 单，展示后不上传（仓库仍取默认或指定值） |
| `owner/repo --dry-run` | 指定仓库 + 只生成不上传 |

默认仓库 `genie/genie` 对应 CNB 地址 `https://cnb.woa.com/genie/genie`。

## 第 2 步：收集代码变更信息

确定变更范围（优先级从高到低）：

1. **有暂存变更**（`git diff --staged` 有内容）→ 分析 staged diff
2. **无暂存但最近有 commit**（`git log -1` 有内容）→ 分析最近一次 commit
3. **都没有**→ 向用户报错："当前没有可分析的代码变更（无暂存、无最近提交），无法生成 Issue 单。"

收集以下信息：

```
git status --porcelain          # 变更文件清单
git diff --staged --stat        # 变更规模（或 git show HEAD --stat）
git diff --staged               # 完整 diff（或 git show HEAD）
git log -1 --format='%s%n%b'    # 最近 commit 的 message（辅助理解意图）
```

用 Read 逐个读取变更涉及的关键文件（非测试文件优先），理解：
- 这次变更实现了什么功能/能力
- 涉及哪些模块、哪些核心流程
- 引入了哪些新依赖、新表、新接口

## 第 3 步：生成 Issue 单

按以下模板生成 Issue 单。**所有内容必须从实际代码变更中提取，不得编造。**

### 标题格式

```
[<类型>][<子类型>] <项目/模块名> <功能简述>
```

- **类型**（从变更意图推断）：
  - `feature` — 新增功能/能力
  - `optimization` — 性能/架构优化
  - `bugfix` — Bug 修复
  - `refactor` — 重构（不改行为）
- **子类型**（可选，按变更领域）：
  - `技术优化` / `性能优化` / `架构调整` / `接口新增` / `数据迁移` 等
  - 无明确子类型时可省略第二个方括号
- **项目/模块名**：从变更文件路径或 commit message 中提取
- **功能简述**：一句话概括，不超过 30 字

示例：`[feature][技术优化] ArtifactRecommend 项目 ES 索引构建进度调度器`

### 正文模板

```markdown
# 目标
<一两句话说明这次变更要解决什么问题、实现什么能力。从 diff 和 commit message 中提炼，不要照抄代码注释。>

# 实施内容
- <实施项 1：从 diff 中提取的一个独立改动点，动宾短语描述>
- <实施项 2>
- <实施项 3>
- <...更多实施项>

# 验收标准
- <验收项 1：可验证的功能行为，从代码的实际效果推导>
- <验收项 2>
- <验收项 3>
- <...更多验收项>
```

### 填写规则

1. **实施内容**：每条对应 diff 中的一个实质改动点（不是每个文件一条，而是每个功能点一条）。
   从 `git diff` 的 hunks 中归纳——多个文件的同类改动合并为一条。
   用动宾短语：`实现…` / `新增…` / `修改…` / `移除…`。
   每条结尾加句号。
2. **验收标准**：从代码的实际行为效果推导可验证的结果。
   写成可检查的断言：`…可正常…` / `…后，…可查询` / `…场景测试通过`。
   3-5 条为宜，覆盖正常路径、异常处理、可观测性。
3. **目标**：站在需求视角，不站在实现视角。
   `为 X 实现 Y` 而非 `修改了 a.py 的 b 函数`。
4. **不得出现**：具体文件名、行号、函数名、类名等实现细节——
   Issue 单是需求文档不是 code review。如果某改动确实需要点名文件，
   说明描述粒度太细，合并到更高层的需求条目里。

## 第 4 步：展示给用户确认

将生成的完整 Issue 单（标题 + 正文）输出到终端，格式：

```
## 生成的 Issue 单

**目标仓库**：<owner/repo>（<CNB 地址>）
**模式**：<上传 / dry-run 只生成>

---

### 标题
<标题>

### 正文
<正文 markdown>

---

请确认以上 Issue 单内容是否正确：
- 直接回复"确认"或"上传" → 执行上传
- 指出需要修改的地方 → 修改后再次展示
- 回复"取消" → 中止
```

**等待用户确认后再执行上传，不要跳过确认步骤。**

## 第 5 步：上传到 CNB

用户确认后，通过 CNB CLI 创建 Issue。

### 调用方式

```
cnb issues create-issue \
  --path '{"repo": "<owner/repo>"}' \
  --data '{"title": "<标题>", "body": "<正文 markdown>", "labels": ["feature"]}'
```

参数说明：
- `--path` 的 `repo`：不带 `.git` 后缀的仓库名称，格式 `组织名称/仓库名称`
- `--data` 的 `title`：Issue 标题（第 3 步生成的标题）
- `--data` 的 `body`：Issue 正文（第 3 步生成的 markdown 正文，换行用 `\n`）
- `--data` 的 `labels`：**默认携带 `["feature"]`**，对应标题中推断的类型。
  标题类型为 `bugfix`/`optimization`/`refactor` 时，labels 跟着变
  （如 `["bugfix"]`/`["optimization"]`/`["refactor"]`）。
  用户在参数中指定了额外标签时，追加到数组里，如 `["feature", "需求"]`。

可选字段（用户在参数中指定时才加）：
- `assignees`：处理人数组，最多 8 人
- `priority`：优先级，可选值 `-2P`/`-1P`/`P0`/`P1`/`P2`/`P3`
- `start_date` / `end_date`：日期格式 `2026-01-01`

### 正文的 JSON 转义

`body` 字段是 JSON 字符串，必须正确转义：
- 换行 → `\n`
- 双引号 → `\"`
- 反斜杠 → `\\`

推荐用 `jq` 构造避免手动转义错误：

```bash
TITLE="<标题>"
BODY=$(printf '%s\n' \
  "# 目标" \
  "正文第一行" \
  "" \
  "# 实施内容" \
  "- 实施项1" \
  "- 实施项2" \
  "" \
  "# 验收标准" \
  "- 验收项1" \
  "- 验收项2")
DATA=$(jq -nc --arg title "$TITLE" --arg body "$BODY" \
  '{title: $title, body: $body, labels: ["feature"]}')
cnb issues create-issue --path '{"repo": "genie/genie"}' --data "$DATA"
```

### 结果处理

CNB CLI 返回标准 JSON 结构：

- `status` 在 200~299 之间 → 上传成功
  - 从返回 `data` 中提取 Issue 编号和 URL
  - 向用户报告：`Issue #<编号> 已创建：<CNB Issue URL>`
- `status >= 300` → 上传失败
  - 向用户报告失败原因（`status` + `trace`）
  - 提示用户检查仓库路径是否正确、CNB token 是否有效

### dry-run 模式

`--dry-run` 时跳过第 5 步，在第 4 步展示后结束，输出：
`--dry-run 模式：Issue 单已生成，未上传。去掉 --dry-run 后重新执行可上传。`

## 边界

- **只读不改代码**：生成 Issue 单不修改任何源代码文件。
- **信息不足时追问**：如果 diff 太小或 commit message 为空无法提炼需求，
  问用户"这次变更的目标是什么？"，而非猜测编造。
- **不上传未经确认的内容**：第 4 步的确认环节不可跳过。
- **一个 Issue 单对应一次变更**：不合并多个不相关的 commit。
  如果 staged diff 包含多个不相关功能，提示用户分批执行或手动拆分。
