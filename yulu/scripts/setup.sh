#!/usr/bin/env bash
#
# Yulu - 交互式安装脚本
# Usage:
#   bash yulu/scripts/setup.sh             # fresh install
#   bash yulu/scripts/setup.sh --upgrade   # idempotent re-run after a `git pull`
#

set -e

UPGRADE_MODE=false
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
    echo "    - whisper-cpp        (本地转录 whisper-cli)"
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
    "language": "zh",
    "local_model_path": "",
    "whisper_cli": "whisper-cli"
  },
  "llm": {
    "enabled": false
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
}

# ─── Step 4.5: Download whisper.cpp model ─────────────

download_whisper_model() {
    header "下载 whisper.cpp 模型"

    mkdir -p "$MODEL_DIR"

    # If any model file already exists in MODEL_DIR, treat as done unless not in upgrade mode.
    local existing
    existing="$(ls "$MODEL_DIR"/ggml-*.bin 2>/dev/null | head -1)"

    if [[ -n "$existing" ]]; then
        ok "模型已存在: $existing"
        # Make sure config.json points at it.
        write_model_to_config "$existing"
        return
    fi

    echo "  Yulu 用 whisper.cpp 在本地转录。需要先下载一个 GGML 模型文件。"
    echo "  模型尺寸权衡：越大越准、越慢、占盘越多。"
    echo
    echo "    1) base         (~142 MB) — 最快，仅适合英文 / 极清晰音频"
    echo "    2) small        (~466 MB) — 较快，多语言可接受"
    echo "    3) medium       (~1.5 GB) — 中文质量明显提升"
    echo "    4) large-v3-q5_0 (~1.1 GB) — 推荐：large-v3 量化版，中文表现接近 large-v3 但体积减半"
    echo "    5) large-v3     (~3.0 GB) — 最高质量，最慢"
    echo

    local choice="4"
    if [[ "$UPGRADE_MODE" != true ]]; then
        prompt "选择模型 [1-5，回车默认 4 (large-v3-q5_0)]:"
        read -r choice
        [[ -z "$choice" ]] && choice="4"
    fi

    local model_name
    case "$choice" in
        1) model_name="base" ;;
        2) model_name="small" ;;
        3) model_name="medium" ;;
        4) model_name="large-v3-q5_0" ;;
        5) model_name="large-v3" ;;
        *) model_name="large-v3-q5_0" ;;
    esac

    local target="$MODEL_DIR/ggml-${model_name}.bin"
    local url="https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model_name}.bin"

    info "下载 ggml-${model_name}.bin（这一步可能要几分钟到十几分钟，取决于你的网络）..."
    if curl -L --fail --progress-bar "$url" -o "$target.partial"; then
        mv "$target.partial" "$target"
        ok "模型已保存: $target"
        write_model_to_config "$target"
    else
        rm -f "$target.partial"
        warn "模型下载失败。手动下载方法："
        warn "  curl -L $url -o $target"
        warn "下载完成后，再次运行 setup.sh 会自动把模型路径写到 config.json。"
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
trans.setdefault("mode", "local")
trans.setdefault("language", "zh")
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
cfg_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False))
PY
    ok "config.json 已指向该模型"
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

    local agents="claude-code openclaw"

    if [[ "$UPGRADE_MODE" == true ]]; then
        info "升级模式：刷新已注册的 agent skill"
    else
        echo "  使用 vercel-labs/skills 把 Yulu 的 SKILL.md 注册到指定 agent。"
        echo "  注册之后，可以直接对 agent 说"开始录制""停止录制""上次会议聊了什么"，"
        echo "  agent 会看 SKILL.md 学到 Yulu 的命令，自动调用。"
        echo "  默认目标 agent：claude-code openclaw"
        echo "  支持列表见：https://github.com/vercel-labs/skills"
        echo

        prompt "注册 Yulu skill 到 agent？[Y/n]"
        read -r ans
        if [[ "$ans" =~ ^[nN] ]]; then
            info "已跳过 skill 注册。以后想装：npx skills add $REPO_DIR -g -a claude-code -a openclaw -y"
            return
        fi

        prompt "目标 agent（空格分隔，回车使用默认 claude-code openclaw）："
        read -r user_agents
        [[ -n "$user_agents" ]] && agents="$user_agents"
    fi

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

    echo "  1/4 检测器测试"
    local detect_result
    detect_result=$(python3 "$SCRIPT_DIR/meeting_detector.py" once 2>&1)
    if echo "$detect_result" | grep -q "active"; then
        ok "检测器运行正常"
    else
        warn "检测器异常: $detect_result"
    fi

    echo "  2/4 日历测试"
    if python3 "$SCRIPT_DIR/check_meetings.py" today 2>&1; then
        ok "日历读取正常"
    else
        warn "日历读取异常（如果未配置日历则正常）"
    fi

    echo "  3/4 Yulu 录音测试"
    local audio_status
    audio_status=$(echo '{"action":"status"}' | nc -w 2 -U "$HOME/.config/yulu/audio_daemon.sock" 2>/dev/null || true)
    if echo "$audio_status" | grep -q '"sysReady":true' && echo "$audio_status" | grep -q '"micReady":true'; then
        ok "Yulu 运行正常"
    else
        warn "Yulu 异常: $audio_status"
    fi

    echo "  4/4 通知测试"
    if command -v terminal-notifier &>/dev/null; then
        terminal-notifier -title "Yulu" -message "安装完成！" -sound default 2>/dev/null || true
        ok "通知测试通过"
    fi

    echo
    ok "安装验证完成！"
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
    echo "  跳过已配置项；只补缺失或更新过的内容。"
    echo
else
    echo -e "${BLUE}"
    echo "  ╔══════════════════════════════════════════╗"
    echo "  ║              Yulu 安装脚本               ║"
    echo "  ╚══════════════════════════════════════════╝"
    echo -e "${NC}"
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
compile_scanner
compile_audio_daemon
download_whisper_model
setup_calendar
install_launchagents
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
