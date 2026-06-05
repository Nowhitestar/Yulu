"""Phase D tests: yulu search CLI (argparse + IPC + in-process fallback)."""

import json
import os
import socket as _socket
import subprocess
import sys
import threading
import uuid
from datetime import timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import pytest

from search import cli as search_cli
from search.indexer import (
    KIND_MEETING_SUMMARY, KIND_MEETING_TRANSCRIPT,
    init_db, upsert_doc,
)


# ── parse_duration ─────────────────────────────────────────────────────

def test_parse_duration_7d():
    assert search_cli.parse_duration("7d") == timedelta(days=7)


def test_parse_duration_24h():
    assert search_cli.parse_duration("24h") == timedelta(hours=24)


def test_parse_duration_2w():
    assert search_cli.parse_duration("2w") == timedelta(weeks=2)


def test_parse_duration_30m():
    assert search_cli.parse_duration("30m") == timedelta(minutes=30)


def test_parse_duration_rejects_garbage():
    import argparse
    with pytest.raises(argparse.ArgumentTypeError):
        search_cli.parse_duration("forever")


# ── _types_to_kinds ───────────────────────────────────────────────────

def test_types_all_both_means_none():
    assert search_cli._types_to_kinds("all", "both") is None


def test_types_meeting_summary():
    assert search_cli._types_to_kinds("meeting", "summary") == [KIND_MEETING_SUMMARY]


def test_types_meeting_transcript():
    assert search_cli._types_to_kinds("meeting", "transcript") == [KIND_MEETING_TRANSCRIPT]


def test_types_all_and_meeting_are_equivalent():
    # Only meetings exist, so --type all and --type meeting select the same kinds.
    assert (search_cli._types_to_kinds("all", "summary")
            == search_cli._types_to_kinds("meeting", "summary")
            == [KIND_MEETING_SUMMARY])


def test_types_rejects_voicemail():
    import argparse
    with pytest.raises(argparse.ArgumentTypeError):
        search_cli._types_to_kinds("voicemail", "transcript")


# ── IPC server fixture (reused from Phase 5 status_agent tests) ────────

def _start_fake_ipc_server(monkeypatch, handler):
    """Bind /tmp/<uuid>.sock; accept one request and return handler(req)."""
    sock_path = Path(f"/tmp/yulu_test_{uuid.uuid4().hex[:12]}.sock")
    monkeypatch.setattr(search_cli, "IPC_SOCKET_PATH", sock_path)
    srv = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)
    srv.bind(str(sock_path))
    srv.listen(1)

    def serve():
        try:
            srv.settimeout(3.0)
            conn, _ = srv.accept()
            with conn:
                conn.settimeout(3.0)
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
            try:
                os.unlink(sock_path)
            except OSError:
                pass

    t = threading.Thread(target=serve, daemon=True)
    t.start()
    return sock_path, t


