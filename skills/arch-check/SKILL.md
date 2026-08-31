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
  **超时判断逻辑用单条件（没有保活判断）或存在时钟不一致**——不合就不能合入。
- **WARN**：跨模块直达内部、过度抽象、现状不一致、暴露中间态但下游暂未消费、
  事务外发布完成事件、request_id 靠层层手工传参、涉用户日志缺 user_id、
  多租户日志缺 tenant_id、异步边界日志上下文丢失、简单操作绕过 ORM、
  原生 SQL 使用 SELECT *、批量写入未控制 batch size 或未按批提交事务、
  **超时阈值硬编码在代码里（应改为可配置）**、
  **进度刷新只更新时间戳而不更新进度计数（无法区分卡死与推进）**——
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
