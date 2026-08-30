#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
LOCK="${YULU_RUNTIME_LOCK:-$ROOT/packaging/runtime-lock.json}"
APP="${1:-}"

fail() {
  echo "prepare_sparkle_framework.sh: $*" >&2
  exit 1
}

if [[ -z "$APP" || "$APP" != /*.app || ! -d "$APP/Contents" ]]; then
  fail "expected an existing absolute .app path"
fi
[[ -f "$LOCK" ]] || fail "runtime lock missing: $LOCK"

json_field() {
  python3 - "$LOCK" "$1" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as source:
    lock = json.load(source)
value = lock["sparkle"][sys.argv[2]]
if not isinstance(value, str) or not value:
    raise SystemExit(f"invalid runtime lock field: sparkle.{sys.argv[2]}")
print(value)
PY
}

TEMP="$(mktemp -d "${TMPDIR:-/tmp}/yulu-sparkle-framework.XXXXXX")"
cleanup() {
  case "$TEMP" in
    "${TMPDIR:-/tmp}"/yulu-sparkle-framework.*) rm -rf "$TEMP" ;;
  esac
}
trap cleanup EXIT

ARCHIVE="$TEMP/Sparkle.zip"
if [[ -n "${YULU_SPARKLE_ARCHIVE:-}" ]]; then
  [[ -f "$YULU_SPARKLE_ARCHIVE" ]] || fail "YULU_SPARKLE_ARCHIVE does not name a file"
  cp "$YULU_SPARKLE_ARCHIVE" "$ARCHIVE"
else
  curl --fail --location --silent --show-error "$(json_field url)" --output "$ARCHIVE"
fi
ACTUAL="$(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
EXPECTED="$(json_field sha256)"
[[ "$ACTUAL" == "$EXPECTED" ]] || fail "Sparkle checksum mismatch: expected $EXPECTED, got $ACTUAL"

python3 "$ROOT/packaging/scripts/validate_runtime_archive.py" "$ARCHIVE"
EXTRACT="$TEMP/extracted"
mkdir -p "$EXTRACT"
ditto -x -k "$ARCHIVE" "$EXTRACT"
SOURCE="$EXTRACT/Sparkle.xcframework/macos-arm64_x86_64/Sparkle.framework"
[[ -d "$SOURCE/Versions" && -f "$SOURCE/Versions/Current/Sparkle" ]] || \
  fail "locked Sparkle archive does not contain the macOS framework"

FRAMEWORKS="$APP/Contents/Frameworks"
DESTINATION="$FRAMEWORKS/Sparkle.framework"
mkdir -p "$FRAMEWORKS" "$APP/Contents/Resources"
case "$DESTINATION" in
  "$APP"/Contents/Frameworks/Sparkle.framework) rm -rf "$DESTINATION" ;;
  *) fail "unsafe Sparkle framework destination" ;;
esac
ditto "$SOURCE" "$DESTINATION"
cp "$EXTRACT/LICENSE" "$APP/Contents/Resources/Sparkle-LICENSE.txt"

while IFS= read -r -d '' candidate; do
  if /usr/bin/file -b "$candidate" | grep -q 'Mach-O'; then
    ARCHS="$(/usr/bin/lipo -archs "$candidate" | xargs)"
    if [[ "$ARCHS" == *x86_64* ]]; then
      THIN="$candidate.arm64-thin"
      /usr/bin/lipo -thin arm64 "$candidate" -output "$THIN"
      chmod "$(stat -f %Lp "$candidate")" "$THIN"
      mv "$THIN" "$candidate"
    fi
    [[ "$(/usr/bin/lipo -archs "$candidate" | xargs)" == "arm64" ]] || \
      fail "Sparkle code is not arm64-only: ${candidate#"$DESTINATION"/}"
  fi
done < <(find -H "$DESTINATION" -type f -print0)

echo "Prepared locked Sparkle $(json_field version) framework at $DESTINATION"
