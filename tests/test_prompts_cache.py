import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import pytest
from prompts import PromptsRepo, Category, open_db
from prompts.cache import PromptsCache


# ── render ─────────────────────────────────────────────────────────

def test_render_substitutes_all_three_vars(tmp_path):
    db = tmp_path / "p.sqlite"
    repo = PromptsRepo(open_db(db))
    repo.add(slug="summary", name="N", category=Category.SUMMARY,
             content="Date: {{date}} Title: {{meeting_title}} -- {{transcript}}",
             is_auto_run=True)
    cache = PromptsCache(db); cache.load()
    p = cache.by_slug("summary")
    out = cache.render(p, transcript="HELLO", meeting_title="Standup", date="2026-05-22")
    assert "Date: 2026-05-22" in out
    assert "Title: Standup" in out
    assert "HELLO" in out
    assert "{{" not in out


# ── auto_run + by_slug + by_id ─────────────────────────────────────

def test_auto_run_filters_by_category(tmp_path):
    db = tmp_path / "p.sqlite"
    repo = PromptsRepo(open_db(db))
    repo.add(slug="s1", name="S1", category=Category.SUMMARY, content="x", is_auto_run=True)
    repo.add(slug="s2", name="S2", category=Category.SUMMARY, content="x", is_auto_run=False)
    repo.add(slug="c1", name="C1", category=Category.CLEANUP, content="x")
    cache = PromptsCache(db); cache.load()
    s = [p.slug for p in cache.auto_run("summary")]
    c = [p.slug for p in cache.auto_run("cleanup")]
    assert s == ["s1"]
    assert c == []


def test_by_slug_and_by_id(tmp_path):
    db = tmp_path / "p.sqlite"
    repo = PromptsRepo(open_db(db))
    pid = repo.add(slug="x", name="X", category=Category.SUMMARY, content="x")
    cache = PromptsCache(db); cache.load()
    assert cache.by_slug("x").id == pid
    assert cache.by_id(pid).slug == "x"
    assert cache.by_slug("ghost") is None


# ── reload ─────────────────────────────────────────────────────────

def test_reload_picks_up_changes(tmp_path):
    db = tmp_path / "p.sqlite"
    repo = PromptsRepo(open_db(db))
    repo.add(slug="a", name="A", category=Category.SUMMARY, content="x", is_auto_run=True)
    cache = PromptsCache(db); cache.load()
    assert len(cache.auto_run("summary")) == 1
    repo.add(slug="b", name="B", category=Category.SUMMARY, content="x", is_auto_run=True)
    cache.reload()
    assert len(cache.auto_run("summary")) == 2


def test_maybe_reload_uses_max_wal_mtime(tmp_path):
    db = tmp_path / "p.sqlite"
    repo = PromptsRepo(open_db(db))
    repo.add(slug="a", name="A", category=Category.SUMMARY, content="x", is_auto_run=True)
    cache = PromptsCache(db, autoreload=True); cache.load()
    initial = len(cache.auto_run("summary"))
    time.sleep(1.0)  # WAL writes go to -wal sidecar; mtime ≥ 1 second
    repo.add(slug="b", name="B", category=Category.SUMMARY, content="x", is_auto_run=True)
    assert cache.maybe_reload() is True
    assert len(cache.auto_run("summary")) == initial + 1


# ── speaker-aware template variables (Phase 3) ─────────────────────

def test_render_substitutes_my_and_their_transcript(tmp_path):
    db = tmp_path / "p.sqlite"
    repo = PromptsRepo(open_db(db))
    repo.add(
        slug="speaker-test",
        name="Speaker Test",
        category=Category.SUMMARY,
        content="我说：{{my_transcript}}\n对方说：{{their_transcript}}\n合并：{{transcript}}",
        is_auto_run=False,
    )

    cache = PromptsCache(db); cache.load()
    p = cache.by_slug("speaker-test")
    out = cache.render(
        p,
        meeting_title="t",
        transcript="MERGED",
        my_transcript="MIC",
        their_transcript="SYS",
        date="2026-05-22",
    )
    assert "我说：MIC" in out
    assert "对方说：SYS" in out
    assert "合并：MERGED" in out


def test_render_defaults_unknown_speaker_vars_to_empty_string(tmp_path):
    """Legacy prompts that don't pass my_/their_transcript still render OK."""
    db = tmp_path / "p.sqlite"
    repo = PromptsRepo(open_db(db))
    repo.add(
        slug="legacy",
        name="Legacy",
        category=Category.SUMMARY,
        content="只有 mic：[{{my_transcript}}] 只有 sys：[{{their_transcript}}]",
        is_auto_run=False,
    )

    cache = PromptsCache(db); cache.load()
    p = cache.by_slug("legacy")
    out = cache.render(p, meeting_title="t", transcript="X", date="2026-05-22")
    assert out == "只有 mic：[] 只有 sys：[]"
