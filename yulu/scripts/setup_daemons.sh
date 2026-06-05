#!/usr/bin/env bash
#
# setup_daemons.sh — launchd LaunchAgent install/load + seed-step concern
# (extracted from setup.sh::install_launchagents 835-958).
#
# What changed vs the monolith:
#   D-14 / §8c  The nested install_plist definition (setup.sh 841-869) is GONE.
#               This script calls the single hoisted install_plist from
#               lib/common.sh. The §6b stable-PATH fix (no baked nvm version
#               literal in __PATH__) lives inside that hoisted helper, not here.
#   Pitfall 5   PYTHON_BIN / NODE_BIN / SCRIPT_DIR / LAUNCH_AGENTS_DIR are taken
#               via env (with safe defaults) and EXPORTED so the hoisted
#               install_plist sees them. The monolith's interactive calendar
#               prompt (842-844) moves to the orchestrator; standalone runs are
#               non-interactive and only refresh the calendar plist on upgrade if
#               it was already installed.
#
# Not touched: com.yulu.audiodaemon.plist's launch form (§8b is a Phase 2
# concern). install_plist substitutes only the tokens present in each template,
# so the audiodaemon plist (which has no __PATH__/__PYTHON__) is not regressed.
#
# Standalone-or-sourced (RESEARCH Pattern 5), idempotent: re-install + reload of a
# plist is safe (install_plist unloads first), and the seed steps are idempotent.
#
# shellcheck source=lib/common.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

# State taken via env/arg, NOT monolith globals (Pitfall 5). EXPORTED so the
# hoisted install_plist (lib/common.sh) reads the same values.
export PYTHON_BIN="${PYTHON_BIN:-$(command -v python3 || echo /usr/bin/python3)}"
export NODE_BIN="${NODE_BIN:-$(command -v node || echo /usr/local/bin/node)}"
export SCRIPT_DIR
export LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
CONFIG_DIR="${CONFIG_DIR:-$HOME/.config/yulu}"
UPGRADE_MODE="${UPGRADE_MODE:-false}"

