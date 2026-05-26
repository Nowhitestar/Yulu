# Menu-Bar Status Agent + Global Hotkey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a macOS menu-bar status item + global hotkey (default `⌘⇧V`) that drives Phase 4's voicemail capture from any app with one click or one keystroke.

**Architecture:** New Swift `StatusAgent.app` bundle (LSUIElement=YES → no Dock icon), managed by a new `com.yulu.statusagent` launchd job, talks to the existing audio_daemon via the same Unix socket that `record_audio.py` / `voicemail.cli` already use. All voicemail logic stays in `voicemail.recorder` (Phase 4); the agent shells out to `python3 -m voicemail.cli new/stop` as detached subprocesses. New `status_agent_config.py` owns the config block + `yulu status-agent` subcommand. A small companion fix in `audio_daemon.swift::mixAndWrite` re-arms the silence-stop monitor on every audio event (fixing the Phase 3 one-shot bug surfaced by Phase 4 smoke).

**Tech Stack:** Swift 5.x (Cocoa NSStatusItem + Carbon RegisterEventHotKey for global hotkey), Python 3.x (`status_agent_config.py` + `yulu` shell wrapper dispatch), `pytest` for Python helpers, existing build pattern from `build_audio_daemon.sh`, existing launchd / setup.sh integration pattern.

**Spec:** [`docs/superpowers/specs/2026-05-26-status-agent-design.md`](../specs/2026-05-26-status-agent-design.md)

---

## Phase A — Silence-Stop Periodic Fix

### Task A.1: Re-arm silence monitor on every audio event

**Files:**
- Modify: `yulu/scripts/audio_daemon.swift` (`AudioRecorder.mixAndWrite`, line 323)

Phase 3 made `startSilenceMonitor()` a one-shot DispatchWorkItem scheduled at recording start. Voicemail's 3-second threshold makes one-shot semantics brittle. Fix: re-arm on each audio event. `startSilenceMonitor` already cancels its previous task before scheduling a new one, so re-arming is safe and bounded.

- [ ] **Step 1: Read current `mixAndWrite` tail**

Run: `grep -nA 4 "private func mixAndWrite" yulu/scripts/audio_daemon.swift | head -20`

Locate the last statement of the function body — should be `w.append(Data(bytes: out, count: out.count * 2))`.

- [ ] **Step 2: Append `startSilenceMonitor()` to `mixAndWrite`**

After the existing `w.append(Data(bytes: out, count: out.count * 2))` line, add:

```swift
    // Re-arm the silence monitor on every audio event. Phase-3 design
    // was one-shot at +silenceSeconds; under voicemail's 3-second threshold
    // any speaker feedback during the window made the check pass once and
    // never run again. With this re-arm, silence-stop means "no audio for
    // the last N seconds" — which is what users expect.
    startSilenceMonitor()
}
```

(The closing brace `}` is the existing one. Place the call + comment immediately before it.)

- [ ] **Step 3: Build the daemon**

Run: `cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6 && bash yulu/scripts/build_audio_daemon.sh 2>&1 | tail -3`

Must end with "Built and signed Yulu.app". Then revert build artifacts (this commit is source-only — binaries land in a separate commit later):

```bash
git checkout -- yulu/scripts/Yulu.app/
```

- [ ] **Step 4: Sanity-check no Python tests broke**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/ -q 2>&1 | tail -3`
Expected: 257 passed, 1 skipped (Phase 4 baseline). The change is Swift-only; no Python test should break.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/audio_daemon.swift
git commit -m "fix(audio_daemon): re-arm silence monitor on every audio event

Phase 3 ShipShape: silence_monitor was a one-shot DispatchWorkItem at
recording start; under Phase 4 voicemail's 3-second threshold, any
speaker feedback during the window made the check pass once and never
re-run, leaving the recording active until external stop. Surfaced
during Phase 4 real-machine smoke (silence didn't trigger; recording
ran 191s instead of ~13s).

Fix: append startSilenceMonitor() at the end of mixAndWrite. The
existing implementation already cancels the prior task before scheduling
a new one, so re-arming is safe and bounded. Net effect: silence-stop
now means 'no audio for the last N seconds' instead of 'no audio at
exactly +N seconds'."
```

---

## Phase B — Status Agent Config + CLI

### Task B.1: `status_agent_config.py` — config + hotkey parser

**Files:**
- Create: `yulu/scripts/status_agent_config.py`
- Create: `tests/test_status_agent_config.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_status_agent_config.py` (verbatim):

```python
"""Status-agent config block + hotkey parser."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import status_agent_config as sac


def _stub_config(tmp_path: Path, monkeypatch, payload: dict | None = None) -> Path:
    cfg = tmp_path / "config.json"
    cfg.write_text(json.dumps(payload or {}, ensure_ascii=False, indent=2))
    monkeypatch.setattr(sac, "CONFIG_PATH", cfg)
    return cfg


def test_load_defaults_when_block_missing(tmp_path, monkeypatch):
    _stub_config(tmp_path, monkeypatch, {})
    block = sac.load()
    assert block["enabled"] is True
    assert block["hotkey"]["key"] == "V"
    assert block["hotkey"]["modifiers"] == ["cmd", "shift"]


def test_load_defaults_when_config_file_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(sac, "CONFIG_PATH", tmp_path / "nonexistent.json")
    block = sac.load()
    assert block["enabled"] is True
    assert block["hotkey"]["key"] == "V"


def test_load_preserves_existing_block(tmp_path, monkeypatch):
    _stub_config(tmp_path, monkeypatch, {
        "status_agent": {
            "enabled": False,
            "hotkey": {"key": "F19", "modifiers": ["ctrl"]}
        }
    })
    block = sac.load()
    assert block["enabled"] is False
    assert block["hotkey"]["key"] == "F19"
    assert block["hotkey"]["modifiers"] == ["ctrl"]


def test_save_writes_block_under_status_agent_key(tmp_path, monkeypatch):
    cfg = _stub_config(tmp_path, monkeypatch, {"audio": {"backend": "daemon"}})
    sac.save({"enabled": False, "hotkey": {"key": "M", "modifiers": ["cmd", "alt"]}})
    data = json.loads(cfg.read_text(encoding="utf-8"))
    assert data["status_agent"]["enabled"] is False
    assert data["status_agent"]["hotkey"]["key"] == "M"
    # Unrelated blocks preserved
    assert data["audio"]["backend"] == "daemon"


def test_save_creates_config_when_missing(tmp_path, monkeypatch):
    cfg = tmp_path / "fresh.json"
    monkeypatch.setattr(sac, "CONFIG_PATH", cfg)
    sac.save({"enabled": True, "hotkey": {"key": "V", "modifiers": ["cmd", "shift"]}})
    assert cfg.exists()
    assert json.loads(cfg.read_text(encoding="utf-8"))["status_agent"]["enabled"] is True


def test_parse_hotkey_basic():
    out = sac.parse_hotkey("cmd+shift+V")
    assert out == {"key": "V", "modifiers": ["cmd", "shift"]}


def test_parse_hotkey_lowercases_modifiers_uppercases_key():
    out = sac.parse_hotkey("CMD+ALT+m")
    assert out["key"] == "M"
    assert sorted(out["modifiers"]) == ["alt", "cmd"]


def test_parse_hotkey_function_key():
    out = sac.parse_hotkey("ctrl+F19")
    assert out == {"key": "F19", "modifiers": ["ctrl"]}


def test_parse_hotkey_space():
    out = sac.parse_hotkey("alt+Space")
    assert out == {"key": "Space", "modifiers": ["alt"]}


def test_parse_hotkey_rejects_no_modifier():
    with pytest.raises(ValueError, match="at least one modifier"):
        sac.parse_hotkey("V")


def test_parse_hotkey_rejects_unknown_modifier():
    with pytest.raises(ValueError, match="unknown modifier"):
        sac.parse_hotkey("hyper+V")


def test_parse_hotkey_rejects_unmapped_key():
    with pytest.raises(ValueError, match="unmapped key"):
        sac.parse_hotkey("cmd+ßß")


def test_parse_hotkey_rejects_empty():
    with pytest.raises(ValueError):
        sac.parse_hotkey("")
    with pytest.raises(ValueError):
        sac.parse_hotkey("+")


def test_keycode_lookup():
    assert sac.keycode_for("V") == 9
    assert sac.keycode_for("A") == 0
    assert sac.keycode_for("Space") == 49
    assert sac.keycode_for("F1") == 122
    assert sac.keycode_for("F19") == 80


def test_modifier_mask_combines_correctly():
    """Carbon modifier mask: cmdKey=0x100, shiftKey=0x200, optKey=0x800, controlKey=0x1000."""
    assert sac.modifier_mask(["cmd"]) == 0x100
    assert sac.modifier_mask(["shift"]) == 0x200
    assert sac.modifier_mask(["alt"]) == 0x800
    assert sac.modifier_mask(["ctrl"]) == 0x1000
    assert sac.modifier_mask(["cmd", "shift"]) == 0x300
    assert sac.modifier_mask(["alt", "ctrl", "cmd"]) == 0x1900
    assert sac.modifier_mask([]) == 0


def test_format_hotkey_pretty():
    """Used for display in the menu and `yulu status-agent status` output."""
    assert sac.format_hotkey({"key": "V", "modifiers": ["cmd", "shift"]}) == "⌘⇧V"
    assert sac.format_hotkey({"key": "F19", "modifiers": ["ctrl"]}) == "⌃F19"
    assert sac.format_hotkey({"key": "Space", "modifiers": ["alt"]}) == "⌥Space"
```

