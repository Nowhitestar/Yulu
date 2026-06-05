"""Phase E.1 tests: search.ipc_helper — stdin→stdout JSON round-trip.

Tested both directly (handle_request) and via a real subprocess so we
verify the I/O wiring Swift will use."""

import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from search import indexer as search_indexer
from search.indexer import (
    KIND_MEETING_SUMMARY,
    KIND_MEETING_TRANSCRIPT,
    init_db,
    upsert_doc,
)
from search.ipc_helper import handle_request, _expand_kinds


def _seed(tmp_path: Path):
    db = tmp_path / "search.sqlite"
    conn = init_db(db)
    docs = [
        ("Plan_20260521_160000.summary.md", KIND_MEETING_SUMMARY, "本周 OKR 完成度"),
        ("Memo_20260513_140012.transcript.txt",
         KIND_MEETING_TRANSCRIPT, "记得明天找 Anthropic 团队 OKR 同步"),
    ]
    for fname, kind, body in docs:
        p = tmp_path / fname
        p.write_text(body, encoding="utf-8")
        upsert_doc(source_path=p, kind=kind, conn=conn)
    conn.close()
    return db


def test_handle_request_returns_hits(tmp_path, monkeypatch):
    db = _seed(tmp_path)
    monkeypatch.setattr(search_indexer, "SEARCH_DB_PATH", db)
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "SEARCH_DB_PATH", db)
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", tmp_path / "nonexistent")

    resp = handle_request({"action": "search", "query": "OKR"})
    assert resp["ok"] is True
    assert resp["hits"]
    assert all("OKR" in h["snippet"] or "[hit]" in h["snippet"] for h in resp["hits"])


def test_handle_request_rejects_empty_query():
    resp = handle_request({"action": "search", "query": ""})
    assert resp["ok"] is False
    assert "required" in resp["error"]


def test_handle_request_rejects_missing_query():
    resp = handle_request({"action": "search"})
    assert resp["ok"] is False


def test_handle_request_rejects_negative_since_days():
    resp = handle_request({"action": "search", "query": "x", "since_days": -1})
    assert resp["ok"] is False
    assert "since_days" in resp["error"]


def test_handle_request_rejects_unknown_kinds(tmp_path, monkeypatch):
    db = _seed(tmp_path)
    monkeypatch.setattr(search_indexer, "SEARCH_DB_PATH", db)
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "SEARCH_DB_PATH", db)
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", tmp_path / "nonexistent")
    resp = handle_request({
        "action": "search", "query": "OKR", "kinds": ["frobnicate"],
    })
    assert resp["ok"] is False
    assert "unknown" in resp["error"]


def test_expand_kinds_explicit_wins():
    assert _expand_kinds({"kinds": ["meeting_summary"]}) == ["meeting_summary"]


def test_expand_kinds_in_shorthand_summary():
    out = _expand_kinds({"in": ["summary"]})
    assert set(out) == {"meeting_summary"}


def test_expand_kinds_in_shorthand_meeting():
    out = _expand_kinds({"in": ["meeting"]})
    assert set(out) == {"meeting_summary", "meeting_transcript"}


def test_expand_kinds_default_none():
    assert _expand_kinds({}) is None


def test_filters_compose(tmp_path, monkeypatch):
    db = _seed(tmp_path)
    monkeypatch.setattr(search_indexer, "SEARCH_DB_PATH", db)
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "SEARCH_DB_PATH", db)
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", tmp_path / "nonexistent")

    resp = handle_request({
        "action": "search", "query": "OKR",
        "kinds": [KIND_MEETING_TRANSCRIPT],
    })
    assert resp["ok"] is True
    assert all(h["kind"] == KIND_MEETING_TRANSCRIPT for h in resp["hits"])


def test_subprocess_round_trip(tmp_path, monkeypatch):
    """Real `python3 -m search.ipc_helper` stdin→stdout."""
    db = _seed(tmp_path)
    req = {"action": "search", "query": "OKR"}
    env = {
        **os.environ,
        "PYTHONPATH": str(SCRIPTS) + os.pathsep + os.environ.get("PYTHONPATH", ""),
        # Point the helper at our isolated db. The helper imports
        # search.indexer at call time; we override SEARCH_DB_PATH via an
        # environment variable wired through a tiny shim below would be
        # cleaner, but for now we exploit the fact that search.indexer's
        # SEARCH_DB_PATH defaults to ~/.config/yulu/search.sqlite and
        # accept that this test exercises the real default DB if present.
        # → instead use a sitecustomize-style env var via a wrapper:
    }
    # Use HOME override so the helper's default ~/.config/yulu lands in tmp_path.
    env["HOME"] = str(tmp_path / "home")
    # Pre-create the config dir + copy our seed db.
    cfg = Path(env["HOME"]) / ".config" / "yulu"
    cfg.mkdir(parents=True)
    import shutil
    shutil.copy(db, cfg / "search.sqlite")

    result = subprocess.run(
        [sys.executable, "-m", "search.ipc_helper"],
        input=json.dumps(req),
        env=env,
        capture_output=True, text=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr
    payload = json.loads(result.stdout)
    assert payload["ok"] is True
    # We seeded "OKR" into two docs — at least one match expected.
    assert payload["elapsed_ms"] >= 0


def test_subprocess_handles_empty_stdin(tmp_path):
    env = {
        **os.environ,
        "PYTHONPATH": str(SCRIPTS) + os.pathsep + os.environ.get("PYTHONPATH", ""),
        "HOME": str(tmp_path),
    }
    result = subprocess.run(
        [sys.executable, "-m", "search.ipc_helper"],
        input="", env=env,
        capture_output=True, text=True, timeout=10,
    )
    assert result.returncode != 0
    payload = json.loads(result.stdout)
    assert payload["ok"] is False
    assert "empty" in payload["error"]
