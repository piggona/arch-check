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
- **数据库访问**：建表与增删改查等简单操作一律走 ORM；确需原生 SQL 的
  复杂查询集中在数据访问层并**显式列出字段，禁止 `SELECT *`**；
  无 WHERE 的 UPDATE/DELETE 是事故级违规。详见"数据库访问专项"。
- **批量数据同步**：同步数据到数据库时**禁止循环逐条插入**——必须分批（batch）
  写入，且每批数据量需控制在 SQL 传输/解析限制以内。详见"批量数据同步专项"。
- **长耗时任务超时设计**：持续执行且有可查询进度的任务（数据同步、批量处理、
  导入导出等），必须同时设置**总超时（absolute timeout）**和**进度保活超时
  （progress timeout）**，并在超时判断时区分"整体卡死"与"仍在推进"。
  详见"任务超时设计专项"。
- **外部服务调用日志追踪**：调用外部服务（大模型 API、其他业务 API、第三方
  服务）时，相关日志**必须记录外部服务返回的 id 字段**（`response_id` /
  `request_id` / `trace_id` / `completion_id` / `transaction_id` 等），
  用于跨系统排查循迹。只打本地 request_id 不够——故障时需要拿着对方的 id
  去对方系统查。详见"外部调用追踪专项"。
- **高频写入表：异步缓冲与分表**：高并发场景的高频记录表（任务执行日志、
  行为埋点、操作流水等），写入操作**不能阻塞主流程**——必须通过异步队列、
  内存 buffer flush、旁路写入等方式解耦；同时此类大数据量表**必须按时间或
  其他字段特征分表（分区）存储**，避免单表体积膨胀导致查询劣化和维护困难。
  详见"高频写入表专项"。
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
7. **数据库访问触发**：变更涉及数据库代码——ORM 模型/migration、
   `db.query/execute` 等原生 SQL 调用、SQL 字符串、DAO/repository——时，
   转"数据库访问专项"逐条检查。
8. **批量数据同步触发**：变更涉及数据导入/同步/迁移逻辑——从外部源（API、
   文件、消息队列、另一个库/表）读取数据后写入数据库、循环遍历集合并逐条
   插入/更新、ETL 管道——时，转"批量数据同步专项"逐条检查。
9. **任务超时设计触发**：变更涉及长耗时异步任务——job/worker/task executor、
   数据同步/导入/导出、定时任务——且代码中有超时判断、deadline 逻辑、
   任务状态流转（`running/timeout/failed`）、`last_heartbeat`/`progress_at`/
   `updated_at` 类进度时间戳字段——时，转"任务超时设计专项"逐条检查。
10. **外部调用追踪触发**：变更涉及调用外部服务——HTTP 客户端（fetch/axios/
   requests/httpClient/RestTemplate/gRPC）、大模型 API（OpenAI/Claude/
   Gemini/通义千问/文心一言等）、第三方 SaaS API——且代码中有对应的日志
   调用时，转"外部调用追踪专项"逐条检查。
11. **高频写入表触发**：变更涉及高频写入场景——任务执行记录/行为日志/
   操作流水/埋点数据/审计日志——的数据库写入逻辑，或者在请求处理主流程中
   同步写入此类记录表时，转"高频写入表专项"逐条检查。

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

### 数据库访问专项：ORM 优先与显式字段

**核心要求：关系型数据库的简单操作走 ORM；确需原生 SQL 时显式指定字段，
禁止 `SELECT *`。**

**触发专项时，对每处数据库访问逐问检查：**

**问 1：简单操作走 ORM 了吗？**
- 建表（DDL/migration）、INSERT、UPDATE、DELETE、单表查询等简单操作
  必须通过项目选定的 ORM（SQLAlchemy / Django ORM / TypeORM / Prisma /
  MyBatis / JPA / GORM……以项目契约为准）。
- 裸 SQL 做简单操作 = WARN：绕过模型的字段校验、类型映射与审计钩子，
  schema 变更时无人保护，且散落在业务代码里无人统一评审。