- [ ] **Step 2: Run tests to verify failure**

Run: `cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6 && PYTHONPATH=yulu/scripts python3 -m pytest tests/test_status_agent_config.py -v`
Expected: ModuleNotFoundError on `status_agent_config`.

- [ ] **Step 3: Create `status_agent_config.py`**

Create `yulu/scripts/status_agent_config.py` (verbatim):

```python
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
    # Stable display order: ctrl ⌃, alt ⌥, shift ⇧, cmd ⌘ (Apple convention)
    order = ["ctrl", "alt", "shift", "cmd"]
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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_status_agent_config.py -v`
Expected: 16 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/status_agent_config.py tests/test_status_agent_config.py
git commit -m "feat(status_agent): add config block + hotkey parser + Carbon keycode tables"
```

---

### Task B.2: `status-agent` CLI dispatch

**Files:**
- Modify: `yulu/scripts/status_agent_config.py` (append `main()` and subcommand handlers)
- Create: `tests/test_status_agent_cli.py`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_status_agent_cli.py`:

```python
"""yulu status-agent CLI dispatch — install/enable/disable/status/set-hotkey."""

from __future__ import annotations

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import status_agent_config as sac


def _stub_paths(tmp_path: Path, monkeypatch) -> Path:
    cfg = tmp_path / "config.json"
    cfg.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(sac, "CONFIG_PATH", cfg)
    monkeypatch.setattr(sac, "PID_PATH", tmp_path / "status_agent.pid")
    return cfg


def test_set_hotkey_writes_config(tmp_path, monkeypatch):
    cfg = _stub_paths(tmp_path, monkeypatch)
    rc = sac.main(["set-hotkey", "ctrl+option+M"])
    assert rc == 0
    data = json.loads(cfg.read_text(encoding="utf-8"))
    # 'option' is the user-facing alias for 'alt' on macOS keyboards.
    # CLI must accept 'option' (already mapped) and write canonical 'alt'.
    # But our parse_hotkey only accepts 'alt' — so this test asserts the
    # CLI normalizes 'option' → 'alt' before parsing.
    # (Either implement the alias here or change the test to "alt+ctrl+M".)
    assert data["status_agent"]["hotkey"]["key"] == "M"
    assert "alt" in data["status_agent"]["hotkey"]["modifiers"]
    assert "ctrl" in data["status_agent"]["hotkey"]["modifiers"]


def test_set_hotkey_sends_sighup(tmp_path, monkeypatch):
    _stub_paths(tmp_path, monkeypatch)
    sent = {"v": False}

    def fake_sighup():
        sent["v"] = True
        return True

    monkeypatch.setattr(sac, "sighup_running_agent", fake_sighup)
    rc = sac.main(["set-hotkey", "cmd+shift+M"])
    assert rc == 0
    assert sent["v"] is True


def test_set_hotkey_rejects_invalid(tmp_path, monkeypatch, capsys):
    _stub_paths(tmp_path, monkeypatch)
    rc = sac.main(["set-hotkey", "hyper+V"])
    assert rc == 1
    err = capsys.readouterr().err
    assert "unknown modifier" in err


def test_enable_writes_enabled_true(tmp_path, monkeypatch):
    cfg = _stub_paths(tmp_path, monkeypatch)
    sac.save({"enabled": False, "hotkey": {"key": "V", "modifiers": ["cmd", "shift"]}})
    rc = sac.main(["enable"])
    assert rc == 0
    assert json.loads(cfg.read_text(encoding="utf-8"))["status_agent"]["enabled"] is True


def test_disable_writes_enabled_false_and_unloads(tmp_path, monkeypatch):
    cfg = _stub_paths(tmp_path, monkeypatch)
    sac.save({"enabled": True, "hotkey": {"key": "V", "modifiers": ["cmd", "shift"]}})

    unloaded = []

    def fake_run(cmd, **kwargs):
        unloaded.append(cmd)
        class _R:
            returncode = 0
            stdout = ""
            stderr = ""
        return _R()

    monkeypatch.setattr(sac.subprocess, "run", fake_run)
    rc = sac.main(["disable"])
    assert rc == 0
    assert json.loads(cfg.read_text(encoding="utf-8"))["status_agent"]["enabled"] is False
    # launchctl unload was invoked
    assert any("unload" in cmd for c in unloaded for cmd in c)


def test_status_prints_current_binding(tmp_path, monkeypatch, capsys):
    _stub_paths(tmp_path, monkeypatch)
    sac.save({"enabled": True, "hotkey": {"key": "V", "modifiers": ["cmd", "shift"]}})
    rc = sac.main(["status"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "⌘⇧V" in out
    assert "enabled" in out.lower()


def test_install_is_stub_when_app_bundle_missing(tmp_path, monkeypatch, capsys):
    """install requires StatusAgent.app to exist — bail with a clear message
    when run before the Swift bundle has been built."""
    _stub_paths(tmp_path, monkeypatch)
    monkeypatch.setattr(sac, "STATUS_AGENT_APP", tmp_path / "missing" / "StatusAgent.app")
    rc = sac.main(["install"])
    assert rc == 1
    err = capsys.readouterr().err
    assert "StatusAgent.app" in err
    assert "build_status_agent.sh" in err


def test_help_when_no_subcommand(capsys):
    rc = sac.main([])
    assert rc != 0
    out = capsys.readouterr().out + capsys.readouterr().err
    assert "install" in out
    assert "set-hotkey" in out
```

- [ ] **Step 2: Run to verify failure**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_status_agent_cli.py -v 2>&1 | tail -10`
Expected: AttributeError — `main` / `subprocess` / `STATUS_AGENT_APP` not in module.

- [ ] **Step 3: Append the CLI to `status_agent_config.py`**

Append to `yulu/scripts/status_agent_config.py`:

```python
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
    if PLIST_DEST.exists():
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
```

- [ ] **Step 4: Run tests to verify pass**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_status_agent_cli.py -v`
Expected: 8 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/status_agent_config.py tests/test_status_agent_cli.py
git commit -m "feat(status_agent): add yulu status-agent CLI (install/enable/disable/status/set-hotkey)"
```

---

## Phase C — Launchd Plist + Shell Wrapper

### Task C.1: launchd plist template

**Files:**
- Create: `yulu/scripts/com.yulu.statusagent.plist`
- Create: `tests/test_status_agent_plist_template.py`

- [ ] **Step 1: Write failing test**

Create `tests/test_status_agent_plist_template.py`:

```python
"""Validate the com.yulu.statusagent.plist template shape."""

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PLIST = ROOT / "yulu" / "scripts" / "com.yulu.statusagent.plist"


def test_plist_exists():
    assert PLIST.exists()


def test_plist_has_required_keys():
    text = PLIST.read_text(encoding="utf-8")
    for needle in (
        "<key>Label</key>",
        "<string>com.yulu.statusagent</string>",
        "<key>ProgramArguments</key>",
        "<key>RunAtLoad</key>",
        "<key>KeepAlive</key>",
        "<key>ThrottleInterval</key>",
        "<key>StandardOutPath</key>",
        "<key>StandardErrorPath</key>",
    ):
        assert needle in text, f"missing {needle}"


def test_plist_uses_open_W_pattern():
    text = PLIST.read_text(encoding="utf-8")
    assert "/usr/bin/open" in text
    assert "-W" in text
    assert "StatusAgent.app" in text


def test_plist_has_script_dir_placeholder():
    """setup.sh substitutes __SCRIPT_DIR__ with the live path."""
    text = PLIST.read_text(encoding="utf-8")
    assert "__SCRIPT_DIR__" in text


def test_plist_has_home_placeholder_for_logs():
    text = PLIST.read_text(encoding="utf-8")
    assert "__HOME__" in text
```

- [ ] **Step 2: Run to verify failure**

Run: `cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6 && PYTHONPATH=yulu/scripts python3 -m pytest tests/test_status_agent_plist_template.py -v`
Expected: AssertionError on `test_plist_exists`.

- [ ] **Step 3: Create the plist template**

Create `yulu/scripts/com.yulu.statusagent.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.yulu.statusagent</string>

    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/open</string>
        <string>-W</string>
        <string>__SCRIPT_DIR__/StatusAgent.app</string>
    </array>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>__HOME__/.config/yulu/status_agent.log</string>

    <key>StandardErrorPath</key>
    <string>__HOME__/.config/yulu/status_agent.log</string>
