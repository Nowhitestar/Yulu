#!/usr/bin/env bash
set -euo pipefail

DMG="${1:-}"
EXPECTED_TEAM_ID="${YULU_EXPECTED_TEAM_ID:-WMU9678ZQL}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

fail() {
    echo "verify_dmg.sh: $*" >&2
    exit 1
}

[[ -n "$DMG" && "$DMG" == /*.dmg && -f "$DMG" ]] || \
    fail "expected an existing absolute .dmg path"

verify_developer_id() {
    local code="$1" details
    details="$(codesign --display --verbose=4 "$code" 2>&1)" || \
        fail "could not read signature metadata: $code"
    [[ "$details" == *"Authority=Developer ID Application:"* ]] || \
        fail "release code is not signed with Developer ID Application: $code"
    [[ "$details" == *"TeamIdentifier=$EXPECTED_TEAM_ID"* ]] || \
        fail "release code has the wrong signing Team ID: $code"
}

codesign --verify --strict --verbose=2 "$DMG"
verify_developer_id "$DMG"
xcrun stapler validate "$DMG"
spctl -a -vv -t open --context context:primary-signature "$DMG"

ATTACH_PLIST="$(mktemp "${TMPDIR:-/tmp}/yulu-dmg-attach.XXXXXX")"
VOLUME_INFO_PLIST="$(mktemp "${TMPDIR:-/tmp}/yulu-dmg-volume.XXXXXX")"
MOUNT_POINT=""
cleanup() {
    if [[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]]; then
        hdiutil detach -quiet "$MOUNT_POINT" >/dev/null 2>&1 || true
    fi
    rm -f "$ATTACH_PLIST" "$VOLUME_INFO_PLIST"
}
trap cleanup EXIT

hdiutil attach -readonly -nobrowse -noautoopen -plist "$DMG" > "$ATTACH_PLIST"
MOUNT_POINT="$(python3 - "$ATTACH_PLIST" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "rb") as source:
    payload = plistlib.load(source)
mounts = [
    entity["mount-point"]
    for entity in payload.get("system-entities", [])
    if isinstance(entity, dict) and entity.get("mount-point")
]
if len(mounts) != 1:
    raise SystemExit("DMG must attach exactly one mounted volume")
print(mounts[0])
PY
)"
[[ -d "$MOUNT_POINT" ]] || fail "DMG mount point is unavailable"

diskutil info -plist "$MOUNT_POINT" > "$VOLUME_INFO_PLIST"
python3 - "$VOLUME_INFO_PLIST" <<'PY'
import plistlib
import sys

with open(sys.argv[1], "rb") as source:
    payload = plistlib.load(source)
if payload.get("VolumeName") != "Yulu":
    raise SystemExit("DMG volume label must be exactly Yulu")
PY

python3 - "$MOUNT_POINT" <<'PY'
import os
import stat
import sys
from pathlib import Path

root = Path(sys.argv[1])
expected = {"Applications", "Yulu.app"}
actual = {entry.name for entry in root.iterdir()}
if actual != expected:
    raise SystemExit(
        f"DMG must contain only Yulu.app and Applications alias: {sorted(actual)}"
    )
app = root / "Yulu.app"
applications = root / "Applications"
if not app.is_dir() or app.is_symlink():
    raise SystemExit("DMG Yulu.app is not an application directory")
if not stat.S_ISLNK(applications.lstat().st_mode) or os.readlink(applications) != "/Applications":
    raise SystemExit("DMG Applications alias must resolve exactly to /Applications")
PY

APP="$MOUNT_POINT/Yulu.app"
codesign --verify --deep --strict --verbose=2 "$APP"
verify_developer_id "$APP"
xcrun stapler validate "$APP"
spctl -a -vv -t exec "$APP"
YULU_REQUIRE_SPARKLE_CONFIGURATION=1 \
  bash "$SCRIPT_DIR/verify_application_runtime.sh" "$APP"

echo "Verified signed, notarized, stapled DMG: $DMG"