- 合理例外（允许，但要点名理由、集中在 infra/DAO 层）：多表 JOIN、
  窗口函数、CTE 报表、ORM 表达不了的批量优化
  （`INSERT ... ON CONFLICT` 大批量、`RETURNING` 等）——记 NOTE 即可。

**问 2：原生 SQL 有没有 SELECT *？**
- 任何原生 SQL **禁止 `SELECT *`**（含 `table.*`），必须显式列出字段 = WARN。
- 为什么：表加列即隐式行为变更（意外拉取大字段、宽表全量传输）；
  破坏覆盖索引优化；按列序取值的代码直接错位；review 时看不出
  实际用了哪些字段。
- ORM 等价行为顺带检查：`findMany()` 不带 `select`、`.all()` 全字段拉取
  大表 = NOTE，建议按需取列。`count(*)` 不在此列（合法）。

**问 3：写操作的安全性（顺手，事故级）**
- 无 WHERE 的 UPDATE/DELETE = **BLOCKER**——全表覆写/清空。
- 多语句数据变更是否包在事务里（与"状态同步专项"联动：
  数据与终态同一事务）。

**示例对照**（检查时的具象参照）：

```
✗ 反例：
   db.execute("CREATE TABLE users (...)")           // 建表不走 migration/ORM
   db.execute("INSERT INTO orders VALUES (...)")    // 简单插入裸 SQL
   db.query("SELECT * FROM orders WHERE id = ?")    // SELECT *
   db.query("SELECT o.*, u.* FROM orders o JOIN ...")  // table.* 同罪

✓ 正例：
   await prisma.order.create({ data: {...} })                       // 简单操作走 ORM
   await db.query("SELECT o.id, o.amount, u.name FROM orders o " +  // 复杂查询：
                  "JOIN users u ON u.id = o.user_id WHERE ...")     //   显式字段
```

### 批量数据同步专项：禁止循环逐条插入

**核心要求：同步/导入数据到数据库时，数据条数未知、规模未知，一定不能做一个循环
一条一条插入——必须按块（batch）批量写入，且每批数据量不得超过 SQL 的传输/解析限制。**

**适用信号**：从外部源拉取数据后写入数据库（API 对接、CSV/Excel 导入、跨库同步、
消息队列批量消费、数据迁移脚本、ETL 管道）；`for`/`for…of`/`while` 循环内包含
单条 INSERT/UPDATE/`model.create`/`model.save`。

**触发专项时，用 Grep 追踪数据源到写入的完整路径，逐问检查：**

**问 1：是否存在循环逐条写入？**
- 反模式（**BLOCKER**）：`for item in data_list: db.insert(item)` ——循环里每条
  数据单独一次 INSERT（或 ORM 的 `.create()` / `.save()`），N 条数据 = N 次
  数据库往返。数据量一大即耗时爆炸、连接池耗尽、甚至打满数据库。
- 正确做法：**攒批 → 批量写入**。ORM 用 `createMany` / `bulk_create` /
  `bulk_save_objects` / `insertMany` / MyBatis `<foreach>`；原生 SQL 用
  `INSERT INTO ... VALUES (...),(...),(...)` 多行一次或数据库的批量导入 API
  （`COPY` / `LOAD DATA` / `executemany`）。

**问 2：batch size 有没有控制？**
- 一次性把不确定数量的全部数据塞进一条 SQL 同样危险——SQL 文本可能超过
  数据库/驱动的传输限制（MySQL `max_allowed_packet` 默认 4/16/64MB，
  PostgreSQL 单条 SQL 1GB 但巨大 SQL 解析也极慢，网络层也有 buffer 上限）。
- 正确做法：按固定批次大小切割（常见 500–5000 行一批，视单行宽度而定），
  分批提交：`for chunk in chunks(data, BATCH_SIZE): bulk_insert(chunk)`。
- BATCH_SIZE **必须是可配置常量**，不能硬编码在循环深处无人留意。
- 如果无法确定合适的 batch size，给出保守默认值并加注释说明选择依据
  （如"单行约 200 bytes，500 行 ≈ 100KB，远低于默认 max_allowed_packet"）。

