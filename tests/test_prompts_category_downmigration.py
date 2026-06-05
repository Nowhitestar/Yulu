"""Down-migration: a legacy prompts.sqlite carrying the 3-value category
CHECK (summary / cleanup / voicemail) must be collapsed back to the 2-value
constraint, re-pointing any surviving voicemail rows to summary/cleanup."""

import sqlite3
import sys
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from prompts.db import Category, PromptsRepo, open_db


def _build_legacy_db(db: Path) -> None:
    """Hand-build a pre-unification prompts.sqlite with the OLD 3-value CHECK
    and the two bundled voicemail seed rows plus a learned voicemail row."""
    conn = sqlite3.connect(str(db))
    conn.executescript("""
        CREATE TABLE prompts (
            id TEXT PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            category TEXT NOT NULL CHECK(category IN ('summary', 'cleanup', 'voicemail')),
            content TEXT NOT NULL,
            is_auto_run INTEGER NOT NULL DEFAULT 0,
            source TEXT NOT NULL DEFAULT 'manual'
                CHECK(source IN ('seed', 'manual', 'learned')),
            sort_order INTEGER NOT NULL DEFAULT 0,
            note TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
    """)
    rows = [
        ("id-sum", "summary", "Summary", "summary", "{{transcript}}", 1, "seed", 10),
        ("id-vt", "voicemail-todos", "VM Todos", "voicemail", "{{transcript}}", 1, "seed", 100),
        ("id-vc", "voicemail-clean", "VM Clean", "voicemail", "{{transcript}}", 0, "seed", 110),
        ("id-vm-manual", "my-memo-notes", "Memo Notes", "voicemail", "{{transcript}}", 0, "manual", 200),
    ]
    for r in rows:
        conn.execute(
            "INSERT INTO prompts (id, slug, name, category, content, is_auto_run, "
            "source, sort_order, created_at, updated_at) VALUES "
            "(?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
            r,
        )
    conn.commit()
    conn.close()


def test_downmigration_repoints_voicemail_rows(tmp_path):
    db = tmp_path / "legacy.sqlite"
    _build_legacy_db(db)

    repo = PromptsRepo(open_db(db))   # triggers the down-migration

    # Existing non-voicemail row untouched.
    assert repo.by_slug("summary").category is Category.SUMMARY
    # todos (no 'clean' in slug) → summary; clean → cleanup; manual memo → summary.
    assert repo.by_slug("voicemail-todos").category is Category.SUMMARY
    assert repo.by_slug("voicemail-clean").category is Category.CLEANUP
    assert repo.by_slug("my-memo-notes").category is Category.SUMMARY
    # No row carries the dead category anymore.
    assert all(p.category in (Category.SUMMARY, Category.CLEANUP)
               for p in repo.list_prompts())


def test_downmigration_rejects_voicemail_after_rebuild(tmp_path):
    db = tmp_path / "legacy.sqlite"
    _build_legacy_db(db)
    repo = PromptsRepo(open_db(db))

    # The narrowed CHECK must now reject an attempt to insert 'voicemail'
    # directly via SQL (Category enum no longer even has the member).
    with pytest.raises(sqlite3.IntegrityError):
        repo.conn.execute(
            "INSERT INTO prompts (id, slug, name, category, content, is_auto_run, "
            "source, sort_order, created_at, updated_at) VALUES "
            "('x', 'x', 'X', 'voicemail', 'c', 0, 'manual', 0, 'now', 'now')"
        )


def test_downmigration_is_idempotent(tmp_path):
    db = tmp_path / "legacy.sqlite"
    _build_legacy_db(db)
    repo = PromptsRepo(open_db(db))
    rows_first = {p.slug: p.category for p in repo.list_prompts()}

    # Re-open — must be a no-op (already 2-value), no rows lost, no re-point churn.
    repo2 = PromptsRepo(open_db(db))
    rows_second = {p.slug: p.category for p in repo2.list_prompts()}
    assert rows_first == rows_second
    assert len(rows_second) == 4


def test_fresh_db_has_two_value_constraint(tmp_path):
    """A brand-new DB never had voicemail — the migration is a clean no-op and
    the CHECK rejects voicemail from the start."""
    db = tmp_path / "fresh.sqlite"
    repo = PromptsRepo(open_db(db))
    assert not hasattr(Category, "VOICEMAIL")
    with pytest.raises(sqlite3.IntegrityError):
        repo.conn.execute(
            "INSERT INTO prompts (id, slug, name, category, content, is_auto_run, "
            "source, sort_order, created_at, updated_at) VALUES "
            "('y', 'y', 'Y', 'voicemail', 'c', 0, 'manual', 0, 'now', 'now')"
        )
