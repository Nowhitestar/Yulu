#!/usr/bin/env bash
#
# Yulu - 交互式安装脚本
# Usage:
#   bash yulu/scripts/setup.sh             # fresh install
#   bash yulu/scripts/setup.sh --upgrade   # idempotent re-run after a `git pull`
#

set -e

UPGRADE_MODE=false
CONFIG_PRESERVED=false
for arg in "$@"; do
    case "$arg" in
        --upgrade|-u) UPGRADE_MODE=true ;;
        --help|-h)
            echo "Usage: bash yulu/scripts/setup.sh [--upgrade]"
            echo "  --upgrade   Skip steps that have already been completed (whisper model exists,"
            echo "              config exists, OAuth granted, TCC granted, LaunchAgents loaded)."
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

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}ℹ️${NC} $1"; }
ok()    { echo -e "${GREEN}✅${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠️${NC} $1"; }
err()   { echo -e "${RED}❌${NC} $1"; }
header(){ echo; echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; echo -e "${BLUE}  $1${NC}"; echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"; }
prompt(){ echo -ne "${YELLOW}➡️${NC} $1 "; }

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

# ─── Step 1: Install system deps ─────────────────────

install_deps() {
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
            return
        fi
    fi

    # `brew install` is idempotent — already-installed packages emit a one-line warning and exit 0.
    brew install sox ffmpeg whisper-cpp terminal-notifier 2>&1 | tail -1
    ok "音频/转录/通知工具安装完成"

    brew install steipete/tap/gogcli 2>&1 | tail -1
    ok "gog CLI 安装完成"

    brew install cloudflared 2>&1 | tail -1
    ok "cloudflared 安装完成"
}

# ─── Step 2: Audio setup ─────────────────────────────

setup_audio() {
    header "音频配置"

    echo "  Yulu 默认使用原生 macOS ScreenCaptureKit + AVFoundation。"
    echo "  不需要 BlackHole、多输出设备或虚拟声卡。"
    echo
    echo "  首次使用 Yulu.app 时，请授权："
    echo "    - 麦克风"
    echo "    - 屏幕与系统音频录制"
    echo

    MIC_DEVICE=":0"
    SYS_DEVICE=":1"  # 仅 SoX fallback 使用；daemon 后端会忽略

    ok "音频后端: daemon (ScreenCaptureKit 系统音频 + AVFoundation 麦克风)"
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
    "mic_device": "$MIC_DEVICE",
    "system_audio_device": "$SYS_DEVICE",
    "output_dir": "$RECORDING_DIR",
    "format": "wav",
    "silence_threshold": 0.01,
    "silence_duration_sec": 300,
    "half_duplex": true
  },
  "transcription": {
    "mode": "local",
    "post_recording_mode": "fast_summary",
    "final_engine": "whisper",
    "language": "zh",
    "local_model_path": "",
    "whisper_cli": "whisper-cli",
    "mlx": {
      "python": "$CONFIG_DIR/venv-mlx-whisper/bin/python",
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

    SUMMARY_MODE="$mode" CUSTOM_LLM_CMD="$custom_cmd" PYTHON_BIN="$PYTHON_BIN" SCRIPT_DIR="$SCRIPT_DIR" CONFIG_DIR="$CONFIG_DIR" "$PYTHON_BIN" - <<'PY'
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

# ─── Step 4: Compile native helpers ──────────────────

compile_scanner() {
    header "编译窗口扫描工具"

    if ! command -v swiftc &>/dev/null; then
        warn "Swift 编译器未安装（swiftc 不可用），跳过编译"
        warn "后续可以手动编译: xcode-select --install"
        return
    fi

    swiftc -o "$SCRIPT_DIR/window_scanner" \
           "$SCRIPT_DIR/window_scanner.swift" \
           -framework Cocoa 2>&1 | tail -1
    chmod +x "$SCRIPT_DIR/window_scanner"
    ok "window_scanner 编译成功"

    # Upgrade path: if scanner already returns a non-empty window list, TCC is granted, skip the prompts.
    if [[ "$UPGRADE_MODE" == true ]]; then
        local result
        result=$("$SCRIPT_DIR/window_scanner" 2>&1 || true)
        if [[ "$result" != "[]" && -n "$result" ]]; then
            ok "辅助功能权限已就绪（升级模式跳过引导）"
            return
        fi
    fi

    echo
    echo "  window_scanner 用于读取会议窗口标题（Zoom / Tencent Meeting / etc.）。"
    echo "  首次运行需要授权辅助功能权限。即将打开 window_scanner..."
    echo "  当系统弹出对话框时，请点击「允许」或「好」。"
    echo
    prompt "准备好了吗？按回车继续..."
    read -r

    open "$SCRIPT_DIR/window_scanner"
    sleep 2
    ok "权限对话框已弹出，请点击允许"
    prompt "点完允许后按回车继续..."
    read -r

    # Verify
    local result
    result=$("$SCRIPT_DIR/window_scanner" 2>&1)
    if [[ "$result" == "[]" ]]; then
        warn "window_scanner 未检测到窗口，可能权限未授权"
        warn "请手动添加: 系统设置 → 隐私与安全性 → 辅助功能"
        warn "路径: $SCRIPT_DIR/window_scanner"
        prompt "继续？[Y/n]"
        read -r ans
        if [[ "$ans" =~ ^[nN] ]]; then exit 1; fi
    else
        local count
        count=$(echo "$result" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null)
        ok "window_scanner 工作正常，检测到 $count 个窗口"
    fi
}

compile_audio_daemon() {
    header "编译并签名 Yulu.app"

    local build_script="$SCRIPT_DIR/build_audio_daemon.sh"
    if [[ ! -x "$build_script" ]]; then
        warn "Yulu.app 的 build script 不存在或不可执行，跳过"
        return
    fi

    "$build_script"
    ok "Yulu.app 已使用固定 codesign identity 签名"

    # Strip Gatekeeper quarantine so that ad-hoc-signed Yulu.app launches without
    # the "cannot verify developer" dialog that LSUIElement apps swallow silently.
    xattr -dr com.apple.quarantine "$SCRIPT_DIR/Yulu.app" 2>/dev/null || true

    # On upgrade, if TCC is already granted and the daemon answers status, skip the
    # interactive permission walkthrough — but ALWAYS restart the daemon so it
    # actually picks up the freshly built binary. (`launchctl unload` of an
    # `open -W Yulu.app` job doesn't kill the LSUIElement child process, so the
    # old binary keeps running unless we pkill it explicitly.)
    if [[ "$UPGRADE_MODE" == true ]]; then
        local existing
        existing=$(echo '{"action":"status"}' | nc -w 2 -U "$HOME/.config/yulu/audio_daemon.sock" 2>/dev/null || true)
        if echo "$existing" | grep -q '"sysReady":true' && echo "$existing" | grep -q '"micReady":true'; then
            info "重载 daemon 让它跑新 binary（TCC 状态保留）..."
            pkill -9 -f "Yulu.app/Contents/MacOS/audio_daemon" 2>/dev/null || true
            sleep 2
            # launchd KeepAlive=true 会自动重启 daemon。如果 plist 已 unload（极端情况），
            # 我们手动 open。
            if ! pgrep -f "Yulu.app/Contents/MacOS/audio_daemon" >/dev/null 2>&1; then
                open "$SCRIPT_DIR/Yulu.app"
                sleep 3
            fi
            ok "麦克风 + 屏幕录制权限已就绪；daemon 已重载"
            return
        fi
    fi

    echo
    echo "  Yulu.app 负责捕获系统音频和麦克风。"
    echo "  首次使用需要授权：系统设置 → 隐私与安全性 → 屏幕与系统音频录制 / 麦克风。"
    echo "  如果系统弹出权限对话框，请点击「允许」。"

    # Reset TCC for the audio daemon's bundle id so macOS will (re)prompt the user
    # for Microphone + Screen Recording instead of silently honoring a previously-
    # denied state. This matters in two cases:
    #   - User accidentally clicked "Don't Allow" the first time.
    #   - Bundle id changed across versions (carry-over from old TCC entries).
    # If the user already granted, macOS just re-prompts and they accept again —
    # one extra click vs. being silently broken.
    # The daemon must be stopped before reset, otherwise the new request goes
    # against the already-running process and the prompt is suppressed.
    launchctl unload "$LAUNCH_AGENTS_DIR/com.yulu.audiodaemon.plist" 2>/dev/null || true
    pkill -f "Yulu.app/Contents/MacOS/audio_daemon" 2>/dev/null || true
    sleep 1
    tccutil reset ScreenCapture com.yulu.audiodaemon 2>/dev/null || true
    tccutil reset Microphone com.yulu.audiodaemon 2>/dev/null || true

    open "$SCRIPT_DIR/Yulu.app"
    sleep 4
    local status
    status=$(echo '{"action":"status"}' | nc -w 2 -U "$HOME/.config/yulu/audio_daemon.sock" 2>/dev/null || true)
    if echo "$status" | grep -q '"sysReady":true' && echo "$status" | grep -q '"micReady":true'; then
        ok "Yulu 捕获权限正常"
    else
        warn "Yulu 尚未 ready: $status"
        warn "如果系统弹出了权限对话框但你来不及点，跑下面这行重新弹一次："
        warn "  tccutil reset ScreenCapture com.yulu.audiodaemon && open '$SCRIPT_DIR/Yulu.app'"
    fi

    # Build the status agent bundle (Phase 5). Skip silently if D.1 hasn't shipped
    # the build script yet — keeps the rest of setup usable on partial checkouts.
    local sa_build="$SCRIPT_DIR/build_status_agent.sh"
    if [[ -x "$sa_build" ]]; then
        info "Building StatusAgent.app..."
        if bash "$sa_build" >/dev/null 2>&1; then
            ok "StatusAgent.app built"
        else
            warn "StatusAgent.app build failed (continuing — status agent will be unavailable)"
        fi
    fi
}

# ─── Step 4.5: Transcription setup ───────────────────

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

    case "$choice" in
        1)
            install_mlx_whisper
            write_mlx_to_config "mlx-community/whisper-large-v3-mlx"
            ;;
        2)
            install_mlx_whisper
            write_mlx_to_config "mlx-community/whisper-large-v3-turbo"
            ;;
        3)
            write_model_to_config "$MODEL_DIR/ggml-large-v3.bin"
            ;;
        4)
            write_model_to_config "$MODEL_DIR/ggml-large-v3-q5_0.bin"
            ;;
        5)
            write_model_to_config "$MODEL_DIR/ggml-medium.bin"
            ;;
    esac
}

