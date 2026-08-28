---
description: 生成交付文档（自动判断任务类型）
argument-hint: "[feature|bugfix|script]"
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(git status:*), Read, Grep, Glob
---

按 `handoff` 技能生成本次对话的交付文档。如果指定了类型 {{args}} 则直接使用该模板；否则自动从对话内容判断。优先从对话历史和 git 变更中提取信息，信息不足时追问用户。输出完整 Markdown 文档到终端。
