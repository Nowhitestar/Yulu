#!/usr/bin/env bash
#
# Uninstall Yulu from this machine.
#
# By default, removes:
#   - All com.yulu.* LaunchAgents and unloads them
#   - The yulu CLI symlink at ~/.local/bin/yulu
#   - The repo clone at ~/.yulu (only if Yulu was installed via install.sh)
#
# Asks before removing (data preserved by default):
#   - ~/.config/yulu/  (config, logs, daemon state, downloaded whisper models)
#   - ~/Movies/Yulu/   (your meeting recordings)
#   - Registered agent skills (~/.claude/skills/yulu, ~/.openclaw/skills/yulu, …)
#
# Does not touch:
#   - macOS TCC entries (Microphone, Screen Recording, Accessibility) — those
#     have to be removed manually in System Settings → Privacy & Security
#   - Homebrew packages (sox, ffmpeg, whisper-cpp, terminal-notifier, gogcli,
#     cloudflared) — they may be used by other apps

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

ok()    { printf "${GREEN}✓${NC} %s\n" "$1"; }
warn()  { printf "${YELLOW}⚠${NC} %s\n" "$1"; }
err()   { printf "${RED}✗${NC} %s\n" "$1"; }
info()  { printf "${BLUE}ℹ${NC} %s\n" "$1"; }
header(){ printf "\n${BLUE}━━━ %s ━━━${NC}\n" "$1"; }
prompt(){ printf "${YELLOW}?${NC} %s " "$1"; }

ASSUME_YES=false
KEEP_DATA=true
KEEP_RECORDINGS=true
KEEP_SKILLS=true

for arg in "$@"; do
    case "$arg" in
        -y|--yes)            ASSUME_YES=true ;;
        --purge)             KEEP_DATA=false; KEEP_RECORDINGS=false; KEEP_SKILLS=false ;;
        --purge-config)      KEEP_DATA=false ;;
        --purge-recordings)  KEEP_RECORDINGS=false ;;
        --purge-skills)      KEEP_SKILLS=false ;;
        -h|--help)
            cat <<EOF
Usage: yulu uninstall [options]

By default this removes services, the CLI, and the repo, but keeps your
recordings, your config, and registered agent skills.

