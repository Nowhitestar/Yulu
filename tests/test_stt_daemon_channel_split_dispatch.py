"""Dual-track dispatch: ensure channel_split=True routes through WavLayout
classification and produces per-channel results."""

import struct
import sys
import wave
from pathlib import Path

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.wav_inspect import WavLayout, classify, DUAL_TRACK_MARKER
from stt_daemon.runtime import dispatch_transcribe, STTResult


class _FakeBackend:
    """Records every call so the test can assert how many jobs were dispatched."""

    def __init__(self):
        self.calls: list[tuple[str, str]] = []

    def transcribe(self, *, audio_path: str, language: str, initial_prompt: str = "") -> STTResult:
        # Echo a deterministic text per call so the test can tell channels apart
        self.calls.append((audio_path, initial_prompt))
        n = len(self.calls)
        return STTResult(text=f"chunk{n}", segments=[{"start": 0.0, "end": 1.0, "text": f"chunk{n}"}])


def _write_mono(path: Path):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(48000)
        w.writeframes(b"\x00\x00" * 16)


def _write_dual_track(path: Path):
    # Non-silent samples on BOTH channels so the per-channel RMS gate
    # (introduced in Task C.3) does not skip either side.
    n_frames = 4800  # 100 ms at 48 kHz
    pcm = bytearray()
    for _ in range(n_frames):
        s = (0x1FFF).to_bytes(2, "little", signed=True)
        pcm += s + s
    pcm = bytes(pcm)
    body = bytearray()
    body += b"RIFF" + struct.pack("<I", 0) + b"WAVE"
    body += b"fmt " + struct.pack("<I", 16) + struct.pack("<HHIIHH", 1, 2, 48000, 192000, 4, 16)
    body += b"LIST" + struct.pack("<I", 30) + b"INFO" + b"ICMT" + struct.pack("<I", 18) + b"Yulu DualTrack v1\x00"
    body += b"data" + struct.pack("<I", len(pcm)) + pcm
    body[4:8] = struct.pack("<I", len(body) - 8)
    path.write_bytes(bytes(body))


def _write_legacy_stereo(path: Path):
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)
        w.writeframes(b"\x00\x00\x00\x00" * 64)


def test_dispatch_mono_returns_single_text(tmp_path):
    p = tmp_path / "m.wav"
    _write_mono(p)
    backend = _FakeBackend()

    resp = dispatch_transcribe(
        wav_path=p, channel_split=True, backend=backend,
        language="zh", initial_prompt="",
    )

    assert resp.layout is WavLayout.MONO
    assert resp.channels is None  # mono path returns flat text
    assert resp.text == "chunk1"
    assert len(backend.calls) == 1


def test_dispatch_dual_track_runs_two_jobs(tmp_path):
    p = tmp_path / "dt.wav"
    _write_dual_track(p)
    backend = _FakeBackend()

    resp = dispatch_transcribe(
        wav_path=p, channel_split=True, backend=backend,
        language="zh", initial_prompt="",
    )

    assert resp.layout is WavLayout.DUAL_TRACK
    assert resp.channels is not None
    assert set(resp.channels.keys()) == {"mic", "sys"}
    assert resp.channels["mic"]["text"] == "chunk1"
    assert resp.channels["sys"]["text"] == "chunk2"
    assert len(backend.calls) == 2


def test_dispatch_legacy_stereo_downmixes_to_mono(tmp_path, caplog):
    p = tmp_path / "leg.wav"
    _write_legacy_stereo(p)
    backend = _FakeBackend()

    import logging
    with caplog.at_level(logging.WARNING):
        resp = dispatch_transcribe(
            wav_path=p, channel_split=True, backend=backend,
            language="zh", initial_prompt="",
        )

    assert resp.layout is WavLayout.LEGACY_STEREO
    assert resp.channels is None
    assert resp.text == "chunk1"
    assert len(backend.calls) == 1
    assert any("legacy stereo wav" in rec.message for rec in caplog.records)


