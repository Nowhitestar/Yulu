#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SMOKE_ROOT="$(mktemp -d /private/tmp/yulu-app-smoke.XXXXXX)"

cleanup() {
  case "$SMOKE_ROOT" in
    /private/tmp/yulu-app-smoke.*) rm -rf "$SMOKE_ROOT" ;;
  esac
}
trap cleanup EXIT

NODE_BIN=""
for candidate in \
  "${YULU_DEV_NODE:-}" \
  "/opt/homebrew/opt/node@24/bin/node" \
  "$(command -v node || true)"; do
  if [[ -n "$candidate" && -x "$candidate" ]] && (
    cd "$SCRIPT_DIR/yulu_ui"
    "$candidate" -e 'require("better-sqlite3")'
  ) >/dev/null 2>&1; then
    NODE_BIN="$candidate"
    break
  fi
done
if [[ -z "$NODE_BIN" ]]; then
  echo "A Node binary compatible with the installed better-sqlite3 build is required" >&2
  exit 69
fi

(
  cd "$SCRIPT_DIR/yulu_ui"
  npm run build
)

APP="$SMOKE_ROOT/Yulu.app"
YULU_APP_OUTPUT_PATH="$APP" \
YULU_BUNDLE_DEVELOPMENT_HOST=1 \
YULU_CODESIGN_IDENTITY=- \
YULU_SWIFT_MODULE_CACHE_PATH="$SMOKE_ROOT/swift-module-cache" \
bash "$SCRIPT_DIR/build_audio_daemon.sh"

PORT="$((30000 + ($$ % 20000)))"
mkdir -p "$SMOKE_ROOT/home"
mkdir -p "$SMOKE_ROOT/home/.config/yulu"
cp "$SCRIPT_DIR/config.example.json" "$SMOKE_ROOT/home/.config/yulu/config.json"
HOME="$SMOKE_ROOT/home" \
YULU_DEV_NODE="$NODE_BIN" \
YULU_DEV_SCRIPT_DIR="$SCRIPT_DIR" \
YULU_UI_PORT="$PORT" \
"$APP/Contents/MacOS/yulu_app" --development-smoke
