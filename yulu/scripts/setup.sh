#!/usr/bin/env bash
#
# Yulu — 交互式安装编排器 (thin orchestrator)
# Usage:
#   bash yulu/scripts/setup.sh             # fresh install (mode auto-resolved)
#   bash yulu/scripts/setup.sh --upgrade   # idempotent re-run after a `git pull`
#   bash yulu/scripts/setup.sh --dev       # force the dev fork (build from source via swiftc)
#
# D-12 — This is a THIN ORCHESTRATOR. It:
#   1. resolves the install mode ONCE (dev|release) via lib/common.sh source-detection
#      (.yulu-install.json `source` field + an explicit `--dev` override),
#   2. owns interactive prompts (deps confirm,
#      calendar opt-in, upgrade detection) and resolves them into variables/env, then
#   3. sequences the four decomposed setup_*.sh concern scripts in order, passing the
#      resolved `mode` + decisions DOWN via args/env (Pitfall 5 — no shared globals).
#
# The concern scripts (setup_deps.sh, setup_audio.sh, setup_daemons.sh,
# setup_ui.sh) each:
#   - are standalone-or-sourced under `set -uo pipefail`,
#   - accept `mode` as $1 and read decision state from env (with safe defaults),
#   - are non-interactive when invoked standalone,
#   - map 1:1 onto a future Phase 6 `yulu provision <step>` (D-12 check/apply shape).
#
# swiftc / Xcode is reached ONLY through the dev branch of setup_audio.sh (D-13 /
# BUILD-03). A release install runs with no compiler present.
#

set -uo pipefail

# ─── Arg parsing (orchestrator owns this) ────────────────────────────
UPGRADE_MODE=false
for arg in "$@"; do
    case "$arg" in
        --upgrade|-u) UPGRADE_MODE=true ;;
        --dev) : ;;  # consumed by resolve_install_mode below; no-op here
        --help|-h)
            echo "Usage: bash yulu/scripts/setup.sh [--upgrade] [--dev]"
            echo "  --upgrade   Skip steps that have already been completed (config exists,"
            echo "              OAuth granted, TCC granted, LaunchAgents loaded)."
            echo "  --dev       Force the development fork: build Yulu.app/StatusAgent.app from"
            echo "              source via swiftc (requires Xcode CLT). Default resolves from"
            echo "              .yulu-install.json (release installs use pre-built signed binaries)."
            exit 0 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_DIR="$(cd "$SKILL_DIR/.." && pwd)"
CONFIG_DIR="$HOME/.config/yulu"
GCP_DIR="$HOME/.config/gcp"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PYTHON_BIN="$(command -v python3 || echo /usr/bin/python3)"
NODE_BIN="$(command -v node || echo /usr/local/bin/node)"
LOCAL_BIN="$HOME/.local/bin"
RECORDING_DIR_DEFAULT="$HOME/Movies/Yulu"

# ─── Shared helpers (colors/log/prompt + resolve_install_mode) ───────
# lib/common.sh provides ok/warn/err/info/header/prompt and the D-13
# resolve_install_mode / detect_source readers. Sourcing is side-effect-free.
# shellcheck source=lib/common.sh
. "$SCRIPT_DIR/lib/common.sh"

# Resolve the install mode ONCE (D-12/D-13). `--dev` (anywhere in "$@") overrides;
# otherwise .yulu-install.json's `source` field decides (missing → dev checkout).
MODE="$(resolve_install_mode "$@")"

# Export the resolved decision state so the sequenced concern scripts (and the
# hoisted lib/common.sh::install_plist) read identical values via env (Pitfall 5).
export SCRIPT_DIR PYTHON_BIN NODE_BIN CONFIG_DIR LAUNCH_AGENTS_DIR
export UPGRADE_MODE

