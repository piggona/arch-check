#!/usr/bin/env node
// arch-check — 共享运行时层（借鉴 ponytail-runtime.js 的宿主适配模式）
//
// 职责：
//   1. 宿主探测：同一份钩子脚本被 Claude Code / Codex 复用，靠环境变量分流
//   2. 输出协议适配：各宿主对钩子 stdout 的消费方式不同，统一从这里出口
//   3. 状态与配置的读写
//
// 可靠性契约（学自 ponytail 的真实事故）：
//   - 任何路径都不抛异常到顶层：钩子挂在用户会话关键路径上，挂了会冻结会话
//   - 所有 JSON.parse 前剥离 UTF-8 BOM（Windows 编辑器常加）

const fs = require('fs');
const path = require('path');
const os = require('os');

// ---------- 宿主探测 ----------
// Claude 原生不设 PLUGIN_DATA；Codex 会设置。按 ponytail 的实践，
// 检测顺序从特殊到一般，避免误判。
const isCodex = Boolean(process.env.PLUGIN_DATA) && !process.env.COPILOT_PLUGIN_DATA;
const isCopilot = Boolean(process.env.COPILOT_PLUGIN_DATA);

// ---------- 配置（env 优先，全部可选） ----------
const rawWatcher = String(process.env.ARCH_CHECK_WATCHER || '').trim().toLowerCase();
const config = {
  // 会话启动时注入架构意识（on/off）
  activate: String(process.env.ARCH_CHECK_ACTIVATE || '').trim().toLowerCase() !== 'off',
  // 写后嗅探强度：hint（只提示）/ enforce（输出阻断性提醒让代理自我修正）/ off
  watcher: ['hint', 'enforce', 'off'].includes(rawWatcher) ? rawWatcher : 'hint',
};

// ---------- 会话注入文案（学 ponytail：常驻上下文必须薄，几行足矣） ----------
function getActivationContext() {
  if (!config.activate) return '';
  return 'ARCH-CHECK ACTIVE — 写代码时遵守项目根 ARCHITECTURE.md 的分层与依赖约束。' +
    '变更完成后提醒用户可运行 /arch-check 做架构检查；暂缓修复的架构问题用 ' +
    '`arch-debt: <上限>, <触发条件>` 注释标记。';
}

// ---------- 输出协议适配 ----------
// Claude：SessionStart 裸 stdout 即注入；PostToolUse 需 JSON（decision/reason）。
// Codex：统一 hookSpecificOutput JSON 形状。
function writeHookOutput(event, context, opts = {}) {
  const { decision, reason } = opts;
  try {
    if (isCodex) {
      const out = {};
      if (reason) out.systemMessage = reason;
      if (context) {
        out.hookSpecificOutput = { hookEventName: event, additionalContext: context };
      }
      process.stdout.write(JSON.stringify(out));
      return;
    }
    if (isCopilot) {
      process.stdout.write(JSON.stringify(event === 'SessionStart' && context
        ? { additionalContext: context } : {}));
      return;
    }
    // Claude 原生
    if (event === 'SessionStart') {
      process.stdout.write(context);
      return;
    }
    if (event === 'PostToolUse') {
      // enforce 档：decision:block 的 reason 会反馈给代理，促其自我修正
      if (decision === 'block' && reason) {
        process.stdout.write(JSON.stringify({ decision: 'block', reason }));
        return;
      }
      // hint 档：additionalContext 温和入上下文
      if (context) {
        process.stdout.write(JSON.stringify({
          hookSpecificOutput: { hookEventName: event, additionalContext: context },
        }));
        return;
      }
    }
    // 无内容则静默成功
  } catch (e) {
    // stdout 已关闭（EPIPE）等情况：静默，绝不让钩子以非零码退出
  }
}

// ---------- 事件输入读取（带超时自救） ----------
// 学自 ponytail #443：Windows 上宿主可能用 PowerShell 包装钩子导致管道 JSON
// 没有 EOF，stdin 'end' 永不触发，钩子挂起会冻结整个会话。
// 因此：1 秒兜底定时器 + error 兜底，拿到多少算多少。
function readHookInput(onDone) {
  let input = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    let parsed = null;
    try {
      parsed = JSON.parse(input.replace(/^\uFEFF/, ''));
    } catch (e) { /* 非 JSON 或空输入：当无输入处理 */ }
    onDone(parsed);
  };
  try {
    process.stdin.on('data', (c) => { input += c; });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
    setTimeout(finish, 1000).unref();
  } catch (e) {
    finish();
  }
}

// ---------- 共享小工具 ----------
function stripBom(s) { return String(s).replace(/^\uFEFF/, ''); }

function readJsonSafe(p) {
  try { return JSON.parse(stripBom(fs.readFileSync(p, 'utf8'))); } catch (e) { return null; }
}

module.exports = {
  isCodex, isCopilot, config,
  getActivationContext, writeHookOutput, readHookInput,
  stripBom, readJsonSafe,
};
