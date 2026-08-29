#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOCK="${YULU_RUNTIME_LOCK:-$ROOT/packaging/runtime-lock.json}"
APP="${1:-}"

fail() {
  echo "prepare_application_runtime.sh: $*" >&2
  exit 1
}

if [[ -z "$APP" || "$APP" != /*.app || ! -d "$APP/Contents" ]]; then
  fail "expected an existing absolute .app path"
fi
[[ -f "$LOCK" ]] || fail "runtime lock missing: $LOCK"

for helper in \
  "$APP/Contents/MacOS/yulu_app" \
  "$APP/Contents/MacOS/xai_keychain" \
  "$APP/Contents/MacOS/calendar_probe" \
  "$APP/Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon"; do
  [[ -x "$helper" ]] || fail "required Swift helper missing or not executable: $helper"
done

json_field() {
  python3 - "$LOCK" "$1" "$2" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    lock = json.load(source)
value = lock[sys.argv[2]][sys.argv[3]]
if not isinstance(value, str) or not value:
    raise SystemExit(f"invalid runtime lock field: {sys.argv[2]}.{sys.argv[3]}")
print(value)
PY
}

TEMP="$(mktemp -d "${TMPDIR:-/tmp}/yulu-application-runtime.XXXXXX")"
cleanup() {
  case "$TEMP" in
    "${TMPDIR:-/tmp}"/yulu-application-runtime.*) rm -rf "$TEMP" ;;
  esac
}
trap cleanup EXIT

obtain() {
  local override="$1" section="$2" filename="$3"
  local supplied="${!override:-}" destination="$TEMP/$filename"
  if [[ -n "$supplied" ]]; then
    [[ -f "$supplied" ]] || fail "$override does not name a file: $supplied"
    cp "$supplied" "$destination"
  else
    curl --fail --location --silent --show-error "$(json_field "$section" url)" --output "$destination"
  fi
  local actual expected
  actual="$(shasum -a 256 "$destination" | awk '{print $1}')"
  expected="$(json_field "$section" sha256)"
  [[ "$actual" == "$expected" ]] || fail "$section checksum mismatch: expected $expected, got $actual"
  printf '%s\n' "$destination"
}

validate_archive() {
  python3 "$ROOT/packaging/scripts/validate_runtime_archive.py" "$1"
}

NODE_ARCHIVE="$(obtain YULU_NODE_ARCHIVE node node.tar.gz)"
PYTHON_ARCHIVE="$(obtain YULU_PYTHON_ARCHIVE python python.tar.gz)"
if [[ -n "${YULU_FFMPEG_BINARY:-}" ]]; then
  FFMPEG_BINARY="$(obtain YULU_FFMPEG_BINARY ffmpeg ffmpeg)"
  FFMPEG_LICENSE="$(obtain YULU_FFMPEG_LICENSE ffmpegLicense ffmpeg.LICENSE)"
else
  FFMPEG_SOURCE="$(obtain YULU_FFMPEG_SOURCE_ARCHIVE ffmpeg ffmpeg.tar.xz)"
  FFMPEG_EXTRACT="$TEMP/ffmpeg-source"
  mkdir -p "$FFMPEG_EXTRACT"
  validate_archive "$FFMPEG_SOURCE"
  tar -xf "$FFMPEG_SOURCE" -C "$FFMPEG_EXTRACT"
  FFMPEG_ROOT="$FFMPEG_EXTRACT/ffmpeg-$(json_field ffmpeg version)"
  [[ -x "$FFMPEG_ROOT/configure" ]] || fail "FFmpeg source archive does not contain the locked release"
  (
    cd "$FFMPEG_ROOT"
    ./configure \
      --arch=arm64 \
      --target-os=darwin \
      --cc=clang \
      --disable-autodetect \
      --disable-debug \
      --disable-doc \
      --disable-ffplay \
      --disable-ffprobe \
      --disable-network \
      --enable-small \
      --extra-cflags=-mmacosx-version-min=13.0 \
      --extra-ldflags=-mmacosx-version-min=13.0
    make -j "$(sysctl -n hw.ncpu)" ffmpeg
  )
  FFMPEG_BINARY="$FFMPEG_ROOT/ffmpeg"
  FFMPEG_LICENSE="$FFMPEG_ROOT/COPYING.LGPLv2.1"
  [[ -x "$FFMPEG_BINARY" && -f "$FFMPEG_LICENSE" ]] || fail "locked FFmpeg build did not produce its binary and license"
fi

NODE_EXTRACT="$TEMP/node"
PYTHON_EXTRACT="$TEMP/python-extract"
mkdir -p "$NODE_EXTRACT" "$PYTHON_EXTRACT"
validate_archive "$NODE_ARCHIVE"
tar -xzf "$NODE_ARCHIVE" -C "$NODE_EXTRACT"
validate_archive "$PYTHON_ARCHIVE"
tar -xzf "$PYTHON_ARCHIVE" -C "$PYTHON_EXTRACT"

NODE_ROOT=""
while IFS= read -r candidate; do
  if [[ -x "$candidate/bin/node" ]]; then
    [[ -z "$NODE_ROOT" ]] || fail "Node archive contains multiple runtime roots"
    NODE_ROOT="$candidate"
  fi
done < <(find "$NODE_EXTRACT" -mindepth 1 -maxdepth 1 -type d -print)
[[ -n "$NODE_ROOT" ]] || fail "Node archive does not contain bin/node"
[[ -x "$PYTHON_EXTRACT/python/bin/python3" ]] || fail "Python archive does not contain python/bin/python3"

RESOURCES="$APP/Contents/Resources"
RUNTIME="$RESOURCES/runtime"
HOST="$RESOURCES/Host"
case "$RUNTIME" in "$APP"/Contents/Resources/runtime) rm -rf "$RUNTIME" ;; *) fail "unsafe runtime destination" ;; esac
case "$HOST" in "$APP"/Contents/Resources/Host) rm -rf "$HOST" ;; *) fail "unsafe Host destination" ;; esac
mkdir -p "$RUNTIME/bin" "$RUNTIME/licenses" "$RUNTIME/python" "$RUNTIME/yulu/scripts" \
  "$HOST/node_modules"

cp "$NODE_ROOT/bin/node" "$RUNTIME/bin/node"
cp "$NODE_ROOT/LICENSE" "$RUNTIME/licenses/node.txt"
cp -R "$PYTHON_EXTRACT/python/." "$RUNTIME/python/"
cp "$FFMPEG_BINARY" "$RUNTIME/bin/ffmpeg"
cp "$FFMPEG_LICENSE" "$RUNTIME/licenses/ffmpeg.txt"
chmod +x "$RUNTIME/bin/node" "$RUNTIME/python/bin/python3" "$RUNTIME/bin/ffmpeg"

UI_SOURCE="${YULU_RUNTIME_UI_SOURCE:-$ROOT/yulu/scripts/yulu_ui}"
SCRIPT_SOURCE="${YULU_RUNTIME_SCRIPT_SOURCE:-$ROOT/yulu/scripts}"
for required in \
  "$UI_SOURCE/dist/server.js" \
  "$UI_SOURCE/dist/web/index.html" \
  "$UI_SOURCE/node_modules/better-sqlite3/build/Release/better_sqlite3.node"; do
  [[ -f "$required" ]] || fail "built Host artifact missing: $required"
done
ADDON="$UI_SOURCE/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
ACTUAL_ADDON_SHA256="$(shasum -a 256 "$ADDON" | awk '{print $1}')"
EXPECTED_ADDON_SHA256="$(json_field betterSqlite3 binarySha256)"
[[ "$ACTUAL_ADDON_SHA256" == "$EXPECTED_ADDON_SHA256" ]] || \
  fail "betterSqlite3 binary checksum mismatch: expected $EXPECTED_ADDON_SHA256, got $ACTUAL_ADDON_SHA256"
cp "$UI_SOURCE/dist/server.js" "$HOST/server.js"
if [[ -f "$UI_SOURCE/dist/server.js.map" ]]; then
  cp "$UI_SOURCE/dist/server.js.map" "$HOST/server.js.map"
fi
cp -R "$UI_SOURCE/dist/web" "$HOST/web"
for dependency in better-sqlite3 bindings file-uri-to-path; do
  [[ -d "$UI_SOURCE/node_modules/$dependency" ]] || fail "production Host dependency missing: $dependency"
  cp -R "$UI_SOURCE/node_modules/$dependency" "$HOST/node_modules/$dependency"
done

while IFS= read -r source; do
  relative="${source#"$SCRIPT_SOURCE"/}"
  destination="$RUNTIME/yulu/scripts/$relative"
  mkdir -p "$(dirname "$destination")"
  cp "$source" "$destination"
done < <(
  find "$SCRIPT_SOURCE" \
    \( -path "$SCRIPT_SOURCE/Yulu.app" -o -path "$SCRIPT_SOURCE/StatusAgent.app" -o -path "$SCRIPT_SOURCE/yulu_ui" \) -prune -o \
    -type f \( -name '*.py' -o -name '*.json' -o -name '*.md' \) -print
)

cat > "$RUNTIME/runtime-versions.json" <<EOF
{
  "schema": 1,
  "architecture": "arm64",
  "node": "$(json_field node version)",
  "python": "$(json_field python version)",
  "ffmpeg": "$(json_field ffmpeg version)"
}
EOF

echo "Prepared self-contained Application Runtime at $APP"