**问 3：事务与错误处理是否合理？**
- 每批一个事务（而非全量一个超大事务——锁持有时间过长、undo log 膨胀）。
- 某批失败时应有重试/跳过/记录策略，不能"半成功半失败"无人知晓。
- 与"状态同步专项"联动：如果后续有消费方依赖同步结果，**同步完成后须有
  显式的完成信号**——禁止消费方以"数据出现"判断同步完毕。

**示例对照**（检查时的具象参照）：

```
✗ 反例：循环逐条插入（N 条 = N 次网络往返）
   for item in api_response['items']:
       db.execute("INSERT INTO products (name, price) VALUES (?, ?)",
                  (item['name'], item['price']))

✗ 反例：一次性全量塞进一条 SQL（数据量大时超 max_allowed_packet）
   values = ", ".join(f"('{i['name']}', {i['price']})" for i in items)
   db.execute(f"INSERT INTO products (name, price) VALUES {values}")

✓ 正例：分批批量插入，每批控制大小
   BATCH_SIZE = 500  # 单行约 200B，500 行 ≈ 100KB，远低于 max_allowed_packet
   for chunk in chunks(items, BATCH_SIZE):
       with db.transaction():
           db.execute_many(
               "INSERT INTO products (name, price) VALUES (?, ?)",
               [(i['name'], i['price']) for i in chunk]
           )
   # 全量同步完成后置终态（与状态同步专项联动）
   db.execute("UPDATE sync_jobs SET status='completed' WHERE id=?", job_id)

✓ 正例（ORM）：
   BATCH_SIZE = 500
   for chunk in chunks(items, BATCH_SIZE):
       Product.objects.bulk_create(
           [Product(name=i['name'], price=i['price']) for i in chunk],
           batch_size=BATCH_SIZE,
       )
```

### 任务超时设计专项：双窗口超时（总超时 + 进度保活）

**核心要求：持续执行且有可查询进度的长耗时任务，必须同时设计两个超时维度——**
- **总超时（absolute_timeout）**：任务从创建/启动到终止的绝对时间上限，
  防止任务无限运行占用资源（不管有没有进度）。
- **进度保活超时（progress_timeout / keepalive_window）**：在总超时到达时，
  若最近一次进度刷新距今在保活窗口内，说明任务仍在推进，**不判超时失败，
  继续等待**；若保活窗口内也没有进度更新，才将任务置为超时失败状态。

**两个超时缺一不可**：
- 只有总超时：正常推进中的大任务会被误杀（数据量大时合理耗时超过阈值）。
- 只有保活超时（没有总超时）：任务可能永久续命，资源无法回收，故障也掩盖了。

**触发专项时，逐问检查：**

**问 1：两个超时是否都定义了？**
- 必须在任务定义/配置中同时存在 `absolute_timeout`（或 `total_timeout` /
  `max_duration`）和 `progress_timeout`（或 `keepalive_window` / `progress_ttl`
  / `heartbeat_timeout`）两个字段——**任意一个缺失 = BLOCKER**。
- 两个值必须是可配置常量（环境变量 / 配置中心），不得硬编码。
- `progress_timeout` 必须 **< absolute_timeout**，否则保活逻辑永远不会触发。

**问 2：进度刷新是否真实反映进展？**
- 任务执行方必须在每完成一个可见进度单元（处理一批数据、完成一个阶段）后
  **主动刷新**进度时间戳（`last_progress_at` / `heartbeat_at` / `updated_at`），
  而不是定时心跳刷时间——**定时刷时间 ≠ 有进度**，任务卡死也能续命。
- 理想做法：同时更新 `progress_at`（时间）和进度值（`processed_count` /
  `progress_pct` / `cursor` 等），超时判断时可验证进度值是否真的在增长。
- WARN：只刷新时间戳而不更新进度计数——无法区分"卡死但心跳在"与"正常推进"。

**问 3：超时判断逻辑是否正确实现双窗口？**
- 超时检查流程（必须同时满足才判超时失败）：
  ```
  now > task.started_at + absolute_timeout        # 总超时已到
  AND now > task.last_progress_at + progress_timeout  # 保活窗口也超了
  → 置为 timeout/failed
  ```
