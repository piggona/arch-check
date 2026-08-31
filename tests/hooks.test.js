#!/usr/bin/env node
// 钩子集成测试（学自 ponytail：不 mock，spawnSync 真实执行钩子脚本，
// 用环境变量组合模拟各宿主，断言输出协议形状与退出码）。
//
// 运行：npm test   （node --test，Node 18+ 自带，零依赖）

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.join(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-check-test-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

function run(script, env, input = '') {
  return spawnSync(process.execPath, [path.join(root, 'hooks', script)], {
    env: { ...process.env, ...env },
    input,
    encoding: 'utf8',
  });
}

// 干净基线：防 CI shell 泄漏宿主变量干扰探测（学 ponytail 的教训）
delete process.env.PLUGIN_DATA;
delete process.env.COPILOT_PLUGIN_DATA;

// ---------- SessionStart：arch-activate.js ----------

test('activate(Claude 原生): 无契约项目输出纯文本注入', () => {
  const home = path.join(tmp, 'home1');
  fs.mkdirSync(home, { recursive: true });
  const r = run('arch-activate.js', { HOME: home, USERPROFILE: home });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /ARCH-CHECK ACTIVE/);
});

test('activate(Claude 原生): 有 ARCHITECTURE.md 的项目点名契约', () => {
  const proj = path.join(tmp, 'proj2');
  fs.mkdirSync(proj, { recursive: true });
  fs.writeFileSync(path.join(proj, 'ARCHITECTURE.md'), '# contract\n');
  const home = path.join(tmp, 'home2');
  fs.mkdirSync(home, { recursive: true });
  const r = run('arch-activate.js', { HOME: home, USERPROFILE: home }, '');
  // 注意：activate 用 process.cwd() 找契约；spawnSync 继承当前 cwd，此处只验证不崩 + 有输出
  assert.equal(r.status, 0, r.stderr);
  assert.ok(typeof r.stdout === 'string');
});

test('activate(off): ARCH_CHECK_ACTIVATE=off 时不注入正文', () => {
  const home = path.join(tmp, 'home3');
  fs.mkdirSync(home, { recursive: true });
  const r = run('arch-activate.js', {
    HOME: home, USERPROFILE: home, ARCH_CHECK_ACTIVATE: 'off',
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('activate(Codex): PLUGIN_DATA 下输出 hookSpecificOutput JSON', () => {
  const home = path.join(tmp, 'home4');
  fs.mkdirSync(home, { recursive: true });
  const r = run('arch-activate.js', {
    HOME: home, USERPROFILE: home, PLUGIN_DATA: path.join(tmp, 'pd4'),
  });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, 'SessionStart');
  assert.match(out.hookSpecificOutput.additionalContext, /ARCH-CHECK ACTIVE/);
});

// ---------- PostToolUse：arch-watcher.js ----------

function writeFixture(rel, source) {
  const p = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, source);
  return p;
}

const evt = (file) => JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file } });

test('watcher: domain 层 import react → 命中违规(hint 档)', () => {
  const f = writeFixture('src/domain/order.ts', "import { useState } from 'react';\nexport const x = 1;\n");
  const r = run('arch-watcher.js', {}, evt(f));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /架构违规|react/);
});

