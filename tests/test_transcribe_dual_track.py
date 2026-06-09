"""Integration test: transcribe.process_audio against a dual-track WAV writes
all three transcript files and enqueues 2 events with the correct snapshots."""

import json
import struct
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import transcribe


def _write_dual_track(path: Path):
    pcm = b"\x00\x00\x00\x00" * 64
    body = bytearray()
    body += b"RIFF" + struct.pack("<I", 0) + b"WAVE"
    body += b"fmt " + struct.pack("<I", 16) + struct.pack("<HHIIHH", 1, 2, 48000, 192000, 4, 16)
    body += b"LIST" + struct.pack("<I", 30) + b"INFO" + b"ICMT" + struct.pack("<I", 18) + b"Yulu DualTrack v1\x00"
    body += b"data" + struct.pack("<I", len(pcm)) + pcm
    body[4:8] = struct.pack("<I", len(body) - 8)
    path.write_bytes(bytes(body))


@pytest.fixture
def isolated_paths(tmp_path, monkeypatch):
    queue = tmp_path / "queue.json"
    prompts = tmp_path / "prompts.sqlite"
    monkeypatch.setattr(transcribe, "AGENT_QUEUE_PATH", queue)
    monkeypatch.setattr(transcribe, "PROMPTS_DB", prompts)

    # Seed prompts so cache.auto_run returns real entries
    from prompts.db import PromptsRepo, open_db
    from prompts.seed import seed_from_current
    repo = PromptsRepo(open_db(prompts))
    seed_from_current(repo)
    return queue, prompts


def test_dual_track_writes_three_transcripts_and_enqueues_two(isolated_paths, tmp_path, monkeypatch):
    queue, prompts = isolated_paths
    wav = tmp_path / "TestMeeting_20260522_120000.wav"
    _write_dual_track(wav)

    # Stub config so process_audio doesn't try to read ~/.config/yulu/config.json.
    monkeypatch.setattr(transcribe, "load_config", lambda: {"transcription": {"language": "zh", "echo_cancel_dual_track": False}})

    # Fake the daemon response — return dual-track shape with both channels
    fake_response = {
        "status": "ok",
        "layout": "dual_track",
        "channels": {
            "mic": {
                "text": "你好",
                "segments": [{"start": 0.0, "end": 1.0, "text": "你好"}],
            },
            "sys": {
                "text": "hi there",
                "segments": [{"start": 0.5, "end": 1.5, "text": "hi there"}],
            },
        },
    }
    with patch.object(transcribe, "_request_final_transcribe_raw", return_value=fake_response):
        transcribe.process_audio(str(wav))

    mic = wav.with_suffix(".mic.transcript.txt").read_text(encoding="utf-8")
    sys_ = wav.with_suffix(".sys.transcript.txt").read_text(encoding="utf-8")
    merged = wav.with_suffix(".transcript.txt").read_text(encoding="utf-8")
    raw = wav.with_suffix(".raw.transcript.txt").read_text(encoding="utf-8")

    assert mic == "你好"
    assert sys_ == "hi there"
    assert "[00:00 我] 你好" in merged
    assert "[00:00 对方] hi there" in merged
    # raw mirrors the merged transcript (pre-cleanup snapshot)
    assert raw == merged

    events = json.loads(queue.read_text())
    assert len(events) == 2
    slugs = sorted(e["prompt_slug"] for e in events)
    assert slugs == ["summary", "transcript-cleanup"]


def test_legacy_mono_falls_back_to_single_transcript(isolated_paths, tmp_path, monkeypatch):
    queue, prompts = isolated_paths
    wav = tmp_path / "OldMono_20260101_120000.wav"
    import wave
    with wave.open(str(wav), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000)
        w.writeframes(b"\x00\x00" * 100)

    monkeypatch.setattr(transcribe, "load_config", lambda: {"transcription": {"language": "zh"}})

    fake_response = {
        "status": "ok",
        "layout": "mono",
        "text": "legacy text",
        "segments": [{"start": 0.0, "end": 1.0, "text": "legacy text"}],
    }
    with patch.object(transcribe, "_request_final_transcribe_raw", return_value=fake_response):
        transcribe.process_audio(str(wav))

    merged = wav.with_suffix(".transcript.txt").read_text(encoding="utf-8")
    raw = wav.with_suffix(".raw.transcript.txt").read_text(encoding="utf-8")
    assert merged == "legacy text"
    assert raw == "legacy text"
    assert not wav.with_suffix(".mic.transcript.txt").exists()
    assert not wav.with_suffix(".sys.transcript.txt").exists()
