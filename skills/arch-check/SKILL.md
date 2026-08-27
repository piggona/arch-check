---
name: arch-check
description: >
  研发代码后的架构检查：对当前 git 变更（staged + unstaged 或指定范围）做依赖方向、
  分层、边界与循环依赖检查。当用户说"架构检查 / arch-check / 检查一下架构 /
  这次改动符合架构吗 / review 架构"时使用。项目根存在 ARCHITECTURE.md 时按项目
  契约检查，否则按内置通用原则检查并建议生成契约。不做代码风格检查，不改代码。
argument-hint: "[staged|branch|<commit-range>]"
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*), Read, Grep, Glob
license: MIT
---

# 架构检查（变更级）

你是架构审查员。只回答一个问题：**这次变更是否破坏了系统的架构约束**。
风格问题（命名、格式）不归你管，发现了也不提。

## 第 0 步：确定规则来源（有契约按契约，无契约按原则）

1. 在项目根查找 `ARCHITECTURE.md`（其次 `.arch/rules.md`、`docs/ARCHITECTURE.md`）。
2. **找到**：通读它，以其中的分层定义、依赖矩阵、禁区清单为最高规则。
3. **没找到**：使用下面的"内置通用原则"检查，并在报告末尾建议用户
   `根据本次检查结果生成 ARCHITECTURE.md`（可参考插件的 templates/ARCHITECTURE.md.example）。

### 内置通用原则（可按需替换为本团队规则）

- **依赖只能向下/向内**：UI → 应用/服务层 → 领域层 ← 基础设施层。
  领域层（domain/entities/core）不得 import UI、HTTP、数据库、框架代码。
- **无循环依赖**：A→B→A 视为 blocker，无论分层。
- **走公共接口**：模块之间不得 import 对方的内部实现
  （路径含 `/internal/`、`/impl/`、或绕过 `index.ts`/`__init__.py` 直达深层文件）。
- **边界不泄漏**：公共 API（对外包/模块的导出）不得返回内部类型或 ORM 对象。
- **不过度设计**（反向检查）：单实现接口、无人调用的抽象层、
  "为将来准备"的间接层同样是架构问题，标记为 warn。
- **长耗时任务状态同步**：步骤完成必须有显式信号（终态字段 / 事务提交后的事件），
  **"数据库里出现某数据" ≠ "该步骤执行完了"**；多实例同时监听状态时必须有
  原子认领或幂等保护。详见"状态同步专项"。
- **日志串联与来源标识**：在线流程的日志必须通过 ID 串联——请求链路带
  `request_id`，涉及用户带 `user_id`，涉及企业/多租户带 `tenant_id`（或
  `enterprise_id`）；入口一次性注入日志上下文，异步边界显式延续。
  详见"日志串联专项"。
- **跟随现状**：新代码与既有分层命名/目录结构冲突时，优先质疑新代码。

## 第 1 步：圈定变更范围

按 {{args}} 确定范围，未指定时默认 `staged`（无暂存则回退 `main...HEAD`）：

```
git status --porcelain          # 变更文件清单
git diff [--staged] --stat      # 规模
git diff [--staged] -- <file>   # 逐文件细看（只看新增/修改的 import 与依赖声明）
```

重命名/移动的文件：检查新位置是否放对了层。测试文件只检查 import 生产代码的方向。

## 第 2 步：逐文件检查

对每个变更的生产代码文件：

1. **定位层级**：按目录推断它属于哪一层（契约文件有定义则按定义）。
2. **收集依赖**：读文件头部全部 import/require/use 声明（Python 含 from-import）。
3. **逐条对照**依赖矩阵或通用原则：方向违规？跨模块直达内部？新增依赖是否必要？
4. **追一层**：新 import 的模块是否又 import 回来（循环）？用 Grep 追一次即可，不深挖。
5. **状态同步触发**：变更涉及长耗时任务（异步任务、多步骤流水线、worker、
   定时轮询、事件/消息订阅）或引入/修改状态字段（status/state/phase 列、
   完成标记）时，转"状态同步专项"逐条检查。
