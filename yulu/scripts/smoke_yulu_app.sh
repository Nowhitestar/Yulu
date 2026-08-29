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

(
  cd "$SCRIPT_DIR/yulu_ui"
  npm run build
)

APP="$SMOKE_ROOT/Yulu.app"
YULU_APP_OUTPUT_PATH="$APP" \
YULU_BUNDLE_DEVELOPMENT_HOST=1 \
YULU_BUNDLE_APPLICATION_RUNTIME=1 \
YULU_CODESIGN_IDENTITY=- \
YULU_SWIFT_MODULE_CACHE_PATH="$SMOKE_ROOT/swift-module-cache" \
bash "$SCRIPT_DIR/build_audio_daemon.sh"

PORT="$((30000 + ($$ % 20000)))"
mkdir -p "$SMOKE_ROOT/home"
mkdir -p "$SMOKE_ROOT/home/.config/yulu"
mkdir -p "$SMOKE_ROOT/denied-host-runtime"
for command in node python3 ffmpeg npm pip brew swiftc; do
  printf '%s\n' \
    '#!/bin/sh' \
    'printf "%s\n" "$(basename "$0")" >> "$YULU_FORBIDDEN_RUNTIME_LOG"' \
    'exit 126' \
    > "$SMOKE_ROOT/denied-host-runtime/$command"
  chmod +x "$SMOKE_ROOT/denied-host-runtime/$command"
done
printf '%s\n' \
  "require('node:fs').appendFileSync(process.env.YULU_HOSTILE_RUNTIME_LOG, 'node-options\\n')" \
  > "$SMOKE_ROOT/node-options-payload.js"
printf '%s\n' \
  '#!/bin/sh' \
  'printf "%s\n" fake-caption-python >> "$YULU_HOSTILE_RUNTIME_LOG"' \
  'exit 126' \
  > "$SMOKE_ROOT/hostile-caption-python"
chmod +x "$SMOKE_ROOT/hostile-caption-python"
cp "$SCRIPT_DIR/config.example.json" "$SMOKE_ROOT/home/.config/yulu/config.json"
if find "$APP" -type f \( -name '*.onnx' -o -name '*paraformer*' \) -print | grep -q .; then
  echo "Optional Runtime Pack content must not ship inside Yulu.app" >&2
  exit 1
fi
(
  cd "$APP"
  find . -type f -print0 | sort -z | xargs -0 shasum -a 256
) > "$SMOKE_ROOT/application-runtime.before.sha256"
"$APP/Contents/MacOS/xai_keychain" self-test \
  > "$SMOKE_ROOT/xai-keychain-self-test.json"
"$APP/Contents/MacOS/calendar_probe" --self-test \
  > "$SMOKE_ROOT/calendar-probe-self-test.json"
grep -q '"helper":"xai_keychain"' "$SMOKE_ROOT/xai-keychain-self-test.json"
grep -q '"ok":true' "$SMOKE_ROOT/xai-keychain-self-test.json"
grep -q '"helper":"calendar_probe"' "$SMOKE_ROOT/calendar-probe-self-test.json"
grep -q '"ok":true' "$SMOKE_ROOT/calendar-probe-self-test.json"
HOME="$SMOKE_ROOT/home" \
PATH="$SMOKE_ROOT/denied-host-runtime" \
YULU_FORBIDDEN_RUNTIME_LOG="$SMOKE_ROOT/forbidden-runtime.log" \
YULU_HOSTILE_RUNTIME_LOG="$SMOKE_ROOT/hostile-runtime.log" \
NODE_OPTIONS="--require=$SMOKE_ROOT/node-options-payload.js" \
YULU_LOCAL_CAPTION_PYTHON="$SMOKE_ROOT/hostile-caption-python" \
YULU_UI_PORT="$PORT" \
"$APP/Contents/MacOS/yulu_app" --development-smoke \
  > "$SMOKE_ROOT/smoke-output.txt" \
  2> "$SMOKE_ROOT/smoke-error.txt"
if grep -Eq 'retired Gateway Keychain cleanup will retry next start|xAI 钥匙串组件不可用' \
  "$SMOKE_ROOT/smoke-error.txt"; then
  echo "Bundled Host could not use its staged xAI Keychain helper:" >&2
  sed 's/^/  /' "$SMOKE_ROOT/smoke-error.txt" >&2
  exit 1
fi
if [[ -s "$SMOKE_ROOT/forbidden-runtime.log" ]]; then
  echo "Application startup invoked a forbidden host runtime:" >&2
  sed 's/^/  /' "$SMOKE_ROOT/forbidden-runtime.log" >&2
  exit 1
fi
[[ ! -s "$SMOKE_ROOT/forbidden-runtime.log" ]]
if [[ -s "$SMOKE_ROOT/hostile-runtime.log" ]]; then
  echo "Application startup executed parent-injected runtime code:" >&2
  sed 's/^/  /' "$SMOKE_ROOT/hostile-runtime.log" >&2
  exit 1
fi
[[ ! -s "$SMOKE_ROOT/hostile-runtime.log" ]]
(
  cd "$APP"
  find . -type f -print0 | sort -z | xargs -0 shasum -a 256
) > "$SMOKE_ROOT/application-runtime.after.sha256"
diff -u \
  "$SMOKE_ROOT/application-runtime.before.sha256" \
  "$SMOKE_ROOT/application-runtime.after.sha256"
cat "$SMOKE_ROOT/smoke-output.txt"
