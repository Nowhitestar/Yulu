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
    pcm = b"\x00\x00\x00\x00" * 64
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
