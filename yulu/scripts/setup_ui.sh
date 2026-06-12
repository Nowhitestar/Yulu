#!/usr/bin/env bash
#
# setup_ui.sh — yulu_ui build + LaunchAgent install concern (extracted from
# setup.sh::install_yulu_ui 1022-1111).
#
# Standalone-or-sourced (RESEARCH Pattern 5). Idempotent: the lockfile/runtime
# marker skips `npm ci` only when package-lock.json and installed deps are valid.
#
# KEY CHANGE vs the monolith: the §8c inline-duplicated install_plist
# (setup.sh 1079-1088 — whose own comment admitted it existed only "so we don't
# rely on shell-function scoping") is REPLACED by the hoisted
# lib/common.sh::install_plist. The lib hoist removes that excuse (D-14).
#
# State ($PYTHON_BIN / $NODE_BIN / $LAUNCH_AGENTS_DIR) is taken via env with
# defaults, NOT monolith globals, so `set -u` standalone runs don't crash
# (Pitfall 5). install_plist reads these from the exported env.
#
# shellcheck source=lib/common.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

# State via env/arg, NOT monolith globals (Pitfall 5). Exported so the hoisted
# install_plist (which reads them from the environment) sees the same values.
export PYTHON_BIN="${PYTHON_BIN:-$(command -v python3 || echo /usr/bin/python3)}"
export NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
export LAUNCH_AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
export SCRIPT_DIR

