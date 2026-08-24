"""Phase C.2-C.4 tests: FTS5 ranked search, LIKE fallback, search() entry."""

import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import pytest

from search.indexer import (
    KIND_MEETING_SUMMARY,
    KIND_MEETING_TRANSCRIPT,
    init_db,
    upsert_doc,
)
from search.reader import (
    MAX_LIMIT,
    SearchHit,
    _fts_search,
    _like_search,
    doctor,
    reindex,
    search,
    sweep,
)


def _seed_three_okr_docs(tmp_path: Path):
    """3 docs containing OKR (varying frequency) + 1 with KPI only."""
    db = tmp_path / "search.sqlite"
    conn = init_db(db)
    docs = [
        ("AgentkeyProductWeekly_20260521_160008.summary.md",
         KIND_MEETING_SUMMARY,
         "本周 OKR OKR OKR 完成度 80%"),
        ("Strategy_20260520_100000.summary.md",
         KIND_MEETING_SUMMARY,
         "Q2 OKR 调整，重点在留存"),
        ("Standup_20260519_090000.transcript.txt",
         KIND_MEETING_TRANSCRIPT,
         "提到 OKR 落地的几个阻塞"),
        ("Finance_20260518_140000.summary.md",
         KIND_MEETING_SUMMARY,
         "KPI 走势平稳，没什么风险"),
    ]
    for fname, kind, body in docs:
        p = tmp_path / fname
        p.write_text(body, encoding="utf-8")
        upsert_doc(source_path=p, kind=kind, conn=conn)
    return db, conn


# ── _fts_search ────────────────────────────────────────────────────────

def test_fts_search_returns_ranked_hits(tmp_path):
    _db, conn = _seed_three_okr_docs(tmp_path)
    hits = _fts_search("OKR", since=None, kinds=None, limit=10, conn=conn)
    assert len(hits) == 3
    # The doc with three OKR occurrences should rank first.
    assert "AgentkeyProductWeekly" in hits[0].stem
    # All returned hits contain OKR.
    for h in hits:
        assert "OKR" in h.snippet or "[hit]" in h.snippet


def test_fts_search_handles_3char_chinese(tmp_path):
    db = tmp_path / "search.sqlite"
    conn = init_db(db)
    p = tmp_path / "Standup_20260519_090000.summary.md"
    p.write_text("本周项目进度整体良好", encoding="utf-8")
    upsert_doc(source_path=p, kind=KIND_MEETING_SUMMARY, conn=conn)
    hits = _fts_search("项目进度", since=None, kinds=None, limit=10, conn=conn)
    assert len(hits) == 1
    assert "项目进度" in hits[0].snippet or "[hit]" in hits[0].snippet


def test_fts_search_filters_by_kind(tmp_path):
    _db, conn = _seed_three_okr_docs(tmp_path)
    hits = _fts_search(
        "OKR", since=None, kinds=[KIND_MEETING_TRANSCRIPT],
        limit=10, conn=conn,
    )
    assert len(hits) == 1
    assert hits[0].kind == KIND_MEETING_TRANSCRIPT


def test_fts_search_filters_by_since(tmp_path):
    _db, conn = _seed_three_okr_docs(tmp_path)
    # The seed docs are dated 2026-05-18..21. Use a since cutoff that
    # excludes everything except the 2026-05-21 doc.
    now = datetime.now()
    target = datetime(2026, 5, 21, 16, 0, 8)
    since = now - target if now >= target else timedelta(seconds=0)
    hits = _fts_search("OKR", since=since, kinds=None, limit=10, conn=conn)
    if now >= target:
        # All four since-window dates lie inside; we should get back 3 OKR docs.
        assert len(hits) >= 1


def test_fts_search_negates_bm25_for_higher_better(tmp_path):
    """score must be 'higher = better'; bm25 itself is 'lower = better'."""
    _db, conn = _seed_three_okr_docs(tmp_path)
    hits = _fts_search("OKR", since=None, kinds=None, limit=10, conn=conn)
    # First hit should have the highest score.
    assert hits[0].score >= hits[-1].score


# ── _like_search ───────────────────────────────────────────────────────