</dict>
</plist>
```

- [ ] **Step 4: Run tests to verify pass**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/test_status_agent_plist_template.py -v`
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/com.yulu.statusagent.plist tests/test_status_agent_plist_template.py
git commit -m "feat(status_agent): add launchd plist template"
```

---

### Task C.2: Shell wrapper + config.example.json + setup.sh

**Files:**
- Modify: `yulu/scripts/yulu` (shell wrapper dispatch)
- Modify: `yulu/scripts/config.example.json` (status_agent defaults)
- Modify: `yulu/scripts/setup.sh` (install StatusAgent.app + plist)

- [ ] **Step 1: Add `status-agent` case to shell wrapper**

Open `yulu/scripts/yulu`. Find the dispatcher case statement (around line 313). Insert a new case alongside `memo`:

```bash
    status-agent|statusagent) shift; PYTHONPATH="$SCRIPT_DIR:${PYTHONPATH:-}" exec "${PYTHON:-python3}" -m status_agent_config "$@" ;;
```

Place it between the `memo)` line and the `where)` line.

- [ ] **Step 2: Smoke-verify dispatch**

Run: `cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6 && bash yulu/scripts/yulu status-agent status 2>&1 | head -5`
Expected: prints `status_agent: enabled / hotkey: ⌘⇧V / plist: not installed / pid file: absent`.

- [ ] **Step 3: Add status_agent block to config.example.json**

Open `yulu/scripts/config.example.json`. Insert a new top-level block alongside `audio` / `transcription`:

```json
,
  "status_agent": {
    "enabled": true,
    "hotkey": {
      "key": "V",
      "modifiers": ["cmd", "shift"]
    },
    "note": "Phase 5 menu-bar agent + global hotkey. Toggle voicemail capture from any app."
  }
```

(Match the existing comma + indentation conventions in the file. The exact insertion point can be at the end of the object — just before the closing `}` — preserving existing structure.)

- [ ] **Step 4: Extend setup.sh to build + install StatusAgent.app + plist**

Open `yulu/scripts/setup.sh`. Find the audio_daemon build block (search for `build_audio_daemon`). After it, insert a sibling block:

```bash
# Build the status agent bundle (Phase 5)
local sa_build="$SCRIPT_DIR/build_status_agent.sh"
if [[ -x "$sa_build" ]]; then
    info "Building StatusAgent.app..."
    if bash "$sa_build" >/dev/null 2>&1; then
        ok "StatusAgent.app built"
    else
        warn "StatusAgent.app build failed (continuing — status agent will be unavailable)"
    fi
fi
```

Then in `install_launchagents()`, after the audiodaemon load block (around line 853), add:

```bash
# Status agent (Phase 5): menu-bar item + global hotkey for voicemail capture.
if [[ -f "$plist_dir/com.yulu.statusagent.plist" ]]; then
    install_plist "$plist_dir/com.yulu.statusagent.plist" "com.yulu.statusagent.plist"
    launchctl load "$LAUNCH_AGENTS_DIR/com.yulu.statusagent.plist" 2>/dev/null || true
    ok "statusagent 已加载"
fi
```

- [ ] **Step 5: Sanity-check the wrapper + plist + setup file**

Run these three checks:
```bash
bash yulu/scripts/yulu status-agent status 2>&1 | head -3
grep -c "status_agent" yulu/scripts/config.example.json
grep -c "com.yulu.statusagent.plist" yulu/scripts/setup.sh
```
Expected: status output prints; config grep ≥ 1; setup grep ≥ 2 (one in `install_plist` call, one likely in checks elsewhere).

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/yulu yulu/scripts/config.example.json yulu/scripts/setup.sh
git commit -m "feat(yulu+setup): dispatch 'status-agent' subcommand + install plist in setup.sh"
```

---

## Phase D — Swift Status Agent

> Swift code can't be pytest'd in this codebase (Phase 1-4 precedent: build success + symbol/string checks + manual smoke). Each Swift task verifies via `swiftc` build + `grep -aob` on the resulting binary for distinctive literals. Full UI behavior is acceptance-tested at G.3 (real-machine smoke).

### Task D.1: Build script + skeleton app (NSStatusItem only, no menu, no hotkey)

**Files:**
- Create: `yulu/scripts/status_agent.swift` (initial skeleton ~80 lines)
- Create: `yulu/scripts/build_status_agent.sh`

- [ ] **Step 1: Create the build script**

Create `yulu/scripts/build_status_agent.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
APP="$SCRIPT_DIR/StatusAgent.app"
BIN="$SCRIPT_DIR/status_agent"
APP_BIN="$APP/Contents/MacOS/status_agent"
RES_DIR="$APP/Contents/Resources"
INFO="$APP/Contents/Info.plist"
ICNS_SRC="$REPO_DIR/assets/Yulu.icns"
ICONS_DIR="$SCRIPT_DIR/status_agent_icons"
YULU_VERSION_RAW="$(tr -d '[:space:]' < "$REPO_DIR/VERSION" 2>/dev/null || echo "0.0.0+unknown")"
YULU_BUNDLE_VERSION="${YULU_VERSION_RAW%%[-+]*}"
YULU_BUILD_NUMBER="$(git -C "$REPO_DIR" rev-list --count HEAD 2>/dev/null || echo 0)"

cd "$SCRIPT_DIR"

swiftc -o "$BIN" status_agent.swift \
  -framework Cocoa \
  -framework Carbon

mkdir -p "$APP/Contents/MacOS" "$RES_DIR"
cp "$BIN" "$APP_BIN"
chmod +x "$APP_BIN"

if [[ -d "$ICONS_DIR" ]]; then
    cp "$ICONS_DIR"/*.png "$RES_DIR/" 2>/dev/null || true
fi
if [[ -f "$ICNS_SRC" ]]; then
    cp "$ICNS_SRC" "$RES_DIR/Yulu.icns"
fi

plist_set_or_add() {
    local key="$1" type="$2" value="$3"
    /usr/libexec/PlistBuddy -c "Set :$key $value" "$INFO" >/dev/null 2>&1 || \
        /usr/libexec/PlistBuddy -c "Add :$key $type $value" "$INFO" >/dev/null 2>&1 || true
}

plist_set_or_add CFBundleIdentifier         string  com.yulu.statusagent
plist_set_or_add CFBundleName               string  "Yulu Status Agent"
plist_set_or_add CFBundleDisplayName        string  "Yulu Status Agent"
plist_set_or_add CFBundleShortVersionString string  "$YULU_BUNDLE_VERSION"
plist_set_or_add CFBundleVersion            string  "$YULU_BUILD_NUMBER"
plist_set_or_add YuluVersion                string  "$YULU_VERSION_RAW"
plist_set_or_add CFBundleIconFile           string  Yulu
plist_set_or_add LSUIElement                bool    true
plist_set_or_add NSAppleEventsUsageDescription string "Yulu Status Agent opens the inbox in Terminal."

# Code-signing identity selection (same logic as build_audio_daemon.sh)
IDENTITY="${YULU_CODESIGN_IDENTITY:-}"
if [[ -z "$IDENTITY" ]]; then
    IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
        | awk -F'"' '/Developer ID Application/ {print $2; exit}')"
fi
if [[ -z "$IDENTITY" ]]; then
    IDENTITY="$(security find-identity -v -p codesigning 2>/dev/null \
        | awk -F'"' '/Apple Development|Mac Developer/ {print $2; exit}')"
fi
if [[ -z "$IDENTITY" ]]; then
    IDENTITY="-"
fi
codesign --force --deep --timestamp=none --sign "$IDENTITY" "$APP"

echo "✅ Built and signed StatusAgent.app"
echo "   version: $YULU_VERSION_RAW (bundle $YULU_BUNDLE_VERSION, build $YULU_BUILD_NUMBER)"
```

Make it executable:

```bash
chmod +x yulu/scripts/build_status_agent.sh
```

- [ ] **Step 2: Create the skeleton Swift source**

Create `yulu/scripts/status_agent.swift` (initial version — just NSStatusItem with a placeholder icon):

