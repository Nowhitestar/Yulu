#!/usr/bin/env bash
# Migrate an existing meeting-assistant installation to Yulu.
#
# What this does:
#   1. Move ~/.config/meeting-assistant/  →  ~/.config/yulu/
#   2. Unload the old com.meetingassistant.* LaunchAgents and remove their plists.
#   3. Tell you what to do about TCC re-authorization.
#
# What this does NOT do:
#   - Touch your recordings, transcripts, or summaries.
#   - Re-grant macOS Microphone / Screen Recording permissions (that has to be
#     done by hand in System Settings, because the bundle id changed).
#   - Run setup.sh — run that yourself afterwards.
#
# Safe to run twice: every step is a no-op if the old paths are already gone.

set -euo pipefail

GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; BLUE='\033[0;34m'; NC='\033[0m'
ok(){    printf "${GREEN}✓${NC} %s\n" "$1"; }
note(){  printf "${BLUE}ℹ${NC} %s\n" "$1"; }
warn(){  printf "${YELLOW}⚠${NC} %s\n" "$1"; }
fail(){  printf "${RED}✗${NC} %s\n" "$1"; exit 1; }

OLD_CONFIG="$HOME/.config/meeting-assistant"
NEW_CONFIG="$HOME/.config/yulu"
LA_DIR="$HOME/Library/LaunchAgents"

echo
printf "${BLUE}╔══════════════════════════════════════════════╗${NC}\n"
printf "${BLUE}║      Migrating meeting-assistant → Yulu     ║${NC}\n"
printf "${BLUE}╚══════════════════════════════════════════════╝${NC}\n"
echo

# ── 1. Stop and remove old LaunchAgents ─────────────────────────────────────
note "Step 1/3 — stopping old LaunchAgents"
old_plists=("$LA_DIR"/com.meetingassistant.*.plist)
if [[ -e "${old_plists[0]}" ]]; then
  for plist in "${old_plists[@]}"; do
    label="$(basename "$plist" .plist)"
    launchctl unload "$plist" 2>/dev/null || true
    rm -f "$plist"
    ok "removed $label"
  done
else
  ok "no old LaunchAgents found"
fi

# ── 2. Move config dir ──────────────────────────────────────────────────────
note "Step 2/3 — moving config directory"
if [[ -d "$OLD_CONFIG" && ! -e "$NEW_CONFIG" ]]; then
  mv "$OLD_CONFIG" "$NEW_CONFIG"
  ok "moved $OLD_CONFIG → $NEW_CONFIG"
elif [[ -d "$OLD_CONFIG" && -d "$NEW_CONFIG" ]]; then
  warn "both old and new config dirs exist; leaving them alone."
  warn "  old: $OLD_CONFIG"
  warn "  new: $NEW_CONFIG"
  warn "Inspect, decide what to keep, and remove the old one yourself."
elif [[ -d "$NEW_CONFIG" ]]; then
  ok "config already at $NEW_CONFIG"
else
  ok "no old config to migrate"
fi

# ── 3. Quit and clean the old AudioDaemon process ───────────────────────────
note "Step 3/3 — stopping the old AudioDaemon process"
pkill -f "audio_daemon" 2>/dev/null && ok "killed running audio_daemon process" || ok "no running audio_daemon"

# ── Done ────────────────────────────────────────────────────────────────────
echo
ok "Migration finished."
echo
warn "Manual steps required:"
echo "  1. Re-run the installer to set up the new Yulu LaunchAgents:"
echo "       bash yulu/scripts/setup.sh"
echo
echo "  2. macOS sees the new AudioDaemon as a different app (bundle id changed"
echo "     from com.meetingassistant.audiodaemon to com.yulu.audiodaemon)."
echo "     You will need to GRANT PERMISSIONS AGAIN:"
echo "       System Settings → Privacy & Security →"
echo "         • Microphone                         → enable AudioDaemon.app"
echo "         • Screen & System Audio Recording    → enable AudioDaemon.app"
echo "         • Accessibility (for window_scanner) → already trusted, no action"
echo
echo "  3. (Optional) Remove the stale macOS TCC entry for the old bundle id:"
echo "       System Settings → Privacy & Security → click each section,"
echo "       find any entry called 'AudioDaemon' or 'Meeting Assistant' that"
echo "       is greyed out, click '−' to delete."
echo
