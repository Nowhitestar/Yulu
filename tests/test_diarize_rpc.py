"""Phase 13 Task 1 — daemon DIARIZE RPC plumbing (CI-safe, sherpa NOT required).

Locks the new request/response protocol + the app handler's graceful-degrade contract:
  * DiarizeRequest / DiarizeResponse round-trip through encode/decode (JobKind.DIARIZE exists,
    is registered in _TYPE_TO_CLS, and sits on the background slot);
  * _on_diarize returns turns when a backend is present;
  * _on_diarize returns ENGINE_UNAVAILABLE when no backend is configured (the live Python-3.14
    case where sherpa isn't installed → diarize_backend is None);
  * _on_diarize returns INTERNAL when the backend raises (sherpa-missing / model-load failure)
    — never a crashed connection.

The backend is a tiny fake (mirrors test_diarize_backend's style) so no sherpa / model is needed.
"""

import asyncio
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from stt_daemon.protocol import (  # noqa: E402
    JobKind, MessageType,
    DiarizeRequest, DiarizeResponse, ErrorEvent, ErrorCode,
    encode, decode, _TYPE_TO_CLS,
)
from stt_daemon.app import STTDaemonApp  # noqa: E402
from stt_daemon.config import DaemonConfig  # noqa: E402
from stt_daemon.runtime import MockSTTBackend  # noqa: E402
from stt_daemon.backends.diarize import SpeakerTurn  # noqa: E402
from socket_helpers import short_socket_dir  # noqa: E402


def _run(coro):
    return asyncio.run(coro)


# ── A fake diarize backend (no sherpa) ────────────────────────────────────────


class _FakeDiarizeBackend:
    def __init__(self, *, turns=None, raise_on_diarize=None):
        self._turns = turns or []
        self._raise = raise_on_diarize
        self._ready = False
        self.warm_up_calls = 0
        self.diarize_kwargs = None

    def is_ready(self):
        return self._ready

    async def warm_up(self):
        self.warm_up_calls += 1
        self._ready = True

    async def diarize(self, *, audio_path, num_speakers, threshold, cancel_token):
        self.diarize_kwargs = {
            "audio_path": audio_path,
            "num_speakers": num_speakers,
            "threshold": threshold,
        }
        if self._raise is not None:
            raise self._raise
        return list(self._turns)

    def release(self):
        self._ready = False


def _short_sock_dir():
    return short_socket_dir()


def _build_app(tmp_path):
    cfg = DaemonConfig(
        socket_path=_short_sock_dir() / "stt.sock",
        vocab_db_path=tmp_path / "vocab.sqlite",
        pid_file=tmp_path / "stt.pid",
        log_path=None,
        sessions_dir=tmp_path / "sessions",
    )
    return STTDaemonApp(cfg, backends={"mlx": MockSTTBackend(canned_text="hi")})


# ── Protocol round-trip ───────────────────────────────────────────────────────


def test_jobkind_diarize_exists_and_is_background():
    assert JobKind.DIARIZE.value == "diarize"
    assert JobKind.DIARIZE.slot == "background"  # never contends with interactive dictation
    # priority is defined (no KeyError)
    assert isinstance(JobKind.DIARIZE.priority, int)


def test_diarize_request_round_trips():
    assert _TYPE_TO_CLS["diarize"] is DiarizeRequest
    assert _TYPE_TO_CLS["diarize_result"] is DiarizeResponse
    req = DiarizeRequest(job_id="j1", audio_path="/tmp/a.wav",
                         num_speakers=3, threshold=0.5, language="zh")
    back = decode(encode(req))
    assert isinstance(back, DiarizeRequest)
    assert back.job_id == "j1"
    assert back.audio_path == "/tmp/a.wav"
    assert back.num_speakers == 3
    assert back.threshold == 0.5


def test_diarize_response_round_trips():
    resp = DiarizeResponse(job_id="j1", status="ok",
                           turns=[{"start": 0.0, "end": 1.0, "speaker_idx": 0, "speaker": 0}],
                           num_speakers_detected=1, duration_ms=12)
    back = decode(encode(resp))
    assert isinstance(back, DiarizeResponse)
    assert back.turns[0]["speaker_idx"] == 0
    assert back.num_speakers_detected == 1


# ── Handler: backend present ──────────────────────────────────────────────────


def test_on_diarize_returns_turns_with_backend(tmp_path):
    wav = tmp_path / "Meeting_20260601_100000.wav"
    wav.write_bytes(b"RIFF")
    app = _build_app(tmp_path)
    app.diarize_backend = _FakeDiarizeBackend(turns=[
        SpeakerTurn(start=0.0, end=2.0, speaker_idx=0),
        SpeakerTurn(start=2.0, end=4.0, speaker_idx=1),
    ])
    msg = DiarizeRequest(job_id="j1", audio_path=str(wav), num_speakers=2, threshold=0.5)
    resp = _run(app._on_diarize(msg, writer=None))
    assert isinstance(resp, DiarizeResponse)
    assert resp.status == "ok"
    assert resp.num_speakers_detected == 2
    assert len(resp.turns) == 2
    assert resp.turns[0]["speaker_idx"] == 0
    # warm_up was lazily invoked + the per-call count/threshold were forwarded
    assert app.diarize_backend.warm_up_calls == 1
    assert app.diarize_backend.diarize_kwargs["num_speakers"] == 2
    assert app.diarize_backend.diarize_kwargs["threshold"] == 0.5


# ── Handler: graceful degrade ─────────────────────────────────────────────────


def test_on_diarize_engine_unavailable_when_no_backend(tmp_path):
    wav = tmp_path / "Meeting_20260601_100000.wav"
    wav.write_bytes(b"RIFF")
    app = _build_app(tmp_path)
    assert app.diarize_backend is None  # defaulted on the app
    msg = DiarizeRequest(job_id="j1", audio_path=str(wav))
    resp = _run(app._on_diarize(msg, writer=None))
    assert isinstance(resp, ErrorEvent)
    assert resp.code == ErrorCode.ENGINE_UNAVAILABLE


def test_on_diarize_internal_error_when_backend_raises(tmp_path):
    wav = tmp_path / "Meeting_20260601_100000.wav"
    wav.write_bytes(b"RIFF")
    app = _build_app(tmp_path)
    app.diarize_backend = _FakeDiarizeBackend(
        raise_on_diarize=RuntimeError("No module named 'sherpa_onnx'"))
    msg = DiarizeRequest(job_id="j1", audio_path=str(wav))
    resp = _run(app._on_diarize(msg, writer=None))
    assert isinstance(resp, ErrorEvent)
    assert resp.code == ErrorCode.INTERNAL
    assert "sherpa_onnx" in resp.message


def test_on_diarize_audio_not_found(tmp_path):
    app = _build_app(tmp_path)
    app.diarize_backend = _FakeDiarizeBackend(turns=[])
    msg = DiarizeRequest(job_id="j1", audio_path=str(tmp_path / "nope.wav"))
    resp = _run(app._on_diarize(msg, writer=None))
    assert isinstance(resp, ErrorEvent)
    assert resp.code == ErrorCode.AUDIO_NOT_FOUND