```swift
// Yulu Status Agent — menu-bar item + global hotkey for voicemail capture.
//
// Built as a Cocoa app with LSUIElement=true so it lives only in the menu
// bar (no Dock icon, no main window). All voicemail logic stays in
// voicemail.recorder (Phase 4); this binary is a button that shells out.

import Cocoa
import Carbon

let CONFIG_DIR = ("~/.config/yulu" as NSString).expandingTildeInPath
let PID_FILE = "\(CONFIG_DIR)/status_agent.pid"
let LOG_FILE = "\(CONFIG_DIR)/status_agent.log"

func log(_ msg: String) {
    let ts = ISO8601DateFormatter().string(from: Date())
    let line = "[\(ts)] \(msg)\n"
    FileManager.default.createFile(atPath: LOG_FILE, contents: nil)  // no-op if exists
    if let fh = FileHandle(forWritingAtPath: LOG_FILE) {
        defer { try? fh.close() }
        _ = try? fh.seekToEnd()
        try? fh.write(contentsOf: Data(line.utf8))
    }
}

func writePidFile() {
    let pid = ProcessInfo.processInfo.processIdentifier
    try? "\(pid)".write(toFile: PID_FILE, atomically: true, encoding: .utf8)
}

class StatusAgentApp: NSObject, NSApplicationDelegate {
    var statusItem: NSStatusItem!

    func applicationDidFinishLaunching(_ notification: Notification) {
        writePidFile()
        log("🟢 Yulu Status Agent started (pid=\(ProcessInfo.processInfo.processIdentifier))")

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = statusItem.button {
            // Placeholder: text glyph until the icon assets are wired in D.2.
            btn.title = "语"
            btn.toolTip = "Yulu — click to record voicemail"
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        log("🔴 Yulu Status Agent terminating")
        try? FileManager.default.removeItem(atPath: PID_FILE)
    }
}

let app = NSApplication.shared
let delegate = StatusAgentApp()
app.delegate = delegate
app.setActivationPolicy(.accessory)  // belt-and-braces: hide from Dock even if LSUIElement somehow missing
app.run()
```

- [ ] **Step 3: Build the agent**

Run: `cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6 && bash yulu/scripts/build_status_agent.sh 2>&1 | tail -3`
Expected: "✅ Built and signed StatusAgent.app".

- [ ] **Step 4: Verify binary contents**

Run: `grep -aob "Yulu Status Agent\|status_agent.pid\|status_agent.log" yulu/scripts/StatusAgent.app/Contents/MacOS/status_agent | head -5`
Expected: at least 3 hits with those strings.

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/build_status_agent.sh yulu/scripts/status_agent.swift yulu/scripts/StatusAgent.app
git commit -m "feat(status_agent): build script + skeleton Cocoa app (NSStatusItem placeholder)"
```

(Yes, commit the StatusAgent.app bundle here — same pattern as Phase 1 Yulu.app. Subsequent Swift tasks will rebuild and re-commit.)

---

### Task D.2: NSMenu + Recent Voicemails submenu

**Files:**
- Modify: `yulu/scripts/status_agent.swift` (append menu builder)

- [ ] **Step 1: Append menu builder code**

Append to `yulu/scripts/status_agent.swift` (place the MenuBuilder class above the `let app = NSApplication.shared` block):

```swift
class MenuBuilder {
    static func build(target: AnyObject) -> NSMenu {
        let menu = NSMenu()
        // The Start/Stop title is updated dynamically by StatusAgentApp;
        // here we just provide an action wire-up.
        let toggleItem = NSMenuItem(
            title: "Start Voicemail",
            action: #selector(StatusAgentApp.onMenuToggle),
            keyEquivalent: ""
        )
        toggleItem.target = target
        toggleItem.identifier = NSUserInterfaceItemIdentifier("toggle")
        menu.addItem(toggleItem)
        menu.addItem(NSMenuItem.separator())

        let recentLabel = NSMenuItem(title: "Recent voicemails", action: nil, keyEquivalent: "")
        recentLabel.isEnabled = false
        menu.addItem(recentLabel)
        // Up to 5 dynamic items inserted here at menuWillOpen time
        for i in 0..<5 {
            let item = NSMenuItem(title: "", action: nil, keyEquivalent: "")
            item.identifier = NSUserInterfaceItemIdentifier("recent_\(i)")
            item.isHidden = true
            menu.addItem(item)
        }
        let openInbox = NSMenuItem(
            title: "Open inbox in Terminal",
            action: #selector(StatusAgentApp.onOpenInbox),
            keyEquivalent: ""
        )
        openInbox.target = target
        menu.addItem(openInbox)
        menu.addItem(NSMenuItem.separator())

        let hotkeyLabel = NSMenuItem(title: "Hotkey: (loading…)",
                                      action: nil, keyEquivalent: "")
        hotkeyLabel.isEnabled = false
        hotkeyLabel.identifier = NSUserInterfaceItemIdentifier("hotkey_label")
        menu.addItem(hotkeyLabel)
        menu.addItem(NSMenuItem.separator())

        let quit = NSMenuItem(
            title: "Quit Yulu Status Agent",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        menu.addItem(quit)
        return menu
    }
}

// Helper to read recent voicemails via the existing Python repo.
// Shells out to a tiny one-liner so we don't reimplement repo logic
// in Swift. Returns up to N (stem, has_summary) tuples; empty on error.
func loadRecentVoicemails(limit: Int = 5) -> [(stem: String, hasSummary: Bool)] {
    let scriptDir = ProcessInfo.processInfo.environment["YULU_SCRIPT_DIR"]
        ?? "\((Bundle.main.bundlePath as NSString).deletingLastPathComponent)"
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    task.arguments = [
        "PYTHONPATH=\(scriptDir)",
        "python3", "-c",
        """
        from voicemail.repo import list_voicemails
        for r in list_voicemails(limit=\(limit)):
            print(f"{r.stem}\\t{int(r.has_summary)}")
        """
    ]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = Pipe()
    do {
        try task.run()
        task.waitUntilExit()
    } catch {
        log("⚠️ failed to enumerate voicemails: \(error)")
        return []
    }
    guard let data = try? pipe.fileHandleForReading.readToEnd(),
          let text = String(data: data ?? Data(), encoding: .utf8) else {
        return []
    }
    var out: [(stem: String, hasSummary: Bool)] = []
    for line in text.split(separator: "\n") {
        let parts = line.split(separator: "\t")
        if parts.count == 2 {
            out.append((String(parts[0]), parts[1] == "1"))
        }
    }
    return out
}
```

Now extend the `StatusAgentApp` class to attach the menu and handlers. Replace the existing `applicationDidFinishLaunching` body (and add new methods + properties):

```swift
class StatusAgentApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var statusItem: NSStatusItem!
    var menu: NSMenu!

    func applicationDidFinishLaunching(_ notification: Notification) {
        writePidFile()
        log("🟢 Yulu Status Agent started (pid=\(ProcessInfo.processInfo.processIdentifier))")

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = statusItem.button {
            btn.title = "语"
            btn.toolTip = "Yulu — click to record voicemail"
        }
        menu = MenuBuilder.build(target: self)
        menu.delegate = self
        statusItem.menu = menu
    }

    func applicationWillTerminate(_ notification: Notification) {
        log("🔴 Yulu Status Agent terminating")
        try? FileManager.default.removeItem(atPath: PID_FILE)
    }

    // Refresh dynamic items whenever the menu is about to display
    func menuWillOpen(_ menu: NSMenu) {
        let recents = loadRecentVoicemails(limit: 5)
        for i in 0..<5 {
            guard let item = menu.item(withIdentifier:
                NSUserInterfaceItemIdentifier("recent_\(i)")) else { continue }
            if i < recents.count {
                let r = recents[i]
                let glyph = r.hasSummary ? "✓ " : "  "
                item.title = "\(glyph)\(r.stem)"
                item.target = self
                item.action = #selector(onRecentClicked(_:))
                item.representedObject = r.stem
                item.isHidden = false
            } else {
                item.isHidden = true
            }
        }
    }

    @objc func onMenuToggle() {
        // Wired in D.5 (VoicemailLauncher). For now, just log.
        log("menu → Start/Stop tapped (toggle stub)")
    }

    @objc func onOpenInbox() {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
        task.arguments = ["-e", "tell application \"Terminal\" to do script \"yulu memo list\""]
        try? task.run()
    }