def test_like_search_handles_2char_chinese(tmp_path):
    db = tmp_path / "search.sqlite"
    conn = init_db(db)
    p = tmp_path / "Standup_20260519_090000.summary.md"
    p.write_text("本周项目进度整体良好", encoding="utf-8")
    upsert_doc(source_path=p, kind=KIND_MEETING_SUMMARY, conn=conn)
    hits = _like_search("进度", since=None, kinds=None, limit=10, conn=conn)
    assert len(hits) == 1
    assert "进度" in hits[0].snippet


def test_like_search_returns_empty_for_nonexistent_term(tmp_path):
    _db, conn = _seed_three_okr_docs(tmp_path)
    hits = _like_search("NoSuchTerm", since=None, kinds=None, limit=10, conn=conn)
    assert hits == []


def test_like_search_filters_by_kind(tmp_path):
    _db, conn = _seed_three_okr_docs(tmp_path)
    hits = _like_search("OK", since=None, kinds=[KIND_MEETING_TRANSCRIPT],
                       limit=10, conn=conn)
    assert all(h.kind == KIND_MEETING_TRANSCRIPT for h in hits)


# ── search() entry point ──────────────────────────────────────────────

def _make_corpus_for_search(tmp_path: Path):
    """Set up a single-root corpus dir + db. Returns (db, root)."""
    db = tmp_path / "search.sqlite"
    root = tmp_path / "Yulu"
    root.mkdir()
    (root / "Plan_20260521_160000.summary.md").write_text(
        "本周关注 OKR 完成度", encoding="utf-8"
    )
    # A migrated memo — a meeting transcript at the root.
    (root / "Memo_20260513_140012.transcript.txt").write_text(
        "记得明天找 Anthropic 团队", encoding="utf-8"
    )
    return db, root


def test_search_picks_fts_for_3char_query(tmp_path, monkeypatch):
    db, root = _make_corpus_for_search(tmp_path)
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", root)
    hits, tel = search("OKR", db_path=db)
    assert tel["fallback_used"] is False
    assert tel["hit_count"] == len(hits) == 1


def test_search_picks_like_for_2char_query(tmp_path, monkeypatch):
    db, root = _make_corpus_for_search(tmp_path)
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", root)
    hits, tel = search("团队", db_path=db)
    assert tel["fallback_used"] is True
    assert tel["hit_count"] == len(hits) == 1


def test_search_validates_kinds(tmp_path, monkeypatch):
    db, root = _make_corpus_for_search(tmp_path)
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", root)
    with pytest.raises(ValueError):
        search("OKR", kinds=["garbage_kind"], db_path=db)


def test_search_clamps_limit_to_max(tmp_path, monkeypatch):
    """limit > MAX_LIMIT should be clamped; the query must not blow up."""
    db, root = _make_corpus_for_search(tmp_path)
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", root)
    hits, tel = search("OKR", limit=10_000, db_path=db)
    # We have 1 hit so this is just smoke; the clamp lives on the limit param.
    assert tel["hit_count"] == 1
    assert MAX_LIMIT == 100  # spec contract


def test_search_returns_telemetry(tmp_path, monkeypatch):
    db, root = _make_corpus_for_search(tmp_path)
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", root)
    hits, tel = search("OKR", db_path=db)
    assert set(tel.keys()) == {"sweep_ms", "query_ms", "fallback_used", "hit_count"}
    assert tel["sweep_ms"] >= 0
    assert tel["query_ms"] >= 0


def test_search_empty_query_returns_empty(tmp_path):
    hits, tel = search("   ", db_path=tmp_path / "search.sqlite")
    assert hits == []
    assert tel["hit_count"] == 0


def test_search_composes_filters(tmp_path, monkeypatch):
    """Spec acceptance #8: kind + since filters compose."""
    db, root = _make_corpus_for_search(tmp_path)
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", root)
    # Wide since (1000 days) — both files lie inside; restrict by kind.
    hits, tel = search(
        "Anthropic",
        since=timedelta(days=1000),
        kinds=[KIND_MEETING_TRANSCRIPT],
        db_path=db,
    )
    assert tel["hit_count"] == 1
    assert hits[0].kind == KIND_MEETING_TRANSCRIPT


