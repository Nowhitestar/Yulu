"""Verify Category.VOICEMAIL + lazy CHECK migration for pre-Phase-4
prompts.sqlite files."""

import sqlite3
import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from prompts.db import Category, PromptsRepo, open_db


def test_category_voicemail_enum_value_exists():
    assert hasattr(Category, "VOICEMAIL")
    assert Category.VOICEMAIL.value == "voicemail"


def test_fresh_db_allows_voicemail_category(tmp_path):
    db = tmp_path / "p.sqlite"
    repo = PromptsRepo(open_db(db))
    pid = repo.add(
        slug="vm-test", name="VM Test",
        category=Category.VOICEMAIL,
        content="hello {{transcript}}",
    )
    assert isinstance(pid, str) and pid
    fetched = repo.by_slug("vm-test")
    assert fetched is not None
    assert fetched.category is Category.VOICEMAIL


def test_legacy_db_migrates_to_include_voicemail(tmp_path):
    """Simulate a pre-Phase-4 prompts.sqlite that has the OLD CHECK
    constraint (only summary/cleanup). open_db must rewrite the table
    so voicemail is also accepted, while preserving all existing rows."""
    db = tmp_path / "legacy.sqlite"
    # Build the pre-Phase-4 schema by hand
    conn = sqlite3.connect(str(db))
    conn.executescript("""
        CREATE TABLE prompts (
            id TEXT PRIMARY KEY,
            slug TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            category TEXT NOT NULL CHECK(category IN ('summary', 'cleanup')),
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
    conn.execute(
        "INSERT INTO prompts (id, slug, name, category, content, "
        "is_auto_run, source, sort_order, created_at, updated_at) "
        "VALUES ('id-1', 'old-summary', 'Old Summary', 'summary', "
        "'content', 1, 'seed', 10, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')"
    )
    conn.commit()
    conn.close()

    # Now re-open with the new open_db — migration must run
    repo = PromptsRepo(open_db(db))
    # Existing row survived
    old = repo.by_slug("old-summary")
    assert old is not None
    assert old.category is Category.SUMMARY
    # And voicemail now accepted
    repo.add(slug="vm-after-migrate", name="VM After Migrate",
             category=Category.VOICEMAIL, content="{{transcript}}")
    assert repo.by_slug("vm-after-migrate") is not None


def test_migration_is_idempotent(tmp_path):
    """Opening a freshly-migrated DB a second time is a no-op."""
    db = tmp_path / "idem.sqlite"
    repo = PromptsRepo(open_db(db))
    repo.add(slug="a", name="A", category=Category.VOICEMAIL,
             content="{{transcript}}")
    # Second open — must not raise, must not duplicate rows
    repo2 = PromptsRepo(open_db(db))
    all_rows = repo2.list_prompts()
    assert len([p for p in all_rows if p.slug == "a"]) == 1