# Honor an existing config's audio.output_dir on upgrade; fall back to the new default.
RECORDING_DIR="$RECORDING_DIR_DEFAULT"
if [[ -f "$CONFIG_DIR/config.json" ]]; then
    existing_dir="$($PYTHON_BIN -c "import json,sys
try:
    print(json.load(open('$CONFIG_DIR/config.json'))['audio']['output_dir'])
except Exception:
    pass" 2>/dev/null)"
    if [[ -n "$existing_dir" ]]; then
        RECORDING_DIR="${existing_dir/#\~/$HOME}"
    fi
fi

yulu_version() {
    if [[ -f "$SCRIPT_DIR/version.py" ]]; then
        "$PYTHON_BIN" "$SCRIPT_DIR/version.py" --short 2>/dev/null || true
    elif [[ -f "$REPO_DIR/VERSION" ]]; then
        tr -d '[:space:]' < "$REPO_DIR/VERSION"
    else
        echo "unknown"
    fi
}

check_repo_layout() {
    if [[ ! -f "$SCRIPT_DIR/record_audio.py" || ! -f "$SCRIPT_DIR/audio_daemon.swift" ]]; then
        err "setup.sh 必须在完整仓库中运行，不能直接 curl | bash。"
        echo "请使用："
        echo "  git clone https://github.com/Nowhitestar/Yulu.git"
        echo "  cd Yulu"
        echo "  bash yulu/scripts/setup.sh"
        exit 1
    fi
}

# ─── Step 0: Check system ────────────────────────────

check_system() {
    header "系统检查"

    if [[ "$(uname)" != "Darwin" ]]; then
        err "此脚本仅支持 macOS"
        exit 1
    fi
    local macos_version macos_major
    macos_version="$(sw_vers -productVersion)"
    macos_major="${macos_version%%.*}"
    if [[ ! "$macos_major" =~ ^[0-9]+$ || "$macos_major" -lt 13 ]]; then
        err "Yulu 需要 macOS 13 或更高版本；当前为 $macos_version"
        exit 1
    fi
    ok "macOS $macos_version"

    if ! command -v brew &>/dev/null; then
        warn "Homebrew 未安装，正在安装..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        ok "Homebrew 已安装"
    else
        ok "Homebrew $(brew --version | head -1)"
    fi

    if command -v python3 &>/dev/null; then
        if ! python3 -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null; then
            err "Yulu 需要 Python 3.10 或更高版本；请先运行: brew install python"
            exit 1
        fi
        ok "Python $(python3 --version)"
    else
        err "Python 3 未安装，请先安装: brew install python"
        exit 1
    fi
}

# ─── Deps confirmation (orchestrator owns the prompt; setup_deps.sh installs) ─

confirm_deps_install() {
    # Returns 0 to proceed with the brew install, 1 to skip it. The interactive
    # confirmation that the monolith carried inside install_deps now lives here
    # (Pitfall 5): setup_deps.sh is non-interactive and only runs once we consent.
    header "安装系统依赖"

    echo "  将安装以下软件包："
    echo "    - ffmpeg / sox       (音频检查与备用处理)"
    echo "    - node@24            (本地 Host 运行时，已有 Node 20.19+/22.12+/24 时复用)"
    echo "    - terminal-notifier  (系统通知)"
    echo "    - steipete/tap/gogcli (Google 日历 CLI)"
    echo "    - cloudflared        (日历 webhook 隧道)"
    echo

    if [[ "$UPGRADE_MODE" != true ]]; then
        prompt "继续安装？[Y/n]"
        read -r ans
        if [[ "$ans" =~ ^[nN] ]]; then
            warn "跳过依赖安装"
            return 1
        fi
    fi
    return 0
}

# ─── Step 3: Create config ───────────────────────────

