import sys
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import pytest
from prompts import (
    PromptsRepo, Category, Source, open_db,
)


def test_open_db_creates_schema(tmp_path):
    conn = open_db(tmp_path / "prompts.sqlite")
    tables = {row[0] for row in conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table'"
    )}
    assert {"prompts", "meta"} <= tables
    version = conn.execute(
        "SELECT value FROM meta WHERE key='schema_version'"
    ).fetchone()
    assert version[0] == "1"


# ── PromptsRepo ────────────────────────────────────────────────────

def test_prompts_add_and_fetch(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    pid = repo.add(
        slug="summary",
        name="Standard Summary",
        category=Category.SUMMARY,
        content="请总结 {{transcript}}",
        is_auto_run=True,
    )
    p = repo.get(pid)
    assert p.slug == "summary"
    assert p.name == "Standard Summary"
    assert p.category == Category.SUMMARY
    assert p.is_auto_run is True
    assert p.source == Source.MANUAL


def test_prompts_slug_unique(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    repo.add(slug="summary", name="A", category=Category.SUMMARY, content="x")
    with pytest.raises(ValueError):
        repo.add(slug="summary", name="B", category=Category.SUMMARY, content="y")


def test_prompts_by_slug(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    pid = repo.add(slug="action-items", name="A", category=Category.SUMMARY, content="x")
    p = repo.by_slug("action-items")
    assert p.id == pid
    assert repo.by_slug("missing") is None


def test_prompts_list_filters(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    repo.add(slug="summary", name="S", category=Category.SUMMARY, content="x", is_auto_run=True)
    repo.add(slug="action-items", name="AI", category=Category.SUMMARY, content="x", is_auto_run=False)
    repo.add(slug="cleanup", name="C", category=Category.CLEANUP, content="x")
    assert len(repo.list_prompts()) == 3
    assert len(repo.list_prompts(category=Category.SUMMARY)) == 2
    assert len(repo.list_prompts(category=Category.CLEANUP)) == 1
    assert len(repo.list_prompts(auto_run_only=True)) == 1
    assert len(repo.list_prompts(category=Category.SUMMARY, auto_run_only=True)) == 1


def test_auto_run_is_limited_to_summary_prompts(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    with pytest.raises(ValueError, match="only for summary prompts"):
        repo.add(
            slug="cleanup",
            name="Cleanup",
            category=Category.CLEANUP,
            content="x",
            is_auto_run=True,
        )

    repo.add(slug="summary", name="S", category=Category.SUMMARY,
             content="x", is_auto_run=True)
    assert repo.edit("summary", category=Category.CLEANUP) is True
    changed = repo.by_slug("summary")
    assert changed.category == Category.CLEANUP
    assert changed.is_auto_run is False


def test_prompts_edit_by_slug(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    repo.add(slug="summary", name="Old", category=Category.SUMMARY, content="x")
    assert repo.edit("summary", name="New", content="y", is_auto_run=True) is True
    p = repo.by_slug("summary")
    assert p.name == "New"
    assert p.content == "y"
    assert p.is_auto_run is True
    assert repo.edit("missing", name="z") is False


def test_prompts_remove(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    pid = repo.add(slug="x", name="X", category=Category.SUMMARY, content="x")
    assert repo.remove("x") is True
    assert repo.get(pid) is None
    assert repo.remove("x") is False


def test_prompts_slug_validation(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    # slug must be lowercase alphanumeric + hyphens
    for bad in ["Summary", "with space", "with_underscore", "ünicode", ""]:
        with pytest.raises(ValueError):
            repo.add(slug=bad, name="X", category=Category.SUMMARY, content="x")


def test_meta_roundtrip(tmp_path):
    repo = PromptsRepo(open_db(tmp_path / "p.sqlite"))
    assert repo.get_meta("seeded_at") is None
    repo.set_meta("seeded_at", "2026-05-22T10:00:00Z")
    assert repo.get_meta("seeded_at") == "2026-05-22T10:00:00Z"
