#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP="$SCRIPT_DIR/Yulu.app"
BIN="$SCRIPT_DIR/audio_daemon"
APP_BIN="$APP/Contents/MacOS/audio_daemon"
RES_DIR="$APP/Contents/Resources"
INFO="$APP/Contents/Info.plist"
ICNS_SRC="$REPO_DIR/assets/Yulu.icns"
YULU_VERSION_RAW="$(tr -d '[:space:]' < "$REPO_DIR/VERSION" 2>/dev/null || echo "0.0.0+unknown")"
YULU_BUNDLE_VERSION="${YULU_VERSION_RAW%%[-+]*}"
YULU_BUILD_NUMBER="$(git -C "$REPO_DIR" rev-list --count HEAD 2>/dev/null || echo 0)"

cd "$SCRIPT_DIR"

swiftc -o "$BIN" audio_daemon.swift \
  -framework Cocoa \
  -framework ScreenCaptureKit \
  -framework AVFoundation \
  -framework CoreMedia \
  -framework CoreAudio

mkdir -p "$APP/Contents/MacOS" "$RES_DIR"
cp "$BIN" "$APP_BIN"
chmod +x "$APP_BIN"

# Bundle the Yulu icon so System Settings, the Dock, TCC prompts, and
# terminal-notifier (via -sender com.yulu.audiodaemon) all show the
# parchment-and-ink 语 logo instead of a generic placeholder.
if [[ -f "$ICNS_SRC" ]]; then
  cp "$ICNS_SRC" "$RES_DIR/Yulu.icns"
else
  echo "⚠️ assets/Yulu.icns missing — bundle will have no icon." >&2
fi

# Force-write the Info.plist fields that govern macOS identity, icon, and
# TCC prompt copy. This script is the single source of truth.
plist_set_or_add() {
  local key="$1" type="$2" value="$3"
  /usr/libexec/PlistBuddy -c "Set :$key $value" "$INFO" >/dev/null 2>&1 || \
    /usr/libexec/PlistBuddy -c "Add :$key $type $value" "$INFO" >/dev/null 2>&1 || true
}

plist_set_or_add CFBundleIdentifier      string  com.yulu.audiodaemon
plist_set_or_add CFBundleName            string  Yulu
plist_set_or_add CFBundleDisplayName     string  Yulu
plist_set_or_add CFBundleShortVersionString string "$YULU_BUNDLE_VERSION"
plist_set_or_add CFBundleVersion         string  "$YULU_BUILD_NUMBER"
plist_set_or_add YuluVersion             string  "$YULU_VERSION_RAW"
plist_set_or_add CFBundleIconFile        string  Yulu
plist_set_or_add CFBundleIconName        string  Yulu
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

echo "✅ Built and signed Yulu.app"
echo "   version: $YULU_VERSION_RAW (bundle $YULU_BUNDLE_VERSION, build $YULU_BUILD_NUMBER)"
echo "   identity: $IDENTITY"
codesign -dvvv "$APP" 2>&1 | grep -E 'Identifier|Authority|TeamIdentifier|CDHash|Signature|Version' || true
