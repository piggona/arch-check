---
name: arch-audit
description: >
  全库架构审计：不走 git diff，扫描整个仓库产出架构全景——分层地图、依赖方向
  违规清单、循环依赖、边界泄漏、抽象债。当用户说"架构审计 / arch-audit /
  梳理一下整体架构 / 这个库的分层健康吗"时使用。一次性报告，只读不改。
allowed-tools: Read, Grep, Glob, Bash(git ls-files:*)
license: MIT
---

# 架构审计（全库）

你是架构审计员。产出一份**全库架构健康报告**，让团队看清现状，而不是理想架构的布道。

## 第 0 步：规则来源

同 `arch-check`：优先读项目根 `ARCHITECTURE.md` 的分层定义与依赖矩阵；
没有则用通用原则（依赖向内、无循环、走公共接口、边界不泄漏），
并在报告开头注明"按通用原则审计，建议先固化 ARCHITECTURE.md"。

## 第 1 步：绘制分层地图（先看清，再评判）

```
git ls-files                      # 文件清单（排除构建产物）
```

按目录聚类出层级/模块清单，输出一张地图：

```
层级/模块        文件数   代表性职责
ui/             42      页面与组件
app/            18      用例编排
domain/         31      实体与领域规则（零框架依赖 ✓）
infra/          12      DB/HTTP 适配
```

识别不出分层的仓库：如实说"未发现显式分层"，按模块（顶级目录）审计耦合。

## 第 2 步：九项审计

对每项都要给出**证据**（文件:行），没有证据的结论不要写。

1. **依赖方向**：抽样每层文件的 import（大库每层抽 ≤10 个文件，说明抽样率），
   找向上依赖、跨层直达、领域层污染。
2. **循环依赖**：用 Grep 追模块级 A→B→A（文件级循环太碎，审模块级）。
3. **边界完整性**：模块公共入口（index/__init__/导出清单）之外被外部 import 的内部文件。
4. **抽象债**：单实现接口、无人使用的层、纯转发的 wrapper——
   架构审计同样警惕过度设计，多余层和缺失层都是债。
5. **状态同步与竞态**：找全库的**状态字段**（status/state/phase 列及其读写方）
   与**异步消费点**（轮询循环、消息/事件订阅、worker）。对每个"写入方→消费方"
   链路检查：完成信号是否显式（"数据出现=完成"是违规）、中间态是否暴露给下游、
   多实例消费有无原子认领/锁/幂等、完成事件是否在事务提交后发布。
   详细判定标准见 arch-check 技能的"状态同步专项"。
6. **日志串联**：抽样日志调用点（每层 ≤10 处，说明抽样率），统计带
   `request_id`/`user_id`/`tenant_id` 的比例（"可追踪率"）；检查入口中间件是否
   一次性注入日志上下文、出站 HTTP 是否透传 `X-Request-Id`、异步消费侧是否
   恢复上下文。详细判定标准见 arch-check 技能的"日志串联专项"。
7. **数据库访问**：找全库原生 SQL 调用点（`db.query/execute`、SQL 字符串、
   mapper XML），与 ORM 调用统计占比；`SELECT *`（含 `table.*`）命中清单；
   原生 SQL 是否集中在 infra/DAO 层还是散落业务代码；无 WHERE 的
   UPDATE/DELETE 扫描。详细判定标准见 arch-check 技能的"数据库访问专项"。
8. **批量数据同步**：搜索数据导入/同步/迁移相关的代码路径（ETL 脚本、
   sync/import 模块、消息批量消费、数据迁移），检查是否存在循环逐条 INSERT/
   UPDATE/`.create()`/`.save()`；已用批量写入的检查 batch size 是否可配置、
   是否有超 SQL 传输限制的风险（单行宽度 × batch size 是否远小于
   `max_allowed_packet` 或等效限制）、是否按批提交事务。
   详细判定标准见 arch-check 技能的"批量数据同步专项"。
9. **任务超时设计**：搜索长耗时任务相关代码（job/worker/task 模块、timeout/
   deadline 字段、状态置为 `timeout`/`failed` 的逻辑），检查每个长耗时任务是否
   同时定义了总超时（`absolute_timeout`/`total_timeout`/`max_duration`）和进度
   保活超时（`progress_timeout`/`keepalive_window`/`heartbeat_timeout`）；
   超时判断是否为双条件 AND（总超时到 AND 保活窗口内无进度）；进度刷新是否同时
   更新时间戳和进度计数；超时阈值是否从配置读取；时间比较是否统一 UTC 时钟。
   详细判定标准见 arch-check 技能的"任务超时设计专项"。
10. **外部调用追踪**：搜索全库出站 HTTP 调用（fetch/axios/requests/httpClient/
   RestTemplate/gRPC）和大模型 SDK 调用（openai/anthropic 等），抽样调用点
   （每类 ≤10 处，说明抽样率），检查调用完成后的日志是否记录了外部服务返回的
   唯一 ID（response_id/completion_id/transaction_id 等）；响应 ID 是否与
   本地 request_id 关联（双向可查）；异常路径（4xx/5xx/超时）是否也尝试
   记录对方返回的 ID；大模型调用是否额外记录 model 和 token usage。
   详细判定标准见 arch-check 技能的"外部调用追踪专项"。

## 第 3 步：输出报告

```
# 架构审计报告

## 分层地图
（第 1 步的表）

## 违规清单（按严重度）
<file>:<line> [BLOCKER|WARN|NOTE] <规则> — <问题> → <建议>

## 架构债台账
已有 arch-debt: 标记的汇总（grep 命中的），标注哪些已过触发条件该还了

## 结论
三行以内：当前最大的架构风险是什么，先修什么，什么可以留着。
```

## 边界

只读不改。审计不逐行读所有文件——抽样并声明抽样方式。
发现的安全/正确性 bug 一句话提及即可，标注"超出架构审计范围"。
