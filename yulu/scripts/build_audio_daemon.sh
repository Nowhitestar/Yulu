#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP="$SCRIPT_DIR/Yulu.app"
APP_TEMPLATE="$APP"
if [[ -n "${YULU_APP_OUTPUT_PATH:-}" ]]; then
  case "$YULU_APP_OUTPUT_PATH" in
    /*.app) APP="$YULU_APP_OUTPUT_PATH" ;;
    *) echo "YULU_APP_OUTPUT_PATH must be an absolute .app path" >&2; exit 64 ;;
  esac
  if [[ -e "$APP" ]]; then
    echo "YULU_APP_OUTPUT_PATH already exists: $APP" >&2
    exit 73
  fi
fi
BIN="$SCRIPT_DIR/audio_daemon"
KEYCHAIN_BIN="$SCRIPT_DIR/xai_keychain"
SHELL_BIN="$APP/Contents/MacOS/yulu_app"
CAPTURE_APP="$APP/Contents/Helpers/YuluCapture.app"
APP_BIN="$CAPTURE_APP/Contents/MacOS/audio_daemon"
LEGACY_APP_BIN="$APP/Contents/MacOS/audio_daemon"
APP_KEYCHAIN_BIN="$APP/Contents/MacOS/xai_keychain"
APP_CALENDAR_BIN="$APP/Contents/MacOS/calendar_probe"
RES_DIR="$APP/Contents/Resources"
INFO="$APP/Contents/Info.plist"
CAPTURE_INFO="$CAPTURE_APP/Contents/Info.plist"
ICNS_SRC="$REPO_DIR/assets/Yulu.icns"
YULU_VERSION_RAW="$(tr -d '[:space:]' < "$REPO_DIR/VERSION" 2>/dev/null || echo "0.0.0+unknown")"
YULU_BUNDLE_VERSION="${YULU_VERSION_RAW%%[-+]*}"
YULU_BUILD_NUMBER="$(git -C "$REPO_DIR" rev-list --count HEAD 2>/dev/null || echo 0)"
SWIFT_TARGET=(-target arm64-apple-macosx13.0)
SWIFT_MODULE_CACHE="${YULU_SWIFT_MODULE_CACHE_PATH:-/private/tmp/yulu-swift-module-cache}"
SWIFT_TARGET+=(-module-cache-path "$SWIFT_MODULE_CACHE")
SHELL_SWIFT_FLAGS=()
if [[ "${YULU_BUNDLE_DEVELOPMENT_HOST:-0}" == "1" ]]; then
  SHELL_SWIFT_FLAGS=(-D YULU_DEVELOPMENT_SMOKE)
fi
BUNDLE_APPLICATION_RUNTIME="${YULU_BUNDLE_APPLICATION_RUNTIME:-0}"

cd "$SCRIPT_DIR"

mkdir -p "$SWIFT_MODULE_CACHE"
if [[ "$APP" != "$APP_TEMPLATE" ]]; then
  mkdir -p "$APP/Contents/Helpers/YuluCapture.app/Contents"
  cp "$APP_TEMPLATE/Contents/Info.plist" "$APP/Contents/Info.plist"
  cp "$APP_TEMPLATE/Contents/Helpers/YuluCapture.app/Contents/Info.plist" \
    "$APP/Contents/Helpers/YuluCapture.app/Contents/Info.plist"
  cp -R "$APP_TEMPLATE/Contents/Library" "$APP/Contents/Library"
fi
mkdir -p "$APP/Contents/MacOS" "$CAPTURE_APP/Contents/MacOS" "$RES_DIR"

swiftc "${SWIFT_TARGET[@]}" "${SHELL_SWIFT_FLAGS[@]}" -o "$SHELL_BIN" yulu_app.swift \
  -framework Cocoa \
  -framework ServiceManagement \
  -framework WebKit
swiftc "${SWIFT_TARGET[@]}" -o "$BIN" audio_daemon.swift \
  -framework Cocoa \
  -framework ScreenCaptureKit \
  -framework AVFoundation \
  -framework CoreMedia \
  -framework CoreAudio \
  -framework AudioToolbox
swiftc "${SWIFT_TARGET[@]}" -o "$KEYCHAIN_BIN" xai_keychain.swift \
  -framework Security
swiftc "${SWIFT_TARGET[@]}" -o "$APP_CALENDAR_BIN" calendar_probe.swift \
  -framework EventKit \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist \
  -Xlinker "$SCRIPT_DIR/calendar_probe-Info.plist"

cp "$BIN" "$APP_BIN"
# Keep the historical binary path during the pre-migration development window.
# The visible shell and the legacy launch path both execute the same signed build;
# normal product supervision uses the nested Capture bundle above.
cp "$BIN" "$LEGACY_APP_BIN"
cp "$KEYCHAIN_BIN" "$APP_KEYCHAIN_BIN"
chmod +x "$APP_BIN"
chmod +x "$LEGACY_APP_BIN"
chmod +x "$SHELL_BIN"
chmod +x "$APP_KEYCHAIN_BIN"
chmod +x "$APP_CALENDAR_BIN"

# Bundle the Yulu icon so System Settings, the Dock, TCC prompts, and
# terminal-notifier (via -sender com.yulu.audiodaemon) all show the
# current blue liquid-glass Yulu logo instead of a generic placeholder.
if [[ -f "$ICNS_SRC" ]]; then
  cp "$ICNS_SRC" "$RES_DIR/Yulu.icns"
else
  echo "⚠️ assets/Yulu.icns missing — bundle will have no icon." >&2
fi

DEVELOPMENT_HOST_NATIVE=""
if [[ "$BUNDLE_APPLICATION_RUNTIME" == "1" ]]; then
  bash "$REPO_DIR/packaging/scripts/prepare_application_runtime.sh" "$APP"
elif [[ "${YULU_BUNDLE_DEVELOPMENT_HOST:-0}" == "1" ]]; then
  UI_DIR="$SCRIPT_DIR/yulu_ui"
  HOST_DIR="$RES_DIR/Host"
  for required in \
    "$UI_DIR/dist/server.js" \
    "$UI_DIR/dist/web/index.html" \
    "$UI_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node"; do
    if [[ ! -f "$required" ]]; then
      echo "development Host artifact missing: $required" >&2
      exit 66
    fi
  done
  mkdir -p "$HOST_DIR/node_modules"
  cp "$UI_DIR/dist/server.js" "$HOST_DIR/server.js"
  if [[ -f "$UI_DIR/dist/server.js.map" ]]; then
    cp "$UI_DIR/dist/server.js.map" "$HOST_DIR/server.js.map"
  fi
  cp -R "$UI_DIR/dist/web" "$HOST_DIR/web"
  cp -R "$UI_DIR/node_modules/better-sqlite3" "$HOST_DIR/node_modules/better-sqlite3"
  cp -R "$UI_DIR/node_modules/bindings" "$HOST_DIR/node_modules/bindings"
  cp -R "$UI_DIR/node_modules/file-uri-to-path" "$HOST_DIR/node_modules/file-uri-to-path"
  DEVELOPMENT_HOST_NATIVE="$HOST_DIR/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
fi

# Force-write the Info.plist fields that govern macOS identity, icon, and
# TCC prompt copy. This script is the single source of truth.
plist_set_or_add() {
  local plist="$1" key="$2" type="$3" value="$4"
  /usr/libexec/PlistBuddy -c "Set :$key $value" "$plist" >/dev/null 2>&1 || \
    /usr/libexec/PlistBuddy -c "Add :$key $type $value" "$plist" >/dev/null 2>&1 || true
}

plist_set_or_add "$INFO" CFBundleExecutable string yulu_app
plist_set_or_add "$INFO" CFBundleIdentifier string com.yulu.app
plist_set_or_add "$INFO" CFBundleName string Yulu
plist_set_or_add "$INFO" CFBundleDisplayName string Yulu
plist_set_or_add "$INFO" CFBundleShortVersionString string "$YULU_BUNDLE_VERSION"
plist_set_or_add "$INFO" CFBundleVersion string "$YULU_BUILD_NUMBER"
plist_set_or_add "$INFO" YuluVersion string "$YULU_VERSION_RAW"
plist_set_or_add "$INFO" CFBundleIconFile string Yulu
plist_set_or_add "$INFO" CFBundleIconName string Yulu

plist_set_or_add "$CAPTURE_INFO" CFBundleExecutable string audio_daemon
plist_set_or_add "$CAPTURE_INFO" CFBundleIdentifier string com.yulu.audiodaemon
plist_set_or_add "$CAPTURE_INFO" CFBundleName string "Yulu Capture"
plist_set_or_add "$CAPTURE_INFO" CFBundleDisplayName string "Yulu Capture"
plist_set_or_add "$CAPTURE_INFO" CFBundleShortVersionString string "$YULU_BUNDLE_VERSION"
plist_set_or_add "$CAPTURE_INFO" CFBundleVersion string "$YULU_BUILD_NUMBER"
plist_set_or_add "$CAPTURE_INFO" YuluVersion string "$YULU_VERSION_RAW"
plist_set_or_add "$CAPTURE_INFO" LSUIElement bool true
plist_set_or_add "$CAPTURE_INFO" NSMicrophoneUsageDescription string "Yulu records microphone audio for meeting notes."
plist_set_or_add "$CAPTURE_INFO" NSScreenCaptureUsageDescription string "Yulu captures system audio for meeting notes."
# NSAudioCaptureUsageDescription drives the macOS 14.4+ Core Audio process-tap
# prompt ("System Audio Recording Only" scope). Required for the tap arm
# (Pitfall 4); the SCK arm uses NSScreenCaptureUsageDescription above.
plist_set_or_add "$CAPTURE_INFO" NSAudioCaptureUsageDescription string "Yulu captures system audio for meeting notes."
plist_set_or_add "$INFO" NSCalendarsUsageDescription string "Yulu reads your calendars to offer recording reminders for scheduled meetings."
plist_set_or_add "$INFO" NSCalendarsFullAccessUsageDescription string "Yulu reads your calendars to offer recording reminders for scheduled meetings."

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
CAPTURE_ENTITLEMENTS="$SCRIPT_DIR/Yulu.app.entitlements"
SHELL_ENTITLEMENTS="$SCRIPT_DIR/YuluShell.app.entitlements"
NODE_ENTITLEMENTS="$SCRIPT_DIR/NodeRuntime.entitlements"
if [[ "$IDENTITY" == "-" ]]; then
  # Ad-hoc signatures have no Team ID, so hardened Node cannot otherwise load
  # the separately signed native addon during local builds and smoke tests.
  NODE_ENTITLEMENTS="$SCRIPT_DIR/NodeRuntimeAdHoc.entitlements"
fi
codesign --force --options runtime --timestamp \
  --sign "$IDENTITY" "$APP_KEYCHAIN_BIN"
codesign --force --options runtime --timestamp \
  --sign "$IDENTITY" "$APP_CALENDAR_BIN"
if [[ -n "$DEVELOPMENT_HOST_NATIVE" ]]; then
  codesign --force --options runtime --timestamp \
    --sign "$IDENTITY" "$DEVELOPMENT_HOST_NATIVE"
fi
if [[ "$BUNDLE_APPLICATION_RUNTIME" == "1" ]]; then
  while IFS= read -r -d '' runtime_code; do
    if /usr/bin/file -b "$runtime_code" | grep -q 'Mach-O'; then
      if [[ "$runtime_code" == "$RES_DIR/runtime/bin/node" ]]; then
        codesign --force --options runtime --timestamp \
          --identifier node \
          --entitlements "$NODE_ENTITLEMENTS" --sign "$IDENTITY" "$runtime_code"
      else
        codesign --force --options runtime --timestamp --sign "$IDENTITY" "$runtime_code"
      fi
    fi
  done < <(find "$RES_DIR/runtime" "$RES_DIR/Host" -type f -print0)
fi
codesign --force --options runtime --timestamp \
  --entitlements "$CAPTURE_ENTITLEMENTS" --sign "$IDENTITY" "$APP_BIN"
codesign --force --options runtime --timestamp \
  --entitlements "$CAPTURE_ENTITLEMENTS" --sign "$IDENTITY" "$LEGACY_APP_BIN"
codesign --force --options runtime --timestamp \
  --entitlements "$CAPTURE_ENTITLEMENTS" --sign "$IDENTITY" "$CAPTURE_APP"
codesign --force --options runtime --timestamp \
  --entitlements "$SHELL_ENTITLEMENTS" --sign "$IDENTITY" "$SHELL_BIN"
if [[ "$BUNDLE_APPLICATION_RUNTIME" == "1" ]]; then
  bash "$REPO_DIR/packaging/scripts/verify_application_runtime.sh" --write-inventory "$APP"
fi
codesign --force --options runtime --timestamp \
  --entitlements "$SHELL_ENTITLEMENTS" --sign "$IDENTITY" "$APP"
codesign --verify --strict --verbose=2 "$APP"
if [[ "$BUNDLE_APPLICATION_RUNTIME" == "1" ]]; then
  bash "$REPO_DIR/packaging/scripts/verify_application_runtime.sh" "$APP"
fi
codesign --display --entitlements :- "$APP"

echo "✅ Built and signed Yulu.app"
echo "   version: $YULU_VERSION_RAW (bundle $YULU_BUNDLE_VERSION, build $YULU_BUILD_NUMBER)"
echo "   identity: $IDENTITY"
codesign -dvvv "$APP" 2>&1 | grep -E 'Identifier|Authority|TeamIdentifier|CDHash|Signature|Version' || true
