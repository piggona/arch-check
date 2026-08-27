#!/bin/sh
# 本地校验：JSON 语法 + 版本一致性 + 结构约定 + SKILL.md frontmatter 完整性
set -e
cd "$(dirname "$0")/.."

fail=0
ok()  { echo "  ✔ $1"; }
bad() { echo "  ✘ $1"; fail=1; }

echo "[1/4] JSON 清单语法"
for f in .claude-plugin/plugin.json .claude-plugin/marketplace.json \
         .codex-plugin/plugin.json hooks/hooks.json package.json; do
  if python3 -m json.tool "$f" > /dev/null 2>&1; then ok "$f"; else bad "$f 不是合法 JSON"; fi
done

echo "[2/4] 版本一致性"
node scripts/check-versions.js && ok "版本一致" || bad "版本不一致"

echo "[3/4] 组件目录约定（在插件根，不在 .claude-plugin/ 内）"
for d in skills commands hooks agents; do
  [ -d "$d" ] && ok "$d/" || bad "缺 $d/"
done
[ -d .claude-plugin/skills ] && bad "组件误放进 .claude-plugin/" || ok "目录位置正确"

echo "[4/4] SKILL.md frontmatter"
for s in skills/*/SKILL.md; do
  if head -1 "$s" | grep -q '^---$' && grep -q '^name:' "$s" && grep -q 'description:' "$s"; then
    ok "$s"
  else
    bad "$s 缺 frontmatter（name/description）"
  fi
done

echo
[ "$fail" -eq 0 ] && echo "全部通过。" || { echo "存在问题，见上方 ✘。"; exit 1; }
