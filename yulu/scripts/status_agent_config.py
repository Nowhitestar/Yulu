"""yulu status-agent — config block + launchd plist install helpers.

The ``enabled`` flag is the user's launch preference. This module owns the
config schema and applies enable/disable via launchctl; the Swift menu-bar app
itself does not gate startup on config.json.

The menu-bar agent also exposes IPC and global hotkeys for experimental dictation.
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
    "feedback_sounds": True,
    "hotkeys": {
        "dictate": {"key": "Space", "modifiers": ["ctrl", "alt"]},
        "translate": {"key": "T", "modifiers": ["ctrl", "alt"], "target_language": "English"},
        "voice_chat": {"key": "A", "modifiers": ["ctrl", "alt"]},
    },
}

_MODIFIER_MASKS = {
    "cmd": 0x100,
    "shift": 0x200,
    "alt": 0x800,
    "ctrl": 0x1000,
}
_PRETTY_MODIFIER = {"cmd": "⌘", "shift": "⇧", "alt": "⌥", "ctrl": "⌃"}
_KEYCODES = {
    "A": 0, "S": 1, "D": 2, "F": 3, "H": 4, "G": 5, "Z": 6, "X": 7,
    "C": 8, "V": 9, "B": 11, "Q": 12, "W": 13, "E": 14, "R": 15,
    "Y": 16, "T": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22,
    "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "O": 31, "U": 32,
    "I": 34, "P": 35, "L": 37, "J": 38, "K": 40, "N": 45, "M": 46,
    "Space": 49, "Tab": 48, "Return": 36, "Escape": 53,
    "F1": 122, "F2": 120, "F3": 99, "F4": 118, "F5": 96, "F6": 97,
    "F7": 98, "F8": 100, "F9": 101, "F10": 109, "F11": 103, "F12": 111,
    "F13": 105, "F14": 107, "F15": 113, "F16": 106, "F17": 64,
    "F18": 79, "F19": 80, "F20": 90,
}


def _read_full_config() -> dict:
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _merge_defaults(block: dict) -> dict:
    """Fill in any missing keys from DEFAULT_BLOCK (one level deep)."""
    out = {**DEFAULT_BLOCK, **(block or {})}
    raw_hotkeys = {**DEFAULT_BLOCK["hotkeys"], **(out.get("hotkeys") or {})}
    out["hotkeys"] = {
        name: {**DEFAULT_BLOCK["hotkeys"].get(name, {}), **(spec or {})}
        for name, spec in raw_hotkeys.items()
    }
    return out


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


def keycode_for(key: str) -> int:
    if key not in _KEYCODES:
        raise ValueError(f"unmapped key: {key!r}")
    return _KEYCODES[key]


def modifier_mask(modifiers: list[str]) -> int:
    mask = 0
    for modifier in modifiers:
        if modifier not in _MODIFIER_MASKS:
            raise ValueError(f"unknown modifier: {modifier!r}")
        mask |= _MODIFIER_MASKS[modifier]
    return mask


def format_hotkey(block: dict) -> str:
    mods = block.get("modifiers") or []
    order = ["cmd", "shift", "ctrl", "alt"]
    return "".join(_PRETTY_MODIFIER[m] for m in order if m in mods) + str(block.get("key", ""))


def status_agent_hotkeys() -> list[dict]:
    full = _read_full_config()
    block = _merge_defaults(full.get("status_agent") or {})
    dictation = ((full.get("transcription") or {}).get("dictation") or {})
    target_language = str(
        dictation.get("target_language")
        or block["hotkeys"]["translate"].get("target_language")
        or "English"
    )
    items = []
    for action in ("dictate", "translate", "voice_chat"):
        spec = block["hotkeys"][action]
        item = {
            "action": action,
            "keyCode": keycode_for(spec["key"]),
            "modifierMask": modifier_mask(spec.get("modifiers") or []),
            "label": format_hotkey(spec),
        }
        if action == "translate":
            item["targetLanguage"] = target_language
        items.append(item)
    return items




# ─── CLI ────────────────────────────────────────────────────────

import argparse
import subprocess
import time

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


def _cmd_dictate() -> int:
    try:
        resp = _ipc_send("dictate_toggle")
    except RuntimeError as exc:
        print(f"⚠️ {exc}", file=sys.stderr)
        return 1
    if not resp.get("ok"):
        print(f"⚠️ {resp.get('error', 'dictation toggle failed')}", file=sys.stderr)
        return 1
    before = resp.get("state_before", "?")
    after = resp.get("state_after", "?")
    print(f"✅ dictation: {before} → {after}")
    return 0


def _cmd_translate(args) -> int:
    try:
        resp = _ipc_send("dictate_translate", target_language=args.target_language)
    except RuntimeError as exc:
        print(f"⚠️ {exc}", file=sys.stderr)
        return 1
    if not resp.get("ok"):
        print(f"⚠️ {resp.get('error', 'translation dictation failed')}", file=sys.stderr)
        return 1
    before = resp.get("state_before", "?")
    after = resp.get("state_after", "?")
    print(f"✅ translate: {before} → {after}")
    return 0


def _cmd_voice_chat() -> int:
    try:
        resp = _ipc_send("voice_chat")
    except RuntimeError as exc:
        print(f"⚠️ {exc}", file=sys.stderr)
        return 1
    if not resp.get("ok"):
        print(f"⚠️ {resp.get('error', 'voice chat failed')}", file=sys.stderr)
        return 1
    before = resp.get("state_before", "?")
    after = resp.get("state_after", "?")
    print(f"✅ voice chat: {before} → {after}")
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
    if "dictation_active" in resp:
        print(f"dictation active: {bool(resp['dictation_active'])}")
    if "launcher_pid" in resp:
        print(f"launcher pid: {resp['launcher_pid']}")
    if "voice_chat_window_visible" in resp:
        print(f"voice chat window visible: {bool(resp['voice_chat_window_visible'])}")
    if resp.get("voice_chat_window_url"):
        print(f"voice chat window url: {resp['voice_chat_window_url']}")
    return 0


def _cmd_hotkeys(as_json: bool) -> int:
    try:
        hotkeys = status_agent_hotkeys()
    except (KeyError, ValueError) as exc:
        print(f"⚠️ invalid status_agent.hotkeys config: {exc}", file=sys.stderr)
        return 1
    if as_json:
        print(json.dumps(hotkeys, ensure_ascii=False))
    else:
        for item in hotkeys:
            print(f"{item['action']}: {item['label']}")
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


def _cmd_open_agent_console() -> int:
    try:
        resp = _ipc_send("open_agent_console")
    except RuntimeError as exc:
        print(f"⚠️ {exc}", file=sys.stderr)
        return 1
    if resp.get("ok"):
        print("✅ open_agent_console dispatched")
        return 0
    print(f"⚠️ {resp.get('error', 'failed')}", file=sys.stderr)
    return 1


def _cmd_open_voice_chat(args) -> int:
    fields = {"url": args.url} if args.url else {}
    try:
        resp = _ipc_send("open_voice_chat", **fields)
    except RuntimeError as exc:
        print(f"⚠️ {exc}", file=sys.stderr)
        return 1
    if resp.get("ok"):
        print("✅ open_voice_chat dispatched")
        if "voice_chat_window_visible" in resp:
            print(f"voice chat window visible: {bool(resp['voice_chat_window_visible'])}")
        if resp.get("voice_chat_window_url"):
            print(f"voice chat window url: {resp['voice_chat_window_url']}")
        return 0
    print(f"⚠️ {resp.get('error', 'failed')}", file=sys.stderr)
    return 1


def _cmd_paste_smoke(args) -> int:
    if args.delay_sec > 0:
        time.sleep(args.delay_sec)
    try:
        resp = _ipc_send(
            "paste_clipboard",
            timeout=4.0,
            text=args.text,
            target_bundle_id=args.target_bundle_id,
            target_app_name=args.target_app_name,
        )
    except RuntimeError as exc:
        print(f"⚠️ {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(resp, ensure_ascii=False, indent=2))
    elif resp.get("ok"):
        method = resp.get("method") or "unknown"
        extra = f" ({resp['accessibility_error']})" if resp.get("accessibility_error") else ""
        print(f"✅ paste-smoke: {method}{extra}")
    else:
        print(f"⚠️ {resp.get('error', 'paste-smoke failed')}", file=sys.stderr)
        if resp.get("accessibility_error"):
            print(f"   accessibility: {resp['accessibility_error']}", file=sys.stderr)
        return 1
    return 0


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
    sub.add_parser("dictate", help="Toggle experimental dictation via IPC")
    translate = sub.add_parser("translate", help="Toggle translation dictation via IPC")
    translate.add_argument("--target-language", default="")
    sub.add_parser("voice-chat", help="Record a voice question and send it to Agent Console")
    hotkeys = sub.add_parser("hotkeys", help="Print configured global hotkeys")
    hotkeys.add_argument("--json", action="store_true")
    paste_smoke = sub.add_parser("paste-smoke", help="Paste test text via StatusAgent IPC")
    paste_smoke.add_argument("--text", default="Yulu paste smoke")
    paste_smoke.add_argument("--target-bundle-id", default="")
    paste_smoke.add_argument("--target-app-name", default="")
    paste_smoke.add_argument("--delay-sec", type=float, default=0.0)
    paste_smoke.add_argument("--json", action="store_true")
    sub.add_parser("open-inbox", help="Open the inbox in the browser via IPC")
    sub.add_parser("open-agent-console", help="Open the Agent Console via IPC")
    open_voice_chat = sub.add_parser("open-voice-chat", help="Open the voice chat floating window via IPC")
    open_voice_chat.add_argument("--url", default="")

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
    if args.cmd == "dictate":
        return _cmd_dictate()
    if args.cmd == "translate":
        return _cmd_translate(args)
    if args.cmd == "voice-chat":
        return _cmd_voice_chat()
    if args.cmd == "hotkeys":
        return _cmd_hotkeys(args.json)
    if args.cmd == "paste-smoke":
        return _cmd_paste_smoke(args)
    if args.cmd == "open-inbox":
        return _cmd_open_inbox()
    if args.cmd == "open-agent-console":
        return _cmd_open_agent_console()
    if args.cmd == "open-voice-chat":
        return _cmd_open_voice_chat(args)
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
