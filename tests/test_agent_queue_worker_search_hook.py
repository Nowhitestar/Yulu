"""Phase B.2 tests: agent_queue_worker pushes summaries into search index.

The hook must:
  - call search.indexer.upsert_doc with kind=meeting_summary after the summary
    file is written (every recording is a meeting now — no voicemail kind);
  - swallow exceptions from the indexer so the recording pipeline never
    breaks on a search-index failure.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import agent_queue_worker
from agent_queue_worker import process_queue_once
from prompts import PromptsRepo, Category, open_db
from search import indexer as search_indexer


def _setup_prompts_db(tmp_path: Path) -> Path:
    prompts_db = tmp_path / "prompts.sqlite"
    repo = PromptsRepo(open_db(prompts_db))
    repo.add(
        slug="summary",
        name="Standard Summary",
        category=Category.SUMMARY,
        content="summarize: {{transcript}}",
        is_auto_run=True,
    )
    return prompts_db


def _valid_summary_text() -> str:
    return (
        "# 最终纪要\n\n"
        "## TL;DR\n"
        "Meeting body with enough length to pass validation." + " more" * 40 + "\n\n"
        "## Action Items\n"
        "- [ ] @Lewis follow up\n"
    )


def _write_fake_llm(tmp_path: Path, output: str) -> Path:
    llm = tmp_path / "fake_llm.py"
    llm.write_text(
        "import sys\nsys.stdin.read()\n"
        f"print({output!r})\n",
        encoding="utf-8",
    )
    return llm


def _queue_meeting_request(tmp_path: Path, transcript: Path, summary: Path,
                            audio_path: Path) -> Path:
    queue_path = tmp_path / "agent-queue.json"
    queue_path.write_text(json.dumps([
        {
            "type": "summary_request",
            "ts": "2026-05-21T16:00:08",
            "title": "AgentkeyProductWeekly",
            "audio_path": str(audio_path),
            "transcript_path": str(transcript),
            "summary_path": str(summary),
        }
    ], ensure_ascii=False), encoding="utf-8")
    return queue_path


def test_hook_invoked_for_meeting_summary(tmp_path, monkeypatch):
    prompts_db = _setup_prompts_db(tmp_path)
    audio = tmp_path / "AgentkeyProductWeekly_20260521_160008.wav"
    audio.write_bytes(b"")
    transcript = audio.with_suffix(".transcript.txt")
    transcript.write_text("transcript body", encoding="utf-8")
    summary = audio.with_suffix(".summary.md")
    llm = _write_fake_llm(tmp_path, _valid_summary_text())

    calls = []

    def fake_upsert(*, source_path, kind, body=None, **_kw):
        calls.append({"source_path": Path(source_path), "kind": kind,
                      "body_len": len(body or "")})
        return True

    monkeypatch.setattr(search_indexer, "upsert_doc", fake_upsert)

    queue_path = _queue_meeting_request(tmp_path, transcript, summary, audio)
    processed = process_queue_once(
        queue_path=queue_path,
        llm_command=[sys.executable, str(llm)],
        timeout_sec=5,
        prompts_db=prompts_db,
    )
    assert processed == 1
    assert len(calls) == 1
    assert calls[0]["kind"] == search_indexer.KIND_MEETING_SUMMARY
    assert calls[0]["source_path"] == summary
    assert calls[0]["body_len"] > 0


def test_hook_indexes_a_migrated_memo_as_meeting(tmp_path, monkeypatch):
    """A recording that still sits under a legacy voicemails/ directory (or a
    migrated Memo_*) indexes as a MEETING — the worker no longer branches on
    the directory to pick a voicemail kind."""
    prompts_db = _setup_prompts_db(tmp_path)
    voicemail_dir = tmp_path / "voicemails"
    voicemail_dir.mkdir()
    audio = voicemail_dir / "Memo_20260513_140012.wav"
    audio.write_bytes(b"")
    transcript = audio.with_suffix(".transcript.txt")
    transcript.write_text("memo body", encoding="utf-8")
    summary = audio.with_suffix(".summary.md")
    llm = _write_fake_llm(tmp_path, _valid_summary_text())

    calls = []
    monkeypatch.setattr(
        search_indexer, "upsert_doc",
        lambda **kw: calls.append(kw) or True,
    )

    queue_path = tmp_path / "agent-queue.json"
    queue_path.write_text(json.dumps([
        {
            "type": "summary_request",
            "ts": "2026-05-13T14:00:12",
            "title": "Memo",
            "audio_path": str(audio),
            "transcript_path": str(transcript),
            "summary_path": str(summary),
        }
    ], ensure_ascii=False), encoding="utf-8")

    processed = process_queue_once(
        queue_path=queue_path,
        llm_command=[sys.executable, str(llm)],
        timeout_sec=5,
        prompts_db=prompts_db,
    )
    assert processed == 1
    assert len(calls) == 1
    assert calls[0]["kind"] == search_indexer.KIND_MEETING_SUMMARY


def test_hook_failure_does_not_break_processing(tmp_path, monkeypatch):
    """Index upsert raising must not bubble up — the summary still lands
    on disk and the queue entry is still marked done."""
    prompts_db = _setup_prompts_db(tmp_path)
    audio = tmp_path / "AgentkeyProductWeekly_20260521_160008.wav"
    audio.write_bytes(b"")
    transcript = audio.with_suffix(".transcript.txt")
    transcript.write_text("transcript body", encoding="utf-8")
    summary = audio.with_suffix(".summary.md")
    llm = _write_fake_llm(tmp_path, _valid_summary_text())

    def boom(**_kw):
        raise RuntimeError("simulated index failure")

    monkeypatch.setattr(search_indexer, "upsert_doc", boom)

    queue_path = _queue_meeting_request(tmp_path, transcript, summary, audio)
    processed = process_queue_once(
        queue_path=queue_path,
        llm_command=[sys.executable, str(llm)],
        timeout_sec=5,
        prompts_db=prompts_db,
    )
    assert processed == 1
    assert summary.exists()
    queue = json.loads(queue_path.read_text(encoding="utf-8"))
    assert queue[0]["status"] == "done"