    @objc func onRecentClicked(_ sender: NSMenuItem) {
        guard let stem = sender.representedObject as? String else { return }
        let dir = ("~/Movies/Yulu/voicemails" as NSString).expandingTildeInPath
        // Prefer summary over transcript over wav
        for ext in [".summary.md", ".transcript.txt", ".wav"] {
            let path = "\(dir)/\(stem)\(ext)"
            if FileManager.default.fileExists(atPath: path) {
                NSWorkspace.shared.open(URL(fileURLWithPath: path))
                return
            }
        }
    }
}
```

NOTE on `NSUserInterfaceItemIdentifier`: this is the correct API for tagging menu items so we can find them on update. The `withIdentifier:` lookup is `menu.item(withIdentifier:)` on macOS 11+.

- [ ] **Step 2: Build**

Run: `bash yulu/scripts/build_status_agent.sh 2>&1 | tail -3`
Expected: build succeeds.

- [ ] **Step 3: Verify binary contents**

Run: `grep -aob "Start Voicemail\|Recent voicemails\|Open inbox in Terminal\|Quit Yulu Status Agent" yulu/scripts/StatusAgent.app/Contents/MacOS/status_agent | head -10`
Expected: at least 4 hits.

- [ ] **Step 4: Commit**

```bash
git add yulu/scripts/status_agent.swift yulu/scripts/StatusAgent.app
git commit -m "feat(status_agent): NSMenu with Recent Voicemails submenu + Open Inbox handler"
```

---

### Task D.3: Carbon hotkey registration + toggle wiring

**Files:**
- Modify: `yulu/scripts/status_agent.swift` (HotkeyRegistrar + integration)

- [ ] **Step 1: Append the hotkey registrar**

Append to `yulu/scripts/status_agent.swift` (place the HotkeyRegistrar class above the StatusAgentApp class so the class can reference it):

```swift
// Carbon RegisterEventHotKey wrapper.
//
// We use Carbon (not NSEvent.addGlobalMonitorForEvents) because Carbon
// doesn't require Input Monitoring permission — system-wide hotkeys with
// modifier keys work out of the box. The API is legacy but stable on
// macOS 14/15. RegisterEventHotKey contract: returns OSStatus, fills in
// an EventHotKeyRef out-parameter, fires kEventHotKeyPressed events to
// the application event target. We install one handler that fires our
// toggle closure.

class HotkeyRegistrar {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private var onTrigger: (() -> Void)?

    static let signature: OSType = 0x59556C75  // 'YuLu' fourcc

    func register(keyCode: UInt32, modifierMask: UInt32, _ trigger: @escaping () -> Void) -> Bool {
        unregister()
        onTrigger = trigger

        var hotKeyID = EventHotKeyID(signature: HotkeyRegistrar.signature, id: 1)
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard),
                                  eventKind: UInt32(kEventHotKeyPressed))

        // Install global handler if not yet installed
        let handler: EventHandlerUPP = { (_, eventRef, userData) -> OSStatus in
            guard let userData = userData else { return noErr }
            let me = Unmanaged<HotkeyRegistrar>.fromOpaque(userData).takeUnretainedValue()
            DispatchQueue.main.async { me.onTrigger?() }
            return noErr
        }
        let selfPtr = Unmanaged.passUnretained(self).toOpaque()
        let installStatus = InstallEventHandler(
            GetApplicationEventTarget(),
            handler, 1, &spec, selfPtr, &handlerRef
        )
        if installStatus != noErr {
            log("⚠️ InstallEventHandler failed: \(installStatus)")
            return false
        }

        let regStatus = RegisterEventHotKey(
            keyCode, modifierMask, hotKeyID,
            GetApplicationEventTarget(), 0, &hotKeyRef
        )
        if regStatus != noErr {
            log("⚠️ RegisterEventHotKey failed: \(regStatus) (key conflict?)")
            return false
        }
        log("hotkey_registered keyCode=\(keyCode) modifiers=0x\(String(modifierMask, radix: 16))")
        return true
    }

    func unregister() {
        if let ref = hotKeyRef {
            UnregisterEventHotKey(ref)
            hotKeyRef = nil
        }
        if let h = handlerRef {
            RemoveEventHandler(h)
            handlerRef = nil
        }
    }
}

// Read config (key + modifiers) by shelling to the Python helper.
// Returns (keyCode, modifierMask, prettyLabel). Falls back to ⌘⇧V on error.
func readHotkeyFromConfig() -> (keyCode: UInt32, modifierMask: UInt32, pretty: String) {
    let scriptDir = ProcessInfo.processInfo.environment["YULU_SCRIPT_DIR"]
        ?? "\((Bundle.main.bundlePath as NSString).deletingLastPathComponent)"
    let task = Process()
    task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
    task.arguments = [
        "PYTHONPATH=\(scriptDir)",
        "python3", "-c",
        """
        import status_agent_config as sac
        b = sac.load()
        k = sac.keycode_for(b['hotkey']['key'])
        m = sac.modifier_mask(b['hotkey']['modifiers'])
        p = sac.format_hotkey(b['hotkey'])
        print(f'{k}\\t{m}\\t{p}')
        """
    ]
    let pipe = Pipe()
    task.standardOutput = pipe
    task.standardError = Pipe()
    do {
        try task.run()
        task.waitUntilExit()
    } catch {
        return (9, 0x300, "⌘⇧V")  // fallback
    }
    guard let data = try? pipe.fileHandleForReading.readToEnd(),
          let text = String(data: data ?? Data(), encoding: .utf8) else {
        return (9, 0x300, "⌘⇧V")
    }
    let parts = text.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\t")
    guard parts.count == 3,
          let kc = UInt32(parts[0]),
          let mm = UInt32(parts[1]) else {
        return (9, 0x300, "⌘⇧V")
    }
    return (kc, mm, String(parts[2]))
}
```

- [ ] **Step 2: Wire the registrar + SIGHUP handler into `StatusAgentApp`**

Extend `StatusAgentApp` properties + `applicationDidFinishLaunching` body:

```swift
class StatusAgentApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var statusItem: NSStatusItem!
    var menu: NSMenu!
    let hotkey = HotkeyRegistrar()

    func applicationDidFinishLaunching(_ notification: Notification) {
        writePidFile()
        log("🟢 Yulu Status Agent started (pid=\(ProcessInfo.processInfo.processIdentifier))")

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let btn = statusItem.button {
            btn.title = "语"
            btn.toolTip = "Yulu — click to record voicemail"
        }
        menu = MenuBuilder.build(target: self)
        menu.delegate = self
        statusItem.menu = menu

        // Initial hotkey registration
        registerHotkeyFromConfig()

        // SIGHUP → re-read config + re-register
        let sigsrc = DispatchSource.makeSignalSource(signal: SIGHUP, queue: .main)
        sigsrc.setEventHandler { [weak self] in
            log("SIGHUP received — re-registering hotkey")
            self?.registerHotkeyFromConfig()
        }
        sigsrc.resume()
        // Carbon expects SIGHUP delivered to the process, so suppress the
        // default SIG_DFL action that would otherwise terminate us.
        signal(SIGHUP, SIG_IGN)
    }

    private func registerHotkeyFromConfig() {
        let (kc, mm, pretty) = readHotkeyFromConfig()
        let ok = hotkey.register(keyCode: kc, modifierMask: mm) { [weak self] in
            self?.onHotkeyToggle()
        }
        // Update the menu's hotkey label
        if let item = menu.item(withIdentifier: NSUserInterfaceItemIdentifier("hotkey_label")) {
            item.title = ok ? "Hotkey: \(pretty)" : "Hotkey: unavailable (\(pretty) — registration failed)"
        }
    }

    @objc func onHotkeyToggle() {
        log("hotkey → toggle")
        onMenuToggle()
    }

    // ... existing onMenuToggle / onOpenInbox / onRecentClicked / menuWillOpen unchanged ...
}
```

- [ ] **Step 3: Build**

Run: `bash yulu/scripts/build_status_agent.sh 2>&1 | tail -3`

If build fails on Carbon API symbols, check that `-framework Carbon` is on the swiftc command line (it should be — added in D.1's build script).

Expected: success.

- [ ] **Step 4: Verify binary**

Run: `grep -aob "hotkey_registered\|RegisterEventHotKey\|Hotkey: unavailable" yulu/scripts/StatusAgent.app/Contents/MacOS/status_agent | head`
Expected: at least 2 hits (the literal strings we logged + the menu label).

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/status_agent.swift yulu/scripts/StatusAgent.app
git commit -m "feat(status_agent): Carbon RegisterEventHotKey + SIGHUP re-registration"
```

---

### Task D.4: Daemon poller + state machine

**Files:**
- Modify: `yulu/scripts/status_agent.swift` (DaemonClient + IconStateMachine + poller)

- [ ] **Step 1: Append DaemonClient + state machine**

Append to `yulu/scripts/status_agent.swift`:

