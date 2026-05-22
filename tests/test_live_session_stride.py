"""LiveSession stride extraction — read alternating Int16 samples from a
single stereo WAV instead of from two sidecar files."""

import struct
import sys
import wave
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.live_session import LiveSession, TailState


def test_livesession_accepts_stride_params():
    spec = LiveSession(
        sid="s1",
        mic_path="/tmp/x.wav",
        sys_path="/tmp/x.wav",      # same path
        engine="mlx",
        language="zh",
        mic_stride_offset=0,
        sys_stride_offset=2,
        stride_step=4,
    )
    assert spec.mic_stride_offset == 0
    assert spec.sys_stride_offset == 2
    assert spec.stride_step == 4


def test_livesession_defaults_to_separate_file_mode():
    """When stride_step=1 (default), behave exactly like Phase 1: mic_path and
    sys_path are separate mono WAVs, no stride extraction."""
    spec = LiveSession(
        sid="s1", mic_path="/tmp/a.wav", sys_path="/tmp/b.wav",
        engine="mlx", language="zh",
    )
    assert spec.stride_step == 1


def test_read_pending_extracts_mic_with_stride(tmp_path):
    """Smoke-level: synthesize a tiny stereo WAV with L=0x1111, R=0x2222,
    then verify the stride-extracted mic chunk WAV contains only L samples."""
    from stt_daemon.live_session import _read_with_stride  # new helper

    p = tmp_path / "stereo.wav"
    n_frames = 96000  # 2 seconds at 48 kHz
    with wave.open(str(p), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(48000)
        frame = struct.pack("<hh", 0x1111, 0x2222)
        w.writeframes(frame * n_frames)

    out = tmp_path / "mic_chunk.wav"
    _read_with_stride(
        path=p, out_path=out,
        start_byte=44,
        end_byte=44 + n_frames * 4,
        stride_offset=0,
        stride_step=4,
        sample_width=2,
        framerate=48000,
    )
    with wave.open(str(out), "rb") as r:
        assert r.getnchannels() == 1
        samples = r.readframes(r.getnframes())
    # Every Int16 should be 0x1111
    for i in range(0, len(samples), 2):
        assert int.from_bytes(samples[i : i + 2], "little", signed=True) == 0x1111
