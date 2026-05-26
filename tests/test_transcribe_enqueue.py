"""End-to-end (with mocks) that transcribe.py enqueues per-prompt events."""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from prompts import PromptsRepo, Category, open_db


def _bootstrap_db(tmp_path, *, with_action_items=False):
    db = tmp_path / "prompts.sqlite"
    repo = PromptsRepo(open_db(db))
    repo.add(slug="summary", name="Standard Summary", category=Category.SUMMARY,
             content="please summarize {{transcript}}", is_auto_run=True)
    repo.add(slug="transcript-cleanup", name="Cleanup", category=Category.CLEANUP,
             content="clean {{transcript}}", is_auto_run=True)
    if with_action_items:
        repo.add(slug="action-items", name="Action Items",
                 category=Category.SUMMARY,
                 content="actions from {{transcript}}", is_auto_run=True)
    return db


def test_enqueues_one_event_per_auto_run_prompt(tmp_path, monkeypatch):
    import transcribe
    fake_home = tmp_path / "config"
    fake_home.mkdir()
    monkeypatch.setattr(transcribe, "CONFIG_PATH", fake_home / "config.json")
    (fake_home / "config.json").write_text(json.dumps({
        "transcription": {"final_engine": "mlx", "language": "zh",
                          "post_recording_mode": "full"},
        "llm": {"enabled": True},
    }))
    db = _bootstrap_db(tmp_path, with_action_items=True)
    monkeypatch.setattr(transcribe, "PROMPTS_DB", db, raising=False)
    monkeypatch.setattr(
        transcribe, "_request_final_transcribe_raw",
        lambda *a, **k: {"status": "ok", "layout": "mono",
                         "text": "the transcript", "segments": []},
    )
    queue_path = fake_home / "agent-queue.json"
    monkeypatch.setattr(transcribe, "AGENT_QUEUE_PATH", queue_path, raising=False)

    audio = tmp_path / "Smoke_20260519_120000.wav"
    audio.write_bytes(b"R")
    transcribe.process_audio(str(audio))

    queue = json.loads(queue_path.read_text())
    sr = [e for e in queue if e["type"] == "summary_request"]
    assert len(sr) == 3
    slugs = sorted(e["prompt_slug"] for e in sr)
    assert slugs == ["action-items", "summary", "transcript-cleanup"]
    for ev in sr:
        assert ev["prompt_content_snapshot"]
        assert ev["audio_path"] == str(audio)
    default = next(e for e in sr if e["prompt_slug"] == "summary")
    assert default["summary_path"].endswith(".summary.md")
    assert not default["summary_path"].endswith(".action-items.summary.md")
    action = next(e for e in sr if e["prompt_slug"] == "action-items")
    assert action["summary_path"].endswith(".action-items.summary.md")
    cleanup = next(e for e in sr if e["prompt_slug"] == "transcript-cleanup")
    assert cleanup["summary_path"].endswith(".transcript.txt")


def test_no_auto_run_prompts_means_no_events(tmp_path, monkeypatch):
    import transcribe
    fake_home = tmp_path / "config"
    fake_home.mkdir()
    monkeypatch.setattr(transcribe, "CONFIG_PATH", fake_home / "config.json")
    (fake_home / "config.json").write_text("{}")
    db = tmp_path / "prompts.sqlite"
    open_db(db)  # schema only
    monkeypatch.setattr(transcribe, "PROMPTS_DB", db, raising=False)
    monkeypatch.setattr(
        transcribe, "_request_final_transcribe_raw",
        lambda *a, **k: {"status": "ok", "layout": "mono",
                         "text": "x", "segments": []},
    )
    queue_path = fake_home / "agent-queue.json"
    monkeypatch.setattr(transcribe, "AGENT_QUEUE_PATH", queue_path, raising=False)

    audio = tmp_path / "S_20260519_120000.wav"
    audio.write_bytes(b"R")
    transcribe.process_audio(str(audio))
    assert not queue_path.exists() or json.loads(queue_path.read_text()) == []
