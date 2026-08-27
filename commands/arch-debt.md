---
description: 收割架构债台账
allowed-tools: Bash(git grep:*), Read, Glob
---

按 `arch-debt` 技能收割全库 `arch-debt:` 注释标记，生成台账：每条标注状态（在期/到期/no-trigger），末尾汇总。默认只输出不落盘；明确要求保存时才写 ARCH-DEBT.md。