- 反模式（BLOCKER）：只检查 `now > started_at + some_timeout`，没有保活判断——
  大任务正常推进时被误杀。
- 反模式（BLOCKER）：超时判断逻辑与进度刷新不在同一时区/时钟源——
  `last_progress_at` 用 UTC 但比较时用本地时间，或 worker 与 scheduler
  在不同机器上时间未同步。时间比较必须统一用 UTC 并来自同一时钟源。
- WARN：超时阈值从代码里读（`if elapsed > 3600:`），应改为从配置读。

**问 4：超时后的处置是否合理？**
- 超时失败的任务必须有**终态**（`timeout` / `failed`），并记录超时原因
  （是总超时到期还是保活超时——方便排查是任务逻辑卡死还是数据量太大）。
- 与"状态同步专项"联动：`timeout` 也是终态，下游消费方只消费终态，
  超时任务不应卡在 `running` 里让下游以为仍在执行。
- 超时任务的重试策略：是自动重试还是人工介入？重试时 `started_at` 必须重置。

**示例对照**（检查时的具象参照）：

```
✗ 反例 1：只有一个超时，正在推进的任务被误杀
   # 只检查总运行时间，不管有没有进度
   if now - job.started_at > TASK_TIMEOUT:
       job.status = 'timeout'           # 大任务正常推进时冤死

✗ 反例 2：用定时心跳刷新时间，任务卡死也续命
   # worker 每 30s 更新一次时间，无论有没有实际进度
   schedule.every(30).seconds.do(lambda: job.update(last_heartbeat=now()))
   # 判断时只看心跳时间 → 卡死的任务永远不超时

✗ 反例 3：缺少总超时，任务可以永久续命
   if now - job.last_progress_at > PROGRESS_TIMEOUT:
       job.status = 'timeout'           # 只要每隔一段时间有点进展就永远不超时

✓ 正例：双窗口超时 + 真实进度计数刷新
   # 任务配置（可配置）
   ABSOLUTE_TIMEOUT = int(os.getenv('TASK_ABSOLUTE_TIMEOUT', 7200))   # 2 小时
   PROGRESS_TIMEOUT = int(os.getenv('TASK_PROGRESS_TIMEOUT', 300))    # 5 分钟无进展

   # 任务执行方：每处理一批时同时刷新时间 + 进度计数
   def process_batch(job, batch):
       do_sync(batch)
       job.update(
           last_progress_at=utcnow(),
           processed_count=job.processed_count + len(batch),  # 进度计数必须增长
       )

   # 超时检查方（scheduler / monitor）：双条件 AND
   def check_timeout(job):
       now = utcnow()
       total_expired  = (now - job.started_at).seconds  > ABSOLUTE_TIMEOUT
       no_progress    = (now - job.last_progress_at).seconds > PROGRESS_TIMEOUT
       if total_expired and no_progress:
           job.update(status='timeout',
                      timeout_reason='no_progress')       # 区分超时原因
       elif total_expired and not no_progress:
           pass  # 总超时已到但仍有进展 → 继续等待
```

### 外部调用追踪专项：外部服务返回 ID 必须入日志

**核心要求：调用外部服务（大模型、第三方 API、其他业务系统）时，日志必须记录
外部服务返回的 id 字段**——`response_id` / `request_id` / `trace_id` /
`completion_id` / `transaction_id` / `order_id` 等（以对方接口文档为准）。

**为什么**：故障排查时只有本地 `request_id` 不够——需要拿着对方系统的 id 去
对方的日志/控制台里定位问题。没有这个 id，排查就断在了系统边界上，
双方对不上口径，排查效率骤降（尤其是大模型等按次计费的服务，
计费争议也需要 id 溯源）。

**适用信号**：`fetch`/`axios`/`requests`/`httpClient`/`RestTemplate`/`http.post`/
`http.get`/`gRPC` 客户端调用；`openai.chat.completions.create`/
`anthropic.messages.create` 等模型 SDK 调用；任何跨系统的出站请求。

**触发专项时，对每处外部调用逐问检查：**

