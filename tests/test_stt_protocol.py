import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.protocol import (
    JobKind, ErrorCode, MessageType,
    TranscribeRequest, TranscribeResponse,
    SubscribeSessionRequest, PartialEvent, FinalReadyEvent,
    ErrorEvent, encode, decode,
)


def test_job_kind_priority_order():
    # final < live < file < dictation (lower number = higher priority within slot)
    assert JobKind.DICTATION.priority == 0
    assert JobKind.FINAL_TRANSCRIBE.priority == 1
    assert JobKind.LIVE_CHUNK.priority == 2
    assert JobKind.FILE_TRANSCRIBE.priority == 3


def test_job_kind_slot_routing():
    assert JobKind.DICTATION.slot == "interactive"
    for k in (JobKind.FINAL_TRANSCRIBE, JobKind.LIVE_CHUNK, JobKind.FILE_TRANSCRIBE):
        assert k.slot == "background"


def test_transcribe_request_roundtrip():
    req = TranscribeRequest(
        job_id="abc",
        kind=JobKind.FINAL_TRANSCRIBE,
        engine="mlx",
        language="zh",
        audio_path="/tmp/x.wav",
        audio_offset_bytes=0,
        audio_length_bytes=None,
        audio_format="wav-pcm-s16le-16k-mono",
        meeting_title="Test",
        session_id=None,
        word_timestamps=False,
        condition_on_previous=True,
        hallucination_silence_threshold=2.0,
        timeout_sec=7200,
        context_prompt="参会者姓名：Lewis, Ciel。",
    )
    encoded = encode(req)
    parsed = json.loads(encoded)
    assert parsed["type"] == "transcribe"
    assert parsed["kind"] == "final_transcribe"
    back = decode(encoded)
    assert isinstance(back, TranscribeRequest)
    assert back.job_id == "abc"
    assert back.kind == JobKind.FINAL_TRANSCRIBE
    assert back.context_prompt == "参会者姓名：Lewis, Ciel。"


def test_subscribe_session_context_roundtrip():
    req = SubscribeSessionRequest(
        sid="rt-1",
        mic_path="/tmp/rec.wav",
        sys_path=None,
        engine="mlx",
        language="zh",
        chunk_sec=10,
        meeting_title="Team",
        context_prompt="参会者姓名：Lewis, Ciel。",
    )
    encoded = encode(req)
    parsed = json.loads(encoded)
    assert parsed["type"] == "subscribe_session"
    assert parsed["meeting_title"] == "Team"
    assert parsed["context_prompt"] == "参会者姓名：Lewis, Ciel。"
    back = decode(encoded)
    assert isinstance(back, SubscribeSessionRequest)
    assert back.meeting_title == "Team"
    assert back.context_prompt == "参会者姓名：Lewis, Ciel。"


def test_error_event_includes_code():
    err = ErrorEvent(job_id="x", code=ErrorCode.AUDIO_NOT_FOUND, message="missing")
    s = encode(err)
    assert "AUDIO_NOT_FOUND" in s


def test_decode_unknown_type_raises():
    import pytest
    with pytest.raises(ValueError):
        decode('{"type":"unknown"}')
