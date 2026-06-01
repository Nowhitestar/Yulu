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


# ─── Swift status_agent.swift static gate (D-07: config.json output_dir) ───────
# Source-static asserts (no swiftc) proving the menu-bar Recent Recordings list
# now resolves its base directory from config.json `audio.output_dir` instead of
# the hardcoded ~/Movies/Yulu, which may survive ONLY as the fallback default.

STATUS_AGENT_SWIFT = SCRIPTS / "status_agent.swift"


def _swift_source() -> str:
    return STATUS_AGENT_SWIFT.read_text(encoding="utf-8")


def test_status_agent_swift_exists():
    assert STATUS_AGENT_SWIFT.exists(), f"missing {STATUS_AGENT_SWIFT}"


def test_status_agent_has_config_output_dir_reader():
    src = _swift_source()
    # The ported config.json reader must exist and key on `output_dir` (D-07).
    assert "func loadRecordingDir()" in src, "loadRecordingDir() reader not added"
    assert "output_dir" in src, "status_agent must read audio.output_dir from config.json"
    assert 'json["audio"]' in src, "reader must descend into the config 'audio' block"


def test_status_agent_recent_recordings_uses_config_dir():
    src = _swift_source()
    # loadRecentRecordings must source its base from loadRecordingDir(), not a
    # hardcoded home/Movies path.
    assert "let base = loadRecordingDir()" in src, (
        "loadRecentRecordings must derive its base from loadRecordingDir()"
    )
    assert '"\\(base)/voicemails"' in src, "vmDir must be derived from the config base"


def test_status_agent_movies_yulu_only_as_fallback():
    src = _swift_source()
    # The historical ~/Movies/Yulu literal is permitted, but ONLY inside
    # loadRecordingDir() as the fallback default — never as the live vmDir/mvDir
    # source in loadRecentRecordings. Assert the old hardcoded interpolation form
    # ("\(home)/Movies/Yulu") is gone.
    assert "\\(home)/Movies/Yulu" not in src, (
        "status_agent still hardcodes \\(home)/Movies/Yulu as a recordings source; "
        "it must read config.json output_dir with the literal only as fallback"
    )
    # The fallback default must live inside the reader.
    reader_start = src.index("func loadRecordingDir()")
    reader_body = src[reader_start : reader_start + 600]
    assert "Movies/Yulu" in reader_body, (
        "the ~/Movies/Yulu fallback default must live inside loadRecordingDir()"
    )
