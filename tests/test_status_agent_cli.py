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
    # CLI must normalize 'option' → 'alt' before parsing.
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
