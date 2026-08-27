---
name: arch-help
description: >
  arch-check 插件速查：列出全部命令、规则来源优先级、arch-debt 标记语法与配置项。
  当用户说"arch-help / 架构检查插件怎么用"时使用。
---

# arch-check 速查

## 命令

| 命令 | 作用 |
|---|---|
| `/arch-check [staged\|branch\|<range>]` | 变更后架构检查（默认 staged） |
| `/arch-audit` | 全库架构审计，产出健康报告 |
| `/arch-debt` | 收割 `arch-debt:` 标记 → 架构债台账 |
| `/arch-help` | 本速查 |

## 规则来源优先级

1. 项目根 `ARCHITECTURE.md`（其次 `.arch/rules.md`、`docs/ARCHITECTURE.md`）
2. 没有契约时用内置通用原则：依赖向内、无循环、走公共接口、边界不泄漏、不过度设计

## arch-debt 标记语法

```
// arch-debt: <上限/风险>, <升级触发条件>, <关联/日期>
```

例：`// arch-debt: 订单直读库存表, 库存服务化时重构, #482`

## 自动行为（钩子）

- **会话启动**：注入一段简短架构意识提醒（提醒遵守项目 ARCHITECTURE.md）
- **每次写/改文件后**：轻量嗅探常见违规（分层 import、直捣内部路径）。
  提醒强度由 `ARCH_CHECK_WATCHER` 控制：`hint`（默认，仅提示）/
  `enforce`（输出阻断提醒，代理会自我修正）/ `off`

## 配置项（环境变量）

| 变量 | 默认 | 作用 |
|---|---|---|
| `ARCH_CHECK_WATCHER` | `hint` | 写后嗅探强度 hint/enforce/off |
| `ARCH_CHECK_ACTIVATE` | `on` | 会话注入开关 on/off |
