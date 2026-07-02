"""yulu status-agent CLI dispatch — install/enable/disable/status/state/toggle/dictate."""

from __future__ import annotations

import json
import sys
from pathlib import Path

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


def test_enable_writes_enabled_true(tmp_path, monkeypatch):
    cfg = _stub_paths(tmp_path, monkeypatch)
    sac.save({"enabled": False})
    rc = sac.main(["enable"])
    assert rc == 0
    assert json.loads(cfg.read_text(encoding="utf-8"))["status_agent"]["enabled"] is True


def test_disable_writes_enabled_false_and_unloads(tmp_path, monkeypatch):
    cfg = _stub_paths(tmp_path, monkeypatch)
    sac.save({"enabled": True})

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


def test_status_prints_enabled_state(tmp_path, monkeypatch, capsys):
    _stub_paths(tmp_path, monkeypatch)
    sac.save({"enabled": True})
    rc = sac.main(["status"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "enabled" in out.lower()
    # The hotkey line is gone entirely.
    assert "hotkey" not in out.lower()


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
    # The removed hotkey subcommand must not reappear in help.
    assert "set-hotkey" not in out


def test_hotkeys_json_prints_status_agent_specs(tmp_path, monkeypatch, capsys):
    _stub_paths(tmp_path, monkeypatch)
    rc = sac.main(["hotkeys", "--json"])
    assert rc == 0
    items = json.loads(capsys.readouterr().out)
    assert [item["action"] for item in items] == ["dictate", "translate", "voice_chat"]
    assert items[0]["keyCode"] == 49
    assert items[1]["targetLanguage"] == "English"


# ─── IPC tests: spin up a tiny Unix-socket server in a thread that
# mirrors the StatusAgent.swift IPCServer contract (line-delimited JSON
# request → line-delimited JSON response). Verifies CLI exit codes, output,
# and graceful failure when the agent isn't running.

import socket as _socket
import threading

from socket_helpers import cleanup_socket_path, short_socket_path


def _start_fake_ipc_server(tmp_path: Path, monkeypatch, handler):
    """Bind an AF_UNIX socket and accept one request, dispatch through
    `handler(req: dict) -> dict`, write the reply, then close.

    NOTE: AF_UNIX paths are capped at 104 bytes on macOS / 108 on Linux.
    Use the shared short socket helper so Codex sandbox runs do not bind
    directly under /tmp."""
    sock_path = short_socket_path()
    monkeypatch.setattr(sac, "IPC_SOCKET_PATH", sock_path)
    srv = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
    srv.bind(str(sock_path))
    srv.listen(1)

    def serve():
        try:
            srv.settimeout(2.0)
            conn, _ = srv.accept()
            with conn:
                conn.settimeout(2.0)
                chunks = []
                while True:
                    buf = conn.recv(4096)
                    if not buf:
                        break
                    chunks.append(buf)
                    if buf.endswith(b"\n"):
                        break
                req = json.loads(b"".join(chunks).decode("utf-8"))
                reply = handler(req)
                conn.sendall((json.dumps(reply) + "\n").encode("utf-8"))
        except Exception:
            pass
        finally:
            srv.close()
            cleanup_socket_path(sock_path)

    t = threading.Thread(target=serve, daemon=True)
    t.start()
    return sock_path, t


def test_state_prints_current_state(tmp_path, monkeypatch, capsys):
    def handler(req):
        assert req["action"] == "status"
        return {
            "ok": True,
            "state": "idle",
            "dictation_active": True,
            "launcher_pid": 4242,
            "voice_chat_window_visible": True,
            "voice_chat_window_url": "http://127.0.0.1:7777/voice-chat?session=s1",
        }

    _start_fake_ipc_server(tmp_path, monkeypatch, handler)
    rc = sac.main(["state"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "state: idle" in out
    assert "dictation active: True" in out
    assert "launcher pid: 4242" in out
    assert "voice chat window visible: True" in out
    assert "voice chat window url: http://127.0.0.1:7777/voice-chat?session=s1" in out


def test_toggle_prints_before_after(tmp_path, monkeypatch, capsys):
    def handler(req):
        assert req["action"] == "toggle"
        return {"ok": True, "state_before": "idle", "state_after": "recording"}

    _start_fake_ipc_server(tmp_path, monkeypatch, handler)
    rc = sac.main(["toggle"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "idle → recording" in out


def test_dictate_prints_before_after(tmp_path, monkeypatch, capsys):
    def handler(req):
        assert req["action"] == "dictate_toggle"
        return {"ok": True, "state_before": "idle", "state_after": "recording"}

    _start_fake_ipc_server(tmp_path, monkeypatch, handler)
    rc = sac.main(["dictate"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "dictation: idle → recording" in out


def test_translate_prints_before_after(tmp_path, monkeypatch, capsys):
    def handler(req):
        assert req == {"action": "dictate_translate", "target_language": "Japanese"}
        return {"ok": True, "state_before": "idle", "state_after": "recording"}

    _start_fake_ipc_server(tmp_path, monkeypatch, handler)
    rc = sac.main(["translate", "--target-language", "Japanese"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "translate: idle → recording" in out


def test_voice_chat_prints_before_after(tmp_path, monkeypatch, capsys):
    def handler(req):
        assert req["action"] == "voice_chat"
        return {"ok": True, "state_before": "idle", "state_after": "processing"}

    _start_fake_ipc_server(tmp_path, monkeypatch, handler)
    rc = sac.main(["voice-chat"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "voice chat: idle → processing" in out


def test_open_inbox_prints_ok(tmp_path, monkeypatch, capsys):
    def handler(req):
        assert req["action"] == "open_inbox"
        return {"ok": True}

    _start_fake_ipc_server(tmp_path, monkeypatch, handler)
    rc = sac.main(["open-inbox"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "open_inbox" in out


def test_open_agent_console_prints_ok(tmp_path, monkeypatch, capsys):
    def handler(req):
        assert req["action"] == "open_agent_console"
        return {"ok": True}

    _start_fake_ipc_server(tmp_path, monkeypatch, handler)
    rc = sac.main(["open-agent-console"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "open_agent_console" in out


def test_open_voice_chat_prints_window_status(tmp_path, monkeypatch, capsys):
    def handler(req):
        assert req == {
            "action": "open_voice_chat",
            "url": "http://127.0.0.1:7777/voice-chat?session=s1",
        }
        return {
            "ok": True,
            "voice_chat_window_visible": True,
            "voice_chat_window_url": "http://127.0.0.1:7777/voice-chat?session=s1",
        }

    _start_fake_ipc_server(tmp_path, monkeypatch, handler)
    rc = sac.main(["open-voice-chat", "--url", "http://127.0.0.1:7777/voice-chat?session=s1"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "open_voice_chat" in out
    assert "voice chat window visible: True" in out
    assert "voice chat window url: http://127.0.0.1:7777/voice-chat?session=s1" in out


def test_paste_smoke_sends_text_and_prints_json(tmp_path, monkeypatch, capsys):
    sleeps = []
    monkeypatch.setattr(sac.time, "sleep", lambda sec: sleeps.append(sec))

    def handler(req):
        assert req == {
            "action": "paste_clipboard",
            "text": "hello",
            "target_bundle_id": "com.apple.TextEdit",
            "target_app_name": "TextEdit",
        }
        return {"ok": True, "method": "accessibility"}

    _start_fake_ipc_server(tmp_path, monkeypatch, handler)
    rc = sac.main([
        "paste-smoke",
        "--text", "hello",
        "--target-bundle-id", "com.apple.TextEdit",
        "--target-app-name", "TextEdit",
        "--delay-sec", "1.25",
        "--json",
    ])
    assert rc == 0
    assert sleeps == [1.25]
    assert json.loads(capsys.readouterr().out)["method"] == "accessibility"


def test_paste_smoke_reports_accessibility_error(tmp_path, monkeypatch, capsys):
    def handler(req):
        assert req["action"] == "paste_clipboard"
        return {"ok": False, "error": "paste_failed", "accessibility_error": "focused_value_unavailable:-25205"}

    _start_fake_ipc_server(tmp_path, monkeypatch, handler)
    rc = sac.main(["paste-smoke"])
    assert rc == 1
    err = capsys.readouterr().err
    assert "paste_failed" in err
    assert "focused_value_unavailable" in err


def test_toggle_reports_unreachable_when_agent_down(tmp_path, monkeypatch, capsys):
    # Point IPC_SOCKET_PATH at a nonexistent (but short) socket — connect raises
    # FileNotFoundError, CLI must convert to exit 1 + friendly stderr.
    # Short /tmp path avoids AF_UNIX 104-byte limit (pytest tmp_path is too long).
    monkeypatch.setattr(
        sac,
        "IPC_SOCKET_PATH",
        short_socket_path("missing.sock", require_bind=False),
    )
    rc = sac.main(["toggle"])
    assert rc == 1
    err = capsys.readouterr().err
    assert "unreachable" in err.lower()


def test_state_reports_ok_false_as_error(tmp_path, monkeypatch, capsys):
    def handler(req):
        return {"ok": False, "error": "internal_xyz"}

    _start_fake_ipc_server(tmp_path, monkeypatch, handler)
    rc = sac.main(["state"])
    assert rc == 1
    err = capsys.readouterr().err
    assert "internal_xyz" in err
