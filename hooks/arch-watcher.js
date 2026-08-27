#!/usr/bin/env node
// arch-check — PostToolUse 钩子（matcher: Write|Edit）
//
// 研发代码后的自动架构嗅探：每次写/改文件后，读取该文件做**单文件级、零依赖、
// <50ms** 的快速检查。深度检查（循环依赖、跨模块图）是 /arch-check 技能的活，
// 这里只做"一眼就能看出的违规"，宁可漏报不可误伤。
//
// 强度（ARCH_CHECK_WATCHER）：
//   hint（默认）— 温和提醒，注入上下文，不打断工作流
//   enforce      — decision:block，代理看到 reason 后会自我修正
//   off          — 什么都不做
//
// 【定制点】SNIFF_RULES 是嗅探规则表——把你们团队的分层命名和禁配依赖填进来。

const fs = require('fs');
const path = require('path');
const { config, writeHookOutput, readHookInput } = require('./arch-runtime');

// ---------- 层级识别：按路径关键词猜文件属于哪一层 ----------
// 【定制点】改成你们的目录命名。匹配顺序即优先级。
const LAYER_PATTERNS = [
  { layer: 'domain', re: /(^|[\\/])(domain|entities|core|model)s?[\\/]/i },
  { layer: 'ui',     re: /(^|[\\/])(ui|web|pages|views|components|screens)[\\/]/i },
  { layer: 'infra',  re: /(^|[\\/])(infra|infrastructure|db|database|repositories|adapters|api)[\\/]/i },
  { layer: 'service',re: /(^|[\\/])(services|usecases|application|app)[\\/]/i },
];

// ---------- 禁配规则：某层文件里出现这些依赖特征 = 违规 ----------
// package 靠前缀匹配（"react" 命中 "react-dom"），相对路径靠层级关键词。
// 【定制点】按技术栈增删。
const SNIFF_RULES = [
  {
    layer: 'domain',
    banPkgs: ['react', 'vue', 'svelte', 'angular', 'express', 'koa', 'fastify',
              'next', 'sequelize', 'mongoose', 'prisma', 'typeorm', 'knex',
              'sqlalchemy', 'django', 'flask', 'fastapi', 'psycopg', 'pymysql', 'boto3'],
    banPathLayers: ['ui', 'infra'],
    why: '领域层不得依赖 UI / 基础设施（依赖只能向内）',
  },
  {
    layer: 'ui',
    banPathLayers: [], // UI 依赖 service/domain 合法；如需禁止直连 infra 在此加 'infra'
    why: '',
  },
];

function detectLayer(filePath) {
  const norm = filePath.replace(/\\/g, '/');
  for (const p of LAYER_PATTERNS) if (p.re.test(norm)) return p.layer;
  return null;
}

function readSource(filePath) {
  try { return fs.readFileSync(filePath, 'utf8'); } catch (e) { return null; }
}

// ---------- import 提取（JS/TS + Python，覆盖主流即可） ----------
function extractImports(source) {
  const found = [];
  const js = /(?:import[\s\S]{0,200}?from\s*|require\(\s*|import\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = js.exec(source)) !== null) found.push(m[1]);
  const pyFrom = /^\s*from\s+([.\w]+)\s+import\s+/gm;
  while ((m = pyFrom.exec(source)) !== null) found.push(m[1].replace(/\./g, '/'));
  const pyImp = /^\s*import\s+([\w.]+)/gm;
  while ((m = pyImp.exec(source)) !== null) {
    if (!m[1].includes('.')) found.push(m[1]); // 排除相对 import 的误匹配交给 pyFrom
  }
  return [...new Set(found)];
}