**问 1：调用后有没有把响应 ID 记入日志？**
- 外部服务通常在响应 header（`X-Request-Id`、`X-Trace-Id`）或响应体
  （`id`、`request_id`、`completion.id`、`transaction_id`）中返回唯一 ID。
- **WARN**：调用外部服务后打了日志，但日志里没有对方返回的 id。
- **BLOCKER**：调用大模型等核心外部服务（影响业务结果的），日志中
  完全没有响应 ID 且也没有本地 request_id 关联——排查和计费都断链。
- 正确做法：调用完成后，日志至少包含：`{localRequestId, externalResponseId,
  status, latency}`；异常时也记录（对方可能在错误响应里仍返回 id）。

**问 2：响应 ID 与本地 request_id 是否关联？**
- 只记录对方 id 不够，必须同时带上本地的 `request_id`——这样两个系统
  的日志才能通过 request_id 和 external_id 双向查找。
- 如果项目已有日志上下文注入（见"日志串联专项"），`request_id` 会自动携带；
  只需确保 external_id 也进入同一条日志。

**问 3：异常路径也记录了吗？**
- 调用超时/网络错误/4xx/5xx 时，仍应尝试记录对方返回的 id
  （很多 API 在 4xx/5xx 响应里也带 `request_id`）。
- 至少记录：`{localRequestId, externalUrl/service, errorType, responseBody摘要}`。
- 完全无响应（超时/连接失败）时记录：`{localRequestId, externalUrl, errorType}`。

**问 4：大模型调用是否记录了模型名和 token 用量？**
- 调用大模型 API 时，日志除了响应 ID 外，建议同时记录：
  `model`（实际使用的模型名）、`usage`（prompt_tokens / completion_tokens）。
- 这不是架构强制项，但对成本追踪和排查非常有用 = **NOTE**。

**示例对照**（检查时的具象参照）：

```
✗ 反例：调用大模型但日志不带响应 ID
   const result = await openai.chat.completions.create({ model, messages });
   logger.info('LLM call done', { inputLen: messages.length });
   //                               ↑ 对方的 completion id 呢？

✗ 反例：调用业务 API 只记状态码
   const resp = await axios.post('https://payment.internal/charge', body);
   logger.info('payment charged', { status: resp.status });
   //                               ↑ 对方返回的 transaction_id 呢？

✓ 正例：记录外部服务响应 ID + 关联本地 request_id
   const result = await openai.chat.completions.create({ model, messages });
   logger.info('LLM call done', {
     completionId: result.id,               // 对方的唯一 ID
     model: result.model,                   // 实际模型
     usage: result.usage,                   // token 用量
     latencyMs: Date.now() - start,
   });
   // request_id 由日志上下文自动注入，无需手工传

✓ 正例（异常路径）：
   try {
     const resp = await axios.post(paymentUrl, body);
     logger.info('payment ok', {
       transactionId: resp.data.transaction_id,
       status: resp.status,
     });
   } catch (err) {
     logger.error('payment failed', {
       externalRequestId: err.response?.data?.request_id,  // 对方的错误 ID
       status: err.response?.status,
       errorMsg: err.message,
     });
   }
```

### 高频写入表专项：异步缓冲与分表存储

**核心要求：高并发业务的高频记录表（每次请求/任务都写一条记录的表），
写入不能阻塞主流程，必须通过异步缓冲方式批量落库；同时此类表因数据量大，
必须按时间或其他字段特征分表（分区）存储。**

**适用信号**：任务执行记录表、行为日志/埋点表、操作流水表、审计日志表、
API 调用记录表——任何"每次业务动作都写一条"且数据量随时间线性增长的表。

**为什么写入要异步**：高并发场景下，主流程中同步写入这类记录表（每次请求
一个 INSERT），会导致：
- **主流程延迟增加**：数据库写入延迟直接加到响应时间上（p99 尤其明显）；
- **数据库压力倍增**：QPS 等于业务 QPS，连接池/磁盘 IO 成为瓶颈；
- **级联故障**：记录表写入慢/连接池满 → 主流程超时/失败（记录不应拖垮业务）。

