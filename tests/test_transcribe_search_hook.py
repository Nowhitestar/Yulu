"""Phase B.4 tests: transcribe.process_audio pushes the meeting transcript
into the search index after writing it to disk."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from prompts import PromptsRepo, Category, open_db


def _bootstrap_db(tmp_path):
    db = tmp_path / "prompts.sqlite"
    repo = PromptsRepo(open_db(db))
    repo.add(slug="summary", name="Standard Summary", category=Category.SUMMARY,
             content="summarize {{transcript}}", is_auto_run=True)
    return db


def test_transcribe_pushes_meeting_transcript_to_search_index(tmp_path, monkeypatch):
    import transcribe
    from search import indexer as search_indexer

    fake_home = tmp_path / "config"
    fake_home.mkdir()
    monkeypatch.setattr(transcribe, "CONFIG_PATH", fake_home / "config.json")
    (fake_home / "config.json").write_text(json.dumps({
        "transcription": {"final_engine": "mlx", "language": "zh",
                          "post_recording_mode": "full"},
        "llm": {"enabled": True},
    }))
    db = _bootstrap_db(tmp_path)
    monkeypatch.setattr(transcribe, "PROMPTS_DB", db, raising=False)
    monkeypatch.setattr(
        transcribe, "_request_final_transcribe_raw",
        lambda *a, **k: {"status": "ok", "layout": "mono",
                         "text": "the transcript body", "segments": []},
    )
    queue_path = fake_home / "agent-queue.json"
    monkeypatch.setattr(transcribe, "AGENT_QUEUE_PATH", queue_path, raising=False)

    calls: list[dict] = []
    monkeypatch.setattr(
        search_indexer, "upsert_doc",
        lambda **kw: calls.append(kw) or True,
    )

    audio = tmp_path / "Smoke_20260519_120000.wav"
    audio.write_bytes(b"R")
    transcribe.process_audio(str(audio))

    assert len(calls) == 1
    assert calls[0]["kind"] == search_indexer.KIND_MEETING_TRANSCRIPT
    assert calls[0]["source_path"] == audio.with_suffix(".transcript.txt")
    assert calls[0]["body"] == "the transcript body"


def test_transcribe_swallows_search_index_failure(tmp_path, monkeypatch, capsys):
    """Index failure must not break process_audio. Queue must still be
    populated; transcript file must still exist."""
    import transcribe
    from search import indexer as search_indexer

    fake_home = tmp_path / "config"
    fake_home.mkdir()
    monkeypatch.setattr(transcribe, "CONFIG_PATH", fake_home / "config.json")
    (fake_home / "config.json").write_text(json.dumps({
        "transcription": {"final_engine": "mlx", "language": "zh",
                          "post_recording_mode": "full"},
        "llm": {"enabled": True},
    }))
    db = _bootstrap_db(tmp_path)
    monkeypatch.setattr(transcribe, "PROMPTS_DB", db, raising=False)
    monkeypatch.setattr(
        transcribe, "_request_final_transcribe_raw",
        lambda *a, **k: {"status": "ok", "layout": "mono",
                         "text": "transcript", "segments": []},
    )
    queue_path = fake_home / "agent-queue.json"
    monkeypatch.setattr(transcribe, "AGENT_QUEUE_PATH", queue_path, raising=False)

    monkeypatch.setattr(
        search_indexer, "upsert_doc",
        lambda **_kw: (_ for _ in ()).throw(RuntimeError("boom")),
    )

    audio = tmp_path / "Smoke_20260519_120000.wav"
    audio.write_bytes(b"R")
    transcribe.process_audio(str(audio))   # must not raise

    assert audio.with_suffix(".transcript.txt").exists()
    queue = json.loads(queue_path.read_text())
    assert any(e["type"] == "summary_request" for e in queue)
    err = capsys.readouterr().err
    assert "search index upsert failed" in err
