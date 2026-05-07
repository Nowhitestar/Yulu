#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP="$SCRIPT_DIR/AudioDaemon.app"
BIN="$SCRIPT_DIR/audio_daemon"
APP_BIN="$APP/Contents/MacOS/audio_daemon"
INFO="$APP/Contents/Info.plist"

cd "$SCRIPT_DIR"

swiftc -o "$BIN" audio_daemon.swift \
  -framework Cocoa \
  -framework ScreenCaptureKit \
  -framework AVFoundation \
  -framework CoreMedia \
  -framework CoreAudio

mkdir -p "$APP/Contents/MacOS"
cp "$BIN" "$APP_BIN"
chmod +x "$APP_BIN"

# Force-write the Info.plist fields that govern macOS identity and TCC prompts,
# so this script is the single source of truth.
plist_set_or_add() {
  local key="$1" type="$2" value="$3"
  /usr/libexec/PlistBuddy -c "Set :$key $value" "$INFO" >/dev/null 2>&1 || \
    /usr/libexec/PlistBuddy -c "Add :$key $type $value" "$INFO" >/dev/null 2>&1 || true
}

plist_set_or_add CFBundleIdentifier      string  com.yulu.audiodaemon
plist_set_or_add CFBundleName            string  "Yulu AudioDaemon"
plist_set_or_add CFBundleDisplayName     string  "Yulu AudioDaemon"
plist_set_or_add NSMicrophoneUsageDescription   string  "Yulu records microphone audio for meeting notes."
plist_set_or_add NSScreenCaptureUsageDescription string "Yulu captures system audio for meeting notes."

# Code-signing identity selection.
#
# Order:
#   1. $YULU_CODESIGN_IDENTITY  — explicit override.
#   2. First "Developer ID Application" identity  — best for distribution.
#   3. First "Apple Development" / "Mac Developer" identity  — fine for local use.
#   4. Ad-hoc ("-")             — last-resort fallback; no Gatekeeper trust.
IDENTITY="${YULU_CODESIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | awk -F'"' '/Developer ID Application/ {print $2; exit}')"
fi
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | awk -F'"' '/Apple Development|Mac Developer/ {print $2; exit}')"
fi
if [[ -z "$IDENTITY" ]]; then
  echo "⚠️ No code-signing identity found; falling back to ad-hoc signing." >&2
  echo "   Override with: YULU_CODESIGN_IDENTITY=\"Developer ID Application: ...\" $0" >&2
  IDENTITY="-"
fi

codesign --force --deep --timestamp=none --sign "$IDENTITY" "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"

echo "✅ Built and signed AudioDaemon.app"
echo "   identity: $IDENTITY"
codesign -dvvv "$APP" 2>&1 | grep -E 'Identifier|Authority|TeamIdentifier|CDHash|Signature' || true