**为什么要分表**：此类表数据量随时间线性膨胀，不分表会导致：
- **查询劣化**：全表扫描越来越慢，索引树深度增加，even 索引查询也退化；
- **DDL 锁表风险**：ALTER TABLE 在大表上锁定时间长，加字段/索引变成运维事故；
- **备份/迁移困难**：单表几十 GB 的 dump/restore 耗时不可控。

**触发专项时，对高频写入逻辑逐问检查：**

**问 1：写入是否脱离了主流程？**
- 反模式（**WARN**）：在请求处理函数/任务执行主路径中**同步**写入记录表——
  `await db.insert(record)` 或 ORM `.create()` 直接 await 在主流程里。
  主流程必须等写入完成才能继续，写入延迟直接叠加到业务响应时间。
- 正确做法（任选其一）：
  a) **内存 buffer + 定时/定量 flush**：写入先攒到内存缓冲区，达到阈值
     （条数或时间间隔）后批量 INSERT——主流程只做 `buffer.push(record)`，
     开销约等于零。需注意 flush 失败的重试和进程退出前的 drain。
  b) **异步队列/消息**：主流程发消息到队列（Kafka/RabbitMQ/Redis Stream），
     消费者异步批量写入数据库——完全解耦，主流程无数据库操作。
  c) **后台线程/协程池**：主流程把写入任务丢到后台——注意背压控制和
     资源回收。
- 如果业务确实要求**写入后立即可查**（如审计合规要求实时可查），
  则同步写入可接受，但仍应走连接池隔离（记录表用独立连接池/数据源，
  不与主业务共享），并标注 `arch-debt:` 说明理由。
- **BLOCKER**：高频记录表写入和主业务逻辑在同一个事务里——记录写入失败
  导致业务事务回滚。记录与业务数据应该**事务隔离**。

**问 2：是否有分表/分区策略？**
- 反模式（**WARN**）：高频写入表使用单张表，无分表/分区定义，
  数据量随时间增长无上限——迟早变成运维噩梦。
- 正确做法：
  a) **按时间分表/分区**：按天/周/月分表（`records_202609`）或使用数据库
     原生分区（PostgreSQL PARTITION BY RANGE、MySQL PARTITION BY RANGE）。
  b) **按业务字段分表**：按 `tenant_id`/`project_id` 等字段 hash 或 range
     分表——适用于多租户且各租户数据量差异大的场景。
  c) **归档策略**：冷数据定期归档到低成本存储（S3/OSS/冷库），
     热表只保留近 N 天数据。
- 分表方案必须在 migration 或建表脚本中体现，不能"计划以后再做"。
- 查询侧必须带分区键（时间/租户），否则跨分区扫描反而更慢。

**问 3：缓冲机制的容错处理了吗？**
- buffer flush 失败时必须有重试策略（指数退避 + 最大重试次数）。
- 进程意外退出前的 buffer 内容不能丢——注册 shutdown hook 做最终 drain，
  或使用持久化队列（WAL/消息队列）而非纯内存 buffer。
- 消息队列方式：消费者挂掉时消息不丢（at-least-once），
  重复消费有幂等保护（record 唯一键去重）。
- WARN：纯内存 buffer 且无 shutdown drain——进程崩溃丢数据。

**问 4：连接池/数据源是否隔离？**
- 高频记录表的写入（无论同步还是异步 flush）应使用**独立连接池/数据源**，
  不与主业务共享——避免记录表写入高峰占满连接导致主业务不可用。
- NOTE 级提醒：如果项目当前只有一个数据源，建议后续拆分。

**示例对照**（检查时的具象参照）：