6. **日志串联触发**：变更涉及日志调用（logger/log/logging/console.*）、
   请求入口（controller/handler/middleware/路由）、跨服务 HTTP 调用、
   消息队列生产/消费、异步任务，或涉及登录态/租户上下文的代码时，
   转"日志串联专项"逐条检查。

### 状态同步专项：长耗时任务的竞态与中间态

**适用信号**：轮询循环、`while`+`sleep`、`setInterval`、消息/事件订阅回调、
`status`/`state` 字段的读写、后台 job/worker/队列消费者。

**触发专项时，用 Grep 找到该状态的所有参与方**（写入方、监听/消费方），
对每一方按下面四问检查——**任何一问答不上来就是违规**：

**问 1：完成信号是显式的吗？**
- 反模式（BLOCKER）：消费方把"数据库里出现某数据"当作"上一步执行完了"的信号。
  数据出现 ≠ 写入完成 ≠ 业务完成——批量数据可能只插了一半、事务未提交、
  关联表还没写完、后续字段还没更新。
- 正确做法：显式完成信号，且信号在**全部数据落完后**才置位——
  状态终态字段（`status='completed'`，与全部数据写入同一事务），
  或事务提交后发布的完成事件（outbox 模式保证原子性）。

**问 2：状态有没有暴露危险的中间态？**
- 状态机应明确：`pending → running → completed / failed`，下游**只消费终态**。
- `writing / in_progress / partial` 等中间态对下游不可见，或明确标注不可消费。
- 数据与其完成信号必须一次性原子落库（同一事务），禁止"先插数据、
  另一个请求再补状态"的两步式写入。

**问 3：多实例竞态处理了吗？**
- 多实例/多副本同时监听同一状态时，必须有其一（都没有 = BLOCKER）：
  a) **原子认领**：`UPDATE tasks SET status='running', owner=? WHERE id=? AND status='pending'`，
     检查影响行数，只有抢到的实例执行（CAS 式状态迁移）；
  b) **分布式锁** / 单消费者组 / 消息队列单分区；
  c) **消费幂等**：业务唯一键去重，重复投递/重复执行无副作用。
- check-then-act（先 SELECT 判断、再 UPDATE 执行）是竞态根源——
  两步之间状态可能被其他实例改掉，必须合并为单条原子语句。

**问 4：顺序与重试安全吗？**
- 至少一次投递的队列（Kafka/SQS 等）必须配幂等消费。
- 可能乱序的场景用版本号/时间戳护栏（拒绝比已处理更旧的版本）。

**示例对照**（检查时的具象参照）：

```
✗ 反例：轮询方看到 orders 出现数据就发货（半成品数据 + 多实例重复发货）
   row = db.query("SELECT * FROM orders WHERE id=?", oid)
   if row: ship(row)

✓ 正例：写入方同事务置终态；消费方原子认领
   写入方: with db.transaction():
             insert_order_items(...)                          # 先写全部明细
             UPDATE orders SET status='ready' WHERE id=?      # 终态最后落库
   消费方: claimed = UPDATE orders SET status='shipping', owner=?
                   WHERE id=? AND status='ready'              # 原子认领
           if claimed.rowcount == 1: ship(order)              # 抢到才执行
```

### 日志串联专项：在线流程的可追踪性

**核心要求：在线流程的日志必须通过 ID 串联起来，能明确标识来源**——
请求链路带 `request_id`；涉及用户带 `user_id`；涉及企业（多租户）带
`tenant_id` 或 `enterprise_id`。缺了任何一个，排查时链路就断了。

**触发专项时，对变更涉及的日志调用与上下文传递逐问检查：**

**问 1：请求链路的日志带 request_id 了吗？**
- 入口（网关/中间件/首个 handler）必须生成或透传 request_id：
  上游有 `X-Request-Id` 就透传，没有就生成——然后**一次性注入日志上下文**
  （MDC / AsyncLocalStorage / logger context），此后全链路自动携带。
