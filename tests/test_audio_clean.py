import struct
import sys
import wave
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from audio_clean import clean_dual_track_to_mono, select_transcription_audio


def _write_dual_track(path: Path, frames: list[tuple[int, int]]) -> None:
    pcm = bytearray()
    for mic, sys_ in frames:
        pcm += struct.pack("<hh", mic, sys_)
    body = bytearray()
    body += b"RIFF" + struct.pack("<I", 0) + b"WAVE"
    body += b"fmt " + struct.pack("<I", 16) + struct.pack("<HHIIHH", 1, 2, 48000, 192000, 4, 16)
    body += b"LIST" + struct.pack("<I", 30) + b"INFO" + b"ICMT" + struct.pack("<I", 18) + b"Yulu DualTrack v1\x00"
    body += b"data" + struct.pack("<I", len(pcm)) + pcm
    body[4:8] = struct.pack("<I", len(body) - 8)
    path.write_bytes(bytes(body))


def _read_mono(path: Path) -> list[int]:
    with wave.open(str(path), "rb") as w:
        raw = w.readframes(w.getnframes())
    return [v[0] for v in struct.iter_unpack("<h", raw)]


def test_clean_dual_track_keeps_boosted_mic_in_playback_mix(tmp_path):
    wav = tmp_path / "Meeting_20260609_120000.wav"
    out = tmp_path / "Meeting_20260609_120000.clean.wav"
    active = [(300, 4000)] * 4800
    silent = [(5000, 0)] * 96000
    _write_dual_track(wav, active + silent)

    clean_dual_track_to_mono(wav, out)

    samples = _read_mono(out)
    assert len(samples) == len(active) + len(silent)
    assert max(samples[:4800]) <= 4100
    assert max(samples[:4800]) >= 3700
    # Let mic-only sections come through at an audible boosted level once
    # system playback is no longer active.
    assert max(samples[-4800:]) >= 11000


def test_clean_dual_track_suppresses_mic_leak_when_system_audio_is_active(tmp_path):
    wav = tmp_path / "Meeting_20260609_120000.wav"
    out = tmp_path / "Meeting_20260609_120000.clean.wav"
    # Speaker playback leaks into the mic at a lower level than the direct
    # system channel. The clean mix should stay close to system-only audio,
    # not add the delayed mic leak as an audible echo.
    _write_dual_track(wav, [(2500, 4000)] * 4800)

    clean_dual_track_to_mono(wav, out)

    samples = _read_mono(out)
    assert max(samples) <= 3770


def test_clean_dual_track_prefers_no_echo_over_local_overlap(tmp_path):
    wav = tmp_path / "Meeting_20260609_120000.wav"
    out = tmp_path / "Meeting_20260609_120000.clean.wav"
    # While system audio is active, even a loud mic track may be speaker leak
    # from playback. Favor no echo over preserving overlapping local speech.
    _write_dual_track(wav, [(9000, 4000)] * 4800)

    clean_dual_track_to_mono(wav, out)

    samples = _read_mono(out)
    assert max(samples) <= 3770


def test_clean_dual_track_holds_mic_after_system_audio_to_suppress_delayed_leak(tmp_path):
    wav = tmp_path / "Meeting_20260609_120000.wav"
    out = tmp_path / "Meeting_20260609_120000.clean.wav"
    active = [(0, 4000)] * 5760
    delayed_leak = [(3000, 0)] * 23040
    quiet = [(0, 0)] * 16800
    local_after_hold = [(5000, 0)] * 9600
    _write_dual_track(wav, active + delayed_leak + quiet + local_after_hold)

    clean_dual_track_to_mono(wav, out)

    samples = _read_mono(out)
    leak_start = len(active)
    leak_end = leak_start + len(delayed_leak)
    assert max(abs(s) for s in samples[leak_start:leak_end]) <= 100
    assert max(abs(s) for s in samples[-len(local_after_hold):]) >= 1000


def test_select_transcription_audio_generates_clean_file_for_dual_track(tmp_path):
    wav = tmp_path / "Meeting_20260609_120000.wav"
    _write_dual_track(wav, [(300, 4000)] * 960)

    selected = select_transcription_audio(wav, {"echo_cancel_dual_track": True})

    assert selected == wav.with_suffix(".clean.wav")
    assert selected.exists()