compatible_node_bin() {
    local candidate
    local node_major
    local candidates=()
    if [[ -n "${NODE_BIN:-}" ]]; then
        candidates+=("$NODE_BIN")
    fi
    if command -v node >/dev/null 2>&1; then
        candidates+=("$(command -v node)")
    fi
    candidates+=(
        "$HOME"/.nvm/versions/node/v20*/bin/node
        "$HOME"/.nvm/versions/node/v22*/bin/node
        /opt/homebrew/opt/node@20/bin/node
        /opt/homebrew/opt/node@22/bin/node
        /usr/local/opt/node@20/bin/node
        /usr/local/opt/node@22/bin/node
    )

    for candidate in "${candidates[@]}"; do
        [[ -x "$candidate" ]] || continue
        node_major="$("$candidate" -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
        if [[ -n "$node_major" && "$node_major" -ge 20 && "$node_major" -le 22 ]]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

ui_node_modules_ready() {
    local ui_dir="$1"
    (
        cd "$ui_dir" && "$NODE_BIN" -e "
            require.resolve('hono');
            require.resolve('@trpc/server');
            require.resolve('@trpc/server/adapters/fetch');
            require.resolve('vite');
            require.resolve('esbuild');
        "
    ) >/dev/null 2>&1
}

setup_ui() {
    local mode="${1:-release}"   # release|dev — accepted for orchestrator parity
    : "$mode"                    # ui build is mode-agnostic

    header "构建 + 安装 yulu_ui (本地 Web UI)"

    local ui_dir="$SCRIPT_DIR/yulu_ui"
    if [[ ! -d "$ui_dir" ]]; then
        warn "yulu_ui/ 不存在于 ${ui_dir}，跳过"
        return
    fi

    local resolved_node
    if ! resolved_node="$(compatible_node_bin)"; then
        warn "未检测到兼容的 Node；yulu_ui 是可选组件，跳过安装。"
        warn "  需要 Node 20 或 22；当前默认 node: $(node -v 2>/dev/null || echo 'not found')"
        warn "  以后想装：brew install node@22 && NODE_BIN=\$(brew --prefix node@22)/bin/node bash $SCRIPT_DIR/setup_ui.sh"
        return
    fi
    export NODE_BIN="$resolved_node"
    local node_dir
    node_dir="$(dirname "$NODE_BIN")"
    local npm_bin="${NPM_BIN:-$node_dir/npm}"
    if [[ ! -x "$npm_bin" ]]; then
        npm_bin="$(command -v npm || true)"
    fi
    if [[ -z "$npm_bin" || ! -x "$npm_bin" ]]; then
        warn "未检测到 npm；yulu_ui 是可选组件，跳过安装。"
        return
    fi
    export PATH="$node_dir:$PATH"

    local node_major
    node_major="$("$NODE_BIN" -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ -z "$node_major" || "$node_major" -lt 20 || "$node_major" -gt 22 ]]; then
        warn "node 版本不兼容（$("$NODE_BIN" -v 2>/dev/null || echo 'unknown')），yulu_ui 需要 Node 20 或 22。跳过。"
        return
    fi
    ok "Node $("$NODE_BIN" -v) 满足 yulu_ui 要求"

    # Idempotency marker: skip npm ci only when the lockfile, Node ABI, and a
    # small module-resolution probe all agree that node_modules is usable.
    local lock="$ui_dir/package-lock.json"
    local marker="$ui_dir/node_modules/.yulu-built-from"
    local lock_sha=""
    if [[ -f "$lock" ]]; then
        lock_sha="$(shasum -a 256 "$lock" | cut -d' ' -f1)"
    fi
    local node_runtime_key
    node_runtime_key="$("$NODE_BIN" -p "process.platform + ':' + process.arch + ':modules' + process.versions.modules" 2>/dev/null || "$NODE_BIN" -v)"
    local marker_value="${lock_sha}:${node_runtime_key}"
    if [[ -f "$marker" ]] && [[ "$(cat "$marker" 2>/dev/null)" == "$marker_value" ]] && ui_node_modules_ready "$ui_dir"; then
        info "npm ci 已是最新（lockfile / Node ABI / 依赖完整性均通过），跳过依赖安装"
    else
        info "运行 npm ci (这一步可能需要 30-60 秒)..."
        ( cd "$ui_dir" && "$npm_bin" ci ) || { err "npm ci 失败"; return 1; }
        printf '%s' "$marker_value" > "$marker"
        ok "依赖已安装"
    fi

    info "运行 npm run build..."
    ( cd "$ui_dir" && "$npm_bin" run build ) || { err "npm run build 失败"; return 1; }
    ok "yulu_ui dist/ 已生成"

    if [[ ! -s "$ui_dir/dist/server.js" || ! -s "$ui_dir/dist/web/index.html" ]]; then
        err "build 产物不完整：dist/server.js 或 dist/web/index.html 缺失"
        return 1
    fi

    # Install + load LaunchAgent via the HOISTED install_plist (lib/common.sh),
    # replacing the §8c inline duplicate the monolith carried (D-14). The helper
    # substitutes the plist tokens (including the §6b stable __PATH__) from the
    # exported PYTHON_BIN/NODE_BIN/SCRIPT_DIR/LAUNCH_AGENTS_DIR.
    local plist_src="$SCRIPT_DIR/com.yulu.ui.plist"
    if [[ ! -f "$plist_src" ]]; then
        warn "com.yulu.ui.plist 不存在于 ${plist_src}，跳过 launchd 安装"
        return
    fi

    install_plist "$plist_src" "com.yulu.ui.plist"
    launchctl load "$LAUNCH_AGENTS_DIR/com.yulu.ui.plist" 2>/dev/null \
        || warn "launchctl load com.yulu.ui 失败"
    ok "com.yulu.ui.plist 已安装并 load"

    # Verify /healthz within ~10s wall time. We drop --max-time because curl
    # against a closed local port returns "connection refused" instantly; on
    # the rare case the port is open but the request hangs, --max-time 1 would
    # have stretched our budget to ~30s. The 0.5s sleep is our sole pacing.
    info "等待 yulu_ui 启动 (最多 10 秒)..."
    local i=0
    local healthy=false
    while [[ $i -lt 20 ]]; do
        if curl -s "http://127.0.0.1:7777/healthz" 2>/dev/null | grep -q '"status":"ok"'; then
            healthy=true
            break
        fi
        sleep 0.5
        i=$((i + 1))
    done
    if [[ "$healthy" == true ]]; then
        ok "yulu_ui 健康检查通过：http://127.0.0.1:7777/"
    else
        warn "yulu_ui 未在 10 秒内响应 /healthz；查看 ~/.config/yulu/ui.log"
    fi
}

[[ "${BASH_SOURCE[0]}" == "${0}" ]] && setup_ui "$@"
