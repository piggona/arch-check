---
description: 变更后架构检查（默认 staged）
argument-hint: [staged|branch|<commit-range>]
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Read, Grep, Glob
---

按 `arch-check` 技能对当前变更做架构检查。范围：{{args}}（staged 只看暂存，branch 看 main...HEAD，也可给任意 commit range；未指定默认 staged，无暂存回退 branch）。
