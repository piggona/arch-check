# arch-check

研发代码后的**架构检查**插件：AI 写完代码，谁来把关分层与依赖？本插件给 Claude Code / Codex 装上一套架构审查能力——变更级检查、全库审计、架构债台账，以及每次写文件后的自动嗅探。

## 功能

| 能力 | 触发方式 | 说明 |
|---|---|---|
| 变更级检查 | `/arch-check [staged\|branch\|<range>]` | 对本次改动查依赖方向、分层、边界、循环依赖 |
| 全库审计 | `/arch-audit` | 分层地图 + 四项体检（方向/循环/边界/抽象债）+ 三行结论 |
| 架构债台账 | `/arch-debt` | 收割全库 `arch-debt:` 注释，标注在期/到期/no-trigger |
| 速查 | `/arch-help` | 命令、标记语法、配置项 |
| 自动嗅探 | 钩子（免操作） | 会话启动注入架构意识；每次写/改文件后 50ms 内嗅探常见违规 |
| 专职审查员 | `@arch-reviewer` | 子代理（仅 Claude），多文件重构后整体把关 |

规则来源优先级：项目根 `ARCHITECTURE.md`（模板见 `templates/ARCHITECTURE.md.example`）> 内置通用原则。`AGENTS.md` 同时供指令级宿主（Gemini/Cursor/Jules 等）零成本复用。

## 安装

**Claude Code：**

```
/plugin marketplace add piggona/arch-check
/plugin install arch-check@arch-check
```

**Codex：**

```
codex plugin marketplace add piggona/arch-check
codex plugin add arch-check@arch-check
```

**本地试跑（免发布）：**

```bash
claude --plugin-dir /path/to/arch-check     # 单会话加载
npm test && npm run validate                # 跑测试与结构校验
```

## 配置（环境变量，均可选）

| 变量 | 默认 | 作用 |
|---|---|---|
| `ARCH_CHECK_WATCHER` | `hint` | 写后嗅探强度：`hint` 提醒 / `enforce` 阻断式提醒（代理自我修正）/ `off` |
| `ARCH_CHECK_ACTIVATE` | `on` | 会话启动注入开关 |

钩子需要 `node` 在 PATH 上；没有 node 时技能与命令仍可用，仅自动行为失效。

## 架构（三层，学 ponytail）

```
适配层  .claude-plugin/ · .codex-plugin/ · AGENTS.md（薄清单，只做指向）
逻辑层  hooks/arch-runtime.js（宿主探测+输出协议） · arch-activate.js · arch-watcher.js
内容层  skills/×4（arch-check 主技能、audit、debt、help）· commands/×4（md+toml 双格式）
```

## 定制成你自己的

1. **全局改名**：`grep -rl 'arch-check\|piggona\|piggona' . | xargs sed -i 's/.../.../g'`
2. **【核心】团队规则**：改 `skills/arch-check/SKILL.md` 的"内置通用原则"和
   `hooks/arch-watcher.js` 顶部的 `LAYER_PATTERNS` / `SNIFF_RULES` 两张规则表
3. **契约模板**：按你们项目改 `templates/ARCHITECTURE.md.example`，复制到目标项目根
4. **发布**：`npm run validate` 通过 → push GitHub → 用户按上面命令安装；版本号 bump 后用户才会收到更新（`node scripts/check-versions.js` 保证三清单一致）

## 测试

```bash
npm test    # node --test：钩子在各宿主环境下的输出协议、违规嗅探、容错路径
```

MIT License.
