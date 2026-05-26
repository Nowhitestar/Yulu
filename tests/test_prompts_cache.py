import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import pytest
from prompts import PromptsRepo, Category, open_db
from prompts.cache import PromptsCache, resolve_meeting_date


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
    repo.add(slug="c1", name="C1", category=Category.CLEANUP, content="x", is_auto_run=True)
    cache = PromptsCache(db); cache.load()
    s = [p.slug for p in cache.auto_run("summary")]
    c = [p.slug for p in cache.auto_run("cleanup")]
    assert s == ["s1"]
    assert c == ["c1"]


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


# ── resolve_meeting_date ───────────────────────────────────────────

def test_resolve_meeting_date_from_filename_suffix(tmp_path):
    p = tmp_path / "AgentkeyWeekly_20260519_160002.wav"
    p.write_bytes(b"")
    assert resolve_meeting_date(p) == "2026-05-19"


def test_resolve_meeting_date_falls_back_to_mtime(tmp_path):
    p = tmp_path / "no-suffix.wav"
    p.write_bytes(b"")
    # mtime should be today; just assert it's a valid ISO YYYY-MM-DD shape
    d = resolve_meeting_date(p)
    assert len(d) == 10 and d[4] == "-" and d[7] == "-"


def test_resolve_meeting_date_missing_file_falls_back_to_today(tmp_path):
    p = tmp_path / "nonexistent.wav"
    from datetime import datetime
    expected = datetime.now().strftime("%Y-%m-%d")
    assert resolve_meeting_date(p) == expected


def test_resolve_meeting_date_unparseable_suffix(tmp_path):
    # Looks like the pattern but invalid date numbers
    p = tmp_path / "Weird_20269999_999999.wav"
    p.write_bytes(b"")
    # Should fall back to mtime, not raise
    d = resolve_meeting_date(p)
    assert len(d) == 10
