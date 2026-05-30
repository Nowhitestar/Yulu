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
#   2. owns ALL interactive prompts (deps confirm, transcription/summary mode,
#      calendar opt-in, upgrade detection) and resolves them into variables/env, then
#   3. sequences the six decomposed setup_*.sh concern scripts in order, passing the
#      resolved `mode` + decisions DOWN via args/env (Pitfall 5 — no shared globals).
#
# The six concern scripts (setup_deps.sh, setup_audio.sh, setup_models.sh,
# setup_capabilities.sh, setup_daemons.sh, setup_ui.sh) each:
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
CONFIG_PRESERVED=false
for arg in "$@"; do
    case "$arg" in
        --upgrade|-u) UPGRADE_MODE=true ;;
        --dev) : ;;  # consumed by resolve_install_mode below; no-op here
        --help|-h)
            echo "Usage: bash yulu/scripts/setup.sh [--upgrade] [--dev]"
            echo "  --upgrade   Skip steps that have already been completed (whisper model exists,"
            echo "              config exists, OAuth granted, TCC granted, LaunchAgents loaded)."
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
MODEL_DIR="$CONFIG_DIR/models"
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
export SCRIPT_DIR PYTHON_BIN NODE_BIN CONFIG_DIR MODEL_DIR LAUNCH_AGENTS_DIR
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
    ok "macOS $(sw_vers -productVersion)"

    if ! command -v brew &>/dev/null; then
        warn "Homebrew 未安装，正在安装..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
        ok "Homebrew 已安装"
    else
        ok "Homebrew $(brew --version | head -1)"
    fi

    if command -v python3 &>/dev/null; then
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
    echo "    - whisper-cpp        (非 MLX 转录 / fallback whisper-cli)"
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

    if [[ -f "$CONFIG_DIR/config.json" ]]; then
        if [[ "$UPGRADE_MODE" == true ]]; then
            ok "配置文件已存在，保留: $CONFIG_DIR/config.json"
        else
            warn "配置文件已存在: $CONFIG_DIR/config.json"
            prompt "覆盖？[y/N]"
            read -r ans
            if [[ ! "$ans" =~ ^[yY] ]]; then
                info "保留现有配置"
                mkdir -p "$RECORDING_DIR"
                CONFIG_PRESERVED=true
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
      "type": "google",
      "enabled": false,
      "gog_account": "",
      "watch_calendars": ["primary"]
    }
  ],
  "audio": {
    "backend": "daemon",
    "mic_device": ":0",
    "system_audio_device": ":1",
    "output_dir": "$RECORDING_DIR",
    "format": "wav",
    "silence_threshold": 0.01,
    "silence_duration_sec": 300,
    "half_duplex": true
  },
  "transcription": {
    "realtime_enabled": true,
    "mode": "local",
    "post_recording_mode": "fast_summary",
    "final_engine": "whisper",
    "language": "zh",
    "local_model_path": "",
    "whisper_cli": "whisper-cli",
    "mlx": {
      "model": "mlx-community/whisper-large-v3-mlx"
    },
    "realtime": {
      "engine": "whisper",
      "chunk_sec": 60
    }
  },
  "llm": {
    "enabled": true,
    "command": null
  },
  "output": {
    "channel": "file"
  },
  "meeting_detection": {
    "enabled": true,
    "interval_sec": 10,
    "stable_sec": 15,
    "prompt_cooldown_sec": 1800
  }
}
CONFIG

    mkdir -p "$RECORDING_DIR"
    ok "配置文件已创建: $CONFIG_DIR/config.json"
    ok "录制目录已创建: $RECORDING_DIR"
}

# ─── Step 3.5: Summary agent / LLM setup ─────────────