```swift
// Synchronous Unix-socket client. Mirrors record_audio.socket_send's
// line-delimited JSON contract: write one JSON object + newline, read
// one JSON object back.
class DaemonClient {
    static let socketPath = (("~/.config/yulu/audio_daemon.sock") as NSString).expandingTildeInPath

    static func send(_ payload: [String: Any]) -> [String: Any]? {
        guard let json = try? JSONSerialization.data(withJSONObject: payload, options: []) else {
            return nil
        }
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }

        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let pathBytes = socketPath.utf8CString
        guard pathBytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return nil }
        withUnsafeMutablePointer(to: &addr.sun_path) { ptr in
            ptr.withMemoryRebound(to: CChar.self, capacity: pathBytes.count) { p in
                _ = strncpy(p, pathBytes.baseAddress!, pathBytes.count)
            }
        }
        let len = socklen_t(MemoryLayout<sockaddr_un>.size)
        let connectResult = withUnsafePointer(to: &addr) { ptr -> Int32 in
            ptr.withMemoryRebound(to: sockaddr.self, capacity: 1) { sa in
                Darwin.connect(fd, sa, len)
            }
        }
        guard connectResult >= 0 else { return nil }

        // Write JSON + newline
        var line = json
        line.append(0x0A)
        _ = line.withUnsafeBytes { buf in
            write(fd, buf.baseAddress, buf.count)
        }

        // Read response (up to 64 KB, blocking — daemon is local)
        var buffer = [UInt8](repeating: 0, count: 65536)
        let n = read(fd, &buffer, buffer.count)
        guard n > 0 else { return nil }
        let data = Data(buffer[0..<n])
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }
}

enum AgentState: String {
    case idle, recording, processing, meetingBusy, daemonDown
}

class IconStateMachine {
    static func glyph(for state: AgentState) -> String {
        switch state {
        case .idle:         return "语"
        case .recording:    return "🔴语"
        case .processing:   return "⋯语"
        case .meetingBusy:  return "🟡语"
        case .daemonDown:   return "🚫语"
        }
    }
}
```

NOTE on icons: D.1's skeleton uses a text glyph (`语`) as a stand-in. Real `NSImage` template variants are wired in Phase E (E.1). For D.4 we keep text glyphs with emoji prefixes — easier to verify state changes in the menu bar visually during dev, and Phase E swaps them in without changing the state machine.

- [ ] **Step 2: Wire the poller + state into StatusAgentApp**

Update `StatusAgentApp` again. Add a poller property + start it in `applicationDidFinishLaunching`:

```swift
class StatusAgentApp: NSObject, NSApplicationDelegate, NSMenuDelegate {
    var statusItem: NSStatusItem!
    var menu: NSMenu!
    let hotkey = HotkeyRegistrar()
    var pollerTimer: Timer?
    var state: AgentState = .idle
    var daemonDownStreak: Int = 0
    var launcherPid: Int32?   // populated by VoicemailLauncher (Task D.5)

    func applicationDidFinishLaunching(_ notification: Notification) {
        // ... existing body (writePidFile, log, statusItem, menu, hotkey, SIGHUP) ...

        // Start polling at 1 Hz
        pollerTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.poll()
        }
        poll()  // immediate first tick
    }

    private func poll() {
        guard let resp = DaemonClient.send(["action": "status"]) else {
            daemonDownStreak += 1
            if daemonDownStreak >= 3 {
                applyState(.daemonDown)
            }
            return
        }
        daemonDownStreak = 0
        let recording = (resp["recording"] as? Bool) ?? false
        let file = (resp["file"] as? String) ?? ""

        if recording {
            if file.contains("/voicemails/") {
                applyState(.recording)
            } else {
                applyState(.meetingBusy)
            }
            return
        }

        // Not recording. Are we waiting for a launcher to finish (processing)?
        if let pid = launcherPid, kill(pid, 0) == 0 {
            applyState(.processing)
            return
        }
        if launcherPid != nil { launcherPid = nil }
        applyState(.idle)
    }

    private func applyState(_ new: AgentState) {
        guard new != state else { return }
        state = new
        if let btn = statusItem.button {
            btn.title = IconStateMachine.glyph(for: new)
        }
        // Update the menu's toggle label
        if let item = menu.item(withIdentifier: NSUserInterfaceItemIdentifier("toggle")) {
            switch new {
            case .idle:        item.title = "Start Voicemail"
            case .recording:   item.title = "● Recording — click to stop"
            case .processing:  item.title = "⋯ Transcribing…"
            case .meetingBusy: item.title = "Meeting in progress"
            case .daemonDown:  item.title = "Audio daemon not running"
            }
            item.isEnabled = (new == .idle || new == .recording)
        }
    }

    // ... existing handlers unchanged ...
}
```

- [ ] **Step 3: Build + verify**

Run: `bash yulu/scripts/build_status_agent.sh 2>&1 | tail -3`
Expected: build succeeds.

Run: `grep -aob "audio_daemon.sock\|Audio daemon not running\|Meeting in progress" yulu/scripts/StatusAgent.app/Contents/MacOS/status_agent | head`
Expected: at least 2 hits.

- [ ] **Step 4: Commit**

```bash
git add yulu/scripts/status_agent.swift yulu/scripts/StatusAgent.app
git commit -m "feat(status_agent): daemon poller + 5-state machine (idle/recording/processing/meeting_busy/daemon_down)"
```

---

### Task D.5: `VoicemailLauncher` — spawn detached `voicemail.cli` for toggle

**Files:**
- Modify: `yulu/scripts/status_agent.swift` (VoicemailLauncher + toggle implementation)

- [ ] **Step 1: Append the launcher + replace toggle stub**

Append to `yulu/scripts/status_agent.swift`:

```swift
// Spawn `voicemail.cli new` / `voicemail.cli stop` as detached subprocesses.
// All recording lifecycle + transcribe + enqueue stays in the Phase 4
// Python module — the status agent is just a button.
class VoicemailLauncher {
    static func launchNew() -> Int32? {
        let scriptDir = ProcessInfo.processInfo.environment["YULU_SCRIPT_DIR"]
            ?? "\((Bundle.main.bundlePath as NSString).deletingLastPathComponent)"
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = [
            "PYTHONPATH=\(scriptDir)",
            "python3", "-m", "voicemail.cli", "new",
        ]
        // Detach from agent's stdio so the subprocess survives independently
        task.standardInput = FileHandle.nullDevice
        let logPath = (("~/.config/yulu/status_agent_launcher.log") as NSString).expandingTildeInPath
        FileManager.default.createFile(atPath: logPath, contents: nil)
        let logFH = FileHandle(forWritingAtPath: logPath) ?? FileHandle.nullDevice
        _ = try? logFH.seekToEnd()
        task.standardOutput = logFH
        task.standardError = logFH
        do {
            try task.run()
            return task.processIdentifier
        } catch {
            log("⚠️ failed to launch voicemail.cli new: \(error)")
            return nil
        }
    }

    static func sendStop() {
        // `voicemail.cli stop` is the user-visible idempotent stop. The
        // already-running `voicemail.cli new` subprocess detects the
        // recording→idle transition in its poll loop and triggers
        // _transcribe_and_enqueue itself; cmd_stop's role is just to send
        // the daemon stop RPC.
        let scriptDir = ProcessInfo.processInfo.environment["YULU_SCRIPT_DIR"]
            ?? "\((Bundle.main.bundlePath as NSString).deletingLastPathComponent)"
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        task.arguments = [
            "PYTHONPATH=\(scriptDir)",
            "python3", "-m", "voicemail.cli", "stop",
        ]
        task.standardOutput = FileHandle.nullDevice
        task.standardError = FileHandle.nullDevice
        try? task.run()
        task.waitUntilExit()  // stop is fast (just one socket roundtrip)
    }
}
```

- [ ] **Step 2: Replace `onMenuToggle` stub with real logic**

In `StatusAgentApp`, replace the `onMenuToggle` body:

```swift
@objc func onMenuToggle() {
    log("toggle (state=\(state.rawValue))")
    switch state {
    case .idle:
        if let pid = VoicemailLauncher.launchNew() {
            launcherPid = pid
            applyState(.recording)
        }
    case .recording:
        VoicemailLauncher.sendStop()
        // Poller will see recording=false; launcherPid still alive → processing
    case .processing:
        log("ignoring click while processing")
    case .meetingBusy:
        showMeetingBusyNotification()
    case .daemonDown:
        showDaemonDownNotification()
    }
}

private func showMeetingBusyNotification() {
    guard let resp = DaemonClient.send(["action": "status"]) else { return }
    let file = (resp["file"] as? String) ?? "<unknown>"
    let title = (file as NSString).lastPathComponent
    log("meeting busy: \(title)")
    let note = NSUserNotification()
    note.title = "Yulu"
    note.informativeText = "Recording in progress: \(title)"
    NSUserNotificationCenter.default.deliver(note)
}

private func showDaemonDownNotification() {
    log("daemon down — surfacing notification")
    let note = NSUserNotification()
    note.title = "Yulu"
    note.informativeText = "audio_daemon not running. Restart with: launchctl load ~/Library/LaunchAgents/com.yulu.audiodaemon.plist"
    NSUserNotificationCenter.default.deliver(note)
}
```

NOTE: `NSUserNotification` is deprecated in macOS 10.14 but still functional in macOS 15. Replacement is `UNUserNotificationCenter` which requires App authorization. For an unsigned/ad-hoc-signed launchd-managed background agent the modern API tends to fail silently; the deprecated NSUserNotification reliably delivers Banner-style notifications without authorization prompts. Future spec can migrate to UN when packaging matures.

- [ ] **Step 3: Build + verify**

