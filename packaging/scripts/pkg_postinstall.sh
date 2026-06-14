#!/usr/bin/env bash
set -euo pipefail

RUNTIME_ROOT="/Library/Application Support/Yulu/runtime"
VISIBLE_APP="/Applications/Yulu.app"
VISIBLE_APP_RUNTIME_PATH="yulu/scripts/Yulu.app"
INSTALLER_PATH="/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin"

log() {
    printf 'Yulu pkg: %s\n' "$1"
}

fail() {
    printf 'Yulu pkg error: %s\n' "$1" >&2
    exit 1
}

console_user="${YULU_PKG_USER:-}"
if [[ -z "$console_user" ]]; then
    console_user="$(stat -f %Su /dev/console 2>/dev/null || true)"
fi
if [[ -z "$console_user" || "$console_user" == "root" || "$console_user" == "loginwindow" ]]; then
    console_user="${SUDO_USER:-}"
fi
if [[ -z "$console_user" || "$console_user" == "root" ]]; then
    fail "could not determine the logged-in user"
fi

user_home="${YULU_PKG_HOME:-}"
if [[ -z "$user_home" ]]; then
    user_home="$(dscl . -read "/Users/$console_user" NFSHomeDirectory 2>/dev/null | awk '{print $2}' || true)"
fi
[[ -n "$user_home" && -d "$user_home" ]] || fail "could not determine home for $console_user"

install_dir="${YULU_INSTALL_DIR:-$user_home/.yulu}"
uid="$(id -u "$console_user")"
gid="$(id -g "$console_user")"

[[ -f "$RUNTIME_ROOT/VERSION" ]] || fail "runtime payload missing VERSION at $RUNTIME_ROOT"
[[ -f "$RUNTIME_ROOT/yulu/scripts/setup.sh" ]] || fail "runtime payload missing setup.sh"

ensure_runtime_audio_app() {
    local runtime_app="$RUNTIME_ROOT/$VISIBLE_APP_RUNTIME_PATH"
    if [[ -d "$runtime_app" ]]; then
        return 0
    fi
    if [[ ! -d "$VISIBLE_APP" ]]; then
        fail "runtime payload missing Yulu.app and visible app is not installed at $VISIBLE_APP"
    fi
    log "restoring runtime Yulu.app from $VISIBLE_APP"
    mkdir -p "$(dirname "$runtime_app")"
    if command -v ditto >/dev/null 2>&1; then
        ditto "$VISIBLE_APP" "$runtime_app"
    else
        cp -R "$VISIBLE_APP" "$runtime_app"
    fi
}

ensure_runtime_audio_app

backup=""
if [[ -e "$install_dir" || -L "$install_dir" ]]; then
    backup="${install_dir}.backup-$(date -u +%Y%m%d%H%M%S)"
    log "moving existing runtime to $backup"
    mv "$install_dir" "$backup"
fi

rollback() {
    local status=$?
    if [[ $status -ne 0 && -n "$backup" && -e "$backup" ]]; then
        log "rolling back to $backup"
        rm -rf "$install_dir"
        mv "$backup" "$install_dir"
        chown -R "$uid:$gid" "$install_dir"
    fi
    exit "$status"
}
trap rollback EXIT

mkdir -p "$(dirname "$install_dir")"
if command -v ditto >/dev/null 2>&1; then
    ditto "$RUNTIME_ROOT" "$install_dir"
else
    cp -R "$RUNTIME_ROOT" "$install_dir"
fi
chown -R "$uid:$gid" "$install_dir"

python3 - "$install_dir" <<'PY'
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

runtime = Path(sys.argv[1])
version = (runtime / "VERSION").read_text(encoding="utf-8").strip()
payload = {
    "schema": 1,
    "source": "release",
    "installed_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
    "version": f"v{version}",
    "asset": f"yulu-macos-arm64-v{version}.pkg",
}
(runtime / ".yulu-install.json").write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
PY
chown "$uid:$gid" "$install_dir/.yulu-install.json"

log "running setup upgrade as $console_user"
launchctl asuser "$uid" sudo -u "$console_user" env \
    HOME="$user_home" USER="$console_user" LOGNAME="$console_user" \
    PATH="$INSTALLER_PATH" \
    YULU_PKG_POSTINSTALL=1 \
    YULU_SKIP_RUNTIME_REPAIRS=1 \
    bash "$install_dir/yulu/scripts/setup.sh" --upgrade < /dev/null

if [[ -n "$backup" && -e "$backup" ]]; then
    log "leaving backup at $backup"
fi
trap - EXIT
log "installed $(cat "$install_dir/VERSION") to $install_dir"
exit 0
