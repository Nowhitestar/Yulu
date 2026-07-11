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
# Re-running is safe: usable host commands are reused, and a failed Homebrew
# invocation is judged by its postcondition because Homebrew can install/link a
# formula successfully before returning non-zero for an unrelated cleanup step.
#
# shellcheck source=lib/common.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

ensure_brew_command() {
    local formula="$1"
    local command_name="$2"

    if command -v "$command_name" >/dev/null 2>&1; then
        return 0
    fi

    if ! brew install "$formula"; then
        warn "brew install $formula 返回失败，正在核对实际安装结果"
    fi
    command -v "$command_name" >/dev/null 2>&1
}

setup_deps() {
    local mode="${1:-release}"   # release|dev — accepted for orchestrator parity
    : "$mode"                    # not branched on here; deps are mode-agnostic

    header "安装系统依赖"

    echo "  将安装以下软件包："
    echo "    - ffmpeg / sox       (音频检查与备用处理)"
    echo "    - terminal-notifier  (系统通知)"
    echo "    - node@24            (Yulu Host 运行时；仅在没有兼容 Node 时安装)"
    echo "    - cloudflared        (日历 webhook 隧道)"
    echo "  以下软件包仅在主机未提供可用版本时安装（复用优先）："
    echo "    - steipete/tap/gogcli (Google 日历 CLI / gog)"
    echo

    if ! command -v brew >/dev/null 2>&1; then
        err "未检测到 Homebrew。请先安装 Homebrew，再运行本脚本。"
        return 1
    fi

    # Reuse working commands. Installing one formula at a time prevents a
    # partially successful multi-formula transaction from aborting an otherwise
    # healthy upgrade, while the command postcondition still fails closed.
    if ! ensure_brew_command sox sox \
        || ! ensure_brew_command ffmpeg ffmpeg \
        || ! ensure_brew_command terminal-notifier terminal-notifier; then
        err "音频/通知工具安装失败"
        return 1
    fi
    ok "音频/通知工具安装完成"

    # better-sqlite3 is compiled for the Host's Node ABI. Reuse a supported
    # Node only when it satisfies the shared Vite/native-runtime policy.
    local compatible_node=""
    compatible_node="$(compatible_node_bin || true)"
    if [[ -n "$compatible_node" ]]; then
        ok "检测到兼容 Node（$($compatible_node -v)），跳过 brew install node@24"
    else
        if ! brew install node@24; then
            warn "brew install node@24 返回失败，正在核对实际安装结果"
        fi
        compatible_node="$(compatible_node_bin || true)"
        if [[ -z "$compatible_node" ]]; then
            err "Node 24 Host 运行时安装失败"
            return 1
        fi
        ok "Node 24 Host 运行时安装完成"
    fi

    # REUSE-01 / D-04 / D-05: gate the gog CLI the same way (gog probe added in Task 1).
    # Same strict ==usable rule; absent/unverified install steipete/tap/gogcli.
    if [[ "$(capability_status gog)" == "usable" ]]; then
        ok "检测到可用的 gog（复用主机的），跳过 brew install steipete/tap/gogcli"
    else
        if ! brew install steipete/tap/gogcli; then
            warn "brew install steipete/tap/gogcli 返回失败，正在核对实际安装结果"
        fi
        if [[ "$(capability_status gog)" != "usable" ]]; then
            err "gog CLI 安装失败"
            return 1
        fi
        ok "gog CLI 安装完成"
    fi

    if ! ensure_brew_command cloudflared cloudflared; then
        err "cloudflared 安装失败"
        return 1
    fi
    ok "cloudflared 安装完成"
}

[[ "${BASH_SOURCE[0]}" == "${0}" ]] && setup_deps "$@"