install_mlx_whisper() {
    if [[ "$(uname -m)" != "arm64" ]]; then
        warn "MLX 主要支持 Apple Silicon；当前机器可能无法安装或运行 mlx-whisper。"
    fi
    local venv="$CONFIG_DIR/venv-mlx-whisper"
    if [[ ! -x "$venv/bin/python" ]]; then
        info "创建 MLX Python 环境: $venv"
        "$PYTHON_BIN" -m venv "$venv"
    fi
    info "安装/更新 mlx-whisper（首次会下载依赖）..."
    "$venv/bin/python" -m pip install --upgrade pip mlx-whisper
    ok "mlx-whisper 已就绪"
}

download_whisper_model() {
    header "下载 whisper.cpp 模型"

    mkdir -p "$MODEL_DIR"

    local target
    target="$("$PYTHON_BIN" - <<PY
import json
from pathlib import Path
cfg_path = Path("$CONFIG_DIR/config.json")
if not cfg_path.exists():
    raise SystemExit(0)
cfg = json.loads(cfg_path.read_text())
trans = cfg.get("transcription", {})
realtime = trans.get("realtime", {}) if isinstance(trans.get("realtime", {}), dict) else {}
needs = trans.get("final_engine", "whisper") == "whisper" or realtime.get("engine") == "whisper"
if needs:
    print(Path(trans.get("local_model_path") or "$MODEL_DIR/ggml-large-v3.bin").expanduser())
PY
)"

    if [[ -z "$target" ]]; then
        ok "当前选择 MLX 转录，跳过 GGML 模型下载"
        return
    fi

    if [[ -f "$target" ]]; then
        ok "模型已存在: $target"
        write_model_to_config "$target"
        return
    fi

    local filename model_name url
    filename="$(basename "$target")"
    model_name="${filename#ggml-}"
    model_name="${model_name%.bin}"
    if [[ "$filename" != ggml-*.bin || -z "$model_name" ]]; then
        warn "无法自动识别模型文件名: $target"
        warn "请手动下载模型后运行: yulu transcription engine whisper $target"
        return
    fi

    url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model_name}.bin"
    info "下载 ggml-${model_name}.bin（这一步可能要几分钟到十几分钟，取决于网络）..."
    if curl -L --fail --progress-bar "$url" -o "$target.partial"; then
        mv "$target.partial" "$target"
        ok "模型已保存: $target"
        write_model_to_config "$target"
    else
        rm -f "$target.partial"
        warn "模型下载失败。手动下载方法："
        warn "  curl -L $url -o $target"
        warn "下载完成后运行：yulu transcription engine whisper $target"
    fi
}