configure_summary_mode() {
    header "摘要生成方式"

    if [[ ! -f "$CONFIG_DIR/config.json" ]]; then
        warn "配置文件不存在，跳过摘要方式配置"
        return
    fi

    if [[ "$UPGRADE_MODE" == true ]]; then
        info "升级模式：保留现有 llm 配置。"
        info "  需要修改时，编辑 $CONFIG_DIR/config.json 的 llm.enabled / llm.command。"
        return
    fi

    echo "  请选择 Yulu 转录完成后如何生成最终会议纪要："
    echo "    1) Agent 队列（推荐）：写入 agent-queue.json，由你信任的 Coding Agent 处理"
    echo "    2) Claude CLI：直接调用 claude --print"
    echo "    3) Codex CLI：通过 Yulu 的 codex_llm.py shim 调用 codex exec"
    echo "    4) 自定义命令：任何读取 stdin、输出 Markdown 的命令"
    echo "    5) 只保留本地规则草稿：不排队、不调用 LLM"
    echo
    prompt "选择 [1-5，默认 1]:"
    read -r choice
    [[ -z "$choice" ]] && choice="1"

    local mode="queue"
    local custom_cmd=""
    case "$choice" in
        2)
            mode="claude"
            if ! command -v claude >/dev/null 2>&1; then
                warn "当前 PATH 未找到 claude；仍会写入配置，安装后请确保 launchd PATH 能找到它。"
            fi
            ;;
        3)
            mode="codex"
            if ! command -v codex >/dev/null 2>&1; then
                warn "当前 PATH 未找到 codex；codex_llm.py 会继续尝试从 PATH / nvm 路径查找。"
            fi
            ;;
        4)
            mode="custom"
            prompt "输入命令（例如：ollama run qwen2.5 或 claude --print）:"
            read -r custom_cmd
            if [[ -z "$custom_cmd" ]]; then
                warn "命令为空，回退到 Agent 队列模式"
                mode="queue"
            fi
            ;;
        5)
            mode="fallback"
            ;;
        *)
            mode="queue"
            ;;
    esac

    # PYTHON_BIN / SCRIPT_DIR / CONFIG_DIR are already exported at the orchestrator
    # top; only the two per-call decisions are passed as the command prefix here.
    # (Avoids SC2097/SC2098: don't re-assign a var on the prefix AND expand it on
    # the same line — the prefix assignment is only visible to the forked process.)
    SUMMARY_MODE="$mode" CUSTOM_LLM_CMD="$custom_cmd" "$PYTHON_BIN" - <<'PY'
import json
import os
import shlex
from pathlib import Path

cfg_path = Path(os.environ["CONFIG_DIR"]) / "config.json"
cfg = json.loads(cfg_path.read_text())
llm = cfg.setdefault("llm", {})
mode = os.environ["SUMMARY_MODE"]

if mode == "queue":
    llm["enabled"] = True
    llm["command"] = None
elif mode == "claude":
    llm["enabled"] = True
    llm["command"] = ["claude", "--print"]
elif mode == "codex":
    llm["enabled"] = True
    llm["command"] = [os.environ["PYTHON_BIN"], str(Path(os.environ["SCRIPT_DIR"]) / "codex_llm.py")]
elif mode == "custom":
    llm["enabled"] = True
    llm["command"] = shlex.split(os.environ.get("CUSTOM_LLM_CMD", ""))
elif mode == "fallback":
    llm["enabled"] = False
    llm["command"] = None

cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n")
PY

    case "$mode" in
        queue) ok "摘要方式：Agent 队列（llm.command=null）" ;;
        claude) ok "摘要方式：Claude CLI" ;;
        codex) ok "摘要方式：Codex CLI shim" ;;
        custom) ok "摘要方式：自定义命令" ;;
        fallback) ok "摘要方式：只保留本地规则草稿" ;;
    esac
}

# ─── Step 4.5: Transcription engine selection (writes the CHOICE to config) ──
# The orchestrator owns the interactive engine/model choice and records it in
# config.json. The heavy lifting then happens in the sequenced concern scripts:
#   - setup_capabilities.sh VERIFIES mlx-whisper importability (D-05, no install),
#   - setup_models.sh DOWNLOADS the GGML model + writes the whisper-cli command.
# So this function only sets final_engine + the chosen model; it does NOT create a
# venv (D-02 removed that) and does NOT download (setup_models.sh owns the download).