create_config() {
    header "创建配置文件"

    mkdir -p "$CONFIG_DIR"
    chmod 700 "$CONFIG_DIR"

    if [[ -f "$CONFIG_DIR/config.json" ]]; then
        chmod 600 "$CONFIG_DIR/config.json"
        if [[ "$UPGRADE_MODE" == true ]]; then
            ok "配置文件已存在，保留: $CONFIG_DIR/config.json"
        else
            warn "配置文件已存在: $CONFIG_DIR/config.json"
            prompt "覆盖？[y/N]"
            read -r ans
            if [[ ! "$ans" =~ ^[yY] ]]; then
                info "保留现有配置"
                mkdir -p "$RECORDING_DIR"
                return
            fi
        fi
        # On upgrade we still need to make sure RECORDING_DIR is honored.
        mkdir -p "$RECORDING_DIR"
        return
    fi

    cat > "$CONFIG_DIR/config.json" <<CONFIG
{
  "calendars": [
    {
      "type": "macos",
      "enabled": true,
      "watch_calendars": []
    },
    {
      "type": "google",
      "enabled": false,
      "gog_account": "",
      "watch_calendars": ["primary"]
    }
  ],
  "audio": {
    "backend": "daemon",
    "mic_device": "",
    "system_audio_device": null,
    "output_dir": "$RECORDING_DIR",
    "format": "wav",
    "silence_threshold": 0.01,
    "silence_duration_sec": 300,
    "half_duplex": true
  },
  "transcription": {
    "language": "zh",
    "dictation": {
      "language": "zh",
      "prompt_slug": "dictation-cleanup",
      "translate_prompt_slug": "dictation-translate",
      "target_language": "English",
      "context_limit": 240,
      "deadline_sec": 30,
      "timeout_sec": 30
    }
  },
  "llm": {
    "enabled": true,
    "command": null,
    "agent": {
      "provider": "hermes"
    }
  },
  "agent_pipeline": {
    "enabled": true,
    "auto_process_recordings": true,
    "auto_send_notion": false,
    "notion_destination": "Yulu Meeting",
    "hermes_serve_port": 0,
    "transcription_chunk_sec": 1200
  },
  "status_agent": {
    "enabled": true
  },
  "meeting_detection": {
    "enabled": true,
    "interval_sec": 10,
    "stable_sec": 15,
    "prompt_cooldown_sec": 1800
  }
}
CONFIG

    chmod 600 "$CONFIG_DIR/config.json"
    mkdir -p "$RECORDING_DIR"
    ok "配置文件已创建: $CONFIG_DIR/config.json"
    ok "录制目录已创建: $RECORDING_DIR"
}

# ─── Step 5: Google Calendar setup ───────────────────