# Update config.json so transcribe.py knows which model to use.
write_model_to_config() {
    local model_path="$1"
    "$PYTHON_BIN" - <<PY
import json
from pathlib import Path

cfg_path = Path("$CONFIG_DIR/config.json")
if not cfg_path.exists():
    raise SystemExit(0)
cfg = json.loads(cfg_path.read_text())
trans = cfg.setdefault("transcription", {})
realtime = trans.setdefault("realtime", {})
trans.setdefault("mode", "local")
trans.setdefault("language", "zh")
trans.setdefault("post_recording_mode", "fast_summary")
trans["final_engine"] = "whisper"
# Write the explicit whisper-cli command so transcribe.py uses our chosen model.
trans["command"] = [
    "whisper-cli",
    "-m", "$model_path",
    "-l", trans.get("language", "zh"),
    "-otxt",
    "-of", "{{output_stem}}",
    "{{input}}",
]
trans["local_model_path"] = "$model_path"
realtime["engine"] = "whisper"
cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False))
PY
    ok "config.json 已指向该模型"
}

write_mlx_to_config() {
    local model="$1"
    "$PYTHON_BIN" - <<PY
import json
from pathlib import Path

cfg_path = Path("$CONFIG_DIR/config.json")
cfg = json.loads(cfg_path.read_text())
trans = cfg.setdefault("transcription", {})
realtime = trans.setdefault("realtime", {})
trans.setdefault("mode", "local")
trans.setdefault("language", "zh")
trans.setdefault("post_recording_mode", "fast_summary")
trans["final_engine"] = "mlx"
trans["mlx"] = {
    "python": "$CONFIG_DIR/venv-mlx-whisper/bin/python",
    "model": "$model",
}
realtime["engine"] = "mlx"
realtime["mlx_model"] = "$model"
cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False))
PY
    ok "config.json 已设置 MLX 模型: $model"
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
}