```
✗ 反例 1：主流程同步写入记录表（每次请求一个 INSERT）
   async function handleTask(task) {
     const result = await executeTask(task);
     // 同步写入 — 写入延迟直接加到任务耗时上，且写入失败可能影响主流程
     await db.execute("INSERT INTO task_records (task_id, result, created_at) VALUES (?, ?, NOW())",
                      [task.id, result, ]);
     return result;
   }

✗ 反例 2：记录写入与业务在同一事务（记录失败 = 业务回滚）
   async function placeOrder(order) {
     await db.transaction(async (tx) => {
       await tx.insert('orders', order);
       await tx.insert('operation_logs', { action: 'order_placed', ... });  // 同事务！
     });
   }

✗ 反例 3：高频表无分表（单表几千万行 + 还在 INSERT）
   CREATE TABLE task_records (
     id BIGINT AUTO_INCREMENT PRIMARY KEY,
     task_id BIGINT, result TEXT, created_at DATETIME,
     INDEX idx_task_id (task_id)
   );  -- 无分区、无归档、数据量无上限

✓ 正例：内存 buffer + 定时 flush + 按月分表
   // 主流程：只往 buffer 推，开销约等于零
   function handleTask(task) {
     const result = executeTask(task);
     recordBuffer.push({ taskId: task.id, result, createdAt: new Date() });
     return result;  // 不等写入
   }

   // 后台 flush（每 5 秒或攒满 500 条）
   setInterval(async () => {
     const batch = recordBuffer.drain(500);
     if (batch.length === 0) return;
     const table = `task_records_${formatMonth(new Date())}`;  // 按月分表
     await recordDb.bulkInsert(table, batch);                  // 独立连接池
   }, 5000);

   // shutdown hook 保证进程退出前不丢数据
   process.on('SIGTERM', async () => {
     await recordBuffer.flushAll();
     process.exit(0);
   });

✓ 正例（消息队列方式）：
   // 主流程：发消息，不碰数据库
   async function handleTask(task) {
     const result = await executeTask(task);
     await mq.publish('task_records', { taskId: task.id, result });
     return result;
   }

   // 消费者：批量消费 + 写入分区表
   consumer.on('batch', async (messages) => {
     const records = messages.map(m => m.value);
     const table = `task_records_${formatMonth(new Date())}`;
     await db.bulkInsert(table, records);
     await consumer.commitOffset();
   });

✓ 正例（数据库分区）：
   CREATE TABLE task_records (
     id BIGINT AUTO_INCREMENT,
     task_id BIGINT, result TEXT, created_at DATETIME,
     PRIMARY KEY (id, created_at),
     INDEX idx_task_id (task_id, created_at)
   ) PARTITION BY RANGE (TO_DAYS(created_at)) (
     PARTITION p202609 VALUES LESS THAN (TO_DAYS('2026-10-01')),
     PARTITION p202610 VALUES LESS THAN (TO_DAYS('2026-11-01')),
     PARTITION p_future VALUES LESS THAN MAXVALUE
   );
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
  无保护的共享消费（既无认领也无幂等）、请求路径日志无 request_id、
  无 WHERE 的 UPDATE/DELETE、循环逐条写入数据库（已知为批量同步场景）、
  **长耗时任务只有一个超时维度（缺总超时或缺进度保活超时）**、
  **超时判断逻辑用单条件（没有保活判断）或存在时钟不一致**、
  **调用核心外部服务（大模型等）日志中无响应 ID 且无本地 request_id 关联**、
  **高频记录表写入与主业务在同一事务（记录失败导致业务回滚）**——
  不合就不能合入。
- **WARN**：跨模块直达内部、过度抽象、现状不一致、暴露中间态但下游暂未消费、
  事务外发布完成事件、request_id 靠层层手工传参、涉用户日志缺 user_id、
  多租户日志缺 tenant_id、异步边界日志上下文丢失、简单操作绕过 ORM、
  原生 SQL 使用 SELECT *、批量写入未控制 batch size 或未按批提交事务、
  **超时阈值硬编码在代码里（应改为可配置）**、
  **进度刷新只更新时间戳而不更新进度计数（无法区分卡死与推进）**、
  **调用外部服务后日志缺对方返回的响应 ID（影响跨系统排查）**、
  **高频写入表在主流程中同步 INSERT（应异步缓冲/队列解耦）**、
  **高频写入表无分表/分区策略（数据量随时间无上限增长）**、
  **纯内存 buffer 无 shutdown drain（进程崩溃丢数据）**——
  建议改，可带 `arch-debt:` 标记合入。
- **NOTE**：值得记录但不要求本次处理（如轮询消费建议确认认领/幂等、
  日志中出现敏感凭证、集中合理使用原生复杂 SQL、ORM 大表全字段拉取）。

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
