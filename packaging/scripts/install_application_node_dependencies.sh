#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOCK="${YULU_RUNTIME_LOCK:-$ROOT/packaging/runtime-lock.json}"
UI_DIR="${1:-$ROOT/yulu/scripts/yulu_ui}"

fail() {
  echo "install_application_node_dependencies.sh: $*" >&2
  exit 1
}

[[ "$UI_DIR" == /* && -f "$UI_DIR/package-lock.json" ]] || \
  fail "expected an absolute UI directory with package-lock.json"
UI_DIR="$(cd "$UI_DIR" && pwd -P)"
[[ -f "$LOCK" ]] || fail "runtime lock missing: $LOCK"

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

TEMP="$(mktemp -d "${TMPDIR:-/tmp}/yulu-node-dependencies.XXXXXX")"
cleanup() {
  case "$TEMP" in
    "${TMPDIR:-/tmp}"/yulu-node-dependencies.*) rm -rf "$TEMP" ;;
  esac
}
trap cleanup EXIT

ARCHIVE="$TEMP/better-sqlite3.tar.gz"
if [[ -n "${YULU_BETTER_SQLITE3_ARCHIVE:-}" ]]; then
  [[ -f "$YULU_BETTER_SQLITE3_ARCHIVE" ]] || \
    fail "YULU_BETTER_SQLITE3_ARCHIVE does not name a file"
  cp "$YULU_BETTER_SQLITE3_ARCHIVE" "$ARCHIVE"
else
  curl --fail --location --silent --show-error \
    "$(json_field betterSqlite3 url)" --output "$ARCHIVE"
fi

ACTUAL_SHA256="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
EXPECTED_SHA256="$(json_field betterSqlite3 sha256)"
[[ "$ACTUAL_SHA256" == "$EXPECTED_SHA256" ]] || \
  fail "betterSqlite3 checksum mismatch: expected $EXPECTED_SHA256, got $ACTUAL_SHA256"

python3 "$ROOT/packaging/scripts/validate_runtime_archive.py" \
  "$ARCHIVE" "build/Release/better_sqlite3.node"
mkdir -p "$TEMP/prebuild"
tar -xzf "$ARCHIVE" -C "$TEMP/prebuild"
PREBUILT_ADDON="$TEMP/prebuild/build/Release/better_sqlite3.node"
[[ -f "$PREBUILT_ADDON" && ! -L "$PREBUILT_ADDON" ]] || \
  fail "locked betterSqlite3 archive does not contain the native addon"
ACTUAL_BINARY_SHA256="$(shasum -a 256 "$PREBUILT_ADDON" | awk '{print $1}')"
EXPECTED_BINARY_SHA256="$(json_field betterSqlite3 binarySha256)"
[[ "$ACTUAL_BINARY_SHA256" == "$EXPECTED_BINARY_SHA256" ]] || \
  fail "betterSqlite3 binary checksum mismatch: expected $EXPECTED_BINARY_SHA256, got $ACTUAL_BINARY_SHA256"

(
  cd "$UI_DIR"
  npm ci --ignore-scripts
)

ADDON_ROOT="$UI_DIR/node_modules/better-sqlite3"
[[ -f "$ADDON_ROOT/package.json" ]] || fail "betterSqlite3 package was not installed"
EXPECTED_ADDON_VERSION="$(json_field betterSqlite3 version)"
ACTUAL_ADDON_VERSION="$(python3 - "$ADDON_ROOT/package.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    print(json.load(source)["version"])
PY
)"
[[ "$ACTUAL_ADDON_VERSION" == "$EXPECTED_ADDON_VERSION" ]] || \
  fail "betterSqlite3 package version mismatch: expected $EXPECTED_ADDON_VERSION, got $ACTUAL_ADDON_VERSION"

case "$ADDON_ROOT/build" in
  "$UI_DIR"/node_modules/better-sqlite3/build) rm -rf "$ADDON_ROOT/build" ;;
  *) fail "unsafe betterSqlite3 build destination" ;;
esac
mkdir -p "$ADDON_ROOT/build/Release"
cp "$PREBUILT_ADDON" "$ADDON_ROOT/build/Release/better_sqlite3.node"

EXPECTED_PROBE="$(json_field node version)|$(json_field betterSqlite3 nodeAbi)|$(json_field betterSqlite3 platform)|$(json_field betterSqlite3 architecture)|$EXPECTED_ADDON_VERSION|1"
ACTUAL_PROBE="$(cd "$UI_DIR" && node - <<'JS'
const Database = require("better-sqlite3");
const db = new Database(":memory:");
const result = db.prepare("SELECT 1 AS ok").get();
db.close();
process.stdout.write([
  process.versions.node,
  process.versions.modules,
  process.platform,
  process.arch,
  require("better-sqlite3/package.json").version,
  result.ok,
].join("|"));
JS
)"
[[ "$ACTUAL_PROBE" == "$EXPECTED_PROBE" ]] || \
  fail "locked Node/native addon probe mismatch: expected $EXPECTED_PROBE, got $ACTUAL_PROBE"

echo "Installed verified Application Runtime Node dependencies at $UI_DIR"
