---
name: arch-debt
description: >
  收割全库 `arch-debt:` 注释，生成/更新架构债台账，让有意的架构妥协被追踪而不是
  悄悄烂掉。当用户说"架构债 / arch-debt / 列一下架构妥协 / 该还哪些债 /
  debt ledger"时使用。默认只读报告；用户明确要求时才写入 ARCH-DEBT.md。
allowed-tools: Bash(git grep:*), Bash(grep:*), Read, Glob
license: MIT
---

# 架构债台账

每次架构检查（/arch-check）中被有意保留的 WARN 都应以
`arch-debt: <上限/风险>, <升级触发条件>` 注释标记在代码处。
本技能把这些标记收割成一份台账，防止"later 变成 never"。

## 扫描

跳过 node_modules、.git、构建产物：

```
git grep -nE '(#|//|/\*) ?arch-debt:'   # 覆盖 JS/TS/Go/Java/Python 主流注释前缀
```

注释前缀之外的纯文字提及（如文档里的 "arch-debt"）不算债，靠前缀过滤。

## 输出

每条标记一行，按文件分组：

```
<file>:<line> — <上限/风险> · 触发: <升级条件> · [状态]
```

状态判定（对照当前日期与触发条件）：
- **到期** — 触发条件已发生/已过期，该进入修复计划
- **no-trigger** — 没写触发条件的标记，烂掉风险最高，标红
- **在期** — 触发条件未满足，正常挂账

末尾总结：`N 条架构债，M 条已到期，K 条缺触发条件。`
空结果输出：`无 arch-debt 标记，台账干净。`

## 落盘（仅用户明确要求时）

用户说"保存/更新台账"时写入项目根 `ARCH-DEBT.md`：台账 + 生成日期 + 到期项置顶。
写之前展示完整内容，确认后一次写入；未要求不建文件。

## 边界

只收割标记，不主动找新债（那是 arch-check/arch-audit 的活）。
不改任何被标记的代码。
