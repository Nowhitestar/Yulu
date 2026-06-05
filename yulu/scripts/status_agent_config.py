"""yulu status-agent — config block + launchd plist install helpers.

The status agent reads its ``enabled`` flag from ~/.config/yulu/config.json's
status_agent block on startup. This module owns the config schema and the
install/enable/disable/IPC commands behind ``yulu status-agent``.

The menu-bar "Start Recording" item records a meeting (mic + system audio);
there is no global hotkey or mic-only mode.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

CONFIG_PATH = Path.home() / ".config" / "yulu" / "config.json"
PID_PATH = Path.home() / ".config" / "yulu" / "status_agent.pid"
IPC_SOCKET_PATH = Path.home() / ".config" / "yulu" / "status_agent.sock"

DEFAULT_BLOCK = {
    "enabled": True,
}


def _read_full_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _merge_defaults(block: dict) -> dict:
    """Fill in any missing keys from DEFAULT_BLOCK (one level deep)."""
    return {**DEFAULT_BLOCK, **(block or {})}


def load() -> dict:
    """Read the status_agent block from config.json (defaults filled in)."""
    full = _read_full_config()
    return _merge_defaults(full.get("status_agent") or {})


def save(block: dict) -> None:
    """Write the status_agent block, preserving other top-level keys."""
    CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
    full = _read_full_config()
    full["status_agent"] = block
    CONFIG_PATH.write_text(
        json.dumps(full, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )




# ─── CLI ────────────────────────────────────────────────────────

import argparse
import subprocess

# Paths the install/enable/disable commands need
SCRIPT_DIR = Path(__file__).resolve().parent
STATUS_AGENT_APP = SCRIPT_DIR / "StatusAgent.app"
PLIST_NAME = "com.yulu.statusagent.plist"
PLIST_DEST = Path.home() / "Library" / "LaunchAgents" / PLIST_NAME


def _cmd_enable() -> int:
    block = load()
    block["enabled"] = True
    save(block)
    print("✅ status agent enabled in config")
    # If plist already installed, load it.
    if PLIST_DEST.exists():
        subprocess.run(["launchctl", "load", str(PLIST_DEST)],
                       capture_output=True)
        print("   (launchctl load issued)")
    return 0


def _cmd_disable() -> int:
    block = load()
    block["enabled"] = False
    save(block)
    print("✅ status agent disabled in config")
    # Always attempt launchctl unload — harmless if the agent isn't loaded
    # (capture_output swallows the "Could not find specified service" noise),
    # and guarantees a stopped daemon even if the plist file was removed
    # out-of-band.
    subprocess.run(["launchctl", "unload", str(PLIST_DEST)],
                   capture_output=True)
    print("   (launchctl unload issued)")
    return 0


def _cmd_status() -> int:
    block = load()
    state = "enabled" if block.get("enabled") else "disabled"
    print(f"status_agent: {state}")
    print(f"plist: {'installed' if PLIST_DEST.exists() else 'not installed'}")
    print(f"pid file: {'present' if PID_PATH.exists() else 'absent'}")
    return 0


# ─── IPC client (talks to running StatusAgent.app via Unix socket) ────

def _ipc_send(action: str, timeout: float = 3.0, **fields) -> dict:
    """Send one line-delimited JSON command to status_agent.sock and read
    the single-line response. Raises RuntimeError when the agent isn't
    reachable so callers can render a uniform error message."""
    import socket as _socket
    payload = {"action": action, **fields}
    line = (json.dumps(payload) + "\n").encode("utf-8")
    s = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        try:
            s.connect(str(IPC_SOCKET_PATH))
        except (FileNotFoundError, ConnectionRefusedError, OSError) as exc:
            # OSError also catches macOS's "AF_UNIX path too long" and other
            # bind-time failures — all of which mean "agent unreachable" from
            # the user's perspective. socket.timeout subclasses OSError in
            # Python 3.10+, so it's caught here too.
            raise RuntimeError(
                f"status_agent IPC unreachable ({exc}). Is the agent running? "
                f"`yulu status-agent status` to check."
            ) from exc
        s.sendall(line)
        chunks: list[bytes] = []
        while True:
            buf = s.recv(4096)
            if not buf:
                break
            chunks.append(buf)
            if buf.endswith(b"\n"):
                break
    finally:
        s.close()
    body = b"".join(chunks).strip()
    if not body:
        raise RuntimeError("empty response from status_agent")
    try:
        return json.loads(body.decode("utf-8"))
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"malformed response: {body!r}") from exc


def _cmd_toggle() -> int:
    try:
        resp = _ipc_send("toggle")
    except RuntimeError as exc:
        print(f"⚠️ {exc}", file=sys.stderr)
        return 1
    if not resp.get("ok"):
        print(f"⚠️ {resp.get('error', 'toggle failed')}", file=sys.stderr)
        return 1
    before = resp.get("state_before", "?")
    after = resp.get("state_after", "?")
    print(f"✅ toggle: {before} → {after}")
    return 0


def _cmd_state() -> int:
    try:
        resp = _ipc_send("status")
    except RuntimeError as exc:
        print(f"⚠️ {exc}", file=sys.stderr)
        return 1
    if not resp.get("ok"):
        print(f"⚠️ {resp.get('error', 'status failed')}", file=sys.stderr)
        return 1
    print(f"state: {resp.get('state', 'unknown')}")
    if "launcher_pid" in resp:
        print(f"launcher pid: {resp['launcher_pid']}")
    return 0


def _cmd_open_inbox() -> int:
    try:
        resp = _ipc_send("open_inbox")
    except RuntimeError as exc:
        print(f"⚠️ {exc}", file=sys.stderr)
        return 1
    if resp.get("ok"):
        print("✅ open_inbox dispatched")
        return 0
    print(f"⚠️ {resp.get('error', 'failed')}", file=sys.stderr)
    return 1


def _cmd_install() -> int:
    if not STATUS_AGENT_APP.exists():
        print(
            f"⚠️ StatusAgent.app not found at {STATUS_AGENT_APP}",
            file=sys.stderr,
        )
        print(
            "   Build it first: bash yulu/scripts/build_status_agent.sh",
            file=sys.stderr,
        )
        return 1
    # Plist install is normally done by setup.sh; this command is a
    # convenience for re-installs without a full setup pass.
    src_plist = SCRIPT_DIR / PLIST_NAME
    if not src_plist.exists():
        print(f"⚠️ plist source missing: {src_plist}", file=sys.stderr)
        return 1
    PLIST_DEST.parent.mkdir(parents=True, exist_ok=True)
    text = src_plist.read_text(encoding="utf-8")
    text = text.replace("__SCRIPT_DIR__", str(SCRIPT_DIR))
    PLIST_DEST.write_text(text, encoding="utf-8")
    subprocess.run(["launchctl", "unload", str(PLIST_DEST)],
                   capture_output=True)
    subprocess.run(["launchctl", "load", str(PLIST_DEST)],
                   capture_output=True)
    print(f"✅ {PLIST_NAME} installed and loaded")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="yulu status-agent",
                                     description="Manage the menu-bar status agent.")
    sub = parser.add_subparsers(dest="cmd")
    sub.add_parser("install", help="Install plist + load via launchctl")
    sub.add_parser("enable",  help="Set enabled=true and load plist")
    sub.add_parser("disable", help="Set enabled=false and unload plist")
    sub.add_parser("status",  help="Show current config + plist load state")
    sub.add_parser("state",   help="Show live state via IPC (idle/recording/...)")
    sub.add_parser("toggle",  help="Toggle recording via IPC (idle ↔ recording)")
    sub.add_parser("open-inbox", help="Open the inbox in the browser via IPC")

    args = parser.parse_args(argv)
    if args.cmd == "enable":
        return _cmd_enable()
    if args.cmd == "disable":
        return _cmd_disable()
    if args.cmd == "status":
        return _cmd_status()
    if args.cmd == "install":
        return _cmd_install()
    if args.cmd == "state":
        return _cmd_state()
    if args.cmd == "toggle":
        return _cmd_toggle()
    if args.cmd == "open-inbox":
        return _cmd_open_inbox()
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
