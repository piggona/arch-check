#!/usr/bin/env node
// arch-check — SessionStart 钩子：注入架构意识（保持极薄）
//
// 行为：
//   1. ARCH_CHECK_ACTIVATE=off 时静默跳过
//   2. 项目根存在 ARCHITECTURE.md → 注入一行"遵守契约"提醒
//   3. 不存在 → 注入提醒 + 一次性建议生成契约（学 ponytail 的 statusline nudge：
//      用标志文件保证只提醒一次，每次会话都唠叨会把提示变成骚扰）

const fs = require('fs');
const path = require('path');
const os = require('os');
const { config, getActivationContext, writeHookOutput } = require('./arch-runtime');

// 总开关关闭：完全静默（连 nudge 都不出）
if (!config.activate) process.exit(0);

const CONTRACT_NAMES = ['ARCHITECTURE.md', '.arch/rules.md', path.join('docs', 'ARCHITECTURE.md')];

function findContract(dir) {
  for (const name of CONTRACT_NAMES) {
    if (fs.existsSync(path.join(dir, name))) return name;
  }
  return null;
}

try {
  const cwd = process.cwd();
  const contract = findContract(cwd);

  if (contract) {
    writeHookOutput('SessionStart',
      getActivationContext() + ' 本项目契约: ' + contract);
    process.exit(0);
  }

  // 无契约：一次性 nudge
  const flag = path.join(os.homedir(), '.arch-check-no-contract-nudged');
  if (!fs.existsSync(flag)) {
    try { fs.writeFileSync(flag, ''); } catch (e) { /* best-effort */ }
    writeHookOutput('SessionStart',
      getActivationContext() +
      ' 本项目还没有 ARCHITECTURE.md（分层定义+依赖矩阵）。' +
      '首次涉及结构调整的任务时，主动提议基于现有代码生成一份。');
  } else {
    writeHookOutput('SessionStart', getActivationContext());
  }
} catch (e) {
  // 契约检测失败不能阻塞会话启动 —— 静默退出
}

process.exit(0);
