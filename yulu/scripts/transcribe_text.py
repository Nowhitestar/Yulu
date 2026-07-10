"""Text helpers used by the meeting transcription orchestrator."""

from __future__ import annotations

from difflib import SequenceMatcher
import json
from pathlib import Path
from typing import Optional

from realtime_coverage import (
    is_repetitive_hallucination as _is_repetitive_hallucination,
    realtime_coverage_ok,
    repeat_key as _repeat_key,
    strip_obvious_hallucination_text,
)


FAST_POST_RECORDING_MODE = "fast_summary"
FULL_POST_RECORDING_MODE = "full_transcribe"


def normalize_post_recording_mode(value) -> str:
    raw = str(value or FAST_POST_RECORDING_MODE).strip().lower().replace("-", "_")
    aliases = {
        "fast": FAST_POST_RECORDING_MODE, "quick": FAST_POST_RECORDING_MODE,
        "realtime": FAST_POST_RECORDING_MODE, "realtime_polish": FAST_POST_RECORDING_MODE,
        "realtime_summary": FAST_POST_RECORDING_MODE, "fast_summary": FAST_POST_RECORDING_MODE,
        "full": FULL_POST_RECORDING_MODE, "quality": FULL_POST_RECORDING_MODE,
        "final": FULL_POST_RECORDING_MODE, "full_transcribe": FULL_POST_RECORDING_MODE,
        "final_transcribe": FULL_POST_RECORDING_MODE,
    }
    allowed = {FAST_POST_RECORDING_MODE, FULL_POST_RECORDING_MODE}
    return aliases.get(raw, raw if raw in allowed else FAST_POST_RECORDING_MODE)


def _segment_start_seconds(seg: dict) -> float:
    value = seg.get("start")
    if value is not None:
        return float(value)
    ms_value = seg.get("start_ms")
    if ms_value is not None:
        return float(ms_value) / 1000.0
    return 0.0


def _segment_end_seconds(seg: dict) -> float:
    value = seg.get("end")
    if value is not None:
        return float(value)
    ms_value = seg.get("end_ms")
    if ms_value is not None:
        return float(ms_value) / 1000.0
    return _segment_start_seconds(seg)


def filter_obvious_hallucination_segments(segments: list[dict]) -> list[dict]:
    filtered: list[dict] = []
    last_key = ""
    last_start = -9999.0
    for seg in segments or []:
        item = dict(seg)
        text = strip_obvious_hallucination_text(str(item.get("text") or ""))
        if not text or _is_repetitive_hallucination(text):
            continue
        key = _repeat_key(text)
        start = _segment_start_seconds(item)
        if key and key == last_key and len(key) >= 8 and start - last_start <= 30.0:
            continue
        item["text"] = text
        filtered.append(item)
        last_key = key
        last_start = start
    return filtered


def _overlap_seconds(a: dict, b: dict) -> float:
    return max(
        0.0,
        min(_segment_end_seconds(a), _segment_end_seconds(b))
        - max(_segment_start_seconds(a), _segment_start_seconds(b)),
    )


def _similar_text(a: str, b: str) -> bool:
    ka = _repeat_key(a)
    kb = _repeat_key(b)
    if len(ka) < 4 or len(kb) < 4:
        return False
    if ka == kb or ka in kb or kb in ka:
        return True
    return SequenceMatcher(None, ka, kb).ratio() >= 0.68


def suppress_mic_leakage_segments(mic_segments: list[dict], sys_segments: list[dict]) -> list[dict]:
    kept: list[dict] = []
    for mic in mic_segments:
        mic_duration = max(0.1, _segment_end_seconds(mic) - _segment_start_seconds(mic))
        drop = False
        for sys_seg in sys_segments:
            sys_duration = max(0.1, _segment_end_seconds(sys_seg) - _segment_start_seconds(sys_seg))
            overlap = _overlap_seconds(mic, sys_seg)
            if overlap < min(mic_duration, sys_duration) * 0.5:
                continue
            if _similar_text(str(mic.get("text") or ""), str(sys_seg.get("text") or "")):
                drop = True
                break
        if not drop:
            kept.append(mic)
    return kept


def transcript_text_from_segments(segments: list[dict], fallback: str) -> str:
    if segments:
        return " ".join(str(seg.get("text") or "").strip() for seg in segments if seg.get("text"))
    return strip_obvious_hallucination_text(fallback)


def read_realtime_transcript(path: Path) -> Optional[str]:
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        return None
    # A real live transcript is plain text; JSON here means an agent event was
    # accidentally written to the transcript sidecar.
    if text[0] in "[{":
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = None
        if isinstance(parsed, (list, dict)):
            return None
    cleaned = strip_obvious_hallucination_text(text)
    return cleaned or None


def provider_diarization_requested(trans_cfg: dict) -> bool:
    if str(trans_cfg.get("final_engine") or "").strip().lower() != "hermes":
        return False
    hermes = trans_cfg.get("hermes", {}) if isinstance(trans_cfg.get("hermes"), dict) else {}
    return str(hermes.get("diarize", True)).strip().lower() not in {
        "0", "false", "no", "off"
    }


def reusable_realtime_transcript(audio_path: Path, trans_cfg: dict) -> tuple[Optional[str], str]:
    text = read_realtime_transcript(audio_path.with_suffix(".realtime.transcript.txt"))
    if not text:
        return None, "missing"
    if provider_diarization_requested(trans_cfg):
        return None, "provider_diarization"
    if not realtime_coverage_ok(audio_path):
        return None, "coverage"
    return text, "ok"
