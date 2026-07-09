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


def test_dual_track_uses_original_file_for_channel_split_transcribe(isolated_paths, tmp_path, monkeypatch):
    queue, prompts = isolated_paths
    wav = tmp_path / "TestMeeting_20260522_120000.wav"
    _write_dual_track(wav)
    seen_paths: list[Path] = []

    monkeypatch.setattr(transcribe, "load_config", lambda: {"transcription": {"language": "zh"}})

    def fake_request(audio_path, trans_cfg, meeting_title, **_kwargs):
        seen_paths.append(audio_path)
        return {
            "status": "ok",
            "layout": "dual_track",
            "channels": {
                "mic": {"text": "你好", "segments": [{"start": 0.0, "end": 1.0, "text": "你好"}]},
                "sys": {"text": "hi", "segments": [{"start": 0.5, "end": 1.5, "text": "hi"}]},
            },
        }

    with patch.object(transcribe, "_request_final_transcribe", side_effect=fake_request):
        transcribe.process_audio(str(wav))

    assert wav.with_suffix(".clean.wav").exists()
    assert seen_paths == [wav]


def test_dual_track_filters_obvious_non_meeting_hallucination(isolated_paths, tmp_path, monkeypatch):
    queue, prompts = isolated_paths
    wav = tmp_path / "TestMeeting_20260522_120000.wav"
    _write_dual_track(wav)

    monkeypatch.setattr(transcribe, "load_config", lambda: {"transcription": {"language": "zh", "echo_cancel_dual_track": False}})

    fake_response = {
        "status": "ok",
        "layout": "dual_track",
        "channels": {
            "mic": {
                "text": "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目Can you hear me, Danny?Can you hear me, Danny?你好",
                "segments": [
                    {"start": 0.0, "end": 1.0, "text": "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目"},
                    {"start": 1.0, "end": 2.0, "text": "Can you hear me, Danny?"},
                    {"start": 4.0, "end": 5.0, "text": "Can you hear me, Danny?"},
                    {"start": 6.0, "end": 7.0, "text": "ぜひぜひぜひぜぜぜぜぜぜぜぜぜぜぜぜぜぜぜ"},
                    {"start": 7.0, "end": 8.0, "text": "你好"},
                ],
            },
            "sys": {"text": "", "segments": []},
        },
    }
    with patch.object(transcribe, "_request_final_transcribe_raw", return_value=fake_response):
        transcribe.process_audio(str(wav))

    raw = wav.with_suffix(".raw.transcript.txt").read_text(encoding="utf-8")
    mic = wav.with_suffix(".mic.transcript.txt").read_text(encoding="utf-8")
    assert "请不吝点赞" not in raw
    assert "请不吝点赞" not in mic
    assert "ぜひ" not in raw
    assert raw.count("Can you hear me, Danny?") == 1
    assert "[00:07 我] 你好" in raw
    assert mic == "Can you hear me, Danny? 你好"


def test_dual_track_suppresses_overlapping_mic_speaker_leakage(isolated_paths, tmp_path, monkeypatch):
    queue, prompts = isolated_paths
    wav = tmp_path / "TestMeeting_20260522_120000.wav"
    _write_dual_track(wav)

    monkeypatch.setattr(transcribe, "load_config", lambda: {"transcription": {"language": "zh", "echo_cancel_dual_track": False}})

    fake_response = {
        "status": "ok",
        "layout": "dual_track",
        "channels": {
            "mic": {
                "text": "介绍一下我们公司Lattice Trading 你是在新加坡吗",
                "segments": [
                    {"start": 0.0, "end": 2.0, "text": "介绍一下我们公司Lattice Trading"},
                    {"start": 3.0, "end": 4.0, "text": "你是在新加坡吗"},
                ],
            },
            "sys": {
                "text": "介绍一下我们公司Lattice Trading",
                "segments": [
                    {"start": 0.2, "end": 2.1, "text": "介绍一下我们公司Lattice Trading"},
                ],
            },
        },
    }
    with patch.object(transcribe, "_request_final_transcribe_raw", return_value=fake_response):
        transcribe.process_audio(str(wav))

    raw = wav.with_suffix(".raw.transcript.txt").read_text(encoding="utf-8")
    mic = wav.with_suffix(".mic.transcript.txt").read_text(encoding="utf-8")
    assert "[00:00 我] 介绍一下我们公司Lattice Trading" not in raw
    assert "[00:00 对方] 介绍一下我们公司Lattice Trading" in raw
    assert "[00:03 我] 你是在新加坡吗" in raw
    assert mic == "你是在新加坡吗"


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


def test_fast_summary_reuses_realtime_for_dual_track(isolated_paths, tmp_path, monkeypatch):
    queue, prompts = isolated_paths
    wav = tmp_path / "FastMeeting_20260522_120000.wav"
    _write_dual_track(wav)
    wav.with_suffix(".realtime.transcript.txt").write_text("live transcript", encoding="utf-8")

    monkeypatch.setattr(
        transcribe,
        "load_config",
        lambda: {"transcription": {"language": "zh", "post_recording_mode": "fast_summary"}},
    )

    with patch.object(transcribe, "_request_final_transcribe_raw", side_effect=AssertionError("final STT should not run")):
        transcribe.process_audio(str(wav))

    assert wav.with_suffix(".transcript.txt").read_text(encoding="utf-8") == "live transcript"
    assert wav.with_suffix(".raw.transcript.txt").read_text(encoding="utf-8") == "live transcript"
    events = json.loads(queue.read_text())
    assert sorted(e["prompt_slug"] for e in events) == ["summary", "transcript-cleanup"]
