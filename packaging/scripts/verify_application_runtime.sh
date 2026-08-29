#!/usr/bin/env bash
set -euo pipefail

MODE=verify
if [[ "${1:-}" == "--write-inventory" ]]; then
  MODE=write
  shift
fi
APP="${1:-}"

fail() {
  echo "verify_application_runtime.sh: $*" >&2
  exit 1
}

if [[ -z "$APP" || "$APP" != /*.app || ! -d "$APP/Contents" ]]; then
  fail "expected an existing absolute .app path"
fi

FILE_TOOL="${YULU_VERIFY_FILE:-/usr/bin/file}"
LIPO_TOOL="${YULU_VERIFY_LIPO:-/usr/bin/lipo}"
CODESIGN_TOOL="${YULU_VERIFY_CODESIGN:-/usr/bin/codesign}"
RESOURCES="$APP/Contents/Resources"
RUNTIME="$RESOURCES/runtime"
HOST="$RESOURCES/Host"
INVENTORY="$RESOURCES/application-runtime.json"
VERSIONS="$RUNTIME/runtime-versions.json"

REQUIRED_FILES=(
  "Contents/MacOS/yulu_app"
  "Contents/MacOS/xai_keychain"
  "Contents/MacOS/calendar_probe"
  "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon"
  "Contents/Resources/runtime/bin/node"
  "Contents/Resources/runtime/bin/ffmpeg"
  "Contents/Resources/runtime/python/bin/python3"
  "Contents/Resources/runtime/runtime-versions.json"
  "Contents/Resources/runtime/yulu/scripts/record_audio.py"
  "Contents/Resources/runtime/yulu/scripts/local_caption_runtime_pack.json"
  "Contents/Resources/Host/server.js"
  "Contents/Resources/Host/web/index.html"
  "Contents/Resources/Host/node_modules/better-sqlite3/package.json"
  "Contents/Resources/Host/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
  "Contents/Resources/Host/node_modules/bindings/package.json"
  "Contents/Resources/Host/node_modules/file-uri-to-path/package.json"
)
REQUIRED_MACHO=(
  "Contents/MacOS/yulu_app"
  "Contents/MacOS/xai_keychain"
  "Contents/MacOS/calendar_probe"
  "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon"
  "Contents/Resources/runtime/bin/node"
  "Contents/Resources/runtime/bin/ffmpeg"
  "Contents/Resources/runtime/python/bin/python3"
  "Contents/Resources/Host/node_modules/better-sqlite3/build/Release/better_sqlite3.node"
)

for relative in "${REQUIRED_FILES[@]}"; do
  [[ -f "$APP/$relative" ]] || fail "required Application Runtime file missing: $relative"
done
python3 - "$RUNTIME/yulu/scripts/local_caption_runtime_pack.json" <<'PY'
import json
import sys

pack = json.load(open(sys.argv[1], encoding="utf-8"))
if (
    pack.get("schema") != 1
    or pack.get("architecture") != "arm64"
    or pack.get("pythonAbi") != "cp313"
    or "{tag}" not in str(pack.get("assetUrlTemplate", ""))
    or not isinstance(pack.get("wheels"), list)
    or not all(len(str(wheel.get("sha256", ""))) == 64 for wheel in pack["wheels"])
):
    raise SystemExit("verify_application_runtime.sh: invalid Optional Runtime Pack definition")
PY
for relative in \
  "Contents/MacOS/yulu_app" \
  "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon" \
  "Contents/Resources/runtime/bin/node" \
  "Contents/Resources/runtime/bin/ffmpeg" \
  "Contents/Resources/runtime/python/bin/python3"; do
  [[ -x "$APP/$relative" ]] || fail "required Application Runtime executable is not executable: $relative"
done

check_macho() {
  local candidate="$1" required="${2:-0}" description archs
  description="$($FILE_TOOL -b "$candidate")"
  if [[ "$description" != *Mach-O* ]]; then
    if [[ "$required" == "1" ]]; then
      fail "required Application Runtime code is not Mach-O: ${candidate#"$APP"/}"
    fi
    return 0
  fi
  archs="$($LIPO_TOOL -archs "$candidate" | xargs)"
  if [[ "$archs" != "arm64" ]]; then
    fail "Application Runtime code must be arm64 only: ${candidate#"$APP"/} (found: ${archs:-unknown})"
  fi
  if ! "$CODESIGN_TOOL" --verify --strict "$candidate" >/dev/null 2>&1; then
    fail "Application Runtime signature invalid: ${candidate#"$APP"/}"
  fi
}

for relative in "${REQUIRED_MACHO[@]}"; do
  check_macho "$APP/$relative" 1
done
while IFS= read -r -d '' candidate; do
  check_macho "$candidate" 0
done < <(
  find "$RUNTIME" "$HOST" "$APP/Contents/MacOS" "$APP/Contents/Helpers/YuluCapture.app/Contents/MacOS" \
    -type f -print0
)

NODE_ENTITLEMENTS="$($CODESIGN_TOOL --display --entitlements :- "$RUNTIME/bin/node" 2>&1)" || \
  fail "could not read bundled Node entitlements"
NODE_SIGNATURE="$($CODESIGN_TOOL --display --verbose=2 "$RUNTIME/bin/node" 2>&1)" || \
  fail "could not read bundled Node signature metadata"
node_entitlement_is_true() {
  python3 -c '
import plistlib
import sys

output = sys.argv[1].encode()
start = output.find(b"<plist")
end = output.find(b"</plist>", start)
if start < 0 or end < 0:
    raise SystemExit(1)
entitlements = plistlib.loads(output[start:end + len(b"</plist>")])
if entitlements.get(sys.argv[2]) is not True:
    raise SystemExit(1)
' "$NODE_ENTITLEMENTS" "$1"
}
if ! node_entitlement_is_true "com.apple.security.cs.allow-jit"; then
  fail "bundled Node is missing its required JIT entitlement"
fi
if [[ "$NODE_SIGNATURE" == *"Signature=adhoc"* || "$NODE_SIGNATURE" == *"TeamIdentifier=not set"* ]]; then
  if ! node_entitlement_is_true "com.apple.security.cs.disable-library-validation"; then
    fail "bundled Node cannot load signed native addons"
  fi
elif node_entitlement_is_true "com.apple.security.cs.disable-library-validation"; then
  fail "team-signed Node must enforce library validation"
fi

if [[ "${YULU_SKIP_RUNTIME_EXECUTION:-0}" != "1" ]]; then
  NODE="$RUNTIME/bin/node"
  PYTHON="$RUNTIME/python/bin/python3"
  FFMPEG="$RUNTIME/bin/ffmpeg"
  NODE_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["node"])' "$VERSIONS")"
  PYTHON_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["python"].split("+", 1)[0])' "$VERSIONS")"
  FFMPEG_VERSION="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["ffmpeg"])' "$VERSIONS")"
  [[ "$($NODE --version)" == "v$NODE_VERSION" ]] || fail "bundled Node version does not match runtime inventory"
  PYTHON_PROBE="$(PYTHONDONTWRITEBYTECODE=1 "$PYTHON" -B -I -c 'import platform,sys; print(platform.machine()+"|"+platform.python_version()+"|"+sys.prefix)')"
  [[ "$PYTHON_PROBE" == "arm64|$PYTHON_VERSION|$RUNTIME/python" ]] || \
    fail "bundled Python identity does not match runtime inventory: $PYTHON_PROBE"
  set +o pipefail
  FFMPEG_FIRST_LINE="$("$FFMPEG" -hide_banner -version 2>&1 | head -1)"
  set -o pipefail
  [[ "$FFMPEG_FIRST_LINE" == "ffmpeg version $FFMPEG_VERSION"* ]] || \
    fail "bundled ffmpeg version does not match runtime inventory"
  NODE_PATH="$HOST/node_modules" "$NODE" -e \
    "const Database=require('better-sqlite3'); const db=new Database(':memory:'); db.close();" || \
    fail "bundled Node cannot load the bundled better-sqlite3 native addon"
fi

if [[ "$MODE" == "write" ]]; then
  python3 - "$APP" "$INVENTORY" <<'PY'
import hashlib
import json
import os
import stat
import sys
from pathlib import Path

app = Path(sys.argv[1])
destination = Path(sys.argv[2])
roots = [
    app / "Contents/Resources/runtime",
    app / "Contents/Resources/Host",
]
fixed = [
    app / "Contents/MacOS/yulu_app",
    app / "Contents/MacOS/xai_keychain",
    app / "Contents/MacOS/calendar_probe",
    app / "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon",
]
paths = set(fixed)
for root in roots:
    paths.update(path for path in root.rglob("*") if path.is_file() or path.is_symlink())

files = []
for path in sorted(paths):
    relative = path.relative_to(app).as_posix()
    mode = stat.S_IMODE(path.lstat().st_mode)
    if relative == "Contents/MacOS/yulu_app":
        # The final outer bundle signature re-signs its main executable after
        # this embedded inventory is sealed. Its architecture and signature
        # are checked above; all independently signed helpers stay hashed.
        files.append({"path": relative, "type": "outer-signed-main", "mode": mode})
        continue
    if path.is_symlink():
        files.append({
            "path": relative,
            "type": "symlink",
            "target": os.readlink(path),
            "mode": mode,
        })
        continue
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    files.append({"path": relative, "type": "file", "sha256": digest.hexdigest(), "mode": mode})

versions = json.loads((app / "Contents/Resources/runtime/runtime-versions.json").read_text())
payload = {
    "schema": 1,
    "architecture": "arm64",
    "versions": {name: versions[name] for name in ("node", "python", "ffmpeg")},
    "files": files,
}
temporary = destination.with_suffix(".json.tmp")
temporary.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
temporary.replace(destination)
PY
  echo "Wrote Application Runtime inventory: $INVENTORY"
  exit 0
fi

[[ -f "$INVENTORY" ]] || fail "Application Runtime inventory missing: $INVENTORY"
python3 - "$APP" "$INVENTORY" <<'PY'
import hashlib
import json
import os
import stat
import sys
from pathlib import Path

app = Path(sys.argv[1])
inventory_path = Path(sys.argv[2])
inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
if inventory.get("schema") != 1 or inventory.get("architecture") != "arm64":
    raise SystemExit("verify_application_runtime.sh: invalid Application Runtime inventory header")

roots = [app / "Contents/Resources/runtime", app / "Contents/Resources/Host"]
fixed = {
    "Contents/MacOS/yulu_app",
    "Contents/MacOS/xai_keychain",
    "Contents/MacOS/calendar_probe",
    "Contents/Helpers/YuluCapture.app/Contents/MacOS/audio_daemon",
}
actual = set(fixed)
for root in roots:
    actual.update(
        path.relative_to(app).as_posix()
        for path in root.rglob("*")
        if path.is_file() or path.is_symlink()
    )
declared = {entry.get("path") for entry in inventory.get("files", [])}
if actual != declared:
    missing = sorted(declared - actual)
    unexpected = sorted(actual - declared)
    raise SystemExit(
        f"verify_application_runtime.sh: inventory file set mismatch; missing={missing}, unexpected={unexpected}"
    )

for entry in inventory["files"]:
    relative = entry["path"]
    path = app / relative
    mode = stat.S_IMODE(path.lstat().st_mode)
    if mode != entry.get("mode"):
        raise SystemExit(f"verify_application_runtime.sh: inventory mode mismatch: {relative}")
    if entry.get("type") == "symlink":
        if not path.is_symlink() or os.readlink(path) != entry.get("target"):
            raise SystemExit(f"verify_application_runtime.sh: inventory symlink mismatch: {relative}")
        resolved = path.resolve()
        try:
            resolved.relative_to(app.resolve())
        except ValueError:
            raise SystemExit(f"verify_application_runtime.sh: inventory symlink escapes App: {relative}")
        continue
    if entry.get("type") == "outer-signed-main":
        if relative != "Contents/MacOS/yulu_app" or not path.is_file():
            raise SystemExit(f"verify_application_runtime.sh: invalid outer-signed main entry: {relative}")
        continue
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    if digest.hexdigest() != entry.get("sha256"):
        raise SystemExit(f"verify_application_runtime.sh: inventory hash mismatch: {relative}")
PY

echo "Verified self-contained Application Runtime: $APP"
