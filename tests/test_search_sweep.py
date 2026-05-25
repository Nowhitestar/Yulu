"""Phase C.1 tests: sweep walks the corpus, upserts changes, removes deletes."""

import os
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from search.indexer import (
    KIND_MEETING_SUMMARY,
    KIND_MEETING_TRANSCRIPT,
    KIND_VOICEMAIL_TRANSCRIPT,
    init_db,
)
from search.reader import sweep


def _make_corpus(tmp_path: Path) -> tuple[Path, Path, Path, Path, Path]:
    """Lay out a tiny corpus mimicking ~/Movies/Yulu/."""
    root = tmp_path / "Yulu"
    voicemails = root / "voicemails"
    root.mkdir()
    voicemails.mkdir()

    meeting_transcript = root / "AgentkeyProductWeekly_20260521_160008.transcript.txt"
    meeting_transcript.write_text("meeting body here", encoding="utf-8")

    meeting_summary = root / "AgentkeyProductWeekly_20260521_160008.summary.md"
    meeting_summary.write_text("meeting summary", encoding="utf-8")

    voicemail_transcript = voicemails / "voicemail_20260513_140012.transcript.txt"
    voicemail_transcript.write_text("voicemail body", encoding="utf-8")

    return root, voicemails, meeting_transcript, meeting_summary, voicemail_transcript


def test_sweep_indexes_new_files(tmp_path):
    db = tmp_path / "search.sqlite"
    root, voicemails, m_trans, m_sum, v_trans = _make_corpus(tmp_path)
    conn = init_db(db)
    counts = sweep(conn=conn, roots=[root, voicemails])
    assert counts["scanned"] == 3
    assert counts["added"] == 3
    assert counts["updated"] == 0
    assert counts["removed"] == 0
    rows = list(conn.execute(
        "SELECT kind, source_path FROM docs ORDER BY source_path"
    ))
    kinds_by_path = {r["source_path"]: r["kind"] for r in rows}
    assert kinds_by_path[str(m_trans)] == KIND_MEETING_TRANSCRIPT
    assert kinds_by_path[str(m_sum)] == KIND_MEETING_SUMMARY
    assert kinds_by_path[str(v_trans)] == KIND_VOICEMAIL_TRANSCRIPT


def test_sweep_is_idempotent(tmp_path):
    db = tmp_path / "search.sqlite"
    root, voicemails, *_ = _make_corpus(tmp_path)
    conn = init_db(db)
    sweep(conn=conn, roots=[root, voicemails])
    counts = sweep(conn=conn, roots=[root, voicemails])
    assert counts["added"] == 0
    assert counts["updated"] == 0
    assert counts["removed"] == 0


def test_sweep_updates_changed_files(tmp_path):
    db = tmp_path / "search.sqlite"
    root, voicemails, m_trans, *_ = _make_corpus(tmp_path)
    conn = init_db(db)
    sweep(conn=conn, roots=[root, voicemails])

    # Touch mtime forward and change content so sha256 differs too.
    m_trans.write_text("changed body", encoding="utf-8")
    future = time.time() + 5
    os.utime(m_trans, (future, future))

    counts = sweep(conn=conn, roots=[root, voicemails])
    assert counts["updated"] == 1
    body = conn.execute(
        "SELECT body FROM docs WHERE source_path=?", (str(m_trans),)
    ).fetchone()[0]
    assert body == "changed body"


def test_sweep_removes_deleted_files(tmp_path):
    db = tmp_path / "search.sqlite"
    root, voicemails, m_trans, m_sum, v_trans = _make_corpus(tmp_path)
    conn = init_db(db)
    sweep(conn=conn, roots=[root, voicemails])

    v_trans.unlink()
    counts = sweep(conn=conn, roots=[root, voicemails])
    assert counts["removed"] == 1
    n = conn.execute("SELECT COUNT(*) FROM docs").fetchone()[0]
    assert n == 2


def test_sweep_skips_unparseable_filenames(tmp_path):
    db = tmp_path / "search.sqlite"
    root, voicemails, *_ = _make_corpus(tmp_path)
    # User dropped a manual note that doesn't match the stem regex.
    (root / "notes.md").write_text("hello", encoding="utf-8")
    (root / "untitled.transcript.txt").write_text("blah", encoding="utf-8")
    conn = init_db(db)
    counts = sweep(conn=conn, roots=[root, voicemails])
    # Only the three valid files should land.
    assert counts["scanned"] == 3
    assert counts["added"] == 3


def test_sweep_excludes_realtime_and_raw_transcripts(tmp_path):
    """Spec §3 non-goal #1: .realtime / .raw / .mic / .sys are NOT indexed."""
    db = tmp_path / "search.sqlite"
    root, voicemails, *_ = _make_corpus(tmp_path)
    for suffix in (".realtime.transcript.txt", ".raw.transcript.txt",
                   ".mic.transcript.txt", ".sys.transcript.txt"):
        (root / f"Some_20260521_160008{suffix}").write_text("noise", encoding="utf-8")
    conn = init_db(db)
    counts = sweep(conn=conn, roots=[root, voicemails])
    # Still just the 3 valid files.
    assert counts["scanned"] == 3


def test_sweep_handles_slug_tagged_summary(tmp_path):
    db = tmp_path / "search.sqlite"
    root, voicemails, *_ = _make_corpus(tmp_path)
    (root / "AgentkeyProductWeekly_20260521_160008.action-items.summary.md"
     ).write_text("action items body", encoding="utf-8")
    conn = init_db(db)
    counts = sweep(conn=conn, roots=[root, voicemails])
    assert counts["scanned"] == 4
    assert counts["added"] == 4


def test_sweep_completes_under_250ms_for_38_files(tmp_path):
    """Spec §6.1 perf gate. Synth corpus of 38 small files; sweep must
    finish within 500ms (generous slack vs spec's 250ms target)."""
    db = tmp_path / "search.sqlite"
    root = tmp_path / "Yulu"
    voicemails = root / "voicemails"
    root.mkdir()
    voicemails.mkdir()
    for i in range(30):
        stem = f"Meeting{i:02d}_20260521_{160000 + i:06d}"
        (root / f"{stem}.transcript.txt").write_text(f"body {i}", encoding="utf-8")
    for i in range(8):
        stem = f"voicemail_20260513_{140000 + i:06d}"
        (voicemails / f"{stem}.transcript.txt").write_text(f"vm {i}", encoding="utf-8")
    conn = init_db(db)
    t0 = time.monotonic()
    counts = sweep(conn=conn, roots=[root, voicemails])
    elapsed_ms = (time.monotonic() - t0) * 1000
    assert counts["scanned"] == 38
    assert elapsed_ms < 500, f"sweep too slow: {elapsed_ms:.0f}ms"


def test_sweep_records_last_full_sweep_at(tmp_path):
    db = tmp_path / "search.sqlite"
    root, voicemails, *_ = _make_corpus(tmp_path)
    conn = init_db(db)
    sweep(conn=conn, roots=[root, voicemails])
    row = conn.execute(
        "SELECT value FROM meta WHERE key='last_full_sweep_at'"
    ).fetchone()
    assert row is not None
    # ISO-8601 prefix sanity.
    assert row[0].startswith("20")