Options:
  -y, --yes              Don't prompt for the optional removals — accept defaults
  --purge                Also remove ~/.config/yulu, ~/Movies/Yulu, agent skills
  --purge-config         Remove ~/.config/yulu (config, models, logs)
  --purge-recordings     Remove the recordings directory (~/Movies/Yulu by default)
  --purge-skills         Run \`npx skills remove yulu\` for all registered agents
  -h, --help             Show this help

Note: macOS TCC entries (Microphone / Screen Recording / Accessibility) and
Homebrew packages (whisper-cpp, etc.) are not touched. See the final summary
for manual cleanup pointers.
EOF
            exit 0
            ;;
    esac
done

ask_yes_no() {
    local question="$1"
    local default="${2:-n}"
    if [[ "$ASSUME_YES" == true ]]; then
        [[ "$default" == "y" ]] && return 0 || return 1
    fi
    local hint
    [[ "$default" == "y" ]] && hint="[Y/n]" || hint="[y/N]"
    prompt "$question $hint"
    read -r ans
    if [[ -z "$ans" ]]; then
        [[ "$default" == "y" ]] && return 0 || return 1
    fi
    [[ "$ans" =~ ^[yY] ]] && return 0 || return 1
}

# ─── Resolve install paths ───────────────────────────────────────

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
CONFIG_DIR="$HOME/.config/yulu"
LOCAL_BIN="$HOME/.local/bin"

# Repo can be at ~/.yulu (install.sh default) or wherever the user cloned.
# Resolve from the script's own location.
SOURCE="${BASH_SOURCE[0]}"
while [[ -h "$SOURCE" ]]; do
    DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
    SOURCE="$(readlink "$SOURCE")"
    [[ "$SOURCE" != /* ]] && SOURCE="$DIR/$SOURCE"
done
SCRIPT_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Recording dir — peek at config.json, fall back to default.
RECORDING_DIR="$HOME/Movies/Yulu"
if [[ -f "$CONFIG_DIR/config.json" ]]; then
    cfg_dir="$(python3 -c "
import json
from pathlib import Path
try:
    cfg = json.loads(Path('$CONFIG_DIR/config.json').read_text())
    print(cfg.get('audio', {}).get('output_dir', ''))
except Exception:
    pass
" 2>/dev/null)"
    if [[ -n "$cfg_dir" ]]; then
        RECORDING_DIR="${cfg_dir/#\~/$HOME}"
    fi
fi

# ─── Plan ────────────────────────────────────────────────────────

header "Yulu uninstall"
echo "Will remove:"
echo "  • LaunchAgents:      $LAUNCH_AGENTS_DIR/com.yulu.*.plist"
echo "  • CLI:               $LOCAL_BIN/yulu"
echo "  • Repo:              $REPO_DIR (if at \$HOME/.yulu)"
echo
echo "Will ask about:"
echo "  • Config + models:   $CONFIG_DIR"
echo "  • Recordings:        $RECORDING_DIR"
echo "  • Agent skills:      ~/.<agent>/skills/yulu/"
echo
echo "Will NOT touch:"
echo "  • macOS TCC entries (Microphone, Screen Recording, Accessibility)"
echo "  • Homebrew packages (whisper-cpp, ffmpeg, sox, terminal-notifier, gogcli, cloudflared)"
echo

if ! ask_yes_no "Proceed?" "y"; then
    info "Cancelled"
    exit 0
fi

# ─── 1. Stop and remove LaunchAgents ─────────────────────────────

header "Stopping background services"
found=0
for plist in "$LAUNCH_AGENTS_DIR"/com.yulu.*.plist; do
    [[ -f "$plist" ]] || continue
    found=1
    label="$(basename "$plist" .plist)"
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    ok "removed $label"
done
[[ $found -eq 0 ]] && warn "no Yulu LaunchAgents installed"

# ─── 2. Kill any leftover daemon processes ───────────────────────

pkill -f "Yulu.app/Contents/MacOS/audio_daemon" 2>/dev/null && ok "killed running audio_daemon" || true
pkill -f "yulu/scripts/scheduler_daemon.py" 2>/dev/null || true
pkill -f "yulu/scripts/meeting_detector.py" 2>/dev/null || true

# ─── 3. Remove yulu CLI symlink ──────────────────────────────────

if [[ -L "$LOCAL_BIN/yulu" || -f "$LOCAL_BIN/yulu" ]]; then
    rm -f "$LOCAL_BIN/yulu"
    ok "removed $LOCAL_BIN/yulu"
fi

# ─── 4. Optional: agent skills ───────────────────────────────────

header "Agent skill cleanup"
if [[ "$KEEP_SKILLS" == true ]] && ask_yes_no "Remove the Yulu skill from registered agents (npx skills remove)?" "n"; then
    KEEP_SKILLS=false
fi

if [[ "$KEEP_SKILLS" != true ]]; then
    if command -v npx &>/dev/null; then
        npx -y skills remove yulu -g 2>/dev/null && ok "agent skills removed" || warn "npx skills remove failed (you may not have any registered)"
    else
        warn "npx not available — agent skills (if any) left in place at ~/.<agent>/skills/yulu/"
    fi
else
    info "Keeping agent skills. Remove later: npx skills remove yulu -g"
fi

# ─── 5. Optional: ~/.config/yulu ─────────────────────────────────

header "Config + whisper models"
if [[ -d "$CONFIG_DIR" ]]; then
    if [[ "$KEEP_DATA" == true ]] && ask_yes_no "Remove $CONFIG_DIR (config, daemon state, downloaded whisper models)?" "n"; then
        KEEP_DATA=false
    fi
    if [[ "$KEEP_DATA" != true ]]; then
        rm -rf "$CONFIG_DIR"
        ok "removed $CONFIG_DIR"
    else
        info "Keeping $CONFIG_DIR"
    fi
else
    info "$CONFIG_DIR does not exist — nothing to remove"
fi

# ─── 6. Optional: recordings ─────────────────────────────────────

header "Recordings"
if [[ -d "$RECORDING_DIR" ]]; then
    local_count=$(ls -1 "$RECORDING_DIR"/*.wav 2>/dev/null | wc -l | tr -d ' ')
    info "$RECORDING_DIR contains $local_count recording(s)"
    if [[ "$KEEP_RECORDINGS" == true ]] && ask_yes_no "Delete all recordings?" "n"; then
        KEEP_RECORDINGS=false
    fi
    if [[ "$KEEP_RECORDINGS" != true ]]; then
        rm -rf "$RECORDING_DIR"
        ok "removed $RECORDING_DIR"
    else
        info "Keeping $RECORDING_DIR"
    fi
else
    info "$RECORDING_DIR does not exist — nothing to remove"
fi

# ─── 7. Repo clone (only if it's the install.sh default) ─────────

header "Repo clone"
if [[ -d "$REPO_DIR" && "$REPO_DIR" == "$HOME/.yulu" ]]; then
    if ask_yes_no "Remove the repo at $REPO_DIR?" "y"; then
        # Self-deleting: must cd out first.
        cd "$HOME"
        rm -rf "$REPO_DIR"
        ok "removed $REPO_DIR"
    else
        info "Keeping $REPO_DIR (re-run \`yulu uninstall\` later or rm -rf it manually)"
    fi
elif [[ -d "$REPO_DIR" ]]; then
    info "Repo at $REPO_DIR is not the install.sh default location — leaving it alone."
    echo "  Remove it yourself if you want to: rm -rf \"$REPO_DIR\""
fi

# ─── Summary + manual steps ──────────────────────────────────────

header "Manual cleanup (we don't touch these)"
echo "  • TCC entries:"
echo "      System Settings → Privacy & Security → click each section,"
echo "      remove rows for 'Yulu' / 'window_scanner' / 'AudioDaemon'."
echo
echo "  • Homebrew packages (only if no other app uses them):"
echo "      brew uninstall whisper-cpp ffmpeg sox terminal-notifier"
echo "      brew uninstall steipete/tap/gogcli cloudflared"
echo

ok "Yulu uninstalled."