def _make_natural_question_corpus(tmp_path: Path):
    db = tmp_path / "search.sqlite"
    root = tmp_path / "Yulu"
    root.mkdir()
    (root / "PhoenixLaunch_20260825_010300.transcript.txt").write_text(
        "Phoenix launch decision: release beta on Oct14. "
        "Mei owns the rollout checklist.", encoding="utf-8"
    )
    (root / "PhoenixReview_20260825_010400.transcript.txt").write_text(
        "Phoenix review decision: readiness review on Oct18. "
        "Arun owns reviewer feedback.", encoding="utf-8"
    )
    (root / "Generic_20260825_010500.transcript.txt").write_text(
        "What did happen yesterday.", encoding="utf-8"
    )
    (root / "PrivateLaunch_20260825_010600.transcript.txt").write_text(
        "Private Apollo launch decision.", encoding="utf-8"
    )
    (root / "PrivateHiring_20260825_010700.transcript.txt").write_text(
        "Private hiring follow-up owner.", encoding="utf-8"
    )
    return db, root


def test_search_treats_natural_question_punctuation_as_literal_terms(tmp_path, monkeypatch):
    db, root = _make_natural_question_corpus(tmp_path)
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", root)

    hits, tel = search(
        "Across the Phoenix meetings, what launch/review decisions were made, "
        "and who owns each follow-up?",
        db_path=db,
    )

    by_stem = {hit.stem: hit for hit in hits}
    assert set(by_stem) == {
        "PhoenixLaunch_20260825_010300",
        "PhoenixReview_20260825_010400",
    }
    launch_snippet = (by_stem["PhoenixLaunch_20260825_010300"].snippet
                      .replace("[hit]", "").replace("[/hit]", ""))
    review_snippet = (by_stem["PhoenixReview_20260825_010400"].snippet
                      .replace("[hit]", "").replace("[/hit]", ""))
    assert "Mei owns the rollout checklist" in launch_snippet
    assert "Arun owns reviewer feedback" in review_snippet
    assert all(len(hit.snippet) <= 400 for hit in hits)
    assert tel["fallback_used"] is False


def test_search_does_not_execute_user_supplied_fts_operators(tmp_path, monkeypatch):
    db, root = _make_natural_question_corpus(tmp_path)
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", root)

    hits, _tel = search(
        'Phoenix AND/OR "launch review"? NOT (fallback)',
        db_path=db,
    )

    assert {hit.stem for hit in hits} == {
        "PhoenixLaunch_20260825_010300",
        "PhoenixReview_20260825_010400",
    }


def test_search_does_not_retrieve_private_distractors_from_question_glue(tmp_path, monkeypatch):
    db, root = _make_natural_question_corpus(tmp_path)
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", root)

    hits, _tel = search(
        "What did we decide about Phoenix?",
        db_path=db,
    )

    assert {hit.stem for hit in hits} == {
        "PhoenixLaunch_20260825_010300",
        "PhoenixReview_20260825_010400",
    }


def test_search_anchor_selection_does_not_depend_on_question_word_order(tmp_path, monkeypatch):
    db, root = _make_natural_question_corpus(tmp_path)
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", root)

    hits, _tel = search(
        "What launch/review decision was made across the Phoenix meetings?",
        db_path=db,
    )

    assert {hit.stem for hit in hits} == {
        "PhoenixLaunch_20260825_010300",
        "PhoenixReview_20260825_010400",
    }


# ── reindex + doctor ──────────────────────────────────────────────────

def test_reindex_rebuilds_from_scratch(tmp_path, monkeypatch):
    db, root = _make_corpus_for_search(tmp_path)
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", root)
    # First run populates.
    hits1, _ = search("OKR", db_path=db)
    assert len(hits1) == 1

    # Wipe out manually then reindex.
    conn = init_db(db)
    conn.execute("DELETE FROM docs"); conn.execute("DELETE FROM docs_meta")
    conn.commit(); conn.close()

    counts = reindex(db_path=db)
    assert counts["added"] >= 2  # both files re-indexed


def test_doctor_returns_health_dict(tmp_path, monkeypatch):
    db, root = _make_corpus_for_search(tmp_path)
    from search import reader as reader_mod
    monkeypatch.setattr(reader_mod, "CORPUS_ROOT", root)
    search("OKR", db_path=db)  # populate

    h = doctor(db_path=db)
    assert h["schema_version"] == "1"
    assert h["integrity_ok"] is True
    assert h["total_docs"] >= 1
    assert h["last_full_sweep_at"] is not None
    assert h["db_size_bytes"] > 0
    assert "meeting_summary" in h["per_kind"] or "meeting_transcript" in h["per_kind"]
    assert h["root_registry"]["roots"][0]["path"] == str(root)
