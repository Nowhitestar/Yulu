#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP="$SCRIPT_DIR/Yulu.app"
BIN="$SCRIPT_DIR/audio_daemon"
KEYCHAIN_BIN="$SCRIPT_DIR/xai_keychain"
APP_BIN="$APP/Contents/MacOS/audio_daemon"
APP_KEYCHAIN_BIN="$APP/Contents/MacOS/xai_keychain"
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
  -framework CoreAudio \
  -framework AudioToolbox
swiftc -o "$KEYCHAIN_BIN" xai_keychain.swift \
  -framework Security

mkdir -p "$APP/Contents/MacOS" "$RES_DIR"
cp "$BIN" "$APP_BIN"
cp "$KEYCHAIN_BIN" "$APP_KEYCHAIN_BIN"
chmod +x "$APP_BIN"
chmod +x "$APP_KEYCHAIN_BIN"

# Bundle the Yulu icon so System Settings, the Dock, TCC prompts, and
# terminal-notifier (via -sender com.yulu.audiodaemon) all show the
# current blue liquid-glass Yulu logo instead of a generic placeholder.
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
# NSAudioCaptureUsageDescription drives the macOS 14.4+ Core Audio process-tap
# prompt ("System Audio Recording Only" scope). Required for the tap arm
# (Pitfall 4); the SCK arm uses NSScreenCaptureUsageDescription above.
plist_set_or_add NSAudioCaptureUsageDescription string "Yulu captures system audio for meeting notes."

# Code-signing identity selection.
#
# Order:
#   1. $YULU_CODESIGN_IDENTITY  — explicit override.
#   2. First "Developer ID Application" identity  — best for distribution.
#   3. First "Apple Development" / "Mac Developer" identity  — fine for local use.
#   4. Ad-hoc ("-")             — last-resort fallback; no Gatekeeper trust.
IDENTITY="${YULU_CODESIGN_IDENTITY:-}"
# Auto-detect selects by the 40-char SHA-1 HASH (whitespace field 2), NOT the
# human-readable name. A name like "Developer ID Application: NAME (TEAMID)" can
# match MORE THAN ONE cert — e.g. the same identity present in both the login and
# System keychains — and then `codesign --sign "<name>"` aborts with
# "ambiguous (matches ... and ...)". With set -e that kills the whole build and the
# app is left linker-ad-hoc WITHOUT the hardened-runtime entitlements, so mic/system
# capture fail at runtime (kAUStartIO). The hash is unique, so signing never aborts
# on a duplicated identity. (An explicit $YULU_CODESIGN_IDENTITY name is honored
# as-is: CI imports exactly one identity into an ephemeral keychain, so it is unique.)
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | awk '/Developer ID Application/ {print $2; exit}')"
fi
if [[ -z "$IDENTITY" ]]; then
  IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
    | awk '/Apple Development|Mac Developer/ {print $2; exit}')"
fi
if [[ -z "$IDENTITY" ]]; then
  echo "⚠️ No code-signing identity found; falling back to ad-hoc signing." >&2
  echo "   Override with: YULU_CODESIGN_IDENTITY=\"Developer ID Application: ...\" $0" >&2
  IDENTITY="-"
fi

# Sign bottom-up with the hardened runtime, a secure timestamp, and the
# least-privilege entitlements. We do NOT use deep recursive signing (it only
# signs Mach-O files and re-signs nested code with the wrong flags), and we use
# a real secure timestamp (an unsigned/absent timestamp makes notarization fail).
#   1. inner Mach-O first ($APP_BIN), then 2. the bundle ($APP).
ENTITLEMENTS="$SCRIPT_DIR/Yulu.app.entitlements"
codesign --force --options runtime --timestamp \
  --sign "$IDENTITY" "$APP_KEYCHAIN_BIN"
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP_BIN"
codesign --force --options runtime --timestamp \
  --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP"
codesign --verify --strict --verbose=2 "$APP"
codesign --display --entitlements :- "$APP"

echo "✅ Built and signed Yulu.app"
echo "   version: $YULU_VERSION_RAW (bundle $YULU_BUNDLE_VERSION, build $YULU_BUILD_NUMBER)"
echo "   identity: $IDENTITY"
codesign -dvvv "$APP" 2>&1 | grep -E 'Identifier|Authority|TeamIdentifier|CDHash|Signature|Version' || true
