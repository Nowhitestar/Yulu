"""yulu status-agent CLI dispatch — install/enable/disable/status/state/toggle."""

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
        return {"ok": True, "state": "idle", "launcher_pid": 4242}

    _start_fake_ipc_server(tmp_path, monkeypatch, handler)
    rc = sac.main(["state"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "state: idle" in out
    assert "launcher pid: 4242" in out


def test_toggle_prints_before_after(tmp_path, monkeypatch, capsys):
    def handler(req):
        assert req["action"] == "toggle"
        return {"ok": True, "state_before": "idle", "state_after": "recording"}

    _start_fake_ipc_server(tmp_path, monkeypatch, handler)
    rc = sac.main(["toggle"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "idle → recording" in out


def test_open_inbox_prints_ok(tmp_path, monkeypatch, capsys):
    def handler(req):
        assert req["action"] == "open_inbox"
        return {"ok": True}

    _start_fake_ipc_server(tmp_path, monkeypatch, handler)
    rc = sac.main(["open-inbox"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "open_inbox" in out


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
