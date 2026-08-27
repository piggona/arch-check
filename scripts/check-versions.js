#!/usr/bin/env node
// 版本一致性守卫（学自 ponytail v4.8.0 事故：所有 manifest"一致地"停在旧版本，
// 互相锚定测不出整体漂移——所以除了互相一致，本地还给出提示：发布时应以 git tag 为准）。
//
// 用法：node scripts/check-versions.js

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const PINNED = /^\d+\.\d+\.\d+$/;

// 【维护点】新增宿主清单时把文件加进来
const VERSION_FILES = [
  '.claude-plugin/plugin.json', // Claude Code 插件
  '.codex-plugin/plugin.json',  // Codex 插件
  'package.json',               // npm / 测试入口
];

let failed = false;
const versions = VERSION_FILES.map((rel) => {
  let v;
  try {
    const raw = fs.readFileSync(path.join(root, rel), 'utf8').replace(/^\uFEFF/, '');
    v = JSON.parse(raw).version;
  } catch (e) {
    console.error(`✘ ${rel}: 无法读取 (${e.message})`);
    failed = true;
    return [rel, null];
  }
  if (typeof v !== 'string' || !PINNED.test(v)) {
    console.error(`✘ ${rel}: version 必须是固定 X.Y.Z，当前 ${JSON.stringify(v)}`);
    failed = true;
  }
  return [rel, v];
});

const distinct = [...new Set(versions.map(([, v]) => v))];
if (distinct.length > 1) {
  console.error('✘ 版本不一致 —— 每个清单必须共享同一版本:');
  for (const [rel, v] of versions) console.error(`  ${v}\t${rel}`);
  failed = true;
} else if (!failed) {
  console.log(`✔ ${VERSION_FILES.length} 个清单版本一致: ${distinct[0]}`);
}

if (!failed) {
  console.log('提示: 发布打 tag (v' + distinct[0] + ') 时，确认 tag 与该版本一致。');
}
process.exit(failed ? 1 : 0);