setup_calendar() {
    header "Google 日历配置（可选）"

    # Upgrade fast-path: if gog already has at least one calendar-scoped account, don't
    # rerun OAuth — that's a 5-step browser dance the user will not thank us for.
    if [[ "$UPGRADE_MODE" == true ]] && command -v gog &>/dev/null; then
        if gog auth list 2>/dev/null | grep -qE "calendar"; then
            ok "Google 日历已授权（升级模式跳过 OAuth）"
            return
        fi
    fi

    echo "  Yulu 可以读取 Google 日历来自动提醒和录制会议。"
    echo "  跳过此步骤也可以使用，只是不会有日历自动同步功能。"
    echo

    prompt "配置 Google 日历？[y/N]"
    read -r ans
    if [[ ! "$ans" =~ ^[yY] ]]; then
        warn "跳过日历配置"
        return
    fi

    # Check gog
    if ! command -v gog &>/dev/null; then
        err "gog 未安装，请先运行安装步骤"
        return
    fi

    # OAuth credentials
    echo
    echo "  需要 Google Cloud OAuth 凭据："
    echo "    1. 打开 https://console.cloud.google.com/"
    echo "    2. 创建项目或选择已有项目"
    echo "    3. 启用 Google Calendar API"
    echo "    4. 凭据 → 创建凭据 → OAuth 客户端 ID → 桌面应用"
    echo "    5. 下载 JSON 文件"
    echo

    prompt "请输入 client_secret.json 的路径（或拖入终端）:"
    read -r cred_path
    cred_path="${cred_path/#\~/$HOME}"
    cred_path="$(eval echo "$cred_path")"

    if [[ ! -f "$cred_path" ]]; then
        err "文件不存在: $cred_path"
        return
    fi

    mkdir -p "$GCP_DIR"
    cp "$cred_path" "$GCP_DIR/client_secret.json"
    ok "凭据已保存到 $GCP_DIR/client_secret.json"

    # gog auth
    echo
    gog auth credentials "$GCP_DIR/client_secret.json"
    ok "gog 凭据已注册"

    prompt "请输入你的 Google 邮箱 (如 user@example.com):"
    read -r email

    echo
    info "即将打开浏览器进行 OAuth 授权..."
    echo "  授权后浏览器可能会显示「无法连接」，这是正常的。"
    echo "  切换到终端，gog 会自动完成授权。"
    echo

    gog auth add "$email" --services calendar

    # Verify
    info "验证日历访问..."
    gog auth list
    ok "gog 授权完成"

    # Update config
    local tmp
    tmp=$(mktemp)
    python3 -c "
import json
cfg = json.load(open('$CONFIG_DIR/config.json'))
for cal in cfg.get('calendars', []):
    if cal.get('type') == 'google':
        cal['enabled'] = True
        cal['gog_account'] = '$email'
json.dump(cfg, open('$tmp', 'w'), indent=2, ensure_ascii=False)
" 2>/dev/null
    mv "$tmp" "$CONFIG_DIR/config.json"
    ok "配置文件已更新"

    # Test
    echo
    info "测试日历读取..."
    gog calendar events "$email" --from "$(date -u +%Y-%m-%dT00:00:00Z)" --to "$(date -u -v+1d +%Y-%m-%dT00:00:00Z)" 2>&1
    ok "日历读取成功"

    # Signal that the calendar LaunchAgent should be installed by setup_daemons.sh.
    YULU_INSTALL_CALENDAR=1
    export YULU_INSTALL_CALENDAR
}

# Calendar-plist opt-in prompt (the monolith asked this inside install_launchagents;
# the orchestrator owns it now and passes YULU_INSTALL_CALENDAR=1 to setup_daemons.sh).
confirm_calendar_plist() {
    [[ -f "$SCRIPT_DIR/com.yulu.calendar.plist" ]] || return 0
    # Already opted in during setup_calendar (fresh OAuth) → keep it.
    [[ "${YULU_INSTALL_CALENDAR:-}" == "1" ]] && return 0
    # On upgrade, setup_daemons.sh inherits the prior decision; no prompt needed.
    [[ "$UPGRADE_MODE" == true ]] && return 0

    prompt "安装日历同步服务（Native Scheduler，用于提醒/自动录制）？[Y/n]"
    read -r ans
    if [[ ! "$ans" =~ ^[nN] ]]; then
        YULU_INSTALL_CALENDAR=1
        export YULU_INSTALL_CALENDAR
    fi
}

# ─── Step 7: Install yulu CLI shim ─────────────────

install_yulu_cli() {
    header "安装 yulu 命令行入口"

    local cli_src="$SCRIPT_DIR/yulu"
    local cli_dest="$LOCAL_BIN/yulu"

    if [[ ! -f "$cli_src" ]]; then
        warn "未找到 yulu CLI 脚本（${cli_src}），跳过"
        return
    fi

    mkdir -p "$LOCAL_BIN"
    chmod +x "$cli_src"
    ln -sf "$cli_src" "$cli_dest"
    ok "yulu CLI: $cli_dest → $cli_src"

    if ! echo "$PATH" | tr ':' '\n' | grep -qx "$LOCAL_BIN"; then
        echo
        warn "$LOCAL_BIN 不在你当前 shell 的 PATH 里。"
        echo "  把下面这行加到 ~/.zshrc 或 ~/.bashrc，重开终端后即可使用 yulu 命令："
        echo "    export PATH=\"\$HOME/.local/bin:\$PATH\""
    fi
}