function checkFile(filePath, source) {
  const layer = detectLayer(filePath);
  if (!layer) return null; // 识别不出层级 → 不猜，交给 /arch-check 深查

  const rule = SNIFF_RULES.find((r) => r.layer === layer);
  if (!rule) return null;

  const violations = [];
  for (const dep of extractImports(source)) {
    if (dep.startsWith('.') || dep.startsWith('/')) {
      // 相对路径：检查是否依赖了被禁层级
      for (const banned of rule.banPathLayers || []) {
        const re = new RegExp('(^|/)' + banned + '(/|$)', 'i');
        const seg = dep.replace(/^\.\.?\//, '');
        if (re.test('/' + seg + '/')) {
          violations.push(`${dep} → ${banned} 层`);
        }
      }
      // 直捣内部实现：跨目录引用 /internal/ /impl/
      if (/\/(internal|impl)\//i.test(dep) && !dep.startsWith('.')) {
        violations.push(`${dep} 越过公共接口直达内部实现`);
      }
    } else {
      // 外部包：前缀匹配禁配清单
      for (const pkg of rule.banPkgs || []) {
        if (dep === pkg || dep.startsWith(pkg + '/') || dep.startsWith(pkg + '.')) {
          violations.push(`${dep}（框架/基础设施依赖）`);
          break;
        }
      }
    }
  }

  if (!violations.length) return null;
  return {
    layer,
    file: filePath,
    msg: '疑似架构违规[' + layer + '层]: ' + violations.join('; ') +
      ' — ' + rule.why + '。误报则忽略并可用 /arch-check 复核。',
  };
}

// ---------- 状态同步嗅探：轮询/订阅式消费（NOTE 级提醒，永不阻断） ----------
// 长耗时任务状态同步的常见事故形态：消费方轮询"数据是否出现"当作"步骤完成"，
// 或多实例同时监听同一状态无认领/幂等保护。单文件静态判断不了对错，
// 只做温和提醒（hint 文案），即使 enforce 档也不 block——宁可漏报不可误伤。
const POLL_LOOP_RE = /while\s*\(\s*true|while\s+True|setInterval\s*\(|PollingLooper/i;
const CONSUME_RE = /SELECT\s|\.query\s*\(|\.findOne?\s*\(|subscribe\s*\(|\.consume\s*\(|on\s*\(\s*['"]message|@KafkaListener|from\s+\w+\s+import/i;

function sniffPollingConsumer(source) {
  if (POLL_LOOP_RE.test(source) && CONSUME_RE.test(source)) {
    return '状态同步提醒: 检测到轮询/订阅式消费 — 确认消费的是终态而非中间态' +
      '（"数据出现" ≠ "步骤完成"，完成信号应在全部数据落库后置位），' +
      '且多实例并发时有原子认领（UPDATE…WHERE status= 并查影响行数）或幂等保护。' +
      '详见 /arch-check 状态同步专项。';
  }
  return null;
}

// ---------- 日志串联嗅探：日志调用但缺追踪 ID（NOTE 级提醒，永不阻断） ----------
// 在线流程的日志要能通过 ID 串联并标识来源：request_id / user_id /
// tenant_id(enterprise_id)。单文件静态判断不了链路是否真的断了，
// 只做温和提醒。domain 层豁免——请求上下文应注入在调用方的 logger 里，
// 领域层日志不要求携带。
const LOG_CALL_RE = /(?:logger|log|logging)\s*\.\s*(?:info|warn|warning|error|debug|trace)\s*\(|console\.\s*(?:log|info|warn|error)\s*\(/;
const TRACE_ID_RE = /request_?id|requestid|trace_?id|x-request-id|correlation_?id|user_?id|userid|tenant_?id|enterprise_?id|_ctx|loggerContext|mdc/i;

function sniffLogTrace(source, layer) {
  // 只针对服务端代码（service/infra 层）：domain 的上下文应注入在调用方；
  // ui 层多为前端组件，无 request_id 概念；识别不出层级的多为脚本/入口，
  // 宁可漏报不误伤——全部豁免，深查交给 /arch-check 日志串联专项。
  if (layer !== 'service' && layer !== 'infra') return null;
  if (LOG_CALL_RE.test(source) && !TRACE_ID_RE.test(source)) {
    return '日志串联提醒: 检测到日志调用但文件内未见 request_id/user_id/tenant_id — ' +
      '在线流程的日志应通过 ID 串联并标识来源（请求带 request_id、涉用户带 user_id、' +
      '涉企业带 tenant_id/enterprise_id，入口注入日志上下文而非层层传参）。' +
      '详见 /arch-check 日志串联专项。';
  }
  return null;
}

// ---------- 主流程 ----------
if (config.watcher === 'off') process.exit(0);

readHookInput((event) => {
  try {
    const filePath = event && event.tool_input &&
      (event.tool_input.file_path || event.tool_input.filePath);
    if (!filePath || typeof filePath !== 'string') process.exit(0);
    if (!/\.(js|jsx|ts|tsx|mjs|cjs|py)$/.test(filePath)) process.exit(0);

    const source = readSource(filePath);
    if (source === null) process.exit(0);

    const layer = detectLayer(filePath);
    const archHit = checkFile(filePath, source);   // 架构违规（可 enforce）
    const notes = [
      sniffPollingConsumer(source),                // 状态同步提醒（永不 enforce）
      sniffLogTrace(source, layer),                // 日志串联提醒（永不 enforce）
    ].filter(Boolean);

    if (config.watcher === 'enforce' && archHit) {
      writeHookOutput('PostToolUse', null, {
        decision: 'block',
        reason: archHit.msg +
          (notes.length ? ' 另: ' + notes.join(' ') : '') +
          '（enforce 模式：请修正依赖方向后继续）',
      });
    } else if (archHit || notes.length) {
      writeHookOutput('PostToolUse',
        [archHit && archHit.msg].concat(notes).filter(Boolean).join('\n'));
    }
  } catch (e) {
    // 嗅探失败 = 静默通过，绝不阻塞写文件
  }
  process.exit(0);
});
