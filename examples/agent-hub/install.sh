#!/usr/bin/env bash
# =============================================================================
# agent-hub — dsh-plugins 全家桶一键安装 + 推荐配置
#
# 作用: 把五个护栏 bundle（tracing / policy / pii / memo / rate-shield）安装到
#       指定的 dsh profile，并把推荐配置幂等地合并进该 profile 的
#       cordis.patch.yml（安全：只新增/更新属于本套件的 bundle 段落，
#       绝不改动你已有的其它插件配置）。
#
# dsh-cost-eval 是评测 CLI（不进 profile），脚本末尾附一行可选的全局安装。
#
# 用法:
#   bash install.sh                     # 默认 profile: web
#   bash install.sh smoke               # 指定 profile
#   bash install.sh web --pin <dir>     # 从本地目录取 .tgz 安装(见下方说明)
#
# 说明: dsh-tracing 的 httpUsage 网关后端在 0.2.0 才可用；若你本地还没有发到
#   npm，可先 pnpm pack 出 tgz，再用 --pin <dist-目录> 让脚本装本地版，例如:
#     bash install.sh web --pin ../dist   # 使用 ../dist/dsh-tracing-0.2.0.tgz
#
# 校验: 装完跑 `dsh --profile <p> --dump-config | grep -E 'id:|name:'` 看合并。
# =============================================================================
set -euo pipefail

PROFILE="${1:-web}"
PIN_DIR=""
# 解析 --pin 参数
_ARGS=("$@")
for ((i=1; i<${#_ARGS[@]}; i++)); do
  case "${_ARGS[$i]}" in
    --pin) PIN_DIR="${_ARGS[$((i+1))]:-}"; i=$((i+1));;
  esac
done

DSH_BIN="${DSH_BIN:-$HOME/.local/bin/dsh}"
if [ ! -x "$DSH_BIN" ]; then
  echo "✗ 找不到 dsh CLI: $DSH_BIN (可用环境变量 DSH_BIN 覆盖)" >&2
  exit 2
fi

echo "◆ dsh CLI: $DSH_BIN"
echo "◆ profile : $PROFILE"

# --- 五个护栏 bundle（install 顺序即依赖顺序） -------------------------------
declare -a BUNDLES=(dsh-tool-policy dsh-pii-gate dsh-tool-memo dsh-rate-shield dsh-tracing)

install_bundle() {
  local name="$1"
  if [ -n "$PIN_DIR" ] && [ -f "$PIN_DIR/$name"-*.tgz ]; then
    local tgz
    tgz=$(ls "$PIN_DIR/$name"-*.tgz 2>/dev/null | head -1)
    echo "► add $name <- local $tgz"
    "$DSH_BIN" plugin --profile "$PROFILE" add "$tgz"
  else
    echo "► add $name (npm)"
    "$DSH_BIN" plugin --profile "$PROFILE" add "$name"
  fi
}

for b in "${BUNDLES[@]}"; do
  install_bundle "$b"
done

# --- 幂等合并 cordis.patch.yml ------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCH_SRC="$SCRIPT_DIR/agent-hub.patch.yml"

# 定位 profile 的 cordis.patch.yml（在各常见 dsh 目录下找，取第一个存在的）
find_patch() {
  local name="$1"
  local cand
  for base in "$HOME/.dsh/profiles" "$HOME/.dsh-smoke/profiles" "$HOME/.dsh-$name/profiles"; do
    cand="$base/$name/cordis.patch.yml"
    [ -f "$cand" ] && { echo "$cand"; return 0; }
  done
  # 兜底：由 dsh 决定的位置（取 --dump-root 之类不可靠，退而让 merge 时提示）
  echo ""
}

PATCH_TARGET="$(find_patch "$PROFILE")"

_py_merge() { python3 - "$PATCH_TARGET" "$PATCH_SRC" <<'PYEOF'
import os, sys, re

target, src = sys.argv[1], sys.argv[2]
if not target or not os.path.isfile(target):
    print("✗ 未找到 profile 的 cordis.patch.yml；请手动把 agent-hub.patch.yml 合并进该 profile 的 cordis.patch.yml", file=sys.stderr)
    sys.exit(3)

TOP = re.compile(r'^\s*- id:\s*(\S+)')

def parse_items(txt):
    """把 yml 拆成顶层条目列表: [{id, lines: [...两空格缩进段落...]}]。
    段落前的 # 注释行与空行直接丢弃（不写入目标）。"""
    items, cur = [], None
    for ln in txt.split('\n'):
        m = TOP.match(ln)
        if m:
            if cur: items.append(cur)
            cur = {'id': m.group(1), 'lines': ['  - id: ' + m.group(1)]}
        elif cur is not None and ln.strip() and not ln.strip().startswith('#'):
            # 保留条目内子行（config 等），沿用原缩进；注释行丢弃
            cur['lines'].append(ln)
    if cur: items.append(cur)
    return items

new_items = parse_items(open(src, encoding='utf-8').read())
lines = open(target, encoding='utf-8').read().split('\n')

out, i, replaced = [], 0, set()
while i < len(lines):
    m = TOP.match(lines[i])
    if m:
        tid = m.group(1)
        seg = [lines[i]]; j = i + 1
        while j < len(lines) and not TOP.match(lines[j]):
            # 原段落非空、非注释子行保留
            if lines[j].strip() and not lines[j].strip().startswith('#'):
                seg.append(lines[j])
            j += 1
        repl = next((p for p in new_items if p['id'] == tid), None)
        if repl is not None:
            out.extend(repl['lines']); replaced.add(tid)
        else:
            out.extend(seg)
        i = j
    else:
        out.append(lines[i]); i += 1

# 追加 patch 有、目标没有的新条目
appended = []
for p in new_items:
    if p['id'] not in replaced:
        out.append('')
        out.extend(p['lines'])
        appended.append(p['id'])

open(target, 'w', encoding='utf-8').write('\n'.join(out) + '\n')
changed = sorted(set(replaced) | set(appended))
print(f"✓ 已幂等合并 -> {target}")
print(f"  更新/新增 bundle: {', '.join(changed) or '(本次无命中)'}")
PYEOF
}

if [ -n "$PATCH_TARGET" ]; then
  _py_merge
else
  echo "⚠ 未找到 profile 的 cordis.patch.yml —— 请复制 agent-hub.patch.yml 到对应 profile 目录后手动改名/合并。"
fi

# --- 可选：cost-eval 评测 CLI（不进 profile） -----------------------------------
echo
echo "◇ 评测 CLI (dsh-cost-eval) 默认未安装，需要时执行:"
echo "      npm i -g dsh-cost-eval"
echo "   用法: dsh-cost-eval report <run.json>  /  dsh-cost-eval gate --base a.json --candidate b.json"
echo
echo "✔ agent-hub 安装完成。验证: dsh --profile $PROFILE --dump-config | grep -E 'id:|name:'"