#!/usr/bin/env bash
#
# setup_deps.sh — brew dependency install concern (extracted from
# setup.sh::install_deps, lines 112-141).
#
# Standalone-or-sourced (RESEARCH Pattern 5). When run directly it installs the
# Homebrew formulae Yulu needs. The interactive "继续安装？" confirmation that
# the monolith had (setup.sh 124-130) is DROPPED here — standalone invocation
# must be non-interactive (Pitfall 5); the setup.sh orchestrator owns that
# confirmation and only invokes this script once the user has consented.
#
# `brew install` is idempotent: already-installed formulae emit a one-line
# warning and exit 0, so re-running this script is safe.
#
# shellcheck source=lib/common.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

setup_deps() {
    local mode="${1:-release}"   # release|dev — accepted for orchestrator parity
    : "$mode"                    # not branched on here; deps are mode-agnostic

    header "安装系统依赖"

    echo "  将安装以下软件包："
    echo "    - ffmpeg / sox       (音频检查与备用处理)"
    echo "    - whisper-cpp        (非 MLX 转录 / fallback whisper-cli)"
    echo "    - terminal-notifier  (系统通知)"
    echo "    - steipete/tap/gogcli (Google 日历 CLI)"
    echo "    - cloudflared        (日历 webhook 隧道)"
    echo

    if ! command -v brew >/dev/null 2>&1; then
        err "未检测到 Homebrew。请先安装 Homebrew，再运行本脚本。"
        return 1
    fi

    # `brew install` is idempotent — already-installed packages emit a one-line
    # warning and exit 0.
    brew install sox ffmpeg whisper-cpp terminal-notifier 2>&1 | tail -1
    ok "音频/转录/通知工具安装完成"

    brew install steipete/tap/gogcli 2>&1 | tail -1
    ok "gog CLI 安装完成"

    brew install cloudflared 2>&1 | tail -1
    ok "cloudflared 安装完成"
}

[[ "${BASH_SOURCE[0]}" == "${0}" ]] && setup_deps "$@"