# ─── One-time data migration: voicemails → meetings (idempotent) ──────
# The voicemail concept was removed; legacy `<data_dir>/voicemails/` recordings
# are merged into the root meetings store and renamed voicemail_* → Memo_*. The
# migrator is a no-op when there is no voicemails/ dir, so it is safe to run on
# every upgrade. It also runs one search-index sweep so moved files re-index as
# meetings and the stale voicemails/ rows are reconciled away.
migrate_unify_voicemails() {
    [[ -f "$SCRIPT_DIR/migrate/voicemail_unify.py" ]] || return 0
    header "迁移：合并旧版 voicemail 录音到会议（voicemail_* → Memo_*）"
    PYTHONPATH="$SCRIPT_DIR:${PYTHONPATH:-}" "$PYTHON_BIN" -m migrate.voicemail_unify \
        --data-dir "$RECORDING_DIR" --apply || warn "voicemail 合并迁移返回非零（详见上方输出）"
}

# ─── Step 8: Test ────────────────────────────────────

run_tests() {
    header "功能验证"

    local passed=0
    local warned=0
    local skipped=0

    verify_ok() {
        ok "$1"
        passed=$((passed + 1))
    }

    verify_warn() {
        warn "$1"
        warned=$((warned + 1))
    }

    verify_skip() {
        info "$1"
        skipped=$((skipped + 1))
    }

    echo "  - CLI 入口"
    if [[ -x "$LOCAL_BIN/yulu" ]]; then
        verify_ok "yulu CLI 已安装: $LOCAL_BIN/yulu"
    else
        verify_warn "yulu CLI 未安装或不可执行: $LOCAL_BIN/yulu"
    fi

    echo "  - 版本"
    if "$PYTHON_BIN" "$SCRIPT_DIR/version.py" --check >/tmp/yulu-version-test.$$ 2>&1; then
        verify_ok "$(cat /tmp/yulu-version-test.$$)"
    else
        verify_warn "版本信息异常: $(cat /tmp/yulu-version-test.$$ 2>/dev/null)"
    fi
    rm -f /tmp/yulu-version-test.$$

    echo "  - 检测器"
    local detect_result
    detect_result=$("$PYTHON_BIN" "$SCRIPT_DIR/meeting_detector.py" once 2>&1 || true)
    local detect_summary
    detect_summary=$(echo "$detect_result" | "$PYTHON_BIN" -c 'import json,sys; d=json.load(sys.stdin); print("active={} windows={}".format(d.get("active"), len(d.get("windows") or [])))' 2>/dev/null || true)
    if [[ -n "$detect_summary" ]]; then
        verify_ok "检测器可运行（${detect_summary}）"
    else
        verify_warn "检测器异常: $detect_result"
    fi

    echo "  - 日历"
    local calendar_enabled
    calendar_enabled=$("$PYTHON_BIN" - <<PY
import json
from pathlib import Path
try:
    cfg = json.loads(Path("$CONFIG_DIR/config.json").read_text())
    print("yes" if any(c.get("enabled") for c in cfg.get("calendars", [])) else "no")
except Exception:
    print("no")
PY
)
    if [[ "$calendar_enabled" == "yes" ]]; then
        if "$PYTHON_BIN" "$SCRIPT_DIR/check_meetings.py" today >/tmp/yulu-calendar-test.$$ 2>&1; then
            verify_ok "日历读取正常"
        else
            verify_warn "日历读取异常: $(cat /tmp/yulu-calendar-test.$$ 2>/dev/null)"
        fi
        rm -f /tmp/yulu-calendar-test.$$
    else
        verify_skip "日历未启用，跳过"
    fi

    echo "  - Yulu 录音 daemon"
    local audio_status
    audio_status=$(echo '{"action":"status"}' | nc -w 2 -U "$HOME/.config/yulu/audio_daemon.sock" 2>/dev/null || true)
    if echo "$audio_status" | grep -q '"sysReady":true' && echo "$audio_status" | grep -q '"micReady":true'; then
        verify_ok "Yulu 运行正常"
    else
        verify_warn "Yulu daemon 未 ready: ${audio_status:-无响应}"
    fi

    echo "  - 通知"
    if command -v terminal-notifier &>/dev/null; then
        if terminal-notifier -title "Yulu" -message "安装完成！" -sound default 2>/dev/null; then
            verify_ok "通知测试通过"
        else
            verify_warn "通知命令存在，但发送失败"
        fi
    else
        verify_skip "terminal-notifier 未安装，跳过通知测试"
    fi

    echo
    if [[ "$warned" -eq 0 ]]; then
        ok "安装验证完成：$passed 通过，$skipped 跳过"
    else
        warn "安装验证完成：$passed 通过，$warned 警告，$skipped 跳过"
    fi
}