configure_post_recording_mode() {
    header "停止后的处理模式"

    if [[ "$UPGRADE_MODE" == true || "$CONFIG_PRESERVED" == true ]]; then
        ok "保留现有停止后处理模式"
        return
    fi

    echo "  1) 快速模式（默认）"
    echo "     会议中持续生成 realtime transcript；停止后只做 polish + summary。"
    echo "     优点：结束后很快出纪要；适合日常会议。"
    echo "     代价：依赖实时分块转录，个别断句/术语可能不如完整重转录。"
    echo
    echo "  2) 完整模式"
    echo "     停止后对整段 WAV 再跑一次最终模型，然后 polish + summary。"
    echo "     优点：质量更稳、长上下文更好；适合正式访谈/客户会议。"
    echo "     代价：会慢很多，尤其 large-v3。"
    echo

    local choice="1"
    prompt "选择处理模式 [1-2，回车默认 1 快速模式]:"
    read -r choice
    [[ -z "$choice" ]] && choice="1"

    local mode="fast_summary"
    [[ "$choice" == "2" ]] && mode="full_transcribe"

    "$PYTHON_BIN" - <<PY
import json
from pathlib import Path
cfg_path = Path("$CONFIG_DIR/config.json")
cfg = json.loads(cfg_path.read_text())
cfg.setdefault("transcription", {})["post_recording_mode"] = "$mode"
cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False))
PY
    ok "停止后处理模式: $mode"
    info "之后可用命令快速切换：yulu transcription mode fast 或 yulu transcription mode full"
}

configure_transcription_engine() {
    header "转录引擎和模型"

    if [[ "$UPGRADE_MODE" == true || "$CONFIG_PRESERVED" == true ]]; then
        ok "保留现有转录引擎配置"
        return
    fi

    echo "  选择你希望停止后完整转录、以及实时分块转录使用的模型。"
    echo
    echo "    1) MLX large-v3（默认，Apple Silicon 高质量推荐）"
    echo "       模型：mlx-community/whisper-large-v3-mlx"
    echo "       优点：完整 large-v3 能力，Apple Silicon 上通常比 whisper.cpp 更舒服。"
    echo "       适合：M1/M2/M3/M4，中文会议质量优先；首次转录会下载 Hugging Face 模型缓存。"
    echo
    echo "    2) MLX large-v3-turbo（Apple Silicon 速度推荐）"
    echo "       模型：mlx-community/whisper-large-v3-turbo"
    echo "       优点：很快，日常会议体验最好。"
    echo "       代价：多人抢话、噪声、术语场景略弱于完整 large-v3；首次转录会下载 Hugging Face 模型缓存。"
    echo
    echo "    3) whisper.cpp large-v3（非 MLX，最高质量/最朴素）"
    echo "       文件：ggml-large-v3.bin（~3.0 GB）"
    echo "       优点：CLI 简单、少 Python 依赖，Intel Mac 也能用。"
    echo "       代价：Apple Silicon 上通常没有 MLX 轻快。"
    echo
    echo "    4) whisper.cpp large-v3-q5_0（非 MLX，均衡）"
    echo "       文件：ggml-large-v3-q5_0.bin（~1.1 GB）"
    echo "       优点：接近 large-v3，体积/速度更友好。"
    echo
    echo "    5) whisper.cpp medium（非 MLX，低配快速）"
    echo "       文件：ggml-medium.bin（~1.5 GB）"
    echo "       优点：更快；代价：中文和复杂会议质量低一档。"
    echo

    local default_choice="1"
    if [[ "$(uname -m)" != "arm64" ]]; then
        default_choice="3"
        warn "当前不是 arm64；MLX 主要适合 Apple Silicon，默认改为 whisper.cpp large-v3。"
    fi

    local choice="$default_choice"
    prompt "选择转录方案 [1-5，回车默认 $default_choice]:"
    read -r choice
    [[ -z "$choice" ]] && choice="$default_choice"
    if [[ ! "$choice" =~ ^[1-5]$ ]]; then
        warn "无效选择，使用默认方案 $default_choice"
        choice="$default_choice"
    fi

    # Record only the engine + model CHOICE here. setup_capabilities.sh (verify
    # mlx) and setup_models.sh (download GGML + write whisper-cli command) act on
    # this config later in the sequence — the orchestrator does NOT venv/download.
    case "$choice" in
        1) record_engine_choice mlx     "mlx-community/whisper-large-v3-mlx" ;;
        2) record_engine_choice mlx     "mlx-community/whisper-large-v3-turbo" ;;
        3) record_engine_choice whisper "$MODEL_DIR/ggml-large-v3.bin" ;;
        4) record_engine_choice whisper "$MODEL_DIR/ggml-large-v3-q5_0.bin" ;;
        5) record_engine_choice whisper "$MODEL_DIR/ggml-medium.bin" ;;
    esac
}