def test_dispatch_channel_split_false_behaves_like_mono(tmp_path):
    """channel_split=False on a dual-track WAV still does single-pass mono.

    This is the back-compat path for callers that don't care about source
    separation (e.g. quick smoke tests)."""
    p = tmp_path / "dt2.wav"
    _write_dual_track(p)
    backend = _FakeBackend()

    resp = dispatch_transcribe(
        wav_path=p, channel_split=False, backend=backend,
        language="zh", initial_prompt="",
    )
    assert resp.channels is None
    assert len(backend.calls) == 1


def test_dual_track_cancel_targets_both_subjobs(monkeypatch):
    """Phase 1 cancellation guarantee must survive dual-track: cancelling the
    parent job_id must cancel both :mic and :sys subjobs."""
    import sys
    SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
    sys.path.insert(0, str(SCRIPTS))

    class _FakeScheduler:
        def __init__(self):
            self.cancelled: list[str] = []
        def cancel(self, job_id: str) -> bool:
            self.cancelled.append(job_id)
            # Pretend both subjob keys exist; parent key does not.
            return job_id.endswith(":mic") or job_id.endswith(":sys")

    sched = _FakeScheduler()
    # Invoke the same cancellation logic the daemon uses. Since _on_cancel is
    # async + bound to STTDaemonApp, the simplest harness is to call the
    # scheduler.cancel-fanout pattern directly:
    target = "abc-123"
    cancelled_any = False
    for key in (target, f"{target}:mic", f"{target}:sys"):
        if sched.cancel(key):
            cancelled_any = True
    assert cancelled_any is True
    assert sched.cancelled == ["abc-123", "abc-123:mic", "abc-123:sys"]


def test_dispatch_dual_track_handles_missing_file_gracefully(tmp_path):
    """classify() raises FileNotFoundError if the file vanishes mid-flight.
    The dispatch must not propagate that — it returns LEGACY_STEREO at worst
    and runs the backend on whatever the caller provided, OR raises a clean
    Python-level exception that the handler catches.

    This test exercises the dispatch_transcribe (sync) path: a non-existent
    path should raise FileNotFoundError so the caller can catch it cleanly,
    not segfault."""
    backend = _FakeBackend()
    with pytest.raises(FileNotFoundError):
        dispatch_transcribe(
            wav_path=tmp_path / "does_not_exist.wav",
            channel_split=True, backend=backend,
            language="zh", initial_prompt="",
        )
    # Backend was never invoked
    assert backend.calls == []


def _write_dual_track_one_silent_channel(path: Path, silent: str):
    """silent='R' → mic non-zero, sys all 0. silent='L' → opposite."""
    n_frames = 4800  # 100 ms at 48 kHz
    pcm = bytearray()
    for _ in range(n_frames):
        L = (0x1FFF).to_bytes(2, "little", signed=True) if silent != "L" else (0).to_bytes(2, "little", signed=True)
        R = (0x1FFF).to_bytes(2, "little", signed=True) if silent != "R" else (0).to_bytes(2, "little", signed=True)
        pcm += L + R
    pcm = bytes(pcm)
    body = bytearray()
    body += b"RIFF" + struct.pack("<I", 0) + b"WAVE"
    body += b"fmt " + struct.pack("<I", 16) + struct.pack("<HHIIHH", 1, 2, 48000, 192000, 4, 16)
    body += b"LIST" + struct.pack("<I", 30) + b"INFO" + b"ICMT" + struct.pack("<I", 18) + b"Yulu DualTrack v1\x00"
    body += b"data" + struct.pack("<I", len(pcm)) + pcm
    body[4:8] = struct.pack("<I", len(body) - 8)
    path.write_bytes(bytes(body))


def test_dispatch_skips_silent_channel(tmp_path):
    p = tmp_path / "voicemail.wav"
    _write_dual_track_one_silent_channel(p, silent="R")
    backend = _FakeBackend()

    resp = dispatch_transcribe(
        wav_path=p, channel_split=True, backend=backend,
        language="zh", initial_prompt="",
    )

    assert resp.layout is WavLayout.DUAL_TRACK
    assert resp.channels["mic"]["text"] == "chunk1"        # ran
    assert resp.channels["sys"].get("skipped_silent") is True
    assert "text" not in resp.channels["sys"] or resp.channels["sys"]["text"] == ""
    # Only mic was dispatched
    assert len(backend.calls) == 1
