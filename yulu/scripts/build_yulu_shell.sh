#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUTPUT="${1:?Usage: build_yulu_shell.sh OUTPUT [swiftc flags]}"
shift
MODULE_DIR="$(mktemp -d "${TMPDIR:-/private/tmp}/yulu-native-recording.XXXXXX")"
trap 'rm -r -- "$MODULE_DIR"' EXIT
SWIFT_CACHE="${YULU_SWIFT_MODULE_CACHE_PATH:-/private/tmp/yulu-swift-module-cache}"
mkdir -p "$SWIFT_CACHE"

# Link the existing native implementation into the shell, not another app or
# launchd owner. The module keeps its legacy entry point and globals isolated.
swiftc -target arm64-apple-macosx13.0 -module-cache-path "$SWIFT_CACHE" \
  -parse-as-library -D YULU_NATIVE_RECORDING_LIBRARY \
  -emit-library -static -emit-module -module-name YuluNativeRecording \
  -emit-module-path "$MODULE_DIR/YuluNativeRecording.swiftmodule" \
  -o "$MODULE_DIR/libYuluNativeRecording.a" "$SCRIPT_DIR/status_agent.swift" \
  -framework Cocoa -framework Carbon -framework WebKit
swiftc -target arm64-apple-macosx13.0 -module-cache-path "$SWIFT_CACHE" \
  -I "$MODULE_DIR" -L "$MODULE_DIR" -lYuluNativeRecording \
  -o "$OUTPUT" "$SCRIPT_DIR/yulu_app.swift" \
  -framework Cocoa -framework Carbon -framework ServiceManagement \
  -framework WebKit -framework Security "$@"
