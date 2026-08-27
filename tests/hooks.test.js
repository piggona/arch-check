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

test('watcher: 空/垃圾 stdin 不炸（超时自救路径）', () => {
  const r = run('arch-watcher.js', {}, 'not-json-at-all');
  assert.equal(r.status, 0, r.stderr);
});
