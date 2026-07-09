"""Tests for agent_queue_worker's new prompt-library-aware dispatch."""

import json
import os
import stat
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import pytest
from prompts import PromptsRepo, SummariesRepo, Category, SummaryStatus, open_db
from prompts.cache import PromptsCache
from vocab import VocabRepo, Scope, open_db as open_vocab_db
import agent_queue_worker as worker


def _stub_llm(tmp_path: Path, output: str, exit_code: int = 0) -> Path:
    """Stub shell script that ignores stdin and echoes a canned response."""
    cli = tmp_path / "stub-llm"
    body = (
        "#!/usr/bin/env bash\n"
        "cat > /dev/null\n"
        f"{'echo ' + repr(output) if exit_code == 0 else 'echo oops >&2'}\n"
        f"exit {exit_code}\n"
    )
    cli.write_text(body)
    cli.chmod(cli.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return cli


def _capture_llm(tmp_path: Path, capture_file: Path, output: str = "OK") -> Path:
    """Stub that writes stdin to capture_file so tests can inspect what was sent.

    Writes the canned output to a sidecar file so bash `cat` emits it with
    real newlines (avoids repr/echo escaping issues with multi-line strings).
    """
    sidecar = tmp_path / "capture-llm-output.txt"
    sidecar.write_text(output, encoding="utf-8")
    cli = tmp_path / "capture-llm"
    cli.write_text(
        "#!/usr/bin/env bash\n"
        f"cat > {capture_file}\n"
        f"cat {sidecar}\n"
    )
    cli.chmod(cli.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return cli


def _setup(tmp_path):
    """Common: prompts.sqlite with default summary prompt + meeting files."""
    prompts_db = tmp_path / "prompts.sqlite"
    repo = PromptsRepo(open_db(prompts_db))
    repo.add(slug="summary", name="Standard Summary", category=Category.SUMMARY,
             content="please summarize: {{transcript}}", is_auto_run=True)
    transcript = tmp_path / "meeting.transcript.txt"
    transcript.write_text("the transcript body", encoding="utf-8")
    summary_path = tmp_path / "meeting.summary.md"
    audio_path = tmp_path / "meeting.wav"
    audio_path.write_bytes(b"R")
    return {
        "prompts_db": prompts_db,
        "transcript": transcript,
        "summary_path": summary_path,
        "audio_path": audio_path,
    }


def _new_summary_event(ctx, *, slug="summary", snapshot=None, title="Test Meeting"):
    """Build a new-style summary_request event (with prompt_* fields)."""
    return {
        "id": "evt-1",
        "type": "summary_request",
        "title": title,
        "audio_path": str(ctx["audio_path"]),
        "transcript_path": str(ctx["transcript"]),
        "summary_path": str(ctx["summary_path"]),
        "prompt_id": "p1",
        "prompt_slug": slug,
        "prompt_name": "Standard Summary",
        "prompt_content_snapshot": snapshot or "please summarize: {{transcript}}",
    }


# ── Tests ───────────────────────────────────────────────────────────

def test_new_event_resolves_snapshot_and_writes_summary(tmp_path):
    ctx = _setup(tmp_path)
    llm = [str(_stub_llm(tmp_path, "## Summary\n\nsome content here\n\n* point one\n* point two\n* point three"))]
    cache = PromptsCache(ctx["prompts_db"]); cache.load()
    entry = _new_summary_event(ctx)
    worker._handle_summary_request(
        entry, llm, timeout_sec=30, cache=cache,
        prompts_db=ctx["prompts_db"],
    )
    assert ctx["summary_path"].exists()
    assert "Summary" in ctx["summary_path"].read_text()
    srepo = SummariesRepo(open_db(ctx["prompts_db"]))
    rows = srepo.list_summaries(audio_path=str(ctx["audio_path"]))
    assert len(rows) == 1
    assert rows[0].status == SummaryStatus.DONE
    assert rows[0].prompt_slug == "summary"
    assert rows[0].duration_ms is not None and rows[0].duration_ms >= 0
    assert rows[0].word_count is not None and rows[0].word_count > 0


def test_legacy_event_falls_back_to_default_summary_prompt(tmp_path):
    ctx = _setup(tmp_path)
    llm = [str(_stub_llm(tmp_path, "## Summary\n\nlegacy fallback worked\n\n* one\n* two"))]
    cache = PromptsCache(ctx["prompts_db"]); cache.load()
    legacy = {
        "id": "evt-legacy",
        "type": "summary_request",
        "title": "Legacy",
        "transcript_path": str(ctx["transcript"]),
        "summary_path": str(ctx["summary_path"]),
        # No prompt_* fields
    }
    worker._handle_summary_request(
        legacy, llm, timeout_sec=30, cache=cache,
        prompts_db=ctx["prompts_db"],
    )
    assert ctx["summary_path"].exists()
    srepo = SummariesRepo(open_db(ctx["prompts_db"]))
    rows = srepo.list_summaries()
    assert len(rows) == 1
    assert rows[0].prompt_slug == "summary"  # fallback worked


def test_llm_failure_marks_error_in_summaries_table(tmp_path):
    ctx = _setup(tmp_path)
    failing_llm = [str(_stub_llm(tmp_path, "ignored", exit_code=7))]
    cache = PromptsCache(ctx["prompts_db"]); cache.load()
    entry = _new_summary_event(ctx)
    with pytest.raises(RuntimeError):
        worker._handle_summary_request(
            entry, failing_llm, timeout_sec=30, cache=cache,
            prompts_db=ctx["prompts_db"],
        )
    srepo = SummariesRepo(open_db(ctx["prompts_db"]))
    err_rows = srepo.list_summaries(status=SummaryStatus.ERROR)
    assert len(err_rows) == 1
    assert err_rows[0].error  # some message recorded


def test_template_variables_all_substituted(tmp_path):
    ctx = _setup(tmp_path)
    # Use audio path with parseable date suffix so {{date}} resolves
    audio = tmp_path / "Meeting_20260519_140000.wav"
    audio.write_bytes(b"R")
    transcript = tmp_path / "Meeting_20260519_140000.transcript.txt"
    transcript.write_text("body content", encoding="utf-8")
    summary = tmp_path / "Meeting_20260519_140000.summary.md"
    capture_file = tmp_path / "captured-stdin.txt"
    capture_llm = [str(_capture_llm(tmp_path, capture_file,
                                     output="## Summary\n\nsome output about the meeting\n\n* action item one\n* action item two"))]
    cache = PromptsCache(ctx["prompts_db"]); cache.load()
    entry = {
        "id": "evt",
        "type": "summary_request",
        "title": "May Meeting",
        "audio_path": str(audio),
        "transcript_path": str(transcript),
        "summary_path": str(summary),
        "prompt_id": "p", "prompt_slug": "summary",
        "prompt_name": "S",
        "prompt_content_snapshot":
            "date={{date}} title={{meeting_title}} ===\n{{transcript}}",
    }
    worker._handle_summary_request(
        entry, capture_llm, timeout_sec=30, cache=cache,
        prompts_db=ctx["prompts_db"],
    )
    payload = capture_file.read_text(encoding="utf-8")
    assert "date=2026-05-19" in payload
    assert "title=May Meeting" in payload
    assert "body content" in payload
    assert "{{" not in payload


def test_summary_prompt_includes_glossary_canonical_context(tmp_path):
    ctx = _setup(tmp_path)
    ctx["transcript"].write_text("今天聊了阿发学院 community", encoding="utf-8")
    vocab_db = tmp_path / "vocab.sqlite"
    repo = VocabRepo(open_vocab_db(vocab_db))
    repo.add(term="阿发学院", canonical="阿尔法学院", scope=Scope.BOTH)
    capture_file = tmp_path / "captured-glossary-prompt.txt"
    capture_llm = [str(_capture_llm(
        tmp_path,
        capture_file,
        output="## Summary\n\n阿尔法学院相关讨论已经整理完成。\n\n* action item one\n* action item two",
    ))]
    cache = PromptsCache(ctx["prompts_db"]); cache.load()
    entry = _new_summary_event(ctx)
    worker._handle_summary_request(
        entry, capture_llm, timeout_sec=30, cache=cache,
        prompts_db=ctx["prompts_db"], vocab_db=vocab_db,
    )
    payload = capture_file.read_text(encoding="utf-8")
    assert "阿发学院 => 阿尔法学院" in payload
    assert "canonical 写法" in payload
    assert "今天聊了阿发学院 community" in payload


def test_cleanup_slug_writes_to_transcript_path(tmp_path):
    ctx = _setup(tmp_path)
    # Add a cleanup-category prompt
    repo = PromptsRepo(open_db(ctx["prompts_db"]))
    repo.add(slug="transcript-cleanup", name="Cleanup",
             category=Category.CLEANUP, content="clean: {{transcript}}",
             is_auto_run=True)
    cleaned_output = "[00:00] cleaned transcript line\n[00:05] another line"
    llm = [str(_stub_llm(tmp_path, cleaned_output))]
    cache = PromptsCache(ctx["prompts_db"]); cache.load()
    entry = _new_summary_event(ctx, slug="transcript-cleanup",
                                snapshot="clean: {{transcript}}")
    # cleanup slug overwrites transcript_path, not summary_path
    entry["summary_path"] = str(ctx["transcript"])  # what transcribe.py would do
    worker._handle_summary_request(
        entry, llm, timeout_sec=30, cache=cache,
        prompts_db=ctx["prompts_db"],
    )
    # Transcript was overwritten with cleaned output
    assert "cleaned transcript" in ctx["transcript"].read_text()
    # No html_path (cleanup skips html)
    srepo = SummariesRepo(open_db(ctx["prompts_db"]))
    rows = srepo.list_summaries()
    cleanup_row = next(r for r in rows if r.prompt_slug == "transcript-cleanup")
    assert cleanup_row.status == SummaryStatus.DONE
    assert cleanup_row.html_path is None
