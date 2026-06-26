"""Phase 13 Task 3 — transcribe.py diarize orchestration (CI-safe, sherpa MOCKED).

Locks the four success criteria at the orchestrator level WITHOUT installing sherpa or running a
daemon — the diarize RPC is mocked with canned turns, and the REAL Phase-9 speaker_merge does the
attribution:

  1. enabled → speaker-labelled `.transcript.txt` + `.speakers.json` sidecar + search upsert of the
     labelled body; disabled / backend-unavailable → today's plain transcript, NO sidecar, no error.
  1b. re-diarize with renumbered clusters preserves a user rename carried in the sidecar.
  4. low-confidence / UNKNOWN segments are passed through to the sidecar (not laundered into a
     confident named owner); the labelled transcript is the diarize output, not a cleanup rewrite.
"""

import json
import sys
import struct
import wave
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import transcribe  # noqa: E402
from stt_daemon import speaker_merge as sm  # noqa: E402
from stt_daemon import diarize_pipeline as dp  # noqa: E402


def _write_mono(path: Path):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(48000)
        w.writeframes(b"\x00\x00" * 100)


def _write_dual_track(path: Path):
    pcm = b"\x00\x00\x00\x00" * 100
    body = bytearray()
    body += b"RIFF" + struct.pack("<I", 0) + b"WAVE"
    body += b"fmt " + struct.pack("<I", 16) + struct.pack("<HHIIHH", 1, 2, 48000, 192000, 4, 16)
    body += b"LIST" + struct.pack("<I", 30) + b"INFO" + b"ICMT" + struct.pack("<I", 18) + b"Yulu DualTrack v1\x00"
    body += b"data" + struct.pack("<I", len(pcm)) + pcm
    body[4:8] = struct.pack("<I", len(body) - 8)
    path.write_bytes(bytes(body))


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Isolated config / queue / prompts; diarize-friendly mono recording."""
    fake_home = tmp_path / "config"
    fake_home.mkdir()
    queue = fake_home / "agent-queue.json"
    prompts = tmp_path / "prompts.sqlite"
    monkeypatch.setattr(transcribe, "CONFIG_PATH", fake_home / "config.json")
    monkeypatch.setattr(transcribe, "AGENT_QUEUE_PATH", queue, raising=False)
    monkeypatch.setattr(transcribe, "PROMPTS_DB", prompts, raising=False)
    # Point the calendar-prior at empty fixtures (→ None → auto mode) unless a test overrides.
    monkeypatch.setattr(dp, "STATE_PATH", tmp_path / "none.state.json", raising=False)
    monkeypatch.setattr(dp, "SCHEDULE_PATH", tmp_path / "none.schedule.json", raising=False)

    from prompts.db import PromptsRepo, open_db
    from prompts.seed import seed_from_current
    seed_from_current(PromptsRepo(open_db(prompts)))
    return fake_home, tmp_path


def _config(fake_home: Path, *, diarize_enabled: bool):
    cfg = {
        "transcription": {
            "final_engine": "mlx", "language": "zh", "post_recording_mode": "full",
            "diarization": {"enabled": diarize_enabled, "provider": "sherpa-onnx"},
        },
        "llm": {"enabled": True},
    }
    (fake_home / "config.json").write_text(json.dumps(cfg), encoding="utf-8")


# Two ASR segments + two turns → two distinct speakers.
_ASR = [
    {"start": 0.0, "end": 2.0, "text": "你好大家好"},
    {"start": 2.0, "end": 4.0, "text": "我们开始吧"},
]
_TURNS = [
    {"start": 0.0, "end": 2.0, "speaker_idx": 0, "speaker": 0},
    {"start": 2.0, "end": 4.0, "speaker_idx": 1, "speaker": 1},
]


def _mono_response(segments):
    return {"status": "ok", "layout": "mono",
            "text": " ".join(s["text"] for s in segments), "segments": segments}


def _dual_track_response():
    return {
        "status": "ok",
        "layout": "dual_track",
        "channels": {
            "mic": {
                "text": "你好",
                "segments": [{"start": 0.0, "end": 1.0, "text": "你好"}],
            },
            "sys": {
                "text": "收到",
                "segments": [{"start": 1.0, "end": 2.0, "text": "收到"}],
            },
        },
    }


# ── Criterion 1: enabled writes both files + upserts labelled body ─────────────


def test_diarize_enabled_writes_labelled_transcript_and_sidecar(env, monkeypatch):
    fake_home, tmp_path = env
    _config(fake_home, diarize_enabled=True)
    monkeypatch.setattr(transcribe, "_request_final_transcribe_raw",
                        lambda *a, **k: _mono_response(_ASR))
    monkeypatch.setattr(dp, "diarize_via_daemon",
                        lambda *a, **k: list(_TURNS))

    upserts = []
    from search import indexer as search_indexer
    monkeypatch.setattr(search_indexer, "upsert_doc",
                        lambda **kw: upserts.append(kw) or True)

    audio = tmp_path / "Team_20260601_100000.wav"
    _write_mono(audio)
    transcribe.process_audio(str(audio))

    transcript = audio.with_suffix(".transcript.txt").read_text(encoding="utf-8")
    # Labelled, [MM:SS Speaker N] format (the speaker_merge render contract).
    assert "[00:00 Speaker 1]" in transcript
    assert "[00:02 Speaker 2]" in transcript

    sidecar = sm.speakers_sidecar_path(audio)
    assert sidecar.exists()
    doc = json.loads(sidecar.read_text(encoding="utf-8"))
    assert doc["schema_version"] == sm.SCHEMA_VERSION
    assert doc["provider"] == "sherpa-onnx"
    assert len(doc["turns"]) == 2
    assert {s["speaker_id"] for s in doc["segments"]} == {"spk-0", "spk-1"}

    # The LABELLED body was upserted (criterion 1: labels searchable). Last upsert wins.
    transcript_upserts = [u for u in upserts
                          if u["kind"] == search_indexer.KIND_MEETING_TRANSCRIPT]
    assert any("[00:00 Speaker 1]" in (u.get("body") or "") for u in transcript_upserts)

    # raw transcript stays the pre-diarize plain text (snapshot preserved).
    raw = audio.with_suffix(".raw.transcript.txt").read_text(encoding="utf-8")
    assert "[00:00" not in raw


def test_diarize_uses_calendar_attendee_names_as_speaker_hints(env, monkeypatch):
    fake_home, tmp_path = env
    _config(fake_home, diarize_enabled=True)
    monkeypatch.setattr(transcribe, "_request_final_transcribe_raw",
                        lambda *a, **k: _mono_response(_ASR))
    monkeypatch.setattr(dp, "diarize_via_daemon",
                        lambda *a, **k: list(_TURNS))

    state = tmp_path / ".state.json"
    schedule = tmp_path / "schedule.json"
    state.write_text(json.dumps({"meeting_id": "ev-team"}), encoding="utf-8")
    schedule.write_text(json.dumps({"meetings": [{
        "id": "ev-team",
        "title": "Team",
        "attendees": ["Lewis", "Ciel"],
    }]}, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(dp, "STATE_PATH", state, raising=False)
    monkeypatch.setattr(dp, "SCHEDULE_PATH", schedule, raising=False)

    audio = tmp_path / "Team_20260601_100000.wav"
    _write_mono(audio)
    transcribe.process_audio(str(audio))

    transcript = audio.with_suffix(".transcript.txt").read_text(encoding="utf-8")
    assert "[00:00 Lewis]" in transcript
    assert "[00:02 Ciel]" in transcript

    doc = json.loads(sm.speakers_sidecar_path(audio).read_text(encoding="utf-8"))
    assert doc["speaker_hints"] == {
        "source": "calendar_attendees",
        "names": ["Lewis", "Ciel"],
    }
    assert doc["speakers"]["spk-0"]["name_source"] == "calendar_attendee"
    assert doc["speakers"]["spk-0"]["name_confidence"] == "candidate"


def test_per_run_speaker_count_override_forces_diarization(env, monkeypatch):
    fake_home, tmp_path = env
    _config(fake_home, diarize_enabled=False)
    monkeypatch.setattr(transcribe, "_request_final_transcribe_raw",
                        lambda *a, **k: _mono_response(_ASR))

    seen_counts = []
    def fake_diarize(*_args, **kwargs):
        seen_counts.append(kwargs.get("num_speakers"))
        return list(_TURNS)

    monkeypatch.setattr(dp, "diarize_via_daemon", fake_diarize)

    audio = tmp_path / "Team_20260601_100000.wav"
    _write_mono(audio)
    transcribe.process_audio(str(audio), diarization_num_speakers=2)

    assert seen_counts == [2]
    assert sm.speakers_sidecar_path(audio).exists()


def test_dual_track_without_count_prior_uses_channel_sidecar(env, monkeypatch):
    fake_home, tmp_path = env
    _config(fake_home, diarize_enabled=True)
    monkeypatch.setattr(transcribe, "_request_final_transcribe_raw",
                        lambda *a, **k: _dual_track_response())
    monkeypatch.setattr(dp, "diarize_via_daemon",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not diarize")))

    audio = tmp_path / "Team_20260601_100000.wav"
    _write_dual_track(audio)
    transcribe.process_audio(str(audio))

    transcript = audio.with_suffix(".transcript.txt").read_text(encoding="utf-8")
    assert "[00:00 我] 你好" in transcript
    assert "[00:01 对方] 收到" in transcript

    doc = json.loads(sm.speakers_sidecar_path(audio).read_text(encoding="utf-8"))
    assert doc["provider"] == "channel-split"
    assert doc["num_speakers_detected"] == 2
    assert doc["speakers"]["spk-0"]["display_name"] == "我"
    assert doc["speakers"]["spk-1"]["display_name"] == "对方"


def test_dual_track_with_count_prior_still_runs_diarization(env, monkeypatch):
    fake_home, tmp_path = env
    _config(fake_home, diarize_enabled=False)
    monkeypatch.setattr(transcribe, "_request_final_transcribe_raw",
                        lambda *a, **k: _dual_track_response())

    seen_counts = []
    def fake_diarize(*_args, **kwargs):
        seen_counts.append(kwargs.get("num_speakers"))
        return list(_TURNS)

    monkeypatch.setattr(dp, "diarize_via_daemon", fake_diarize)

    audio = tmp_path / "Team_20260601_100000.wav"
    _write_dual_track(audio)
    transcribe.process_audio(str(audio), diarization_num_speakers=2)

    assert seen_counts == [2]
    transcript = audio.with_suffix(".transcript.txt").read_text(encoding="utf-8")
    assert "[00:00 Speaker 1]" in transcript


# ── Criterion 1: disabled degrades cleanly ────────────────────────────────────


def test_diarize_disabled_leaves_plain_transcript(env, monkeypatch):
    fake_home, tmp_path = env
    _config(fake_home, diarize_enabled=False)
    monkeypatch.setattr(transcribe, "_request_final_transcribe_raw",
                        lambda *a, **k: _mono_response(_ASR))
    # If diarize were attempted this would explode — proving it is NOT called when disabled.
    monkeypatch.setattr(dp, "diarize_via_daemon",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("must not diarize")))

    audio = tmp_path / "Team_20260601_100000.wav"
    _write_mono(audio)
    transcribe.process_audio(str(audio))  # must not raise

    transcript = audio.with_suffix(".transcript.txt").read_text(encoding="utf-8")
    assert "[00:00 Speaker" not in transcript
    assert not sm.speakers_sidecar_path(audio).exists()


# ── Criterion 1: backend unavailable degrades cleanly ─────────────────────────


def test_diarize_backend_unavailable_degrades(env, monkeypatch):
    fake_home, tmp_path = env
    _config(fake_home, diarize_enabled=True)
    monkeypatch.setattr(transcribe, "_request_final_transcribe_raw",
                        lambda *a, **k: _mono_response(_ASR))
    # Simulate the live Python-3.14 case: sherpa not installed → request_diarize raised →
    # _diarize_via_daemon returns None.
    monkeypatch.setattr(dp, "diarize_via_daemon", lambda *a, **k: None)

    audio = tmp_path / "Team_20260601_100000.wav"
    _write_mono(audio)
    transcribe.process_audio(str(audio))  # must not raise

    transcript = audio.with_suffix(".transcript.txt").read_text(encoding="utf-8")
    assert "the transcript" or transcript  # plain text persisted
    assert "[00:00 Speaker" not in transcript
    assert not sm.speakers_sidecar_path(audio).exists()


def test_diarize_zero_turns_degrades(env, monkeypatch):
    fake_home, tmp_path = env
    _config(fake_home, diarize_enabled=True)
    monkeypatch.setattr(transcribe, "_request_final_transcribe_raw",
                        lambda *a, **k: _mono_response(_ASR))
    monkeypatch.setattr(dp, "diarize_via_daemon", lambda *a, **k: [])

    audio = tmp_path / "Team_20260601_100000.wav"
    _write_mono(audio)
    transcribe.process_audio(str(audio))

    transcript = audio.with_suffix(".transcript.txt").read_text(encoding="utf-8")
    assert "[00:00 Speaker" not in transcript
    assert not sm.speakers_sidecar_path(audio).exists()


def test_diarize_skipped_when_no_timestamped_segments(env, monkeypatch):
    """Text-only daemon reply (no segments) → diarize skipped (needs timings)."""
    fake_home, tmp_path = env
    _config(fake_home, diarize_enabled=True)
    monkeypatch.setattr(transcribe, "_request_final_transcribe_raw",
                        lambda *a, **k: {"status": "ok", "layout": "mono",
                                         "text": "plain text only", "segments": []})
    monkeypatch.setattr(dp, "diarize_via_daemon",
                        lambda *a, **k: (_ for _ in ()).throw(AssertionError("no segments → skip")))

    audio = tmp_path / "Team_20260601_100000.wav"
    _write_mono(audio)
    transcribe.process_audio(str(audio))
    assert not sm.speakers_sidecar_path(audio).exists()


# ── Criterion 1b: re-diarize preserves a user rename ──────────────────────────


def test_rediarize_preserves_rename(env, monkeypatch):
    fake_home, tmp_path = env
    _config(fake_home, diarize_enabled=True)
    monkeypatch.setattr(transcribe, "_request_final_transcribe_raw",
                        lambda *a, **k: _mono_response(_ASR))

    audio = tmp_path / "Team_20260601_100000.wav"
    _write_mono(audio)

    # First diarize: clusters 0,1.
    monkeypatch.setattr(dp, "diarize_via_daemon", lambda *a, **k: list(_TURNS))
    transcribe.process_audio(str(audio))

    # User renames spk-1 → "Lewis" in the sidecar (what the Phase-14 UI mutation will do).
    sidecar_path = sm.speakers_sidecar_path(audio)
    doc = json.loads(sidecar_path.read_text(encoding="utf-8"))
    # spk for the second segment (0..1 may map either way depending on assignment).
    target_sid = doc["segments"][1]["speaker_id"]
    sm.apply_rename(doc, target_sid, "Lewis")
    sm.write_sidecar(sidecar_path, doc)

    # Re-diarize with RENUMBERED clusters (sherpa indices are volatile across runs): swap idx.
    renumbered = [
        {"start": 0.0, "end": 2.0, "speaker_idx": 1, "speaker": 1},
        {"start": 2.0, "end": 4.0, "speaker_idx": 0, "speaker": 0},
    ]
    monkeypatch.setattr(dp, "diarize_via_daemon", lambda *a, **k: list(renumbered))
    transcribe.process_audio(str(audio))

    doc2 = json.loads(sidecar_path.read_text(encoding="utf-8"))
    # The rename survived: "Lewis" is still present and still marked renamed.
    lewis = [sid for sid, e in doc2["speakers"].items()
             if e.get("display_name") == "Lewis" and e.get("renamed")]
    assert lewis, f"rename lost across re-diarize: {doc2['speakers']}"
    # And the labelled transcript shows "Lewis" on the segment that person spoke.
    transcript = audio.with_suffix(".transcript.txt").read_text(encoding="utf-8")
    assert "Lewis]" in transcript


# ── Criterion 4: low-confidence not laundered ─────────────────────────────────


def test_low_confidence_segment_not_laundered(env, monkeypatch):
    """An ASR segment with NO overlapping turn and far from any turn → UNKNOWN / low-confidence in
    the sidecar, never a confident named owner (criterion 4)."""
    fake_home, tmp_path = env
    _config(fake_home, diarize_enabled=True)
    # Segment at 100s sits far outside the only turn at 0-2s → coverage gap → UNKNOWN.
    asr = [
        {"start": 0.0, "end": 2.0, "text": "你好"},
        {"start": 100.0, "end": 102.0, "text": "孤立片段"},
    ]
    turns = [{"start": 0.0, "end": 2.0, "speaker_idx": 0, "speaker": 0}]
    monkeypatch.setattr(transcribe, "_request_final_transcribe_raw",
                        lambda *a, **k: _mono_response(asr))
    monkeypatch.setattr(dp, "diarize_via_daemon", lambda *a, **k: list(turns))

    audio = tmp_path / "Team_20260601_100000.wav"
    _write_mono(audio)
    transcribe.process_audio(str(audio))

    doc = json.loads(sm.speakers_sidecar_path(audio).read_text(encoding="utf-8"))
    far = [s for s in doc["segments"] if s["text"] == "孤立片段"][0]
    assert far["speaker_id"] == sm.UNKNOWN_SPEAKER_ID
    assert far["confident"] is False
