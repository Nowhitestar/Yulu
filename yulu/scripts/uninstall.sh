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
DRY_RUN=false
JSON=false
KEEP_DATA=true
KEEP_RECORDINGS=true
KEEP_SKILLS=true
KEEP_BACKUPS=true

for arg in "$@"; do
    case "$arg" in
        -y|--yes)            ASSUME_YES=true ;;
        --dry-run|--plan)    DRY_RUN=true ;;
        --json)              JSON=true ;;
        --purge)             KEEP_DATA=false; KEEP_RECORDINGS=false; KEEP_SKILLS=false; KEEP_BACKUPS=false ;;
        --purge-config)      KEEP_DATA=false ;;
        --purge-recordings)  KEEP_RECORDINGS=false ;;
        --purge-skills)      KEEP_SKILLS=false ;;
        --purge-backups)     KEEP_BACKUPS=false ;;
        -h|--help)
            cat <<EOF
Usage: yulu uninstall [options]

By default this removes services, the CLI, and the repo, but keeps your
recordings, your config, and registered agent skills.

Options:
  -y, --yes              Don't prompt for the optional removals — accept defaults
  --dry-run, --plan      Print what would be removed, then exit without changes
  --json                 With --dry-run/--plan, print the uninstall plan as JSON
  --purge                Also remove ~/.config/yulu, ~/Movies/Yulu, agent skills
  --purge-config         Remove ~/.config/yulu (config, models, logs)
  --purge-recordings     Remove the recordings directory (~/Movies/Yulu by default)
  --purge-skills         Run \`npx skills remove yulu\` for all registered agents
  --purge-backups        Remove ~/.yulu.backup-* runtime backups
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
PKG_IDENTIFIER="${YULU_PKG_IDENTIFIER:-com.yulu.installer}"
VISIBLE_APP="${YULU_VISIBLE_APP:-/Applications/Yulu.app}"
PKG_RUNTIME_ROOT="${YULU_PKG_RUNTIME_ROOT:-/Library/Application Support/Yulu/runtime}"
PKG_SUPPORT_DIR="$(dirname "$PKG_RUNTIME_ROOT")"

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
BACKUP_PARENT="$(dirname "$REPO_DIR")"
BACKUP_PATTERN="$(basename "$REPO_DIR").backup-*"

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

pkg_installed() {
    command -v pkgutil >/dev/null 2>&1 && pkgutil --pkg-info "$PKG_IDENTIFIER" >/dev/null 2>&1
}

path_state() {
    local path="$1"
    [[ -e "$path" || -L "$path" ]] && printf 'true' || printf 'false'
}

backup_count() {
    find "$BACKUP_PARENT" -maxdepth 1 -name "$BACKUP_PATTERN" -type d 2>/dev/null | wc -l | tr -d ' '
}

print_json_plan() {
    python3 - "$LAUNCH_AGENTS_DIR" "$LOCAL_BIN/yulu" "$REPO_DIR" "$CONFIG_DIR" "$RECORDING_DIR" \
        "$VISIBLE_APP" "$PKG_RUNTIME_ROOT" "$PKG_IDENTIFIER" "$(path_state "$VISIBLE_APP")" \
        "$(path_state "$PKG_RUNTIME_ROOT")" "$(pkg_installed && echo true || echo false)" \
        "$(backup_count)" "$KEEP_DATA" "$KEEP_RECORDINGS" "$KEEP_SKILLS" "$KEEP_BACKUPS" <<'PY'
import json
import sys

(
    launch_agents,
    cli,
    repo,
    config,
    recordings,
    visible_app,
    pkg_runtime,
    pkg_identifier,
    visible_app_present,
    pkg_runtime_present,
    pkg_receipt_present,
    backups,
    keep_data,
    keep_recordings,
    keep_skills,
    keep_backups,
) = sys.argv[1:]

def b(value):
    return str(value).lower() == "true"

print(json.dumps({
    "schema": 1,
    "dry_run": True,
    "remove": {
        "launch_agents_glob": f"{launch_agents}/com.yulu.*.plist",
        "cli": cli,
        "repo": repo,
        "visible_app": visible_app,
        "pkg_runtime": pkg_runtime,
        "pkg_receipt": pkg_identifier,
    },
    "optional": {
        "config": {"path": config, "remove": not b(keep_data)},
        "recordings": {"path": recordings, "remove": not b(keep_recordings)},
        "agent_skills": {"remove": not b(keep_skills)},
        "runtime_backups": {"parent": str(__import__("pathlib").Path(repo).parent), "count": int(backups or 0), "remove": not b(keep_backups)},
    },
    "detected": {
        "visible_app_present": b(visible_app_present),
        "pkg_runtime_present": b(pkg_runtime_present),
        "pkg_receipt_present": b(pkg_receipt_present),
    },
    "kept": {
        "tcc_permissions": True,
        "homebrew_packages": True,
    },
}, ensure_ascii=False, indent=2))
PY
}

if [[ "$DRY_RUN" == true && "$JSON" == true ]]; then
    print_json_plan
    exit 0
fi

# ─── Plan ────────────────────────────────────────────────────────

header "Yulu uninstall"
echo "Will remove:"
echo "  • LaunchAgents:      $LAUNCH_AGENTS_DIR/com.yulu.*.plist"
echo "  • CLI:               $LOCAL_BIN/yulu"
echo "  • Repo:              $REPO_DIR (if at \$HOME/.yulu)"
echo "  • App bundle:        $VISIBLE_APP"
echo "  • Pkg runtime:       $PKG_RUNTIME_ROOT"
echo "  • Pkg receipt:       $PKG_IDENTIFIER (if present)"
echo
echo "Will ask about:"
echo "  • Config + models:   $CONFIG_DIR"
echo "  • Recordings:        $RECORDING_DIR"
echo "  • Agent skills:      ~/.<agent>/skills/yulu/"
echo "  • Runtime backups:   $BACKUP_PARENT/$BACKUP_PATTERN ($(backup_count) found)"
echo
echo "Will NOT touch:"
echo "  • macOS TCC entries (Microphone, Screen Recording, Accessibility)"
echo "  • Homebrew packages (whisper-cpp, ffmpeg, sox, terminal-notifier, gogcli, cloudflared)"
echo

if [[ "$DRY_RUN" == true ]]; then
    info "Dry run only — no files or services were changed."
    exit 0
fi

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
pkill -f "yulu_ui/dist/server.js" 2>/dev/null && ok "killed running yulu_ui server" || true

# ─── 3. Remove yulu CLI symlink ──────────────────────────────────

if [[ -L "$LOCAL_BIN/yulu" || -f "$LOCAL_BIN/yulu" ]]; then
    rm -f "$LOCAL_BIN/yulu"
    ok "removed $LOCAL_BIN/yulu"
fi

# ─── 3b. Remove pkg-installed visible app/runtime/receipt ───────────

remove_path() {
    local path="$1"
    local label="$2"
    if [[ ! -e "$path" && ! -L "$path" ]]; then
        info "$label not present: $path"
        return
    fi
    if rm -rf "$path" 2>/dev/null; then
        ok "removed $label: $path"
    else
        warn "could not remove $label: $path"
        warn "  Try with admin privileges: sudo rm -rf \"$path\""
    fi
}

header "Package payload"
remove_path "$VISIBLE_APP" "visible app"
remove_path "$PKG_RUNTIME_ROOT" "pkg runtime"
if [[ -d "$PKG_SUPPORT_DIR" ]]; then
    rmdir "$PKG_SUPPORT_DIR" 2>/dev/null || true
fi
if pkg_installed; then
    if pkgutil --forget "$PKG_IDENTIFIER" >/dev/null 2>&1; then
        ok "forgot pkg receipt $PKG_IDENTIFIER"
    else
        warn "could not forget pkg receipt $PKG_IDENTIFIER"
        warn "  Try with admin privileges: sudo pkgutil --forget $PKG_IDENTIFIER"
    fi
else
    info "pkg receipt not present: $PKG_IDENTIFIER"
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

header "Agent MCP cleanup"
PYTHONPATH="$SCRIPT_DIR:${PYTHONPATH:-}" "${PYTHON:-python3}" -m provision.cli mcp remove --detected-only --non-fatal \
    || warn "Yulu MCP cleanup failed (continuing uninstall)"

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

# ─── 6b. Optional: runtime backups ─────────────────────────────────

header "Runtime backups"
backup_total="$(backup_count)"
if [[ "$backup_total" == "0" ]]; then
    info "No runtime backups found at $BACKUP_PARENT/$BACKUP_PATTERN"
else
    info "Found $backup_total runtime backup(s) at $BACKUP_PARENT/$BACKUP_PATTERN"
    if [[ "$KEEP_BACKUPS" == true ]] && ask_yes_no "Remove runtime backups?" "n"; then
        KEEP_BACKUPS=false
    fi
    if [[ "$KEEP_BACKUPS" != true ]]; then
        while IFS= read -r backup; do
            [[ -n "$backup" ]] || continue
            rm -rf "$backup"
            ok "removed $backup"
        done < <(find "$BACKUP_PARENT" -maxdepth 1 -name "$BACKUP_PATTERN" -type d 2>/dev/null)
    else
        info "Keeping runtime backups"
    fi
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
