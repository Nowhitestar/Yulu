"""Hermes STT backend.

This backend delegates transcription to the user's configured Hermes STT provider. It never
calls back into Yulu's STT daemon; the dependency direction is strictly Yulu -> Hermes provider.
"""

from __future__ import annotations

import asyncio
import importlib
import inspect
import os
import sys
from pathlib import Path
from typing import Any, Optional

from ..runtime import CancelToken, STTResult


DEFAULT_HERMES_AGENT_DIR = Path.home() / ".hermes" / "hermes-agent"


def _first_text(data: dict, keys: tuple[str, ...]) -> str:
    for key in keys:
        value = data.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return ""


def _number(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _read_time_seconds(item: dict, key: str) -> Optional[float]:
    ms_value = _number(item.get(f"{key}_ms"))
    if ms_value is not None:
        return ms_value / 1000.0
    value = _number(item.get(key))
    if value is not None:
        return value
    if key == "start":
        value = _number(item.get("start_time") or item.get("begin"))
        if value is not None:
            return value
    if key == "end":
        value = _number(item.get("end_time") or item.get("finish"))
        if value is not None:
            return value
    timestamp = item.get("timestamp") or item.get("timestamps")
    if isinstance(timestamp, (list, tuple)) and len(timestamp) >= 2:
        value = _number(timestamp[0 if key == "start" else 1])
        if value is not None:
            return value
    return None


def _speaker_value(item: dict) -> Any:
    for key in ("speaker_idx", "speaker_index", "speaker_id", "speaker_label", "speaker", "spk"):
        value = item.get(key)
        if value is not None and value != "":
            return value
    return None


def _iter_candidate_payloads(result: Any):
    if isinstance(result, dict):
        yield result
        for key in ("result", "data", "transcription", "response"):
            nested = result.get(key)
            if isinstance(nested, dict):
                yield nested


def _segments_list(payload: dict) -> list:
    for key in ("segments", "utterances", "speaker_segments", "diarization", "chunks"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
    return []


def _words_list(payload: dict) -> list:
    for key in ("words", "word_segments"):
        value = payload.get(key)
        if isinstance(value, list):
            return value
    return []


def _normalize_segment(item: dict, speaker_ids: dict[str, int]) -> Optional[dict]:
    text = _first_text(item, ("text", "transcript", "content", "word"))
    start = _read_time_seconds(item, "start")
    end = _read_time_seconds(item, "end")
    if start is None and end is None:
        return None
    if start is None:
        start = end or 0.0
    if end is None or end < start:
        end = start
    out = {
        "start": start,
        "end": end,
        "start_ms": int(round(start * 1000)),
        "end_ms": int(round(end * 1000)),
        "text": text,
    }
    speaker = _speaker_value(item)
    if speaker is not None:
        key = str(speaker)
        speaker_idx = speaker_ids.setdefault(key, len(speaker_ids))
        out["speaker"] = speaker_idx
        out["speaker_idx"] = speaker_idx
        out["speaker_label"] = key
    return out


def _normalize_segments(result: Any) -> list[dict]:
    speaker_ids: dict[str, int] = {}
    segments: list[dict] = []
    for payload in _iter_candidate_payloads(result):
        for item in _segments_list(payload):
            if not isinstance(item, dict):
                continue
            segment = _normalize_segment(item, speaker_ids)
            if segment is not None:
                segments.append(segment)
        if segments:
            break
        for item in _words_list(payload):
            if not isinstance(item, dict):
                continue
            segment = _normalize_segment(item, speaker_ids)
            if segment is not None:
                segments.append(segment)
        if segments:
            break
    segments.sort(key=lambda s: (s.get("start", 0.0), s.get("end", 0.0)))
    return segments


def _result_text(result: Any) -> str:
    for payload in _iter_candidate_payloads(result):
        text = _first_text(payload, ("transcript", "text", "result", "content"))
        if text:
            return text
    return ""


def _duration_ms(result: Any, segments: list[dict]) -> int:
    for payload in _iter_candidate_payloads(result):
        value = _number(payload.get("duration_ms"))
        if value is not None:
            return int(value)
        value = _number(payload.get("duration"))
        if value is not None:
            return int(value * 1000)
    if segments:
        return int(max(float(seg.get("end_ms", 0)) for seg in segments))
    return 0


class HermesSTTBackend:
    def __init__(
        self,
        *,
        agent_dir: str = "",
        model: Optional[str] = None,
        diarize: bool = True,
    ):
        self.agent_dir = Path(agent_dir).expanduser() if agent_dir else DEFAULT_HERMES_AGENT_DIR
        self.model = model or None
        self.diarize = diarize
        self._ready = False
        self._module = None
        self._lock = asyncio.Lock()

    def _ensure_import_path(self) -> None:
        agent_dir = str(self.agent_dir)
        if agent_dir not in sys.path:
            sys.path.insert(0, agent_dir)

    def _load_module(self):
        if not self.agent_dir.exists():
            raise RuntimeError(f"Hermes agent directory not found: {self.agent_dir}")
        self._ensure_import_path()
        if self._module is None:
            self._module = importlib.import_module("tools.transcription_tools")
        return self._module

    async def warm_up(self) -> None:
        self._load_module()
        self._ready = True

    def is_ready(self) -> bool:
        return self._ready

    def release(self) -> None:
        self._ready = False

    async def transcribe(
        self,
        *,
        audio_path: str,
        language: str,
        initial_prompt: str,
        cancel_token: CancelToken,
        options: Optional[dict] = None,
    ) -> STTResult:
        cancel_token.check()
        if not self.is_ready():
            await self.warm_up()
        request_diarize = self.diarize and (options or {}).get("job_kind") == "final_transcribe"
        request_format = (options or {}).get("job_kind") != "dictation"
        request_timeout = max(0.2, float((options or {}).get("timeout_sec") or 120.0))
        async with self._lock:
            cancel_token.check()
            result = await asyncio.to_thread(
                self._transcribe_sync,
                audio_path,
                language,
                request_diarize,
                request_format,
                initial_prompt,
                request_timeout,
            )
            cancel_token.check()
        return self._to_stt_result(result, language)

    def _stt_config(self) -> dict:
        module = self._load_module()
        load_config = getattr(module, "_load_stt_config", None)
        if callable(load_config):
            data = load_config()
            if isinstance(data, dict):
                return data
        return {}

    def _provider(self, stt_config: dict) -> str:
        module = self._load_module()
        get_provider = getattr(module, "_get_provider", None)
        if callable(get_provider):
            return str(get_provider(stt_config) or "").strip().lower()
        return str(stt_config.get("provider") or "").strip().lower()

    def _transcribe_sync(
        self,
        audio_path: str,
        language: str,
        request_diarize: bool,
        request_format: bool,
        initial_prompt: str,
        request_timeout: float,
    ) -> dict:
        module = self._load_module()
        stt_config = self._stt_config()
        provider = self._provider(stt_config)
        if provider == "xai":
            payload = self._transcribe_xai_json(
                audio_path,
                language,
                stt_config,
                diarize=request_diarize,
                initial_prompt=initial_prompt,
                format_text=request_format,
                request_timeout=request_timeout,
            )
            return {"provider": "xai", "payload": payload}

        transcribe_audio = getattr(module, "transcribe_audio", None)
        if not callable(transcribe_audio):
            raise RuntimeError("Hermes transcription tool is unavailable")
        kwargs: dict[str, Any] = {"model": self.model}
        if initial_prompt:
            try:
                params = inspect.signature(transcribe_audio).parameters
            except (TypeError, ValueError):
                params = {}
            if "initial_prompt" in params:
                kwargs["initial_prompt"] = initial_prompt
            elif "prompt" in params:
                kwargs["prompt"] = initial_prompt
        result = transcribe_audio(audio_path, **kwargs)
        if not isinstance(result, dict):
            raise RuntimeError("Hermes transcription returned a non-dict result")
        if not result.get("success", True):
            raise RuntimeError(str(result.get("error") or "Hermes transcription failed"))
        return {"provider": str(result.get("provider") or provider or "hermes"), "payload": result}

    def _transcribe_xai_json(
        self,
        audio_path: str,
        language: str,
        stt_config: dict,
        *,
        diarize: bool,
        initial_prompt: str,
        format_text: bool,
        request_timeout: float,
    ) -> dict:
        module = self._load_module()
        xai_config = stt_config.get("xai", {}) if isinstance(stt_config.get("xai"), dict) else {}

        self._ensure_import_path()
        xai_http = importlib.import_module("tools.xai_http")
        resolve_creds = getattr(xai_http, "resolve_xai_http_credentials")
        user_agent = getattr(xai_http, "hermes_xai_user_agent", lambda: "Hermes")
        credentials = resolve_creds()

        get_env_value = getattr(module, "get_env_value", None)
        if not callable(get_env_value):
            get_env_value = os.getenv
        default_base = getattr(module, "XAI_STT_BASE_URL", "https://api.x.ai/v1")

        base_url = (
            str(credentials.get("base_url") or "").strip()
            or str(xai_config.get("base_url") or "").strip()
            or str(get_env_value("XAI_STT_BASE_URL") or "").strip()
            or default_base
        ).rstrip("/")
        request_language = (
            str(xai_config.get("language") or "").strip()
            or str(get_env_value("HERMES_LOCAL_STT_LANGUAGE") or "").strip()
            or language
            or "auto"
        )
        api_key = str(credentials.get("api_key") or "").strip()
        if not api_key:
            raise RuntimeError("Hermes xAI STT credentials are not configured")

        import requests

        data = {
            "language": request_language,
        }
        if format_text:
            data["format"] = "true"
        if initial_prompt.strip():
            data["prompt"] = initial_prompt.strip()
        if diarize:
            data["diarize"] = "true"
        model = self.model or xai_config.get("model")
        if model:
            data["model"] = str(model)

        with open(audio_path, "rb") as fh:
            files = {"file": (Path(audio_path).name, fh, "audio/wav")}
            response = requests.post(
                f"{base_url}/stt",
                headers={
                    "Authorization": f"Bearer {api_key}",
                    "User-Agent": str(user_agent()),
                },
                files=files,
                data=data,
                timeout=request_timeout,
            )
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, dict):
            raise RuntimeError("Hermes xAI STT returned a non-dict response")
        return payload

    def _to_stt_result(self, result: dict, language: str) -> STTResult:
        payload = result.get("payload") if isinstance(result.get("payload"), dict) else result
        text = _result_text(payload)
        segments = _normalize_segments(payload)
        if not text and segments:
            text = " ".join(str(seg.get("text") or "").strip() for seg in segments).strip()
        provider = str(result.get("provider") or "hermes")
        for segment in segments:
            segment.setdefault("provider", provider)
        return STTResult(
            text=text,
            raw_text=text,
            segments=segments,
            language=str(payload.get("language") or language),
            duration_ms=_duration_ms(payload, segments),
        )
