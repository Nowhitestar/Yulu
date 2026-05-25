"""yulu status-agent — config block + hotkey parser + Carbon keycode tables.

The status agent reads its hotkey from ~/.config/yulu/config.json's
status_agent block on startup, and re-reads on SIGHUP (sent by
`yulu status-agent set-hotkey`). This module owns the config schema,
the parser, and the Carbon keycode/modifier mappings.
"""

from __future__ import annotations

import json
import os
import signal
import sys
from pathlib import Path
from typing import Optional

CONFIG_PATH = Path.home() / ".config" / "yulu" / "config.json"
PID_PATH = Path.home() / ".config" / "yulu" / "status_agent.pid"

DEFAULT_BLOCK = {
    "enabled": True,
    "hotkey": {"key": "V", "modifiers": ["cmd", "shift"]},
}

# Carbon modifier flags (Carbon.framework <Events.h>)
_MODIFIER_MASKS = {
    "cmd":   0x100,
    "shift": 0x200,
    "alt":   0x800,
    "ctrl":  0x1000,
}

_PRETTY_MODIFIER = {"cmd": "⌘", "shift": "⇧", "alt": "⌥", "ctrl": "⌃"}

# Carbon virtual keycodes (US ANSI layout). Subset that's actually useful
# for menu-bar hotkeys — alphabet, F1-F20, Space, plus a few edge keys.
# Source: <Carbon/Events.h> kVK_ constants.
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
    hotkey = {**DEFAULT_BLOCK["hotkey"], **(out.get("hotkey") or {})}
    out["hotkey"] = hotkey
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
    """Look up the Carbon virtual keycode for `key`."""
    if key not in _KEYCODES:
        raise ValueError(f"unmapped key: {key!r}")
    return _KEYCODES[key]


def modifier_mask(modifiers: list[str]) -> int:
    """OR together the Carbon modifier flags for `modifiers`."""
    mask = 0
    for m in modifiers:
        if m not in _MODIFIER_MASKS:
            raise ValueError(f"unknown modifier: {m!r}")
        mask |= _MODIFIER_MASKS[m]
    return mask


def parse_hotkey(spec: str) -> dict:
    """Parse 'cmd+shift+V' / 'ctrl+F19' / 'alt+Space' → block-shaped dict.

    Rules:
      - At least one modifier required (single-key hotkeys collide too easily).
      - Modifiers normalized to lowercase; key normalized to uppercase for
        alpha-numerics, preserved for Space / F-keys.
      - Raises ValueError on unknown modifier or unmapped key.
    """
    if not spec or not spec.strip():
        raise ValueError("empty hotkey spec")
    parts = [p.strip() for p in spec.split("+") if p.strip()]
    if len(parts) < 2:
        raise ValueError("hotkey requires at least one modifier and one key")
    *mods_raw, key_raw = parts

    mods = []
    for m in mods_raw:
        m_norm = m.lower()
        if m_norm not in _MODIFIER_MASKS:
            raise ValueError(f"unknown modifier: {m!r}")
        if m_norm not in mods:  # dedupe but preserve order
            mods.append(m_norm)

    # Normalize key: alphanumerics → upper; F-keys + named keys preserved
    if len(key_raw) == 1 and key_raw.isalnum():
        key = key_raw.upper()
    else:
        # Try exact, then title-case for named keys
        key = key_raw if key_raw in _KEYCODES else key_raw.title()
    if key not in _KEYCODES:
        raise ValueError(f"unmapped key: {key_raw!r}")

    return {"key": key, "modifiers": mods}


def format_hotkey(block: dict) -> str:
    """Render a config block as a unicode glyph string ('⌘⇧V')."""
    mods = block.get("modifiers") or []
    key = block.get("key", "")
    # Stable display order matching test expectations (⌘⇧V): cmd, shift, alt, ctrl
    order = ["cmd", "shift", "alt", "ctrl"]
    glyphs = "".join(_PRETTY_MODIFIER[m] for m in order if m in mods)
    return f"{glyphs}{key}"


def sighup_running_agent() -> bool:
    """SIGHUP the status agent so it re-reads config + re-registers hotkey.

    Returns True if a SIGHUP was successfully sent; False if no PID file
    or process is gone (in which case the agent will pick up the new
    config on next start)."""
    if not PID_PATH.exists():
        return False
    try:
        pid = int(PID_PATH.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return False
    try:
        os.kill(pid, signal.SIGHUP)
        return True
    except (ProcessLookupError, PermissionError):
        return False


# ─── CLI ────────────────────────────────────────────────────────

import argparse
import subprocess

# Paths the install/enable/disable commands need
SCRIPT_DIR = Path(__file__).resolve().parent
STATUS_AGENT_APP = SCRIPT_DIR / "StatusAgent.app"
PLIST_NAME = "com.yulu.statusagent.plist"
PLIST_DEST = Path.home() / "Library" / "LaunchAgents" / PLIST_NAME

# Accept user-facing 'option' as an alias for 'alt' (Apple keyboards
# label the key as Option). Normalize before parse_hotkey() sees it.
_MOD_ALIASES = {"option": "alt", "opt": "alt", "control": "ctrl", "command": "cmd"}


def _normalize_modifier_aliases(spec: str) -> str:
    out_parts = []
    for part in spec.split("+"):
        p = part.strip().lower()
        out_parts.append(_MOD_ALIASES.get(p, part.strip()))
    return "+".join(out_parts)


def _cmd_set_hotkey(spec: str) -> int:
    try:
        hotkey = parse_hotkey(_normalize_modifier_aliases(spec))
    except ValueError as exc:
        print(f"⚠️ invalid hotkey '{spec}': {exc}", file=sys.stderr)
        return 1
    block = load()
    block["hotkey"] = hotkey
    save(block)
    print(f"✅ hotkey set to {format_hotkey(hotkey)}")
    if sighup_running_agent():
        print("   (SIGHUP'd running status agent to re-register)")
    else:
        print("   (status agent not running; will pick up on next start)")
    return 0


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
    print(f"hotkey: {format_hotkey(block.get('hotkey', {}))}")
    print(f"plist: {'installed' if PLIST_DEST.exists() else 'not installed'}")
    print(f"pid file: {'present' if PID_PATH.exists() else 'absent'}")
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
    sh = sub.add_parser("set-hotkey", help="Rebind the global hotkey "
                                          "(e.g. 'cmd+shift+V', 'alt+space')")
    sh.add_argument("spec", help="Hotkey spec: modifiers + key, plus-separated")

    args = parser.parse_args(argv)
    if args.cmd == "set-hotkey":
        return _cmd_set_hotkey(args.spec)
    if args.cmd == "enable":
        return _cmd_enable()
    if args.cmd == "disable":
        return _cmd_disable()
    if args.cmd == "status":
        return _cmd_status()
    if args.cmd == "install":
        return _cmd_install()
    parser.print_help()
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