# ─── Summary ─────────────────────────────────────────

show_summary() {
    if [[ "$UPGRADE_MODE" == true ]]; then
        header "升级完成 🎉"
    else
        header "安装完成 🎉"
    fi

    echo "  Yulu 已安装并运行："
    echo
    echo "  🏷️  版本: $(yulu_version)"
    echo "  📁 配置目录: $CONFIG_DIR"
    echo "  📁 录制目录: $RECORDING_DIR"
    echo "  📁 项目路径: $REPO_DIR"
    echo
    echo "  ⚡ 已运行的服务："
    launchctl list | grep com.yulu 2>/dev/null | while IFS= read -r line; do
        pid=$(echo "$line" | awk '{print $1}')
        name=$(echo "$line" | awk '{print $3}')
        if [[ "$pid" != "-" ]]; then
            echo "     ✅ $name (pid=$pid)"
        else
            echo "     ❌ $name (未运行)"
        fi
    done
    echo
    echo "  📖 常用命令（如果 ~/.local/bin 在 PATH 里）："
    echo "    yulu status      # 查看服务状态"
    echo "    yulu start/stop  # 启动 / 停止后台服务"
    echo "    yulu update      # 拉最新版并重跑 setup --upgrade"
    echo "    yulu uninstall   # 卸载 Yulu"
    echo "    yulu logs        # tail 各 daemon 日志"
    echo
    echo "  ❓ 需要帮助？"
    echo "    README.md 中有完整文档"
    echo "    https://github.com/Nowhitestar/Yulu"
}

# ─── Main: thin orchestrator (D-12) ──────────────────
# Resolve mode once (done above as $MODE), own the prompts here, then sequence the
# four concern scripts passing $MODE + decisions via env. swiftc is reached ONLY via
# setup_audio.sh's dev branch (D-13 / BUILD-03).

run_provision() {
    PYTHONPATH="$SCRIPT_DIR:${PYTHONPATH:-}" "$PYTHON_BIN" -m provision.cli provision "$@" \
        --mode "$MODE" \
        --ledger "$REPO_DIR/.yulu-install.json"
}

run_setup_deps() {
    if ! confirm_deps_install; then
        return 0
    fi
    if [[ "${YULU_USE_PROVISION:-}" == "1" ]]; then
        header "运行可恢复 provision 步骤"
        info "使用 .yulu-install.json 记录每个安装步骤，便于 Agent 续跑/诊断。"
        run_provision deps
    else
        "$SCRIPT_DIR/setup_deps.sh" "$MODE"
    fi
}

