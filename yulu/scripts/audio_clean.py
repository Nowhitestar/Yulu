#!/usr/bin/env python3
"""Playback/transcription-friendly audio derived from Yulu dual-track WAVs."""

from __future__ import annotations

import math
import struct
import wave
from pathlib import Path

from stt_daemon.wav_inspect import WavLayout, classify


def _rms_dbfs(samples: list[int]) -> float:
    if not samples:
        return -math.inf
    peak = 32767.0
    rms = math.sqrt(sum((s / peak) ** 2 for s in samples) / len(samples))
    return 20.0 * math.log10(rms) if rms > 0 else -math.inf


def _gain_to_target(samples: list[int], target_dbfs: float = -20.0) -> float:
    db = _rms_dbfs(samples)
    if not math.isfinite(db):
        return 1.0
    return max(0.1, min(10.0, 10 ** ((target_dbfs - db) / 20.0)))


def _clamp_i16(value: float) -> int:
    return int(max(-32768, min(32767, round(value))))


def clean_dual_track_to_mono(src: Path, dst: Path, *, frame_ms: int = 30) -> Path:
    """Write a mono WAV that avoids replaying system audio through the mic track."""
    with wave.open(str(src), "rb") as w:
        if w.getnchannels() != 2 or w.getsampwidth() != 2:
            raise ValueError("clean_dual_track_to_mono requires stereo s16 WAV")
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())

    pairs = list(struct.iter_unpack("<hh", raw))
    mic = [p[0] for p in pairs]
    sys = [p[1] for p in pairs]
    frame = max(1, int(sr * frame_ms / 1000))
    frame_db = [_rms_dbfs(sys[i:i + frame]) for i in range(0, len(sys), frame)]
    finite = sorted(v for v in frame_db if math.isfinite(v))
    noise = finite[max(0, int(len(finite) * 0.2) - 1)] if finite else -math.inf
    threshold = max(-50.0, min(-30.0, noise + 12.0)) if math.isfinite(noise) else -50.0
    mic_gain = _gain_to_target(mic)
    sys_gain = _gain_to_target(sys)

    out = bytearray()
    for i, (m, s) in enumerate(zip(mic, sys)):
        active = frame_db[min(i // frame, len(frame_db) - 1)] > threshold
        sample = s * sys_gain if active else m * mic_gain
        out += struct.pack("<h", _clamp_i16(sample))

    dst.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(dst), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(bytes(out))
    return dst


def select_transcription_audio(audio_path: Path, trans_cfg: dict) -> Path:
    if trans_cfg.get("echo_cancel_dual_track", True) is False:
        return audio_path
    try:
        if classify(audio_path) is not WavLayout.DUAL_TRACK:
            return audio_path
    except Exception:
        return audio_path
    clean_path = audio_path.with_suffix(".clean.wav")
    try:
        if clean_path.exists() and clean_path.stat().st_mtime >= audio_path.stat().st_mtime:
            return clean_path
        return clean_dual_track_to_mono(audio_path, clean_path)
    except Exception as exc:
        print(f"⚠️ 生成 clean 音频失败，回退原始录音: {exc}", file=__import__("sys").stderr)
        return audio_path
