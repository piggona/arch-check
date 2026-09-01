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
| `/handoff [feature\|bugfix\|script]` | 对话结束后生成交付文档（自动判断任务类型） |
| `/arch-help` | 本速查 |

## 规则来源优先级

1. 项目根 `ARCHITECTURE.md`（其次 `.arch/rules.md`、`docs/ARCHITECTURE.md`）
2. 没有契约时用内置通用原则：依赖向内、无循环、走公共接口、边界不泄漏、
   不过度设计、长耗时任务状态同步防竞态——显式完成信号（终态/事务后事件）、
   无中间态暴露、多实例原子认领或幂等，"数据出现" ≠ "步骤完成"；
   日志串联与来源标识——在线请求带 request_id、涉用户带 user_id、
   涉企业带 tenant_id/enterprise_id，入口注入日志上下文、异步边界显式延续；
   数据库访问——简单操作（建表/增删改查）走 ORM，原生 SQL 显式字段、
   禁止 SELECT *，无 WHERE 的 UPDATE/DELETE 是事故级违规；
   批量数据同步——禁止循环逐条插入，必须分批批量写入且控制 batch size
   不超过 SQL 传输限制；
   长耗时任务超时设计——必须同时设置总超时（absolute_timeout）和进度保活超时
   （progress_timeout），超时判断为双条件 AND（总超时到期 AND 保活窗口无进度），
   进度刷新同时更新时间戳+进度计数，阈值从配置读，时间比较统一 UTC；
   外部调用日志追踪——调用外部服务（大模型/业务 API/第三方服务）后日志必须记录
   对方返回的唯一 ID（response_id/completion_id/transaction_id），并与本地
   request_id 关联，异常路径也要记，大模型调用额外记 model 和 token usage；
   高频写入表——高并发业务的高频记录表写入不能阻塞主流程（buffer flush 或
   异步队列解耦），记录与业务事务隔离，此类大表必须按时间/字段分表存储，
   buffer 需有 shutdown drain 和 flush 失败重试，记录表用独立连接池

## arch-debt 标记语法

```
// arch-debt: <上限/风险>, <升级触发条件>, <关联/日期>
```

例：`// arch-debt: 订单直读库存表, 库存服务化时重构, #482`

## 自动行为（钩子）

- **会话启动**：注入一段简短架构意识提醒（提醒遵守项目 ARCHITECTURE.md）
- **每次写/改文件后**：轻量嗅探常见违规（分层 import、直捣内部路径、
  轮询式状态消费——提醒确认终态消费与原子认领、日志调用缺追踪 ID——
  提醒补 request_id/user_id/tenant_id、原生 SQL 简单操作与 SELECT *——
  提醒走 ORM 并显式列出字段、循环内逐条 INSERT/create——
  提醒改为批量写入并控制 batch size、超时逻辑缺保活判断或阈值硬编码——
  提醒补双窗口超时设计、外部服务调用日志缺响应 ID——
  提醒记录对方返回的唯一 ID 用于跨系统排查、主流程同步写入记录/日志类数据表——
  提醒改为 buffer flush 或异步队列解耦并注意分表）。
  提醒强度由 `ARCH_CHECK_WATCHER` 控制：`hint`（默认，仅提示）/
  `enforce`（输出阻断提醒，代理会自我修正）/ `off`

## 配置项（环境变量）

| 变量 | 默认 | 作用 |
|---|---|---|
| `ARCH_CHECK_WATCHER` | `hint` | 写后嗅探强度 hint/enforce/off |
| `ARCH_CHECK_ACTIVATE` | `on` | 会话注入开关 on/off |
