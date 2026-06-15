#!/usr/bin/env python3
"""Playback/transcription-friendly audio derived from Yulu dual-track WAVs."""

from __future__ import annotations

import struct
import wave
from pathlib import Path

from stt_daemon.wav_inspect import WavLayout, classify


SYS_ACTIVE_THRESHOLD = 0.001
DEFAULT_FRAME_MS = 30
MIC_PLAYBACK_GAIN = 2.4
SYS_ACTIVE_MIC_BLEND = 0.22
SYS_ACTIVE_LEAK_MIC_BLEND = 0.02
SYS_ACTIVE_SYS_GAIN = 0.94
LOCAL_OVERLAP_MIC_RATIO = 1.35


def _rms(samples: list[int]) -> float:
    if not samples:
        return 0.0
    peak = 32767.0
    return (sum((s / peak) ** 2 for s in samples) / len(samples)) ** 0.5


def _clamp_i16(value: float) -> int:
    return int(max(-32768, min(32767, round(value))))


def clean_dual_track_to_mono(src: Path, dst: Path, *, frame_ms: int = DEFAULT_FRAME_MS) -> Path:
    """Write a mono WAV using a playback-friendly dual-track mix.

    Dual-track files are stored as L=mic and R=system. Playing both directly can
    sound echoey because the microphone track often contains leaked speaker
    audio. Prefer system audio while it is active, and only keep meaningful mic
    signal when it is likely to be local speech overlapping the remote speaker.
    """
    with wave.open(str(src), "rb") as w:
        if w.getnchannels() != 2 or w.getsampwidth() != 2:
            raise ValueError("clean_dual_track_to_mono requires stereo s16 WAV")
        sr = w.getframerate()
        raw = w.readframes(w.getnframes())

    pairs = list(struct.iter_unpack("<hh", raw))
    mic = [p[0] for p in pairs]
    sys = [p[1] for p in pairs]
    frame = max(1, int(sr * frame_ms / 1000))
    fade_pos = 0.0

    out = bytearray()
    for start in range(0, len(sys), frame):
        end = min(start + frame, len(sys))
        sys_frame = sys[start:end]
        mic_frame = mic[start:end]
        sys_rms = _rms(sys_frame)
        mic_rms = _rms(mic_frame)
        sys_active = sys_rms > SYS_ACTIVE_THRESHOLD
        if sys_active:
            fade_pos = 0.0
        else:
            fade_pos = min(1.0, fade_pos + ((end - start) / sr))
        sys_ratio = 1.0 - fade_pos
        if sys_active:
            mic_blend = SYS_ACTIVE_LEAK_MIC_BLEND
            if mic_rms > sys_rms * LOCAL_OVERLAP_MIC_RATIO:
                mic_blend = SYS_ACTIVE_MIC_BLEND
        else:
            mic_blend = SYS_ACTIVE_MIC_BLEND + (1.0 - SYS_ACTIVE_MIC_BLEND) * fade_pos
        for i in range(start, end):
            sys_sample = sys[i] / 32767.0
            mic_sample = (mic[i] / 32767.0) if i < len(mic) else 0.0
            mic_sample = max(-0.99, min(0.99, mic_sample * MIC_PLAYBACK_GAIN))
            if sys_ratio > 0:
                mixed = SYS_ACTIVE_SYS_GAIN * sys_sample + mic_blend * mic_sample
            else:
                mixed = mic_sample
            out += struct.pack("<h", _clamp_i16(mixed * 32767.0))

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
