"""JSON message types + codec for the stt_daemon Unix socket protocol."""

from __future__ import annotations

import json
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Any, Optional, Union


class JobKind(str, Enum):
    DICTATION = "dictation"
    FINAL_TRANSCRIBE = "final_transcribe"
    LIVE_CHUNK = "live_chunk"
    FILE_TRANSCRIBE = "file_transcribe"
    # v0.6 diarization (Phase 13). A SIBLING stage, not an ASR engine — it runs on the
    # background slot (never contends with interactive dictation) and is dispatched to the
    # app's diarize_backend, NOT through STTRuntime's ASR fallback chain.
    DIARIZE = "diarize"

    @property
    def priority(self) -> int:
        return {
            JobKind.DICTATION: 0,
            JobKind.FINAL_TRANSCRIBE: 1,
            JobKind.LIVE_CHUNK: 2,
            JobKind.FILE_TRANSCRIBE: 3,
            JobKind.DIARIZE: 4,
        }[self]

    @property
    def slot(self) -> str:
        return "interactive" if self is JobKind.DICTATION else "background"


class ErrorCode(str, Enum):
    MODEL_NOT_LOADED = "MODEL_NOT_LOADED"
    ENGINE_UNAVAILABLE = "ENGINE_UNAVAILABLE"
    AUDIO_NOT_FOUND = "AUDIO_NOT_FOUND"
    AUDIO_TOO_SHORT = "AUDIO_TOO_SHORT"
    JOB_CANCELLED = "JOB_CANCELLED"
    ENGINE_BUSY = "ENGINE_BUSY"
    VOCAB_LOCKED = "VOCAB_LOCKED"
    WATCHDOG_TIMEOUT = "WATCHDOG_TIMEOUT"
    INTERNAL = "INTERNAL"


class MessageType(str, Enum):
    HEALTH = "health"
    HEALTH_RESPONSE = "health_response"
    WARM_UP = "warm_up"
    VOCAB_RELOAD = "vocab_reload"
    VOCAB_RELOADED = "vocab_reloaded"
    TRANSCRIBE = "transcribe"
    TRANSCRIBE_RESULT = "transcribe_result"
    DIARIZE = "diarize"
    DIARIZE_RESULT = "diarize_result"
    CANCEL = "cancel"
    SUBSCRIBE_SESSION = "subscribe_session"
    UNSUBSCRIBE_SESSION = "unsubscribe_session"
    PARTIAL = "partial"
    FINAL_READY = "final_ready"
    ERROR = "error"
    OK = "ok"


@dataclass
class HealthRequest:
    pass


@dataclass
class HealthResponse:
    ready: bool
    model_loaded: bool
    vocab_size: int
    in_flight_jobs: int
    active_sessions: int


@dataclass
class WarmUpRequest:
    engine: Optional[str] = None


@dataclass
class VocabReloadRequest:
    pass


@dataclass
class VocabReloadedResponse:
    prompt_terms: int
    replace_rules: int


@dataclass
class TranscribeRequest:
    job_id: str
    kind: JobKind
    engine: str
    language: str
    audio_path: str
    audio_offset_bytes: int = 0
    audio_length_bytes: Optional[int] = None
    audio_format: str = "wav-pcm-s16le-16k-mono"
    meeting_title: Optional[str] = None
    session_id: Optional[str] = None
    word_timestamps: bool = False
    condition_on_previous: bool = False
    hallucination_silence_threshold: float = 2.0
    timeout_sec: float = 7200.0
    channel_split: bool = False
    context_prompt: str = ""
    dictation_mode: str = ""
    target_language: str = ""


@dataclass
class TranscribeResponse:
    job_id: str
    status: str
    engine_used: str
    language_used: str
    text: str
    raw_text: str
    segments: list[dict]
    vocab_prompt_terms_count: int
    vocab_replacements_count: int
    duration_ms: int
    error: Optional[str] = None
    # Phase 3 (dual-track): which layout the daemon dispatched for. Always
    # set on successful transcribe_result responses. For DUAL_TRACK, `text`
    # / `segments` stay empty and per-channel results live in `channels`.
    layout: Optional[str] = None
    channels: Optional[dict] = None