def test_cli_query_round_trips_via_ipc_when_agent_running(monkeypatch, capsys):
    def handler(req):
        assert req["action"] == "search"
        assert req["query"] == "OKR"
        return {
            "ok": True,
            "hits": [
                {"kind": "meeting_summary",
                 "stem": "Plan_20260521_160000",
                 "meeting_title": "Plan",
                 "recorded_at": "2026-05-21T16:00:00",
                 "source_path": "/tmp/Plan_20260521_160000.summary.md",
                 "score": 3.0, "snippet": "本周 [hit]OKR[/hit] ..."}
            ],
            "elapsed_ms": 7,
            "fallback_used": False,
        }
    _start_fake_ipc_server(monkeypatch, handler)
    rc = search_cli.main(["OKR"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "Plan" in out
    assert "OKR" in out


def test_cli_falls_back_to_in_process_when_agent_down(tmp_path, monkeypatch, capsys):
    # Force IPC to fail by pointing at a non-existent socket.
    monkeypatch.setattr(
        search_cli, "IPC_SOCKET_PATH",
        Path(f"/tmp/nonexistent_{uuid.uuid4().hex[:8]}.sock"),
    )
    # Seed a tiny corpus + isolated db.
    db = tmp_path / "search.sqlite"
    root = tmp_path / "Yulu"
    root.mkdir()
    (root / "Plan_20260521_160000.summary.md").write_text(
        "本周 OKR 完成度", encoding="utf-8"
    )
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", root)
    monkeypatch.setattr(reader_mod, "SEARCH_DB_PATH", db)
    from search import indexer as indexer_mod
    monkeypatch.setattr(indexer_mod, "SEARCH_DB_PATH", db)

    rc = search_cli.main(["OKR"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "Plan" in out


def test_cli_open_runs_macos_open_on_top_hit(monkeypatch, capsys):
    def handler(req):
        return {
            "ok": True,
            "hits": [
                {"kind": "meeting_summary",
                 "stem": "Plan_20260521_160000",
                 "meeting_title": "Plan",
                 "recorded_at": "2026-05-21T16:00:00",
                 "source_path": "/tmp/some.md",
                 "score": 1.0, "snippet": "..."}
            ],
            "elapsed_ms": 5, "fallback_used": False,
        }
    _start_fake_ipc_server(monkeypatch, handler)
    called: list[list] = []

    def fake_run(cmd, **_kw):
        called.append(cmd)
        class R:
            returncode = 0
        return R()
    monkeypatch.setattr(search_cli.subprocess, "run", fake_run)
    rc = search_cli.main(["OKR", "--open"])
    assert rc == 0
    assert called and called[0][0] == "open"
    assert called[0][1] == "/tmp/some.md"


def test_cli_json_output_is_valid_json(monkeypatch, capsys):
    def handler(req):
        return {"ok": True, "hits": [], "elapsed_ms": 1, "fallback_used": False}
    _start_fake_ipc_server(monkeypatch, handler)
    rc = search_cli.main(["nothing-matches", "--json"])
    assert rc == 0
    out = capsys.readouterr().out
    payload = json.loads(out)
    assert payload["ok"] is True
    assert "hits" in payload


def test_cli_doctor_prints_row_counts(tmp_path, monkeypatch, capsys):
    db = tmp_path / "search.sqlite"
    init_db(db).close()
    p = tmp_path / "Plan_20260521_160000.summary.md"
    p.write_text("body", encoding="utf-8")
    conn = init_db(db)
    upsert_doc(source_path=p, kind=KIND_MEETING_SUMMARY, conn=conn)
    conn.close()
    from search import indexer as indexer_mod
    from search import reader as reader_mod
    monkeypatch.setattr(indexer_mod, "SEARCH_DB_PATH", db)
    monkeypatch.setattr(reader_mod, "SEARCH_DB_PATH", db)

    rc = search_cli.main(["--doctor"])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["schema_version"] == "1"
    assert payload["total_docs"] == 1


def test_cli_reindex_calls_reindex_path(tmp_path, monkeypatch, capsys):
    db = tmp_path / "search.sqlite"
    root = tmp_path / "Yulu"
    root.mkdir()
    (root / "Plan_20260521_160000.summary.md").write_text("body", encoding="utf-8")
    from search import indexer as indexer_mod
    from search import reader as reader_mod
    monkeypatch.setattr(indexer_mod, "SEARCH_DB_PATH", db)
    monkeypatch.setattr(reader_mod, "SEARCH_DB_PATH", db)
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", root)
    rc = search_cli.main(["--reindex"])
    assert rc == 0
    payload = json.loads(capsys.readouterr().out)
    assert "reindex" in payload
    assert payload["reindex"]["added"] >= 1


def test_cli_requires_query_or_special_flag(capsys):
    rc = search_cli.main([])
    assert rc != 0
    err = capsys.readouterr().err
    assert "requires a query" in err


# ── Shell wrapper dispatch (subprocess) ────────────────────────────────

def test_yulu_wrapper_dispatches_search(tmp_path):
    """Calling `yulu search` should run search.cli (--help here as smoke).

    Sets HOME so the wrapper's $HOME-prefixed paths land under tmp_path
    (it shouldn't write anything for --help, but defensive)."""
    wrapper = SCRIPTS / "yulu"
    assert wrapper.exists()
    result = subprocess.run(
        ["bash", str(wrapper), "search", "--help"],
        env={**os.environ, "HOME": str(tmp_path)},
        capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert "yulu search" in result.stdout
    assert "--since" in result.stdout
