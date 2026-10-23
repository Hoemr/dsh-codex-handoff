#!/usr/bin/env bash
# dsh-codex-handoff 安装脚本
#
#   默认         → Codex skill + `bridge` 命令
#   --with-plugin → 再装 DSH 原生插件（codex_task / codex_send / codex_threads）
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BRIDGE="$ROOT/bin/bridge.mjs"
SKILL_SRC="$ROOT/skills/dsh-bridge/SKILL.md"
SKILL_DIR="$HOME/.codex/skills/dsh-bridge"
BIN_DIR="$HOME/.local/bin"
STATE_DIR="${DSH_BRIDGE_HOME:-$HOME/.codex-dsh-bridge}"
DSH_BIN="${DSH_BIN:-/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh}"
PROFILE="${DSH_PROFILE_NAME:-desktop}"
WITH_PLUGIN=0

usage() {
  cat <<'EOF'
用法: ./install.sh [--with-plugin] [--profile=<name>]

  --with-plugin       同时把 DSH 插件装进 profile（默认 desktop）
  --profile=<name>    DSH profile 名（desktop / web / 自定义）
环境变量:
  DSH_BIN             dsh CLI 路径（默认 macOS 应用内路径）
  DSH_PROFILE_NAME    等价于 --profile
  DSH_BRIDGE_HOME     状态目录（默认 ~/.codex-dsh-bridge）
EOF
}

for arg in "$@"; do
  case "$arg" in
    --with-plugin) WITH_PLUGIN=1 ;;
    --profile=*) PROFILE="${arg#--profile=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "未知参数: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

echo "==> 检查 Codex 目录"
if [ ! -d "$HOME/.codex" ]; then
  echo "找不到 ~/.codex，先安装并运行一次 Codex CLI 再安装。" >&2
  exit 1
fi

echo "==> 安装 Codex skill 到 $SKILL_DIR"
mkdir -p "$SKILL_DIR"
cp "$SKILL_SRC" "$SKILL_DIR/SKILL.md"

echo "==> 链接命令到 $BIN_DIR/dsh-bridge"
mkdir -p "$BIN_DIR"
chmod +x "$BRIDGE"
ln -sf "$BRIDGE" "$BIN_DIR/dsh-bridge"
# 清理旧版命令名（仅当它确实指向本仓库时）
if [ -L "$BIN_DIR/bridge" ] && [ "$(readlink "$BIN_DIR/bridge")" = "$BRIDGE" ]; then
  rm -f "$BIN_DIR/bridge"
fi

mkdir -p "$STATE_DIR" "$STATE_DIR/runs" "$STATE_DIR/logs"

echo "==> 体检"
"$BRIDGE" doctor || true

if [ "$WITH_PLUGIN" = "1" ]; then
  echo "==> 安装 DSH 插件到 profile: $PROFILE"
  if [ ! -x "$DSH_BIN" ]; then
    echo "找不到 dsh CLI：$DSH_BIN（用 DSH_BIN=... 指定）" >&2
  else
    "$DSH_BIN" plugin --profile "$PROFILE" add "$ROOT"
    echo "    已写入 profile（重启 DSH 后生效）"
  fi
fi

cat <<EOF

安装完成。

  dsh-bridge 命令：${BIN_DIR}/dsh-bridge
  Codex skill：${SKILL_DIR}/SKILL.md（Codex 重启或新开会话后生效）
  状态目录：${STATE_DIR}
$( [ "$WITH_PLUGIN" = "1" ] && echo "  DSH 插件：dsh-codex-handoff → profile ${PROFILE}（已安装，重启 DSH 生效）" )

试一次（任意目录）：
  dsh-bridge doctor
  dsh-bridge ask --notify off "用一句话说明你能做什么"

从 Codex 里派发（Codex 会自动带上 CODEX_THREAD_ID）：
  dsh-bridge ask --background -- "把 <任务> 做完并给出结论"

还没装 DSH 插件：
  ./install.sh --with-plugin
  ./install.sh --with-plugin --profile=web

卸载：
  rm -rf "$SKILL_DIR" "$BIN_DIR/dsh-bridge" "$STATE_DIR"
  "$DSH_BIN" plugin --profile ${PROFILE} remove dsh-codex-handoff
EOF
