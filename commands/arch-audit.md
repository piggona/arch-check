---
description: 全库架构审计
allowed-tools: Read, Grep, Glob, Bash(git ls-files:*)
---

按 `arch-audit` 技能对整个仓库做架构审计：分层地图、依赖方向、循环依赖、边界完整性、抽象债，末尾给出三行结论。规则来源优先 ARCHITECTURE.md。一次性只读报告。