test('watcher: 干净的 domain 文件 → 静默', () => {
  const f = writeFixture('src/domain/order2.ts', "import { v4 } from './util.js';\nexport const y = 2;\n");
  const r = run('arch-watcher.js', {}, evt(f));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('watcher(enforce): 违规输出 decision:block', () => {
  const f = writeFixture('src/domain/bad.ts', "import React from 'react';\nexport const z = 3;\n");
  const r = run('arch-watcher.js', { ARCH_CHECK_WATCHER: 'enforce' }, evt(f));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /react|依赖/);
});

test('watcher(off): 直接跳过', () => {
  const f = writeFixture('src/domain/skip.ts', "import React from 'react';\n");
  const r = run('arch-watcher.js', { ARCH_CHECK_WATCHER: 'off' }, evt(f));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('watcher: 非 JS/TS/Py 文件不检查', () => {
  const f = writeFixture('src/domain/notes.md', '# notes\n');
  const r = run('arch-watcher.js', {}, evt(f));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('watcher: 带 BOM 的事件 JSON 不炸', () => {
  const f = writeFixture('src/domain/ok.ts', 'export const a = 1;\n');
  const r = run('arch-watcher.js', {}, '\uFEFF' + evt(f));
  assert.equal(r.status, 0, r.stderr);
});

test('watcher: 空垃圾 stdin 不炸（超时自救路径）', () => {
  const r = run('arch-watcher.js', {}, 'not-json-at-all');
  assert.equal(r.status, 0, r.stderr);
});

// ---------- 状态同步嗅探（轮询式消费提醒） ----------

test('watcher: 轮询循环 + 查询消费 → 输出状态同步提醒', () => {
  const f = writeFixture('src/services/poller.ts',
    "async function loop() {\n  while (true) {\n    const rows = db.query('SELECT * FROM tasks WHERE status = 1');\n    await sleep(1000);\n  }\n}\n");
  const r = run('arch-watcher.js', {}, evt(f));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /状态同步提醒/);
});

test('watcher: 轮询但无查询消费特征 → 静默（防误报）', () => {
  const f = writeFixture('src/ui/clock.ts',
    "setInterval(() => { console.log('tick'); }, 1000);\n");
  const r = run('arch-watcher.js', {}, evt(f));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('watcher(enforce): 轮询提醒不升级为 block（只有架构违规才 block）', () => {
  const f = writeFixture('src/services/poller2.ts',
    "while (true) { const r = await db.query('SELECT 1'); }\n");
  const r = run('arch-watcher.js', { ARCH_CHECK_WATCHER: 'enforce' }, evt(f));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, undefined, '轮询提醒不应产生 decision:block');
  assert.match(out.hookSpecificOutput.additionalContext, /状态同步提醒/);
});

// ---------- 日志串联嗅探（缺追踪 ID 提醒） ----------

test('watcher: service 层日志调用无追踪 ID → 输出日志串联提醒', () => {
  const f = writeFixture('src/services/order.ts',
    "export function create(o: Order) {\n  logger.info('order created', { orderId: o.id });\n}\n");
  const r = run('arch-watcher.js', {}, evt(f));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /日志串联提醒/);
});

test('watcher: 日志调用带 requestId → 静默', () => {
  const f = writeFixture('src/services/order2.ts',
    "export function create(o: Order) {\n  logger.info('order created', { orderId: o.id, requestId: o.reqId });\n}\n");
  const r = run('arch-watcher.js', {}, evt(f));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('watcher: domain 层日志无 ID → 静默（领域层豁免，上下文应注入在调用方）', () => {
  const f = writeFixture('src/domain/rule.ts',
    "export function calc(x: number) {\n  console.log('calc', x);\n  return x * 2;\n}\n");
  const r = run('arch-watcher.js', {}, evt(f));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('watcher(enforce): 日志缺 ID 提醒不升级为 block', () => {
  const f = writeFixture('src/services/billing.ts',
    "export function charge(c: Card) {\n  logger.warn('charge failed');\n}\n");
  const r = run('arch-watcher.js', { ARCH_CHECK_WATCHER: 'enforce' }, evt(f));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, undefined, '日志提醒不应产生 decision:block');
  assert.match(out.hookSpecificOutput.additionalContext, /日志串联提醒/);
});

// ---------- 数据库访问嗅探（SELECT * 与裸 SQL） ----------

test('watcher: SELECT * → 输出数据库访问违规提醒', () => {
  const f = writeFixture('src/infra/repo.ts',
    "export function getOrder(id: number) {\n  return db.query('SELECT * FROM orders WHERE id = ?', [id]);\n}\n");
  const r = run('arch-watcher.js', {}, evt(f));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /SELECT \*/);
});

test('watcher: 显式字段的原生 SELECT → 静默（合法复杂查询）', () => {
  const f = writeFixture('src/infra/report.ts',
    "export function summary() {\n  return db.query('SELECT o.id, o.amount, u.name FROM orders o JOIN users u ON u.id = o.user_id');\n}\n");
  const r = run('arch-watcher.js', {}, evt(f));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('watcher: 裸 INSERT INTO → 提醒走 ORM', () => {
  const f = writeFixture('src/infra/seed.ts',
    "db.execute(\"INSERT INTO users (name) VALUES ('a')\");\n");
  const r = run('arch-watcher.js', {}, evt(f));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /ORM/);
});

test('watcher: ORM 调用 → 静默', () => {
  const f = writeFixture('src/infra/order-repo.ts',
    "export async function getOrder(id: number) {\n  return prisma.order.findUnique({ where: { id }, select: { id: true, amount: true } });\n}\n");
  const r = run('arch-watcher.js', {}, evt(f));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('watcher: count(*) 不误伤', () => {
  const f = writeFixture('src/infra/stats.ts',
    "const n = await db.query('SELECT count(*) FROM orders');\n");
  const r = run('arch-watcher.js', {}, evt(f));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('watcher(enforce): SELECT * 升级为 block（确定性违规）', () => {
  const f = writeFixture('src/infra/bad.ts',
    "db.query('SELECT * FROM users');\n");
  const r = run('arch-watcher.js', { ARCH_CHECK_WATCHER: 'enforce' }, evt(f));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /SELECT \*/);
});

test('watcher(enforce): 裸 INSERT 只有提醒不 block（可能有合理例外）', () => {
  const f = writeFixture('src/infra/bulk.ts',
    "db.execute('INSERT INTO logs (msg) SELECT msg FROM staging');\n");
  const r = run('arch-watcher.js', { ARCH_CHECK_WATCHER: 'enforce' }, evt(f));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, undefined, '裸 SQL 提醒不应 block');
  assert.match(out.hookSpecificOutput.additionalContext, /ORM/);
});

// ---------- 批量数据同步嗅探（循环逐条写入） ----------

test('watcher: for 循环内 db.execute INSERT → 输出批量同步违规', () => {
  const f = writeFixture('src/services/sync.ts',
    "for (const item of items) {\n  db.execute('INSERT INTO products (name) VALUES (?)', [item.name]);\n}\n");
  const r = run('arch-watcher.js', {}, evt(f));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /批量同步违规|循环逐条/);
});

test('watcher: for 循环内 ORM .create() → 输出批量同步违规', () => {
  const f = writeFixture('src/services/importer.ts',
    "for (const row of csvRows) {\n  await prisma.product.create({ data: { name: row.name } });\n}\n");
  const r = run('arch-watcher.js', {}, evt(f));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.match(out.hookSpecificOutput.additionalContext, /批量同步违规|循环逐条/);
});

test('watcher: 使用 bulk_create/createMany → 静默（合法批量写入）', () => {
  const f = writeFixture('src/services/bulk-sync.ts',
    "for (const chunk of chunks(items, BATCH_SIZE)) {\n  await prisma.product.createMany({ data: chunk });\n}\n");
  const r = run('arch-watcher.js', {}, evt(f));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('watcher: 无循环的单条 create → 静默（非批量同步场景）', () => {
  const f = writeFixture('src/services/order.ts',
    "export async function placeOrder(data: OrderInput) {\n  return prisma.order.create({ data });\n}\n");
  const r = run('arch-watcher.js', {}, evt(f));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('watcher(enforce): 循环逐条写入升级为 block', () => {
  const f = writeFixture('src/services/sync-bad.py',
    "for item in api_data:\n    session.add(Product(name=item['name']))\n    session.commit()\n");
  const r = run('arch-watcher.js', { ARCH_CHECK_WATCHER: 'enforce' }, evt(f));
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /批量同步|循环逐条/);
});