# Write the transcription engine + chosen model into config.json. For whisper it
# records local_model_path (setup_models.sh downloads it + writes the command); for
# mlx it records mlx.model (setup_capabilities.sh verifies importability). No venv
# (D-02), no download (setup_models.sh owns it), no dead mlx.python field (D-03).
record_engine_choice() {
    local engine="$1" model="$2"
    ENGINE="$engine" MODEL_CHOICE="$model" CONFIG_DIR="$CONFIG_DIR" "$PYTHON_BIN" - <<'PY'
import json
import os
from pathlib import Path

cfg_path = Path(os.environ["CONFIG_DIR"]) / "config.json"
cfg = json.loads(cfg_path.read_text())
trans = cfg.setdefault("transcription", {})
realtime = trans.setdefault("realtime", {})
trans.setdefault("mode", "local")
trans.setdefault("language", "zh")
trans.setdefault("post_recording_mode", "fast_summary")

engine = os.environ["ENGINE"]
model = os.environ["MODEL_CHOICE"]

if engine == "mlx":
    trans["final_engine"] = "mlx"
    mlx = trans.setdefault("mlx", {})
    mlx.pop("python", None)  # D-03: no venv path; daemon uses plist __PYTHON__
    mlx["model"] = model
    realtime["engine"] = "mlx"
    realtime["mlx_model"] = model
else:
    trans["final_engine"] = "whisper"
    trans["local_model_path"] = model
    realtime["engine"] = "whisper"

cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False))
PY
    if [[ "$engine" == "mlx" ]]; then
        ok "转录引擎：MLX（$model）— 将在能力检查中验证可用性"
    else
        ok "转录引擎：whisper.cpp（$(basename "$model")）— 将在模型步骤中下载"
    fi
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

    prompt "安装日历推送服务（需要 Google 日历）？[y/N]"
    read -r ans
    if [[ "$ans" =~ ^[yY] ]]; then
        YULU_INSTALL_CALENDAR=1
        export YULU_INSTALL_CALENDAR
    fi
}

# ─── Step 7: Install Yulu as an agent skill (optional) ─────────

install_agent_skill() {
    header "（可选）注册 Yulu skill 到 Coding Agent"

    if ! command -v npx >/dev/null 2>&1; then
        info "未检测到 npx (Node.js)，跳过 agent skill 注册。"
        info "  以后想装：先装 Node.js，再跑 npx skills add Nowhitestar/Yulu -g"
        return
    fi

    echo "  使用 vercel-labs/skills 把 Yulu 的 SKILL.md 注册到你选择的 agent。"
    echo "  注册之后，可以直接对 agent 说「开始录制」「停止录制」「上次会议聊了什么」，"
    echo "  agent 会看 SKILL.md 学到 Yulu 的命令，自动调用。"
    echo "  常见目标：claude-code openclaw codex cursor"
    echo "  支持列表见：https://github.com/vercel-labs/skills"
    echo

    if [[ "$UPGRADE_MODE" == true ]]; then
        prompt "刷新/安装 Yulu skill 到 agent？[y/N]"
    else
        prompt "注册 Yulu skill 到 agent？[y/N]"
    fi
    read -r ans || ans=""   # tolerate EOF under non-interactive stdin
    if [[ ! "$ans" =~ ^[yY] ]]; then
        info "已跳过 skill 注册。以后想装：npx skills add $REPO_DIR -g -a <agent> -y"
        return
    fi

    local agents=""
    while [[ -z "$agents" ]]; do
        prompt "目标 agent（空格或逗号分隔，如 claude-code openclaw codex；回车跳过）："
        read -r agents || agents=""   # tolerate EOF under non-interactive stdin
        agents="${agents//,/ }"
        # Collapse repeated whitespace.
        agents="$(echo "$agents" | xargs 2>/dev/null || true)"
        if [[ -z "$agents" ]]; then
            prompt "未输入目标 agent，跳过 skill 注册？[Y/n]"
            read -r skip_ans || skip_ans=""   # tolerate EOF under non-interactive stdin
            if [[ ! "$skip_ans" =~ ^[nN] ]]; then
                info "已跳过 skill 注册。"
                return
            fi
        fi
    done

    local agent_args=()
    for a in $agents; do
        agent_args+=("-a" "$a")
    done

    info "运行：npx -y skills add $REPO_DIR -g ${agent_args[*]} -y"
    if npx -y skills add "$REPO_DIR" -g "${agent_args[@]}" -y; then
        ok "Yulu skill 已注册到：$agents"
        echo "  位置：~/.<agent>/skills/yulu/  (symlink 到 $REPO_DIR/skills/yulu/)"
    else
        warn "skill 注册失败（不影响 Yulu 主功能）。手动重试：npx skills add $REPO_DIR -g ${agent_args[*]}"
    fi
}

