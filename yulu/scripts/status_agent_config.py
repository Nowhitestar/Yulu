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
