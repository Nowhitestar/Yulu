#!/usr/bin/env python3
"""Repair/check Yulu macOS capture permissions.

This helper cannot grant Screen & System Audio Recording permission by itself —
macOS requires the user to approve it in System Settings. It can reset stale TCC
state, restart Yulu.app from the current runtime, and open the right settings
pane with exact instructions.
"""

from __future__ import annotations

import argparse
import json
import socket
import subprocess
import sys
import time
from pathlib import Path

from application_paths import IPC_DIR

BUNDLE_ID = "com.yulu.audiodaemon"
SCRIPT_DIR = Path(__file__).resolve().parent
APP_PATH = SCRIPT_DIR / "Yulu.app"
PLIST_PATH = Path.home() / "Library/LaunchAgents/com.yulu.audiodaemon.plist"
SOCKET_PATH = IPC_DIR / "audio_daemon.sock"


def screen_capture_settings_url() -> str:
    # Works across recent macOS versions; Sequoia labels this pane
    # "Screen & System Audio Recording" while the anchor remains ScreenCapture.
    return "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"


def plan(app_path: Path = APP_PATH, plist_path: Path = PLIST_PATH, bundle_id: str = BUNDLE_ID, reset: bool = False) -> dict:
    steps = []
    if reset:
        steps.append(f"tccutil reset ScreenCapture {bundle_id}")
    steps.extend([
        f"restart Yulu audio daemon from {app_path}",
        f"open System Settings privacy pane: {screen_capture_settings_url()}",
        "In Screen & System Audio Recording, enable Yulu (or remove/re-add Yulu.app if it is stale).",
        "If macOS asks to quit/reopen Yulu, allow it; then run yulu status again.",
    ])
    return {
        "bundle_id": bundle_id,
        "app_path": str(app_path),
        "plist_path": str(plist_path),
        "settings_url": screen_capture_settings_url(),
        "reset": reset,
        "steps": steps,
    }


def run(cmd: list[str], check: bool = False, timeout: int = 20) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode != 0:
        raise RuntimeError(f"command failed ({result.returncode}): {' '.join(cmd)}\n{result.stderr or result.stdout}")
    return result


def reset_capture_permission() -> None:
    """Reset the stale capture grant through the PermissionModel seam.

    Routes the TCC reset through ``MacOSPermissionModel().reset(...)`` so the
    consent-database scope name lives inside the seam (D-09), not inline here.
    The import is guarded so this script still loads off Darwin / if the seam
    package is unavailable; a missing seam simply skips the reset.
    """
    try:
        sys.path.insert(0, str(SCRIPT_DIR))
        from yulu_platform.macos import MacOSPermissionModel
    except Exception:
        return
    try:
        MacOSPermissionModel().reset("system-audio-capture")
    except Exception:
        # Off-Darwin construction raises; an unavailable seam must not break repair.
        pass


def daemon_status(timeout: float = 3.0) -> dict:
    if not SOCKET_PATH.exists():
        return {"ok": False, "exists": False, "error": "socket not found"}
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as s:
            s.settimeout(timeout)
            s.connect(str(SOCKET_PATH))
            s.sendall(b'{"action":"status"}\n')
            s.shutdown(socket.SHUT_WR)
            data = s.recv(4096).decode("utf-8", errors="replace")
        parsed = json.loads(data)
        parsed["ok"] = True
        return parsed
    except Exception as exc:
        return {"ok": False, "exists": True, "error": str(exc)}


def restart_daemon(app_path: Path = APP_PATH, plist_path: Path = PLIST_PATH) -> None:
    if plist_path.exists():
        run(["launchctl", "unload", str(plist_path)], check=False)
    run(["pkill", "-f", str(app_path / "Contents/MacOS/audio_daemon")], check=False)
    # Also catch any older runtime child process.
    run(["pkill", "-f", "Yulu.app/Contents/MacOS/audio_daemon"], check=False)
    time.sleep(1)
    if plist_path.exists():
        run(["launchctl", "load", str(plist_path)], check=False)
    else:
        run(["open", str(app_path)], check=False)
    time.sleep(4)


def print_instructions(data: dict) -> None:
    print("Yulu Screen & System Audio Recording repair")
    print(f"Bundle ID: {data['bundle_id']}")
    print(f"App:       {data['app_path']}")
    print()
    print("If no permission popup appears, do this manually:")
    print("1. System Settings → Privacy & Security → Screen & System Audio Recording")
    print("2. Enable Yulu")
    print("3. If the existing Yulu entry looks stale, remove it, then drag this app in:")
    print(f"   {data['app_path']}")
    print("4. Quit/reopen Yulu if macOS asks, then run:")
    print("   yulu status")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Repair Yulu Screen/System Audio permission")
    parser.add_argument("--reset", action="store_true", help="reset ScreenCapture TCC entry before reopening Yulu")
    parser.add_argument("--no-open-settings", action="store_true", help="do not open System Settings")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)

    data = plan(reset=args.reset)
    if args.reset:
        reset_capture_permission()  # routes through MacOSPermissionModel.reset (D-09)
    restart_daemon()
    status = daemon_status()
    data["status_after_restart"] = status

    if not args.no_open_settings and not status.get("sysReady"):
        run(["open", screen_capture_settings_url()], check=False)

    if args.json:
        print(json.dumps(data, ensure_ascii=False, indent=2))
    else:
        print_instructions(data)
        print()
        print("Status after restart:")
        print(json.dumps(status, ensure_ascii=False, indent=2))
    return 0 if status.get("sysReady") else 2


if __name__ == "__main__":
    raise SystemExit(main())