run_setup_concerns() {
    if [[ "${YULU_USE_PROVISION:-}" == "1" ]]; then
        if [[ "$UPGRADE_MODE" == true ]]; then
            # A release payload replaces the runtime tree before this point,
            # but probes cannot prove the already-loaded processes use it.
            # Force every lifecycle concern so old daemons are retired and the
            # audio/UI LaunchAgents reload the new binaries and server bundle.
            run_provision audio --force || return 1
            run_provision daemons --force || return 1
            run_provision ui --force || return 1
            return
        fi
        run_provision --all
        return
    fi

    # 3) Audio: dev/release fork lives INSIDE setup_audio.sh (swiftc only on dev).
    "$SCRIPT_DIR/setup_audio.sh" "$MODE" || return 1

    # 4) Daemons.
    "$SCRIPT_DIR/setup_daemons.sh" "$MODE" || return 1

    # 5) UI: build yulu_ui + install its LaunchAgent.
    "$SCRIPT_DIR/setup_ui.sh" "$MODE" || return 1
}

if [[ "$UPGRADE_MODE" == true ]]; then
    echo -e "${BLUE}"
    echo "  ╔══════════════════════════════════════════╗"
    echo "  ║         Yulu 升级（idempotent）          ║"
    echo "  ╚══════════════════════════════════════════╝"
    echo -e "${NC}"
    echo "  版本：$(yulu_version)"
    echo "  安装模式：$MODE"
    echo "  跳过已配置项；只补缺失或更新过的内容。"
    echo
else
    echo -e "${BLUE}"
    echo "  ╔══════════════════════════════════════════╗"
    echo "  ║              Yulu 安装脚本               ║"
    echo "  ╚══════════════════════════════════════════╝"
    echo -e "${NC}"
    echo "  版本：$(yulu_version)"
    echo "  安装模式：$MODE"
    echo "  本脚本将引导你完成 Yulu 的安装和配置。"
    echo "  全程大约需要 10-15 分钟。"
    echo

    prompt "开始安装？[Y/n]"
    read -r ans
    if [[ "$ans" =~ ^[nN] ]]; then
        echo "安装已取消"
        exit 0
    fi
fi

# ── Pre-flight (orchestrator-resident) ──────────────────────────────
check_repo_layout
check_system

# ── Interactive prompts resolved up-front; decisions passed DOWN via env/args ──
run_setup_deps || exit 1

# Config is Agent-native: Yulu records local capture/pipeline preferences only.
create_config

# Calendar opt-in stays in the orchestrator because it may need OAuth/user input.
setup_calendar
confirm_calendar_plist

# Register the token-protected Host MCP endpoints before loading the Host. The
# recording pipeline is deliberately Hermes-specific, so its general, artifact,
# and delivery registrations are a required install boundary. Other Agents are
# optional conversation providers and remain best-effort.
if ! PYTHONPATH="$SCRIPT_DIR:${PYTHONPATH:-}" "$PYTHON_BIN" -m provision.cli mcp install --agent hermes; then
    err "Hermes CLI and its Yulu phase MCP registrations are required. Install or repair Hermes, then rerun setup."
    exit 1
fi
PYTHONPATH="$SCRIPT_DIR:${PYTHONPATH:-}" "$PYTHON_BIN" -m provision.cli mcp install \
    --agent codex --agent claude --agent openclaw --detected-only --non-fatal \
    || warn "Optional Agent MCP registration returned a warning"

run_setup_concerns || exit 1

# ── Orchestrator-resident tail (NOT in the D-11 six-concern set) ─────
# install_yulu_cli / run_tests / show_summary stay here. Agent-skill registration
# is decoupled from core install; install or refresh it independently with:
# yulu skill install --agent <name>
install_yulu_cli
# Upgrades only: merge any legacy voicemail recordings into the meetings store
# (idempotent + safe to skip on fresh installs, which have no voicemails/ dir).
if [[ "$UPGRADE_MODE" == true ]]; then
    migrate_unify_voicemails
fi
run_tests
show_summary

echo
if [[ "$UPGRADE_MODE" == true ]]; then
    info "升级完成！"
else
    info "安装完成！有任何问题请查看 README.md 或提交 GitHub Issue。"
fi