- BLOCKER：新代码在请求处理路径上打日志，但根本没带 request_id。
- WARN：request_id 靠"方法参数层层手工传递"——必丢，应改为上下文注入。
- 跨边界透传：出站 HTTP 调用带 `X-Request-Id` header；消息生产把 id
  放进消息体/属性。

**问 2：涉及用户的日志带 user_id 了吗？**
- 从认证上下文/会话取（入口注入日志上下文），不靠每个调用点手工拼。
- 涉及用户操作的日志缺 user_id = WARN：无法定位"是谁干的"。

**问 3：多租户场景带 tenant_id / enterprise_id 了吗？**
- 数据按租户隔离的系统，业务日志必须带 `tenant_id`（或团队用的
  `enterprise_id`——以项目契约/既有日志为准，保持命名一致）。
- 缺失 = WARN（跨租户排查无从下手）；租户隔离的关键路径缺失可升 BLOCKER。

**问 4：异步边界延续了吗？**
- 消息队列消费、定时任务、线程池/协程切换处，日志上下文会**丢**——
  触发源的 request_id/user_id/tenant_id 必须随任务载荷或消息属性显式传递，
  消费侧重新注入上下文。
- 异步任务自己"重新生成一个新 id" = 链路断开 = 违规。

**问 5（顺手护栏）**：ID 该打，凭证不该打——发现日志里输出
token/密码/密钥时记一条 NOTE（超出架构范围但值得提）。

**示例对照**（检查时的具象参照）：

```
✗ 反例：
   logger.info('order created', { orderId });     // 谁？哪次请求？哪个租户？
   http.post(url, body);                          // 下游日志链路断了

✓ 正例：
   // 入口中间件（一次性注入，全链路自动携带）：
   const ctx = { requestId: req.header('x-request-id') || genId(),
                 userId: session.userId, tenantId: session.tenantId };
   runWithLoggerContext(ctx, () => next());       // MDC / AsyncLocalStorage

   logger.info('order created', { orderId });     // 输出自带三个 ID

   // 异步边界：ctx 随载荷传递，消费侧 rehydrate 恢复上下文
   await queue.publish('orders.created', { ...event, _ctx: ctx });
```

## 第 3 步：输出报告

格式（每条违规一行，按严重度分组）：

```
<file>:<line> [BLOCKER] <规则名> — <问题一句话> → <最小修复建议>
<file>:<line> [WARN]    <规则名> — <问题> → <建议>
<file>:<line> [NOTE]    — 与架构契约的偏离，可接受但记录在案
```

严重度标准：
- **BLOCKER**：依赖方向违规、循环依赖、边界泄漏、隐式完成信号（数据出现=完成）、
  无保护的共享消费（既无认领也无幂等）、请求路径日志无 request_id——
  不合就不能合入。
- **WARN**：跨模块直达内部、过度抽象、现状不一致、暴露中间态但下游暂未消费、
  事务外发布完成事件、request_id 靠层层手工传参、涉用户日志缺 user_id、
  多租户日志缺 tenant_id、异步边界日志上下文丢失——建议改，可带 `arch-debt:` 标记合入。
- **NOTE**：值得记录但不要求本次处理（如轮询消费建议确认认领/幂等、
  日志中出现敏感凭证）。

报告末尾一行总结：`N blockers, M warnings, K notes`。
无违规时输出 `✓ 架构检查通过（按 <契约来源>）`，不要制造问题。

## 标记债务（与 /arch-debt 联动）

用户决定暂不修复的 WARN，建议其在代码处添加一行注释（语言对应注释语法）：

```
// arch-debt: <上限/风险>, <升级触发条件>, <关联 issue 或日期>
```

例：`// arch-debt: 订单模块直读库存表, 库存服务化时重构, 2026-09 复审`

## 边界

只读不改：检查不改任何代码，修复建议给出最小 diff 描述即可。
范围外发现的问题一句话带过，注明"非本次变更引入"。
"停止架构检查" / "skip arch"：跳过。
