"""Status-agent config block (enabled flag + plist install helpers)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

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
    # The hotkey/mic-only surface was removed — only `enabled` remains.
    assert "hotkey" not in block


def test_load_defaults_when_config_file_missing(tmp_path, monkeypatch):
    monkeypatch.setattr(sac, "CONFIG_PATH", tmp_path / "nonexistent.json")
    block = sac.load()
    assert block["enabled"] is True


def test_load_preserves_existing_block(tmp_path, monkeypatch):
    _stub_config(tmp_path, monkeypatch, {
        "status_agent": {"enabled": False}
    })
    block = sac.load()
    assert block["enabled"] is False


def test_save_writes_block_under_status_agent_key(tmp_path, monkeypatch):
    cfg = _stub_config(tmp_path, monkeypatch, {"audio": {"backend": "daemon"}})
    sac.save({"enabled": False})
    data = json.loads(cfg.read_text(encoding="utf-8"))
    assert data["status_agent"]["enabled"] is False
    # Unrelated blocks preserved
    assert data["audio"]["backend"] == "daemon"


def test_save_creates_config_when_missing(tmp_path, monkeypatch):
    cfg = tmp_path / "fresh.json"
    monkeypatch.setattr(sac, "CONFIG_PATH", cfg)
    sac.save({"enabled": True})
    assert cfg.exists()
    assert json.loads(cfg.read_text(encoding="utf-8"))["status_agent"]["enabled"] is True


def test_no_hotkey_surface_remains():
    """The global hotkey was deleted entirely — its parser/keycode helpers
    must be gone so nothing reintroduces a Cmd+Shift+V binding."""
    for attr in (
        "keycode_for", "modifier_mask", "parse_hotkey",
        "format_hotkey", "sighup_running_agent",
    ):
        assert not hasattr(sac, attr), f"{attr} should have been removed"


# ─── Swift status_agent.swift static gates ─────────────────────────────────────
# Source-static asserts (no swiftc) over the menu-bar agent: it resolves the
# recordings base directory from config.json `audio.output_dir` (D-07), scans a
# single recordings root (the voicemails/ subdir was merged away), and no longer
# registers a global hotkey or shells out to the voicemail module.

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


def test_status_agent_scans_single_root_no_voicemails_subdir():
    src = _swift_source()
    # The historical second directory (~/Movies/Yulu/voicemails) is gone:
    # recordings now live only in the root, so the agent must not reconstruct
    # a voicemails/ subdir path.
    assert "voicemails" not in src, (
        "status_agent still references a voicemails/ subdir; recordings now "
        "live in a single root directory"
    )


def test_status_agent_movies_yulu_only_as_fallback():
    src = _swift_source()
    # The historical ~/Movies/Yulu literal is permitted, but ONLY inside
    # loadRecordingDir() as the fallback default — never as a live source.
    assert "\\(home)/Movies/Yulu" not in src, (
        "status_agent still hardcodes \\(home)/Movies/Yulu as a recordings source"
    )
    reader_start = src.index("func loadRecordingDir()")
    reader_body = src[reader_start : reader_start + 600]
    assert "Movies/Yulu" in reader_body, (
        "the ~/Movies/Yulu fallback default must live inside loadRecordingDir()"
    )


def test_status_agent_has_no_hotkey_or_voicemail():
    src = _swift_source()
    # Decision #1: the global hotkey is deleted (no Carbon, no HotkeyRegistrar).
    assert "import Carbon" not in src, "Carbon import should be gone (no hotkey)"
    assert "HotkeyRegistrar" not in src, "HotkeyRegistrar should be removed"
    assert "RegisterEventHotKey" not in src, "Carbon hotkey registration should be removed"
    # The launcher now starts a meeting via meeting_daemon.py, not voicemail.cli.
    assert "voicemail" not in src.lower(), "no voicemail references should remain"
    assert "RecordingLauncher" in src, "launcher should be renamed RecordingLauncher"
    assert "meeting_daemon.py" in src, "launcher should shell out to meeting_daemon.py"


def test_status_agent_processing_allows_next_recording():
    src = _swift_source()
    assert "Start Recording (transcribing previous)" in src
    assert "new == .idle || new == .recording || new == .processing" in src
    assert "case .processing:" in src
    assert "startRecordingFromMenu()" in src
    assert "starting next recording while previous processing continues" in src