@dataclass
class DiarizeRequest:
    """Ask the daemon to diarize one audio file (v0.6, Phase 13).

    A SIBLING of TranscribeRequest, routed to the app's diarize_backend (NOT the ASR runtime).
    ``num_speakers`` / ``threshold`` carry the Phase-12 count-strategy decision for THIS call
    (None / <=0 → auto threshold clustering). ``language`` is advisory (provenance/logging only).
    """

    job_id: str
    audio_path: str
    num_speakers: Optional[int] = None
    threshold: Optional[float] = None
    language: Optional[str] = None
    timeout_sec: float = 7200.0


@dataclass
class DiarizeResponse:
    """Diarization result: raw speaker turns (each ``{start, end, speaker_idx, speaker}``) feeding
    ``speaker_merge.assign_speakers`` verbatim. ``status`` is ``"ok"`` / ``"error"``."""

    job_id: str
    status: str
    turns: list[dict]
    num_speakers_detected: int
    duration_ms: int
    error: Optional[str] = None


@dataclass
class CancelRequest:
    job_id: str


@dataclass
class SubscribeSessionRequest:
    sid: str
    mic_path: str
    sys_path: Optional[str] = None
    engine: str = "mlx"
    language: str = "zh"
    chunk_sec: int = 10
    meeting_title: Optional[str] = None
    context_prompt: str = ""


@dataclass
class UnsubscribeSessionRequest:
    sid: str
    reason: str


@dataclass
class PartialEvent:
    sid: str
    seq: int
    source: str
    started_ms: int
    ended_ms: int
    text: str


@dataclass
class FinalReadyEvent:
    sid: str
    transcript_path: str
    raw_path: str
    engine: str
    duration_ms: int


@dataclass
class ErrorEvent:
    code: ErrorCode
    message: str
    job_id: Optional[str] = None
    details: Optional[dict] = None


@dataclass
class OkResponse:
    detail: Optional[str] = None


Message = Union[
    HealthRequest, HealthResponse,
    WarmUpRequest,
    VocabReloadRequest, VocabReloadedResponse,
    TranscribeRequest, TranscribeResponse,
    DiarizeRequest, DiarizeResponse,
    CancelRequest,
    SubscribeSessionRequest, UnsubscribeSessionRequest,
    PartialEvent, FinalReadyEvent,
    ErrorEvent, OkResponse,
]


_TYPE_TO_CLS: dict[str, type] = {
    "health": HealthRequest,
    "health_response": HealthResponse,
    "warm_up": WarmUpRequest,
    "vocab_reload": VocabReloadRequest,
    "vocab_reloaded": VocabReloadedResponse,
    "transcribe": TranscribeRequest,
    "transcribe_result": TranscribeResponse,
    "diarize": DiarizeRequest,
    "diarize_result": DiarizeResponse,
    "cancel": CancelRequest,
    "subscribe_session": SubscribeSessionRequest,
    "unsubscribe_session": UnsubscribeSessionRequest,
    "partial": PartialEvent,
    "final_ready": FinalReadyEvent,
    "error": ErrorEvent,
    "ok": OkResponse,
}

_CLS_TO_TYPE: dict[type, str] = {v: k for k, v in _TYPE_TO_CLS.items()}


def _to_jsonable(obj: Any) -> Any:
    if isinstance(obj, Enum):
        return obj.value
    if isinstance(obj, dict):
        return {k: _to_jsonable(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_to_jsonable(v) for v in obj]
    return obj


def encode(msg: Message) -> str:
    """Encode a dataclass message to a JSON string ending with \\n."""
    type_name = _CLS_TO_TYPE.get(type(msg))
    if type_name is None:
        raise ValueError(f"unknown message class: {type(msg).__name__}")
    payload = {"type": type_name, **_to_jsonable(asdict(msg))}
    return json.dumps(payload, ensure_ascii=False) + "\n"


def decode(line: str) -> Message:
    """Decode one JSON line into a dataclass message."""
    data = json.loads(line)
    type_name = data.get("type")
    if type_name not in _TYPE_TO_CLS:
        raise ValueError(f"unknown message type: {type_name}")
    cls = _TYPE_TO_CLS[type_name]
    payload = {k: v for k, v in data.items() if k != "type"}
    if cls is TranscribeRequest:
        payload["kind"] = JobKind(payload["kind"])
    if cls is ErrorEvent:
        payload["code"] = ErrorCode(payload["code"])
    try:
        return cls(**payload)
    except TypeError as exc:
        raise ValueError(f"invalid payload for {type_name}: {exc}") from exc
