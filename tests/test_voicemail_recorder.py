"""Voicemail recorder: post-stop transcribe + enqueue pipeline.

These tests stub the daemon socket and the prompts cache so the recorder
logic can be tested without launching audio_daemon / stt_daemon."""

import json
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import voicemail.recorder as recorder
import queue_store


@pytest.fixture
def isolated_paths(tmp_path, monkeypatch):
    queue = tmp_path / "queue.json"
    lock = tmp_path / "queue.lock"
    prompts_db = tmp_path / "prompts.sqlite"
    monkeypatch.setattr(recorder, "AGENT_QUEUE_PATH", queue)
    monkeypatch.setattr(recorder, "PROMPTS_DB", prompts_db)
    monkeypatch.setattr(queue_store, "QUEUE_PATH", queue)
    monkeypatch.setattr(queue_store, "LOCK_PATH", lock)

    # Initialize empty queue file so tests can read it even when nothing
    # was appended (e.g. the daemon-error path).
    queue.write_text("[]", encoding="utf-8")

    # Seed prompts so the cache returns voicemail prompts
    from prompts.db import PromptsRepo, open_db
    from prompts.seed import seed_from_current
    repo = PromptsRepo(open_db(prompts_db))
    seed_from_current(repo)
    return queue, prompts_db


def test_transcribe_writes_mic_text_only(isolated_paths, tmp_path, monkeypatch):
    queue, prompts_db = isolated_paths
    wav = tmp_path / "voicemail_20260523_201500.wav"
    wav.touch()

    fake_response = {
        "status": "ok",
        "layout": "dual_track",
        "channels": {
            "mic": {"text": "嗯 记得明天找 Anthropic 团队",
                    "segments": [{"start": 0.0, "end": 2.0,
                                  "text": "嗯 记得明天找 Anthropic 团队"}]},
            "sys": {"skipped_silent": True, "text": "", "segments": []},
        },
    }
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        recorder._transcribe_and_enqueue(wav, title=None)

    # No speaker tag — single-speaker voicemail
    transcript_text = (wav.with_suffix(".transcript.txt")).read_text(encoding="utf-8")
    assert transcript_text == "嗯 记得明天找 Anthropic 团队"
    # raw mirrors transcript (pre-cleanup snapshot)
    raw = (wav.with_suffix(".raw.transcript.txt")).read_text(encoding="utf-8")
    assert raw == transcript_text
    # NO mic/sys siblings for voicemails (mono-equivalent)
    assert not wav.with_suffix(".mic.transcript.txt").exists()
    assert not wav.with_suffix(".sys.transcript.txt").exists()


def test_transcribe_writes_title_sidecar_when_provided(isolated_paths, tmp_path, monkeypatch):
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260523_201500.wav"
    wav.touch()
    fake_response = {
        "status": "ok",
        "channels": {
            "mic": {"text": "hi", "segments": []},
            "sys": {"skipped_silent": True, "text": "", "segments": []},
        },
    }
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        recorder._transcribe_and_enqueue(wav, title="Anthropic follow-up")
    sidecar = wav.with_suffix(".title")
    assert sidecar.read_text(encoding="utf-8") == "Anthropic follow-up\n"


def test_enqueues_only_voicemail_category_prompts(isolated_paths, tmp_path, monkeypatch):
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260523_201500.wav"
    wav.touch()
    fake_response = {
        "status": "ok",
        "channels": {
            "mic": {"text": "hi", "segments": [{"start": 0.0, "end": 1.0, "text": "hi"}]},
            "sys": {"skipped_silent": True, "text": "", "segments": []},
        },
    }
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        recorder._transcribe_and_enqueue(wav, title=None)
    events = json.loads(queue.read_text(encoding="utf-8"))
    # Only voicemail-todos (auto-run); voicemail-clean is opt-in
    slugs = [e["prompt_slug"] for e in events]
    assert slugs == ["voicemail-todos"]
    assert events[0]["audio_path"] == str(wav)
    # summary_path is <wav>.summary.md (default-slug convention from Phase 2)
    assert events[0]["summary_path"] == str(wav.with_suffix(".summary.md"))


def test_transcribe_handles_legacy_response_shape(isolated_paths, tmp_path, monkeypatch):
    """If stt_daemon returns the legacy single-text shape (channel_split=False),
    use response['text'] directly."""
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260523_201500.wav"
    wav.touch()
    fake_response = {"status": "ok", "layout": "mono",
                     "text": "legacy text", "segments": []}
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        recorder._transcribe_and_enqueue(wav, title=None)
    assert wav.with_suffix(".transcript.txt").read_text(encoding="utf-8") == "legacy text"


def test_transcribe_handles_daemon_error_gracefully(isolated_paths, tmp_path, monkeypatch):
    queue, _ = isolated_paths
    wav = tmp_path / "voicemail_20260523_201500.wav"
    wav.touch()
    fake_response = {"status": "error", "error": "daemon dead"}
    with patch.object(recorder, "_request_transcribe", return_value=fake_response):
        rc = recorder._transcribe_and_enqueue(wav, title=None)
    assert rc != 0
    assert not wav.with_suffix(".transcript.txt").exists()
    events = json.loads(queue.read_text(encoding="utf-8"))
    assert events == []
