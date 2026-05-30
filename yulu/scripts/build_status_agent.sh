#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP="$SCRIPT_DIR/StatusAgent.app"
BIN="$SCRIPT_DIR/status_agent"
APP_BIN="$APP/Contents/MacOS/status_agent"
RES_DIR="$APP/Contents/Resources"
INFO="$APP/Contents/Info.plist"
ICNS_SRC="$REPO_DIR/assets/Yulu.icns"
ICONS_DIR="$SCRIPT_DIR/status_agent_icons"
YULU_VERSION_RAW="$(tr -d '[:space:]' < "$REPO_DIR/VERSION" 2>/dev/null || echo "0.0.0+unknown")"
YULU_BUNDLE_VERSION="${YULU_VERSION_RAW%%[-+]*}"
YULU_BUILD_NUMBER="$(git -C "$REPO_DIR" rev-list --count HEAD 2>/dev/null || echo 0)"

cd "$SCRIPT_DIR"

swiftc -o "$BIN" status_agent.swift \
  -framework Cocoa \
  -framework Carbon

mkdir -p "$APP/Contents/MacOS" "$RES_DIR"
cp "$BIN" "$APP_BIN"
chmod +x "$APP_BIN"

if [[ -d "$ICONS_DIR" ]]; then
    cp "$ICONS_DIR"/*.png "$RES_DIR/" 2>/dev/null || true
fi
if [[ -f "$ICNS_SRC" ]]; then
    cp "$ICNS_SRC" "$RES_DIR/Yulu.icns"
fi

plist_set_or_add() {
    local key="$1" type="$2" value="$3"
    /usr/libexec/PlistBuddy -c "Set :$key $value" "$INFO" >/dev/null 2>&1 || \
        /usr/libexec/PlistBuddy -c "Add :$key $type $value" "$INFO" >/dev/null 2>&1 || true
}

plist_set_or_add CFBundleExecutable         string  status_agent
plist_set_or_add CFBundleIdentifier         string  com.yulu.statusagent
plist_set_or_add CFBundleName               string  "Yulu Status Agent"
plist_set_or_add CFBundleDisplayName        string  "Yulu Status Agent"
plist_set_or_add CFBundleShortVersionString string  "$YULU_BUNDLE_VERSION"
plist_set_or_add CFBundleVersion            string  "$YULU_BUILD_NUMBER"
plist_set_or_add YuluVersion                string  "$YULU_VERSION_RAW"
plist_set_or_add CFBundleIconFile           string  Yulu
plist_set_or_add LSUIElement                bool    true
plist_set_or_add NSAppleEventsUsageDescription string "Yulu Status Agent opens the inbox in Terminal."

# Code-signing identity selection (same logic as build_audio_daemon.sh)
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
    IDENTITY="-"
fi
# Sign bottom-up with the hardened runtime, a secure timestamp, and the
# least-privilege entitlements (same rationale as build_audio_daemon.sh: no deep
# recursive signing, real secure timestamp): inner Mach-O first, then the bundle.
ENTITLEMENTS="$SCRIPT_DIR/StatusAgent.app.entitlements"
codesign --force --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP_BIN"
codesign --force --options runtime --timestamp \
    --entitlements "$ENTITLEMENTS" --sign "$IDENTITY" "$APP"
codesign --verify --strict --verbose=2 "$APP"
codesign --display --entitlements :- "$APP"

echo "✅ Built and signed StatusAgent.app"
echo "   version: $YULU_VERSION_RAW (bundle $YULU_BUNDLE_VERSION, build $YULU_BUILD_NUMBER)"
