"""Phase A tests: schema bootstrap + tokenizer sanity for search.indexer."""

import sys
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from search.indexer import (
    SCHEMA_VERSION,
    init_db,
    open_conn,
)


def test_init_db_creates_tables(tmp_path):
    conn = init_db(tmp_path / "search.sqlite")
    tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )}
    # FTS5 virtual table appears in sqlite_master with type='table' too.
    assert "docs" in tables
    assert "docs_meta" in tables
    assert "meta" in tables
    conn.close()


def test_init_db_is_idempotent(tmp_path):
    p = tmp_path / "search.sqlite"
    conn1 = init_db(p)
    conn1.close()
    # Second call must not raise.
    conn2 = init_db(p)
    version = conn2.execute(
        "SELECT value FROM meta WHERE key='schema_version'"
    ).fetchone()[0]
    assert version == SCHEMA_VERSION
    conn2.close()


def test_init_db_seeds_schema_version(tmp_path):
    conn = init_db(tmp_path / "search.sqlite")
    row = conn.execute(
        "SELECT value FROM meta WHERE key='schema_version'"
    ).fetchone()
    assert row is not None
    assert row[0] == SCHEMA_VERSION
    conn.close()


def test_trigram_tokenizer_available(tmp_path):
    """The trigram tokenizer is the linchpin of the whole search design;
    fail loudly if SQLite was built without it."""
    conn = init_db(tmp_path / "search.sqlite")
    # Insert a row and verify a 3-char match works through trigram.
    conn.execute(
        """INSERT INTO docs(kind, stem, meeting_title, recorded_at,
                            source_path, body)
           VALUES (?, ?, ?, ?, ?, ?)""",
        ("meeting_summary", "Stem_20260513_140012", "Stem",
         "2026-05-13T14:00:12", "/tmp/x.summary.md", "本周项目进度整体良好"),
    )
    hits = list(conn.execute(
        "SELECT body FROM docs WHERE docs MATCH ?", ("项目进度",)
    ))
    assert len(hits) == 1
    conn.close()


def test_open_conn_does_not_create_schema(tmp_path):
    """open_conn is the lightweight reader path — no schema work."""
    p = tmp_path / "fresh.sqlite"
    conn = open_conn(p)
    # docs table should NOT exist yet (no init_db call).
    tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )}
    assert "docs" not in tables
    conn.close()


def test_init_db_sets_wal_mode(tmp_path):
    conn = init_db(tmp_path / "search.sqlite")
    mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode.lower() == "wal"
    conn.close()
