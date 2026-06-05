"""Phase B.1 tests: upsert_doc — sha256 dedup, replace, concurrency."""

import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from search.indexer import (
    KIND_MEETING_SUMMARY,
    KIND_MEETING_TRANSCRIPT,
    init_db,
    open_conn,
    upsert_doc,
)


def _make_memo(tmp_path: Path, text: str = "本周项目进度整体良好") -> Path:
    p = tmp_path / "Memo_20260513_140012.transcript.txt"
    p.write_text(text, encoding="utf-8")
    return p


def _make_meeting_summary(tmp_path: Path, text: str = "Standard summary.") -> Path:
    p = tmp_path / "AgentkeyProductWeekly_20260521_160008.summary.md"
    p.write_text(text, encoding="utf-8")
    return p


def test_upsert_inserts_new_doc(tmp_path):
    db = tmp_path / "search.sqlite"
    src = _make_memo(tmp_path)
    conn = init_db(db)
    changed = upsert_doc(source_path=src, kind=KIND_MEETING_TRANSCRIPT, conn=conn)
    assert changed is True
    rows = list(conn.execute("SELECT meeting_title, recorded_at FROM docs"))
    assert len(rows) == 1
    assert rows[0]["meeting_title"] == "Memo"
    assert rows[0]["recorded_at"] == "2026-05-13T14:00:12"


def test_upsert_is_noop_when_unchanged(tmp_path):
    """sha256 match → no replace, but docs.rowid is stable."""
    db = tmp_path / "search.sqlite"
    src = _make_memo(tmp_path)
    conn = init_db(db)

    assert upsert_doc(source_path=src, kind=KIND_MEETING_TRANSCRIPT, conn=conn) is True
    rowid_1 = conn.execute("SELECT rowid FROM docs").fetchone()[0]

    assert upsert_doc(source_path=src, kind=KIND_MEETING_TRANSCRIPT, conn=conn) is False
    rowid_2 = conn.execute("SELECT rowid FROM docs").fetchone()[0]

    assert rowid_1 == rowid_2
    assert len(list(conn.execute("SELECT rowid FROM docs"))) == 1


def test_upsert_replaces_on_change(tmp_path):
    db = tmp_path / "search.sqlite"
    src = _make_memo(tmp_path, text="original")
    conn = init_db(db)
    assert upsert_doc(source_path=src, kind=KIND_MEETING_TRANSCRIPT, conn=conn) is True

    src.write_text("changed content", encoding="utf-8")
    assert upsert_doc(source_path=src, kind=KIND_MEETING_TRANSCRIPT, conn=conn) is True

    rows = list(conn.execute("SELECT body FROM docs"))
    assert len(rows) == 1
    assert rows[0]["body"] == "changed content"


def test_upsert_skips_unparseable_stem(tmp_path):
    db = tmp_path / "search.sqlite"
    src = tmp_path / "random_notes.md"
    src.write_text("hello", encoding="utf-8")
    conn = init_db(db)
    changed = upsert_doc(source_path=src, kind=KIND_MEETING_SUMMARY, conn=conn)
    assert changed is False
    assert list(conn.execute("SELECT COUNT(*) FROM docs"))[0][0] == 0


def test_upsert_handles_slug_tagged_summary(tmp_path):
    db = tmp_path / "search.sqlite"
    stem_summary = tmp_path / "Memo_20260513_140012.summary.md"
    slug_summary = tmp_path / "Memo_20260513_140012.action-items.summary.md"
    stem_summary.write_text("default body", encoding="utf-8")
    slug_summary.write_text("action-items body", encoding="utf-8")
    conn = init_db(db)
    upsert_doc(source_path=stem_summary, kind=KIND_MEETING_TRANSCRIPT, conn=conn)
    upsert_doc(source_path=slug_summary, kind=KIND_MEETING_TRANSCRIPT, conn=conn)
    rows = list(conn.execute(
        "SELECT source_path, meeting_title, recorded_at FROM docs ORDER BY source_path"
    ))
    assert len(rows) == 2
    # Same stem-derived metadata, distinct source_path.
    assert rows[0]["meeting_title"] == rows[1]["meeting_title"] == "Memo"
    assert rows[0]["recorded_at"] == rows[1]["recorded_at"]
    assert rows[0]["source_path"] != rows[1]["source_path"]


def test_upsert_rejects_unknown_kind(tmp_path):
    import pytest
    db = tmp_path / "search.sqlite"
    src = _make_memo(tmp_path)
    conn = init_db(db)
    with pytest.raises(ValueError):
        upsert_doc(source_path=src, kind="garbage", conn=conn)


def test_upsert_uses_body_arg_when_provided(tmp_path):
    """Writers pass body= so we don't need to round-trip via disk."""
    db = tmp_path / "search.sqlite"
    src = _make_meeting_summary(tmp_path, text="ondisk")
    conn = init_db(db)
    upsert_doc(source_path=src, kind=KIND_MEETING_SUMMARY, conn=conn,
               body="in-memory only")
    rows = list(conn.execute("SELECT body FROM docs"))
    assert rows[0]["body"] == "in-memory only"


def test_upsert_concurrent_same_file(tmp_path):
    """Two threads upserting the same path must produce one final row.

    Each thread uses its own connection (concurrent connection re-use is
    not supported by sqlite3 anyway). BEGIN IMMEDIATE serializes the
    writes; the sha256 dedup makes the second writer a no-op.
    """
    db = tmp_path / "search.sqlite"
    init_db(db).close()  # ensure schema exists before threads race

    src = _make_memo(tmp_path)
    errors = []

    def worker():
        try:
            # Open per-thread conn; init_db is fine — it's idempotent.
            c = init_db(db)
            upsert_doc(source_path=src, kind=KIND_MEETING_TRANSCRIPT, conn=c)
            c.close()
        except Exception as exc:  # noqa: BLE001
            errors.append(exc)

    threads = [threading.Thread(target=worker) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(timeout=10)

    assert not errors, f"unexpected errors: {errors}"
    c = open_conn(db)
    n = c.execute("SELECT COUNT(*) FROM docs").fetchone()[0]
    assert n == 1
    c.close()


def test_upsert_without_conn_opens_its_own(tmp_path, monkeypatch):
    """Writers can call upsert_doc without a conn — it opens + closes its own."""
    db = tmp_path / "search.sqlite"
    monkeypatch.setattr("search.indexer.SEARCH_DB_PATH", db)
    src = _make_memo(tmp_path)
    assert upsert_doc(source_path=src, kind=KIND_MEETING_TRANSCRIPT) is True
    # Confirm second call detects unchanged body.
    assert upsert_doc(source_path=src, kind=KIND_MEETING_TRANSCRIPT) is False
