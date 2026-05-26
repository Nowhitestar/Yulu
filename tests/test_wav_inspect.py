"""Unit tests for stt_daemon.wav_inspect.WavLayout classifier.

Generates synthetic WAV byte streams (RIFF / fmt / optional LIST-INFO / data)
rather than producing audio — the classifier only inspects header bytes."""

from __future__ import annotations

import struct
import sys
import wave
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.wav_inspect import WavLayout, classify, DUAL_TRACK_MARKER


def _write_mono(path: Path, n_samples: int = 16) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(48000)
        w.writeframes(b"\x00\x00" * n_samples)


def _write_plain_stereo(path: Path, n_frames: int = 16) -> None:
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(48000)
        w.writeframes(b"\x00\x00\x00\x00" * n_frames)


def _write_stereo_with_marker(path: Path, marker: bytes = DUAL_TRACK_MARKER,
                              n_frames: int = 16) -> None:
    """Hand-write a RIFF/WAVE file: RIFF + fmt + LIST-INFO-ICMT + data."""
    pcm = b"\x00\x00\x00\x00" * n_frames

    # fmt chunk (PCM stereo 48kHz 16-bit)
    fmt = struct.pack("<HHIIHH", 1, 2, 48000, 48000 * 2 * 2, 4, 16)
    fmt_chunk = b"fmt " + struct.pack("<I", len(fmt)) + fmt

    # ICMT subchunk: id (4) + size (4) + payload (must be word-aligned)
    payload = marker + b"\x00"  # null terminator
    if len(payload) % 2:
        payload += b"\x00"
    icmt = b"ICMT" + struct.pack("<I", len(payload)) + payload

    # LIST chunk: id (4) + size (4) + form-type (4=INFO) + subchunks
    list_body = b"INFO" + icmt
    list_chunk = b"LIST" + struct.pack("<I", len(list_body)) + list_body

    data_chunk = b"data" + struct.pack("<I", len(pcm)) + pcm

    body = b"WAVE" + fmt_chunk + list_chunk + data_chunk
    riff = b"RIFF" + struct.pack("<I", len(body)) + body
    path.write_bytes(riff)


def test_classify_mono(tmp_path):
    p = tmp_path / "mono.wav"
    _write_mono(p)
    assert classify(p) is WavLayout.MONO


def test_classify_legacy_stereo_no_info_chunk(tmp_path):
    p = tmp_path / "legacy.wav"
    _write_plain_stereo(p)
    assert classify(p) is WavLayout.LEGACY_STEREO


def test_classify_dual_track_marker(tmp_path):
    p = tmp_path / "dt.wav"
    _write_stereo_with_marker(p)
    assert classify(p) is WavLayout.DUAL_TRACK


def test_classify_unknown_info_value_is_legacy(tmp_path):
    p = tmp_path / "other_info.wav"
    _write_stereo_with_marker(p, marker=b"Some Other Recorder v3")
    assert classify(p) is WavLayout.LEGACY_STEREO


def test_classify_nonexistent_raises(tmp_path):
    import pytest
    with pytest.raises(FileNotFoundError):
        classify(tmp_path / "missing.wav")


def test_classify_truncated_file_returns_legacy_stereo(tmp_path):
    """A 12-byte header-only file should not crash — degrade gracefully."""
    p = tmp_path / "trunc.wav"
    p.write_bytes(b"RIFF\x00\x00\x00\x00WAVE")
    # No fmt → channels stays None → falls through to LEGACY_STEREO so the
    # caller treats it as opaque and downmixes/skips. Deterministic.
    assert classify(p) is WavLayout.LEGACY_STEREO


def test_classify_marker_after_data_is_missed_by_design(tmp_path):
    """Documents that classify() stops at the data chunk — a writer that puts
    LIST/INFO/ICMT *after* data will be silently classified as LEGACY_STEREO.

    Yulu's WavWriter always writes INFO before data, so this is fine. The test
    exists to catch future writer-side changes that would break the contract:
    if someone moves the INFO chunk after data, this test still passes (proving
    nothing changed in classify), but a sibling end-to-end test would fail
    because real recordings would lose their DUAL_TRACK identity."""
    import struct as _s
    pcm = b"\x00\x00\x00\x00" * 16
    fmt = _s.pack("<HHIIHH", 1, 2, 48000, 48000 * 2 * 2, 4, 16)
    fmt_chunk = b"fmt " + _s.pack("<I", len(fmt)) + fmt
    data_chunk = b"data" + _s.pack("<I", len(pcm)) + pcm
    # ICMT after data
    payload = DUAL_TRACK_MARKER + b"\x00"
    icmt = b"ICMT" + _s.pack("<I", len(payload)) + payload
    list_body = b"INFO" + icmt
    list_chunk = b"LIST" + _s.pack("<I", len(list_body)) + list_body

    body = b"WAVE" + fmt_chunk + data_chunk + list_chunk
    riff = b"RIFF" + _s.pack("<I", len(body)) + body
    p = tmp_path / "marker_after_data.wav"
    p.write_bytes(riff)

    assert classify(p) is WavLayout.LEGACY_STEREO
