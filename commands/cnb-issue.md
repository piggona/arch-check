---
description: 从当前代码提交生成需求 Issue 单并上传到 CNB
argument-hint: "[<cnb-repo-path>] [--dry-run]"
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git status:*), Bash(git show:*), Bash(cnb:*), Read, Grep, Glob
---

按 `cnb-issue` 技能，从当前 git 变更（staged 或最近 commit）中提取需求信息，生成结构化 Issue 单（标题 + 目标 + 实施内容 + 验收标准），展示给用户确认后，通过 CNB CLI 上传到指定仓库的 Issue 列表。

目标仓库默认 `genie/genie`（对应 https://cnb.woa.com/genie/genie），可通过参数 {{args}} 覆盖。`--dry-run` 只生成不上传。
