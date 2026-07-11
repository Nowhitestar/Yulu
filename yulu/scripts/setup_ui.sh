#!/usr/bin/env bash
#
# setup_ui.sh — yulu_ui runtime dependency + LaunchAgent install concern.
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
        "$HOME"/.nvm/versions/node/v24*/bin/node
        /opt/homebrew/opt/node@20/bin/node
        /opt/homebrew/opt/node@22/bin/node
        /opt/homebrew/opt/node@24/bin/node
        /usr/local/opt/node@20/bin/node
        /usr/local/opt/node@22/bin/node
        /usr/local/opt/node@24/bin/node
    )

    for candidate in "${candidates[@]}"; do
        [[ -x "$candidate" ]] || continue
        node_major="$("$candidate" -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
        if [[ -n "$node_major" && "$node_major" -ge 20 && "$node_major" -le 24 ]]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    return 1
}

ui_runtime_modules_ready() {
    local ui_dir="$1"
    (
        cd "$ui_dir" && "$NODE_BIN" -e "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close();"
    ) >/dev/null 2>&1
}

ui_dev_modules_ready() {
    local ui_dir="$1"
    ui_runtime_modules_ready "$ui_dir" || return 1
    (
        cd "$ui_dir" && "$NODE_BIN" -e "require.resolve('vite'); require.resolve('esbuild');"
    ) >/dev/null 2>&1
}

ui_dist_ready() {
    local ui_dir="$1"
    [[ -s "$ui_dir/dist/server.js" && -s "$ui_dir/dist/web/index.html" ]]
}

setup_ui() {
    local mode="${1:-release}"

    header "构建 + 安装 yulu_ui (本地 Web UI)"

    local ui_dir="$SCRIPT_DIR/yulu_ui"
    if [[ ! -d "$ui_dir" ]]; then
        err "核心 Host 目录 yulu_ui/ 不存在于 ${ui_dir}"
        return 1
    fi
    if [[ "$mode" == "release" ]] && ! ui_dist_ready "$ui_dir"; then
        err "正式 release 缺少 CI 预构建的 dist/server.js 或 dist/web/index.html"
        return 1
    fi

    local resolved_node
    if ! resolved_node="$(compatible_node_bin)"; then
        err "未检测到兼容的 Node；持久化 Host 无法启动。"
        err "需要 Node 20、22 或 24；当前默认 node: $(node -v 2>/dev/null || echo 'not found')"
        return 1
    fi
    export NODE_BIN="$resolved_node"
    local node_dir
    node_dir="$(dirname "$NODE_BIN")"
    local npm_bin="${NPM_BIN:-$node_dir/npm}"
    if [[ ! -x "$npm_bin" ]]; then
        npm_bin="$(command -v npm || true)"
    fi
    if [[ -z "$npm_bin" || ! -x "$npm_bin" ]]; then
        err "未检测到 npm；持久化 Host 无法构建。"
        return 1
    fi
    export PATH="$node_dir:$PATH"

    local node_major
    node_major="$("$NODE_BIN" -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ -z "$node_major" || "$node_major" -lt 20 || "$node_major" -gt 24 ]]; then
        err "node 版本不兼容（$("$NODE_BIN" -v 2>/dev/null || echo 'unknown')），Host 需要 Node 20–24。"
        return 1
    fi
    ok "Node $("$NODE_BIN" -v) 满足 yulu_ui 要求"

    # The release payload's dist/ is covered by the signed runtime manifest and
    # must remain byte-for-byte unchanged after verification. Release setup only
    # materializes production/native dependencies; dev setup installs toolchain
    # dependencies and rebuilds dist locally.
    local lock="$ui_dir/package-lock.json"
    local marker="$ui_dir/node_modules/.yulu-built-from"
    local lock_sha=""
    if [[ -f "$lock" ]]; then
        lock_sha="$(shasum -a 256 "$lock" | cut -d' ' -f1)"
    fi
    local node_runtime_key
    node_runtime_key="$("$NODE_BIN" -p "process.platform + ':' + process.arch + ':modules' + process.versions.modules" 2>/dev/null || "$NODE_BIN" -v)"
    local marker_value="${lock_sha}:${node_runtime_key}:${mode}"
    local modules_ready=false
    if [[ "$mode" == "release" ]]; then
        ui_runtime_modules_ready "$ui_dir" && modules_ready=true
    else
        ui_dev_modules_ready "$ui_dir" && modules_ready=true
    fi
    if [[ -f "$marker" ]] && [[ "$(cat "$marker" 2>/dev/null)" == "$marker_value" ]] && [[ "$modules_ready" == true ]]; then
        info "npm ci 已是最新（lockfile / Node ABI / 依赖完整性均通过），跳过依赖安装"
    else
        info "运行 npm ci (这一步可能需要 30-60 秒)..."
        if [[ "$mode" == "release" ]]; then
            ( cd "$ui_dir" && "$npm_bin" ci --omit=dev ) || { err "npm ci --omit=dev 失败"; return 1; }
            ui_runtime_modules_ready "$ui_dir" || { err "better-sqlite3 与当前 Node ABI 不兼容"; return 1; }
        else
            ( cd "$ui_dir" && "$npm_bin" ci ) || { err "npm ci 失败"; return 1; }
            ui_dev_modules_ready "$ui_dir" || { err "yulu_ui 开发依赖或原生模块不可用"; return 1; }
        fi
        printf '%s' "$marker_value" > "$marker" || { err "无法写入 yulu_ui 依赖标记"; return 1; }
        ok "依赖已安装"
    fi

    if [[ "$mode" == "dev" ]]; then
        info "运行 npm run build..."
        ( cd "$ui_dir" && "$npm_bin" run build ) || { err "npm run build 失败"; return 1; }
        ok "yulu_ui dist/ 已生成"
    else
        info "使用 release 中经 CI 构建并由签名清单覆盖的 yulu_ui dist/"
    fi

    if ! ui_dist_ready "$ui_dir"; then
        err "build 产物不完整：dist/server.js 或 dist/web/index.html 缺失"
        return 1
    fi

    # Install + load LaunchAgent via the HOISTED install_plist (lib/common.sh),
    # replacing the §8c inline duplicate the monolith carried (D-14). The helper
    # substitutes the plist tokens (including the §6b stable __PATH__) from the
    # exported PYTHON_BIN/NODE_BIN/SCRIPT_DIR/LAUNCH_AGENTS_DIR.
    local plist_src="$SCRIPT_DIR/com.yulu.ui.plist"
    if [[ ! -f "$plist_src" ]]; then
        err "com.yulu.ui.plist 不存在于 ${plist_src}"
        return 1
    fi

    install_plist "$plist_src" "com.yulu.ui.plist" || return 1
    if ! launchctl load "$LAUNCH_AGENTS_DIR/com.yulu.ui.plist" 2>/dev/null; then
        err "launchctl load com.yulu.ui 失败"
        return 1
    fi
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
        err "Yulu Host 未在 10 秒内响应 /healthz；查看 ~/.config/yulu/ui.log"
        return 1
    fi
}

[[ "${BASH_SOURCE[0]}" == "${0}" ]] && setup_ui "$@"
