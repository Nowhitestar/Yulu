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


def test_clean_dual_track_uses_original_meeting_half_duplex_fade(tmp_path):
    wav = tmp_path / "Meeting_20260609_120000.wav"
    out = tmp_path / "Meeting_20260609_120000.clean.wav"
    active = [(300, 4000)] * 4800
    silent = [(5000, 0)] * 96000
    _write_dual_track(wav, active + silent)

    clean_dual_track_to_mono(wav, out)

    samples = _read_mono(out)
    assert len(samples) == len(active) + len(silent)
    assert max(samples[:4800]) <= 4100
    assert max(samples[:4800]) >= 3900
    # Do not hard-switch to the mic at the first silent frame; old meeting
    # capture fades the microphone in over roughly one second.
    assert abs(samples[4800]) < 300
    assert max(samples[-4800:]) >= 4900


def test_select_transcription_audio_generates_clean_file_for_dual_track(tmp_path):
    wav = tmp_path / "Meeting_20260609_120000.wav"
    _write_dual_track(wav, [(300, 4000)] * 960)

    selected = select_transcription_audio(wav, {"echo_cancel_dual_track": True})

    assert selected == wav.with_suffix(".clean.wav")
    assert selected.exists()
