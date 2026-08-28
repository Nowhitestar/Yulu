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
#               Calendar polling is now a core installed service. Choosing the
#               advanced gog source remains an explicit, separate decision.
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

    # Retired executors must be removed on upgrade so they cannot race the Host
    # task store or duplicate Host-owned recording work.
    local obsolete label
    local retire_failed=false
    local launch_domain
    launch_domain="gui/$(id -u)"
    for obsolete in com.yulu.agentqueue.plist com.yulu.sttdaemon.plist; do
        label="${obsolete%.plist}"
        # Boot out by service label first: the job can remain loaded even when
        # its plist was already deleted. Keep unload/remove as compatibility
        # fallbacks for older launchctl behavior.
        launchctl bootout "$launch_domain/$label" 2>/dev/null || true
        if [[ -f "$LAUNCH_AGENTS_DIR/$obsolete" ]]; then
            launchctl unload "$LAUNCH_AGENTS_DIR/$obsolete" 2>/dev/null || true
        fi
        launchctl remove "$label" 2>/dev/null || true
        rm -f "$LAUNCH_AGENTS_DIR/$obsolete"
        ok "legacy $label 已请求卸载"
    done
    pkill -f "agent_queue_worker.py" 2>/dev/null || true
    pkill -f "stt_daemon" 2>/dev/null || true
    # Phase 13 retired the legacy Google webhook/tunnel path. Stop only the
    # exact Yulu quick-tunnel command left by an interrupted older service;
    # preserve .watch_state.json as inert audit history.
    pkill -f "cloudflared tunnel --url http://localhost:8899" 2>/dev/null || true
    local loaded_labels
    loaded_labels="$(launchctl list 2>/dev/null | awk 'NF { print $NF }')" || {
        err "无法通过 launchctl list 验证 legacy LaunchAgent 状态"
        return 1
    }
    for obsolete in com.yulu.agentqueue.plist com.yulu.sttdaemon.plist; do
        label="${obsolete%.plist}"
        if grep -Fqx "$label" <<<"$loaded_labels"; then
            err "legacy $label 仍处于加载状态，停止安装以避免重复执行"
            retire_failed=true
        fi
    done
    [[ "$retire_failed" == false ]] || return 1
    rm -f \
        "$CONFIG_DIR/stt_daemon.sock" \
        "$CONFIG_DIR/stt_daemon.pid" \
        "$CONFIG_DIR/dictation/realtime.pid"

    # Yulu.app (native system audio + mic capture). install_plist leaves any
    # tokens it doesn't recognize in this plist untouched (§8b not regressed).
    if [[ -f "$plist_dir/com.yulu.audiodaemon.plist" ]]; then
        install_plist "$plist_dir/com.yulu.audiodaemon.plist" "com.yulu.audiodaemon.plist" || return 1
        if ! launchctl load "$LAUNCH_AGENTS_DIR/com.yulu.audiodaemon.plist" 2>/dev/null; then
            err "audiodaemon LaunchAgent 加载失败"
            return 1
        fi
        ok "audiodaemon 已加载"
    else
        err "com.yulu.audiodaemon.plist 缺失"
        return 1
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

    # Vocab and prompt data are deterministic context inputs for Agent-owned
    # dictation; search remains the local recording index. None require an STT
    # daemon, so seed them independently.
    info "种子词表 vocab.sqlite..."
    if PYTHONPATH="$SCRIPT_DIR" "$PYTHON_BIN" -m vocab.cli seed --from-current >/dev/null 2>&1; then
        ok "vocab seed 完成"
    else
        warn "vocab seed 失败（可稍后重试: yulu vocab seed --from-current）"
    fi

    info "种子 prompts.sqlite..."
    if PYTHONPATH="$SCRIPT_DIR" "$PYTHON_BIN" -m prompts.cli seed --from-current >/dev/null 2>&1; then
        ok "prompts seed 完成"
    else
        warn "prompts seed 失败（可稍后重试: yulu prompts seed --from-current）"
    fi

    info "初始化 search.sqlite..."
    if PYTHONPATH="$SCRIPT_DIR" "$PYTHON_BIN" -m search.indexer init >/dev/null 2>&1; then
        ok "search index 初始化完成（首次 yulu search 会全量索引）"
    else
        warn "search index 初始化失败（可稍后重试: yulu search --reindex）"
    fi

    # Calendar polling is part of the core Yulu runtime for the recommended
    # macOS EventKit source. The optional gog CLI/OAuth path is configured
    # separately and is never required to install or start this service.
    if [[ -f "$plist_dir/com.yulu.calendar.plist" ]]; then
        local calendar_dest="$LAUNCH_AGENTS_DIR/com.yulu.calendar.plist"
        local calendar_backup=""
        local calendar_was_loaded=false
        if grep -Fqx "com.yulu.calendar" <<<"$loaded_labels"; then
            calendar_was_loaded=true
        fi
        if [[ -f "$calendar_dest" ]]; then
            calendar_backup="$(mktemp "$LAUNCH_AGENTS_DIR/.com.yulu.calendar.plist.backup.XXXXXX")" || return 1
            if ! cp "$calendar_dest" "$calendar_backup"; then
                rm -f "$calendar_backup"
                err "calendar LaunchAgent 备份失败"
                return 1
            fi
        fi
        local calendar_activation_ok=false
        local calendar_activation_error="calendar LaunchAgent 加载失败"
        if install_plist "$plist_dir/com.yulu.calendar.plist" "com.yulu.calendar.plist" \
            && launchctl load "$calendar_dest" 2>/dev/null; then
            if launchctl list 2>/dev/null \
                | awk '$3 == "com.yulu.calendar" && $1 ~ /^[0-9]+$/ && $1 > 0 { found=1 } END { exit !found }'; then
                calendar_activation_ok=true
            else
                calendar_activation_error="calendar LaunchAgent 加载后未运行"
            fi
        fi
        if [[ "$calendar_activation_ok" != true ]]; then
            # `launchctl load` can return non-zero after partially registering
            # the new job. Remove by label before deleting/restoring its plist,
            # then prove the failed registration is gone.
            launchctl bootout "$launch_domain/com.yulu.calendar" 2>/dev/null || true
            launchctl remove "com.yulu.calendar" 2>/dev/null || true
            local calendar_cleanup_labels
            calendar_cleanup_labels="$(launchctl list 2>/dev/null | awk 'NF { print $NF }')" || {
                err "无法验证 calendar LaunchAgent 残留状态"
                return 1
            }
            if grep -Fqx "com.yulu.calendar" <<<"$calendar_cleanup_labels"; then
                err "calendar LaunchAgent 加载失败且残留注册无法移除"
                return 1
            fi
            rm -f "$calendar_dest"
            if [[ -n "$calendar_backup" && -f "$calendar_backup" ]]; then
                if ! mv "$calendar_backup" "$calendar_dest"; then
                    err "旧 calendar LaunchAgent plist 回滚失败"
                    return 1
                fi
                if [[ "$calendar_was_loaded" == true ]]; then
                    if ! launchctl load "$calendar_dest" 2>/dev/null; then
                        err "旧 calendar LaunchAgent 回滚后重新加载失败"
                        return 1
                    fi
                    if ! launchctl list 2>/dev/null \
                        | awk '$3 == "com.yulu.calendar" && $1 ~ /^[0-9]+$/ && $1 > 0 { found=1 } END { exit !found }'; then
                        err "旧 calendar LaunchAgent 回滚后未恢复运行"
                        return 1
                    fi
                    ok "旧 calendar LaunchAgent 已恢复并重新加载"
                else
                    ok "旧 calendar LaunchAgent plist 已恢复（先前未加载）"
                fi
            fi
            err "$calendar_activation_error"
            return 1
        fi
        [[ -z "$calendar_backup" ]] || rm -f "$calendar_backup"
        ok "calendar 已加载"
    else
        err "com.yulu.calendar.plist 缺失"
        return 1
    fi

    echo
    info "正在等待服务启动..."
    sleep 3
    launchctl list | grep com.yulu || true
    ok "服务已安装"
}

[[ "${BASH_SOURCE[0]}" == "${0}" ]] && setup_daemons "$@"