Run: `bash yulu/scripts/build_status_agent.sh 2>&1 | tail -3`
Expected: build succeeds (may emit deprecation warnings for NSUserNotification — ignore).

Run: `grep -aob "voicemail.cli\|launcher.log\|Recording in progress\|audio_daemon not running" yulu/scripts/StatusAgent.app/Contents/MacOS/status_agent | head`
Expected: at least 3 hits.

- [ ] **Step 4: Commit**

```bash
git add yulu/scripts/status_agent.swift yulu/scripts/StatusAgent.app
git commit -m "feat(status_agent): VoicemailLauncher + real toggle behavior (idle→recording→processing→idle)"
```

---

## Phase E — Icon Resources

### Task E.1: 3 PNG status icon variants

**Files:**
- Create: `yulu/scripts/status_agent_icons/status_idle.png` (18×18 + @2x 36×36)
- Create: `yulu/scripts/status_agent_icons/status_recording.png`
- Create: `yulu/scripts/status_agent_icons/status_processing.png`
- Modify: `yulu/scripts/status_agent.swift` (use NSImage instead of text glyph)

The icons are template-mode PNGs (black with alpha; macOS auto-inverts for dark mode). The simplest path:
1. Start from `assets/Yulu.icns` 16×16 variant
2. For `status_recording.png`: composite a small red dot in the bottom-right
3. For `status_processing.png`: composite three small dots in the bottom-right

Since assets are hand-tweaked once and committed, this task uses `sips` to extract a base PNG and Python's PIL (already a runtime dep via mlx-whisper) for overlay composition.

- [ ] **Step 1: Generate the 3 PNGs via a one-shot script**

Run this as a one-time generator (NOT committed as a build step — the PNGs themselves are committed):

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
mkdir -p yulu/scripts/status_agent_icons

# Extract 18×18 base from Yulu.icns
sips -s format png -z 18 18 assets/Yulu.icns --out /tmp/yulu_base_18.png 2>/dev/null
sips -s format png -z 36 36 assets/Yulu.icns --out /tmp/yulu_base_36.png 2>/dev/null

# Template-mode means black + alpha. Convert to grayscale + alpha.
python3 <<'PY'
from PIL import Image, ImageDraw

def to_template(src_path: str, dst_path: str):
    img = Image.open(src_path).convert("RGBA")
    # Convert to black + alpha; macOS will tint based on appearance
    out = Image.new("RGBA", img.size, (0, 0, 0, 0))
    for x in range(img.width):
        for y in range(img.height):
            r, g, b, a = img.getpixel((x, y))
            luma = int(0.299*r + 0.587*g + 0.114*b)
            # darker pixel → more opaque template ink
            alpha = a if luma < 128 else int(a * (1 - (luma - 128) / 127))
            out.putpixel((x, y), (0, 0, 0, alpha))
    out.save(dst_path)