# ─── Step 7.5: Install yulu CLI shim ─────────────────

install_yulu_cli() {
    header "安装 yulu 命令行入口"

    local cli_src="$SCRIPT_DIR/yulu"
    local cli_dest="$LOCAL_BIN/yulu"

    if [[ ! -f "$cli_src" ]]; then
        warn "未找到 yulu CLI 脚本（$cli_src），跳过"
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

    echo "  - 转录配置"
    if "$PYTHON_BIN" "$SCRIPT_DIR/configure.py" transcription status >/tmp/yulu-transcription-status.$$ 2>&1; then
        verify_ok "转录配置可读取"
        sed 's/^/      /' /tmp/yulu-transcription-status.$$
    else
        verify_warn "转录配置异常: $(cat /tmp/yulu-transcription-status.$$ 2>/dev/null)"
    fi
    rm -f /tmp/yulu-transcription-status.$$

    echo "  - 检测器"
    local detect_result
    detect_result=$("$PYTHON_BIN" "$SCRIPT_DIR/meeting_detector.py" once 2>&1 || true)
    local detect_summary
    detect_summary=$(echo "$detect_result" | "$PYTHON_BIN" -c 'import json,sys; d=json.load(sys.stdin); print("active={} windows={}".format(d.get("active"), len(d.get("windows") or [])))' 2>/dev/null || true)
    if [[ -n "$detect_summary" ]]; then
        verify_ok "检测器可运行（$detect_summary）"
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
# six concern scripts passing $MODE + decisions via env. swiftc is reached ONLY via
# setup_audio.sh's dev branch (D-13 / BUILD-03).

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
# 1) Deps (orchestrator confirms, setup_deps.sh installs non-interactively).
if confirm_deps_install; then
    "$SCRIPT_DIR/setup_deps.sh" "$MODE"
fi

# 2) Config + transcription/summary choices (orchestrator-owned, write to config).
create_config
configure_post_recording_mode
configure_transcription_engine
configure_summary_mode

# 3) Audio: dev/release fork lives INSIDE setup_audio.sh (swiftc only on dev).
"$SCRIPT_DIR/setup_audio.sh" "$MODE"

# 4) Models: download the chosen GGML model + write the whisper-cli command.
"$SCRIPT_DIR/setup_models.sh" "$MODE"

# 5) Capabilities: verify mlx-whisper importability (no venv, no install — D-02/D-05).
"$SCRIPT_DIR/setup_capabilities.sh" "$MODE"

# 6) Calendar opt-in (orchestrator owns the prompt + OAuth), then daemons.
setup_calendar
confirm_calendar_plist
"$SCRIPT_DIR/setup_daemons.sh" "$MODE"

# 7) UI: build yulu_ui + install its LaunchAgent.
"$SCRIPT_DIR/setup_ui.sh" "$MODE"

# ── Orchestrator-resident tail (NOT in the D-11 six-concern set) ─────
# install_yulu_cli / run_tests / show_summary stay here. Agent-skill registration
# is DECOUPLED from core install (Phase 6 PROV-05, D-05/D-08): it is no longer run
# here. Install/refresh the skill independently with:  yulu skill install --agent <name>
# (the install_agent_skill function body is retained above for reference but is
# intentionally NOT called in the main flow).
install_yulu_cli
run_tests
show_summary

echo
if [[ "$UPGRADE_MODE" == true ]]; then
    info "升级完成！"
else
    info "安装完成！有任何问题请查看 README.md 或提交 GitHub Issue。"
fi