setup_daemons() {
    local mode="${1:-release}"   # release|dev — accepted for orchestrator parity
    : "$mode"                    # daemon install is mode-agnostic

    header "安装 LaunchAgent 常驻服务"

    mkdir -p "$LAUNCH_AGENTS_DIR"

    local plist_dir="$SCRIPT_DIR"

    # Yulu.app (native system audio + mic capture). install_plist leaves any
    # tokens it doesn't recognize in this plist untouched (§8b not regressed).
    if [[ -f "$plist_dir/com.yulu.audiodaemon.plist" ]]; then
        install_plist "$plist_dir/com.yulu.audiodaemon.plist" "com.yulu.audiodaemon.plist"
        launchctl load "$LAUNCH_AGENTS_DIR/com.yulu.audiodaemon.plist" 2>/dev/null || true
        ok "audiodaemon 已加载"
    fi

    # Status agent: menu-bar recording indicator + Start Recording item.
    if [[ -f "$plist_dir/com.yulu.statusagent.plist" ]]; then
        install_plist "$plist_dir/com.yulu.statusagent.plist" "com.yulu.statusagent.plist"
        launchctl load "$LAUNCH_AGENTS_DIR/com.yulu.statusagent.plist" 2>/dev/null || true
        ok "statusagent 已加载"
    fi

    # Scheduler
    if [[ -f "$plist_dir/com.yulu.scheduler.plist" ]]; then
        install_plist "$plist_dir/com.yulu.scheduler.plist" "com.yulu.scheduler.plist"
        launchctl load "$LAUNCH_AGENTS_DIR/com.yulu.scheduler.plist" 2>/dev/null || true
        ok "scheduler 已加载"
    fi

    # Detector
    if [[ -f "$plist_dir/com.yulu.detector.plist" ]]; then
        install_plist "$plist_dir/com.yulu.detector.plist" "com.yulu.detector.plist"
        launchctl load "$LAUNCH_AGENTS_DIR/com.yulu.detector.plist" 2>/dev/null || true
        ok "detector 已加载"
    fi

    # Agent queue worker: promptly handles summary_request events via llm.command.
    if [[ -f "$plist_dir/com.yulu.agentqueue.plist" ]]; then
        install_plist "$plist_dir/com.yulu.agentqueue.plist" "com.yulu.agentqueue.plist"
        launchctl load "$LAUNCH_AGENTS_DIR/com.yulu.agentqueue.plist" 2>/dev/null || true
        ok "agentqueue 已加载"
    fi

    # STT daemon: resident mlx-whisper service + vocab cache.
    if [[ -f "$plist_dir/com.yulu.sttdaemon.plist" ]]; then
        mkdir -p "$CONFIG_DIR/logs"
        install_plist "$plist_dir/com.yulu.sttdaemon.plist" "com.yulu.sttdaemon.plist"
        launchctl load "$LAUNCH_AGENTS_DIR/com.yulu.sttdaemon.plist" 2>/dev/null || true
        ok "sttdaemon 已加载"

        # Seed vocab.sqlite from frozen snapshots (idempotent). Explicit if/else
        # (not A && B || C) so a future failing `ok` can't trigger the warn branch
        # — same behavior as the monolith, shellcheck SC2015-clean.
        info "种子词表 vocab.sqlite..."
        if PYTHONPATH="$SCRIPT_DIR" "$PYTHON_BIN" -m vocab.cli seed --from-current >/dev/null 2>&1; then
            ok "vocab seed 完成"
        else
            warn "vocab seed 失败（可稍后重试: yulu vocab seed --from-current）"
        fi

        # Seed prompts.sqlite from frozen snapshots (idempotent).
        info "种子 prompts.sqlite..."
        if PYTHONPATH="$SCRIPT_DIR" "$PYTHON_BIN" -m prompts.cli seed --from-current >/dev/null 2>&1; then
            ok "prompts seed 完成"
        else
            warn "prompts seed 失败（可稍后重试: yulu prompts seed --from-current）"
        fi

        # Bootstrap search.sqlite schema (idempotent). First `yulu search`
        # call will run a full sweep over ~/Movies/Yulu to populate it.
        info "初始化 search.sqlite..."
        if PYTHONPATH="$SCRIPT_DIR" "$PYTHON_BIN" -m search.indexer init >/dev/null 2>&1; then
            ok "search index 初始化完成（首次 yulu search 会全量索引）"
        else
            warn "search index 初始化失败（可稍后重试: yulu search --reindex）"
        fi
    fi

    # Calendar service (optional, only if gog configured). The interactive
    # "install calendar?" prompt the monolith had (842-844) is owned by the
    # orchestrator now. Standalone behavior: on upgrade, refresh the calendar
    # plist only if it was already installed (inherit the prior decision); on a
    # fresh non-interactive run, skip it (the orchestrator opts in via YULU_INSTALL_CALENDAR=1).
    if [[ -f "$plist_dir/com.yulu.calendar.plist" ]]; then
        local install_calendar=false
        if [[ "${YULU_INSTALL_CALENDAR:-}" == "1" ]]; then
            install_calendar=true
        elif [[ "$UPGRADE_MODE" == true && -f "$LAUNCH_AGENTS_DIR/com.yulu.calendar.plist" ]]; then
            install_calendar=true
        fi
        if [[ "$install_calendar" == true ]]; then
            install_plist "$plist_dir/com.yulu.calendar.plist" "com.yulu.calendar.plist"
            launchctl load "$LAUNCH_AGENTS_DIR/com.yulu.calendar.plist" 2>/dev/null || true
            ok "calendar 已加载"
        fi
    fi

    echo
    info "正在等待服务启动..."
    sleep 3
    launchctl list | grep com.yulu || true
    ok "服务已安装"
}

[[ "${BASH_SOURCE[0]}" == "${0}" ]] && setup_daemons "$@"