def add_overlay(base_path: str, dst_path: str, overlay: str):
    img = Image.open(base_path).convert("RGBA")
    draw = ImageDraw.Draw(img)
    w, h = img.size
    if overlay == "recording":
        # Red dot bottom-right, ~30% of icon size
        d = max(4, w // 3)
        draw.ellipse([w - d, h - d, w, h], fill=(220, 30, 30, 255))
    elif overlay == "processing":
        # Three dots horizontally, bottom-right corner
        r = max(1, w // 10)
        y = h - r * 2
        for i in range(3):
            x = w - (r * 6) + i * (r * 2)
            draw.ellipse([x, y, x + r, y + r], fill=(0, 0, 0, 220))
    img.save(dst_path)

OUT = "yulu/scripts/status_agent_icons"
for size in (18, 36):
    src = f"/tmp/yulu_base_{size}.png"
    suffix = "" if size == 18 else "@2x"
    to_template(src, f"{OUT}/status_idle{suffix}.png")
    add_overlay(f"{OUT}/status_idle{suffix}.png", f"{OUT}/status_recording{suffix}.png", "recording")
    add_overlay(f"{OUT}/status_idle{suffix}.png", f"{OUT}/status_processing{suffix}.png", "processing")
print("✅ generated 6 PNGs")
PY

ls yulu/scripts/status_agent_icons/
```

Expected: 6 files (`status_idle.png`, `status_idle@2x.png`, `status_recording.png`, `status_recording@2x.png`, `status_processing.png`, `status_processing@2x.png`).

If `sips` fails because `Yulu.icns` is missing or in an unexpected format, the fallback is to handcraft simple 18×18 PNGs using Pillow alone (draw `语` Unicode glyph onto a transparent canvas). Document and adapt.

- [ ] **Step 2: Replace text glyphs with NSImage in `status_agent.swift`**

In `IconStateMachine`, replace `glyph(for:)` with an NSImage-returning version:

```swift
class IconStateMachine {
    static func image(for state: AgentState) -> NSImage? {
        let name: String
        switch state {
        case .idle:         name = "status_idle"
        case .recording:    name = "status_recording"
        case .processing:   name = "status_processing"
        case .meetingBusy:  name = "status_idle"   // greyed-out via alpha (set by caller)
        case .daemonDown:   name = "status_idle"   // strikethrough overlay drawn by caller
        }
        guard let img = NSImage(named: name) else { return nil }
        img.isTemplate = true
        return img
    }
}
```

In `StatusAgentApp.applyState`, replace `btn.title = IconStateMachine.glyph(for: new)` with:

```swift
if let btn = statusItem.button {
    if let img = IconStateMachine.image(for: new) {
        btn.image = img
        btn.title = ""
    } else {
        // Fallback if assets missing — keep text glyph
        btn.image = nil
        switch new {
        case .idle:        btn.title = "语"
        case .recording:   btn.title = "● 语"
        case .processing:  btn.title = "⋯ 语"
        case .meetingBusy: btn.title = "🟡 语"
        case .daemonDown:  btn.title = "🚫 语"
        }
    }
    if new == .meetingBusy {
        btn.alphaValue = 0.4  // greyed-out
    } else {
        btn.alphaValue = 1.0
    }
}
```

- [ ] **Step 3: Build + verify**

Run: `bash yulu/scripts/build_status_agent.sh 2>&1 | tail -3`
Expected: build succeeds. The Resources directory inside the bundle should now contain the 6 PNGs (copied by the build script's `cp "$ICONS_DIR"/*.png "$RES_DIR/"` line).

```bash
ls yulu/scripts/StatusAgent.app/Contents/Resources/
```
Expected: includes `status_idle.png`, `status_recording.png`, `status_processing.png` (with @2x variants).

- [ ] **Step 4: Commit**

```bash
git add yulu/scripts/status_agent_icons/ yulu/scripts/status_agent.swift yulu/scripts/StatusAgent.app
git commit -m "feat(status_agent): template-mode PNG icons + NSImage state rendering"
```

---

## Phase F — Acceptance + Regression + Smoke

### Task F.1: Phase 5 acceptance tests

**Files:**
- Modify: `tests/test_spec_acceptance.py`

- [ ] **Step 1: Append the Phase 5 block**

Append at the end of `tests/test_spec_acceptance.py`:

```python
# ── Status Agent acceptance (spec 2026-05-26-status-agent-design.md) ──

def test_status_agent_config_module_exists():
    assert (SCRIPTS / "status_agent_config.py").exists()


def test_status_agent_swift_source_exists():
    assert (SCRIPTS / "status_agent.swift").exists()


def test_status_agent_plist_template_exists():
    assert (SCRIPTS / "com.yulu.statusagent.plist").exists()


def test_status_agent_build_script_exists():
    p = SCRIPTS / "build_status_agent.sh"
    assert p.exists()
    import os
    assert os.access(p, os.X_OK), "build_status_agent.sh must be executable"


def test_status_agent_app_bundle_exists():
    """StatusAgent.app should be built (tracked binary, like Yulu.app)."""
    app = SCRIPTS / "StatusAgent.app" / "Contents" / "MacOS" / "status_agent"
    assert app.exists()


def test_status_agent_binary_has_required_strings():
    """Static verification that the Swift binary embeds the key contracts."""
    app = SCRIPTS / "StatusAgent.app" / "Contents" / "MacOS" / "status_agent"
    blob = app.read_bytes()
    for needle in (
        b"Yulu Status Agent",          # log line + bundle name
        b"audio_daemon.sock",           # daemon client target
        b"voicemail.cli",               # launcher subprocess
        b"hotkey_registered",           # registrar success log
        b"status_agent.pid",            # pid file
    ):
        assert needle in blob, f"missing string: {needle!r}"


def test_audio_daemon_silence_monitor_periodic():
    """Acceptance #9: silence_monitor re-armed on every mixAndWrite event."""
    text = (SCRIPTS / "audio_daemon.swift").read_text(encoding="utf-8")
    # The re-arm call must appear inside mixAndWrite (search for the function
    # then check the next ~40 lines contain another startSilenceMonitor() call)
    import re
    match = re.search(r"private func mixAndWrite\(\)\s*\{(.*?)\n    \}", text, re.DOTALL)
    assert match is not None, "mixAndWrite function not found"
    body = match.group(1)
    assert "startSilenceMonitor()" in body, "silence monitor not re-armed in mixAndWrite"


def test_yulu_wrapper_dispatches_status_agent():
    text = (SCRIPTS / "yulu").read_text(encoding="utf-8")
    assert "status-agent)" in text or "status-agent|statusagent" in text
    assert "status_agent_config" in text


def test_status_agent_plist_lsuielement_via_build():
    """The build script must set LSUIElement=true so the agent has no Dock icon."""
    text = (SCRIPTS / "build_status_agent.sh").read_text(encoding="utf-8")
    assert "LSUIElement" in text
    assert "true" in text  # the build_status_agent.sh sets it via PlistBuddy


def test_setup_sh_installs_statusagent_plist():
    text = (SCRIPTS / "setup.sh").read_text(encoding="utf-8")
    assert "com.yulu.statusagent.plist" in text


def test_config_example_has_status_agent_block():
    text = (SCRIPTS / "config.example.json").read_text(encoding="utf-8")
    assert "status_agent" in text
    # Confirm the default hotkey is there
    assert '"V"' in text or "'V'" in text
```

- [ ] **Step 2: Run all acceptance tests**

Run: `cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6 && PYTHONPATH=yulu/scripts python3 -m pytest tests/test_spec_acceptance.py -v`
Expected: all green (Phase 1+2+3+4+5).

- [ ] **Step 3: Commit**

```bash
git add tests/test_spec_acceptance.py
git commit -m "test(acceptance): extend with status-agent + silence-stop fix criteria"
```

---

### Task F.2: Full regression sanity

- [ ] **Step 1: Run the entire test suite**

Run: `PYTHONPATH=yulu/scripts python3 -m pytest tests/ -q --tb=short 2>&1 | tail -10`
Expected: every test passes. Count should be 257 (Phase 4 baseline) + Phase 5 new (~30) = ~287 passed, 1 skipped.

- [ ] **Step 2: Fix any regression**

If anything fails, root-cause and fix; don't mutate the test unless the test itself was buggy.

- [ ] **Step 3: Commit any fix-ups (if needed)**

```bash
git add -A
git commit -m "fix(phase5): address regression surfaced by full suite"
```

(Skip if nothing failed.)

---

### Task F.3: Real-machine smoke (deferred; manual)

After F.2 is green and the user installs the Phase 5 build:

- [ ] **Step 1: Build + install StatusAgent.app + plist**

```bash
bash yulu/scripts/build_status_agent.sh
yulu status-agent install
```

Within 2 s, a 语 icon should appear in the menu bar.

- [ ] **Step 2: Left-click idle → recording**

Click the menu-bar icon while audio_daemon is idle and no recording is in flight. Verify within 1 polling cycle:
- icon flips to recording variant (red dot)
- audio_daemon log shows `🎙 voicemail_YYYYMMDD_HHMMSS.wav` + `🔇 SYS_DISABLED — mic-only recording mode`
- a `voicemail.cli new` Python process is alive (`pgrep -af voicemail.cli`)

- [ ] **Step 3: Left-click recording → processing → idle**

Click again. Verify:
- icon flips to processing variant (three dots)
- audio_daemon log shows `⏹ Recording stopped`
- after transcribe + enqueue completes (~15–60 s), icon flips back to idle
- a fresh `.summary.md` lands in `~/Movies/Yulu/voicemails/`

- [ ] **Step 4: Global hotkey from another app**

Focus Safari (or any non-Terminal app). Press `⌘⇧V`. Verify recording starts (no app focus switch). Press again to stop. Same outcome as left-click flow.

- [ ] **Step 5: Right-click menu**

Right-click the icon. Verify menu contains:
- "Start Voicemail" / "● Recording — click to stop" (state-aware)
- "Recent voicemails" label + up to 5 entries
- "Open inbox in Terminal"
- "Hotkey: ⌘⇧V"
- "Quit Yulu Status Agent"

Click "Open inbox in Terminal" → Terminal opens with `yulu memo list` output.

Click a recent voicemail → `.summary.md` (or fallback) opens in default viewer.

- [ ] **Step 6: Rebind hotkey**

```bash
yulu status-agent set-hotkey "ctrl+option+M"
```

Verify:
- config.json updated
- agent log shows `SIGHUP received — re-registering hotkey`
- menu now shows "Hotkey: ⌃⌥M"
- new combo fires voicemail recording from any app
- old `⌘⇧V` no longer fires

Restore default:

```bash
yulu status-agent set-hotkey "cmd+shift+V"
```

- [ ] **Step 7: Meeting-busy state**

Start a meeting via `yulu record start "Smoke meeting"`. Verify:
- status icon greys out (alpha 0.4)
- right-click menu's toggle item says "Meeting in progress" and is disabled
- pressing `⌘⇧V` posts a Notification Center alert mentioning the meeting title

Stop the meeting (`yulu record stop`). Within 1 polling cycle, icon returns to idle.

- [ ] **Step 8: Silence-stop periodic fix**

Start a voicemail (`yulu memo new`). Speak briefly, then stay silent. The recording should stop within ~3.5 s of falling silent (was: never, until external stop).

- [ ] **Step 9: launchd respawn**

```bash
launchctl unload ~/Library/LaunchAgents/com.yulu.statusagent.plist
sleep 2
launchctl load ~/Library/LaunchAgents/com.yulu.statusagent.plist
```

Icon disappears then reappears within 2 s. Hotkey still works.

- [ ] **Step 10: No Dock icon / ⌘-Tab**

Confirm StatusAgent.app does NOT show in Dock or `⌘-Tab` app switcher.

---

## Plan Self-Review

Cross-checked the plan against the spec section-by-section:

| Spec § | Covered by |
|---|---|
| §2.1 One-click voicemail capture | Tasks D.2 (menu wire-up) + D.5 (launcher) |
| §2.2 One-keystroke via global hotkey | Task D.3 |
| §2.3 Visible recording state | Task D.4 (state machine) + E.1 (icon variants) |
| §2.4 Right-click menu | Task D.2 |
| §2.5 Always-on at login | Tasks C.1 (plist) + C.2 (setup.sh) |
| §2.6 Pure client of existing daemon | Task D.5 (shells out to voicemail.cli; never opens mic) |
| §2.7 Companion silence-stop fix | Task A.1 |
| §5 Status Agent (Swift) | Tasks D.1–D.5 |
| §6 Silence-stop periodic fix | Task A.1 |
| §7 Configuration | Tasks B.1 (config block + parser) + B.2 (CLI) + C.2 (config.example.json) |
| §8 Launchd plist | Task C.1 |
| §9 CLI module | Tasks B.1 + B.2 |
| §10 Build script | Task D.1 |
| §11 Setup integration | Task C.2 |
| §12 Failure modes | Implemented in D.3 (hotkey conflict), D.4 (daemon down + meeting busy), D.5 (notifications) |
| §13 Acceptance criteria 1–12 | Task F.1 (static checks) + F.3 (manual smoke for UI behaviors) |

**Departures from spec:**
- Icon variants (§5.6) use Python PIL composition in E.1 rather than committing pre-baked hand-tweaked PNGs. The base 18×18 + 36×36 PNGs are generated once during the implementation (one-shot script in E.1 Step 1) and the resulting PNGs are committed. Future asset tweaks would either re-run the generator or hand-edit the committed files. This is a small simplification — the spec said "hand-tweaked once and committed"; we automate the "once."
- Notification API: spec mentions NSUserNotification implicitly via "post NSUserNotification"; plan documents D.5's choice to keep NSUserNotification (deprecated but reliable for unsigned background agents) over UNUserNotificationCenter. Documented in Task D.5 Step 2's inline NOTE.

**Placeholder scan:**

Searched plan for "TBD"/"TODO"/"fill in" — clean. Test-fixture strings containing "todo" or similar are intentional content (voicemail prompts, sample summaries).

**Type / signature consistency:**

- `parse_hotkey(spec) → {"key": str, "modifiers": [str]}` shape consistent across B.1 / B.2 / D.3 (the Swift `readHotkeyFromConfig` shells out to Python and parses the tab-separated `keycode\tmodifier_mask\tpretty` output, matching the helper exposed in B.1).
- `AgentState` enum cases (`idle, recording, processing, meetingBusy, daemonDown`) consistent between D.4 and D.5.
- `NSUserInterfaceItemIdentifier("toggle" | "hotkey_label" | "recent_N")` consistent between D.2 (declaration) and D.4 (lookup).
- `voicemail.cli new` / `voicemail.cli stop` references match Phase 4 module structure (verified earlier).
- `audio_daemon.sock` path matches the existing Phase 1+ install location.

Plan ready for execution.
