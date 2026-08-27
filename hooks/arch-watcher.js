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

function checkFile(filePath) {
  const layer = detectLayer(filePath);
  if (!layer) return null; // 识别不出层级 → 不猜，交给 /arch-check 深查

  let source;
  try { source = fs.readFileSync(filePath, 'utf8'); } catch (e) { return null; }

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

// ---------- 主流程 ----------
if (config.watcher === 'off') process.exit(0);

readHookInput((event) => {
  try {
    const filePath = event && event.tool_input &&
      (event.tool_input.file_path || event.tool_input.filePath);
    if (!filePath || typeof filePath !== 'string') process.exit(0);
    if (!/\.(js|jsx|ts|tsx|mjs|cjs|py)$/.test(filePath)) process.exit(0);

    const hit = checkFile(filePath);
    if (!hit) process.exit(0);

    if (config.watcher === 'enforce') {
      writeHookOutput('PostToolUse', null, {
        decision: 'block',
        reason: hit.msg + '（enforce 模式：请修正依赖方向后继续）',
      });
    } else {
      writeHookOutput('PostToolUse', hit.msg);
    }
  } catch (e) {
    // 嗅探失败 = 静默通过，绝不阻塞写文件
  }
  process.exit(0);
});