# ─── Step 6: Install LaunchAgents ────────────────────

install_launchagents() {
    header "安装 LaunchAgent 常驻服务"

    mkdir -p "$LAUNCH_AGENTS_DIR"

    # Helper function to fix paths in plist
    install_plist() {
        local src="$1"
        local name="$2"
        local dest="$LAUNCH_AGENTS_DIR/$name"

        if [[ -f "$dest" ]]; then
            launchctl unload "$dest" 2>/dev/null || true
        fi

        cp "$src" "$dest"

        local launch_path="$HOME/.local/bin:$HOME/.nvm/versions/node/$(node -v 2>/dev/null || true)/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
        # Replace placeholder paths with real paths
        sed -i '' \
            -e "s|__PYTHON__|$PYTHON_BIN|g" \
            -e "s|__NODE_BIN__|$NODE_BIN|g" \
            -e "s|__HOME__|$HOME|g" \
            -e "s|__SCRIPT_DIR__|$SCRIPT_DIR|g" \
            -e "s|__PATH__|$launch_path|g" \
            "$dest" 2>/dev/null || true

        # If plist has hardcoded paths, update if needed
        if grep -q "$HOME" "$dest"; then
            ok "$name: 已复制"
        else
            # For plists with absolute paths, just copy
            ok "$name: 已复制"
        fi
    }

    local plist_dir="$SCRIPT_DIR"

    # Yulu.app (native system audio + mic capture)
    if [[ -f "$plist_dir/com.yulu.audiodaemon.plist" ]]; then
        install_plist "$plist_dir/com.yulu.audiodaemon.plist" "com.yulu.audiodaemon.plist"
        launchctl load "$LAUNCH_AGENTS_DIR/com.yulu.audiodaemon.plist" 2>/dev/null || true
        ok "audiodaemon 已加载"
    fi

    # Status agent (Phase 5): menu-bar item + global hotkey for voicemail capture.
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
        mkdir -p "$HOME/.config/yulu/logs"
        install_plist "$plist_dir/com.yulu.sttdaemon.plist" "com.yulu.sttdaemon.plist"
        launchctl load "$LAUNCH_AGENTS_DIR/com.yulu.sttdaemon.plist" 2>/dev/null || true
        ok "sttdaemon 已加载"

        # Seed vocab.sqlite from frozen snapshots (idempotent).
        info "种子词表 vocab.sqlite..."
        PYTHONPATH="$SCRIPT_DIR" "$PYTHON_BIN" -m vocab.cli seed --from-current >/dev/null 2>&1 \
          && ok "vocab seed 完成" \
          || warn "vocab seed 失败（可稍后重试: yulu vocab seed --from-current）"

        # Seed prompts.sqlite from frozen snapshots (idempotent).
        info "种子 prompts.sqlite..."
        PYTHONPATH="$SCRIPT_DIR" "$PYTHON_BIN" -m prompts.cli seed --from-current >/dev/null 2>&1 \
          && ok "prompts seed 完成" \
          || warn "prompts seed 失败（可稍后重试: yulu prompts seed --from-current）"

        # Bootstrap search.sqlite schema (idempotent). First `yulu search`
        # call will run a full sweep over ~/Movies/Yulu to populate it.
        info "初始化 search.sqlite..."
        PYTHONPATH="$SCRIPT_DIR" "$PYTHON_BIN" -m search.indexer init >/dev/null 2>&1 \
          && ok "search index 初始化完成（首次 yulu search 会全量索引）" \
          || warn "search index 初始化失败（可稍后重试: yulu search --reindex）"
    fi

    # Calendar service (optional, only if gog configured)
    if [[ -f "$plist_dir/com.yulu.calendar.plist" ]]; then
        local install_calendar=false
        if [[ "$UPGRADE_MODE" == true ]]; then
            # Inherit existing decision: if user installed calendar plist last time, refresh it.
            [[ -f "$LAUNCH_AGENTS_DIR/com.yulu.calendar.plist" ]] && install_calendar=true
        else
            prompt "安装日历推送服务（需要 Google 日历）？[y/N]"
            read -r ans
            [[ "$ans" =~ ^[yY] ]] && install_calendar=true
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
    launchctl list | grep com.yulu
    ok "服务已安装"
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
    read -r ans
    if [[ ! "$ans" =~ ^[yY] ]]; then
        info "已跳过 skill 注册。以后想装：npx skills add $REPO_DIR -g -a <agent> -y"
        return
    fi

    local agents=""
    while [[ -z "$agents" ]]; do
        prompt "目标 agent（空格或逗号分隔，如 claude-code openclaw codex；回车跳过）："
        read -r agents
        agents="${agents//,/ }"
        # Collapse repeated whitespace.
        agents="$(echo "$agents" | xargs 2>/dev/null || true)"
        if [[ -z "$agents" ]]; then
            prompt "未输入目标 agent，跳过 skill 注册？[Y/n]"
            read -r skip_ans
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

# ─── Step 7.4: Install yulu_ui (web UI on :7777) ─────

install_yulu_ui() {
    header "构建 + 安装 yulu_ui (本地 Web UI)"

    local ui_dir="$SCRIPT_DIR/yulu_ui"
    if [[ ! -d "$ui_dir" ]]; then
        warn "yulu_ui/ 不存在于 $ui_dir，跳过"
        return
    fi

    if ! command -v node &>/dev/null; then
        warn "未检测到 node；yulu_ui 是可选组件，跳过安装。"
        warn "  以后想装：brew install node && bash $0 --upgrade"
        return
    fi

    local node_major
    node_major="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ -z "$node_major" || "$node_major" -lt 20 ]]; then
        warn "node 版本过低（$(node -v 2>/dev/null || echo 'unknown')），yulu_ui 需要 Node 20+。跳过。"
        return
    fi
    ok "Node $(node -v) 满足 yulu_ui 要求"

    # Idempotency marker: skip npm ci when package-lock.json hasn't changed.
    local lock="$ui_dir/package-lock.json"
    local marker="$ui_dir/node_modules/.yulu-built-from"
    local lock_sha=""
    if [[ -f "$lock" ]]; then
        lock_sha="$(shasum -a 256 "$lock" | cut -d' ' -f1)"
    fi
    if [[ -f "$marker" ]] && [[ "$(cat "$marker" 2>/dev/null)" == "$lock_sha" ]]; then
        info "npm ci 已是最新（lockfile sha 未变），跳过依赖安装"
    else
        info "运行 npm ci (这一步可能需要 30-60 秒)..."
        ( cd "$ui_dir" && npm ci ) || { err "npm ci 失败"; exit 1; }
        echo -n "$lock_sha" > "$marker"
        ok "依赖已安装"
    fi

    info "运行 npm run build..."
    ( cd "$ui_dir" && npm run build ) || { err "npm run build 失败"; exit 1; }
    ok "yulu_ui dist/ 已生成"

    if [[ ! -s "$ui_dir/dist/server.js" || ! -s "$ui_dir/dist/web/index.html" ]]; then
        err "build 产物不完整：dist/server.js 或 dist/web/index.html 缺失"
        exit 1
    fi

    # Install + load LaunchAgent. install_plist is defined inside install_launchagents;
    # we duplicate the minimal sed+copy here so we don't rely on shell-function scoping.
    local plist_src="$SCRIPT_DIR/com.yulu.ui.plist"
    local plist_dest="$LAUNCH_AGENTS_DIR/com.yulu.ui.plist"
    if [[ ! -f "$plist_src" ]]; then
        warn "com.yulu.ui.plist 不存在于 $plist_src，跳过 launchd 安装"
        return
    fi

    if [[ -f "$plist_dest" ]]; then
        launchctl unload "$plist_dest" 2>/dev/null || true
    fi
    cp "$plist_src" "$plist_dest"
    sed -i '' \
        -e "s|__NODE_BIN__|$NODE_BIN|g" \
        -e "s|__HOME__|$HOME|g" \
        -e "s|__SCRIPT_DIR__|$SCRIPT_DIR|g" \
        "$plist_dest"
    launchctl load "$plist_dest" 2>/dev/null || warn "launchctl load com.yulu.ui 失败"
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

# ─── Main ────────────────────────────────────────────

if [[ "$UPGRADE_MODE" == true ]]; then
    echo -e "${BLUE}"
    echo "  ╔══════════════════════════════════════════╗"
    echo "  ║         Yulu 升级（idempotent）          ║"
    echo "  ╚══════════════════════════════════════════╝"
    echo -e "${NC}"
    echo "  版本：$(yulu_version)"
    echo "  跳过已配置项；只补缺失或更新过的内容。"
    echo
else
    echo -e "${BLUE}"
    echo "  ╔══════════════════════════════════════════╗"
    echo "  ║              Yulu 安装脚本               ║"
    echo "  ╚══════════════════════════════════════════╝"
    echo -e "${NC}"
    echo "  版本：$(yulu_version)"
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

check_repo_layout
check_system
install_deps
setup_audio
create_config
configure_post_recording_mode
configure_transcription_engine
configure_summary_mode
compile_scanner
compile_audio_daemon
download_whisper_model
setup_calendar
install_launchagents
install_yulu_ui
install_yulu_cli
install_agent_skill
run_tests
show_summary

echo
if [[ "$UPGRADE_MODE" == true ]]; then
    info "升级完成！"
else
    info "安装完成！有任何问题请查看 README.md 或提交 GitHub Issue。"
fi
