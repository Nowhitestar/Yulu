"""Protocol contract for channel_split (Phase 3)."""

import sys
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.protocol import TranscribeRequest, JobKind


def _base_kwargs():
    return dict(
        job_id="j1",
        kind=JobKind.FILE_TRANSCRIBE,
        engine="mlx",
        language="zh",
        audio_path="/tmp/x.wav",
    )


def test_transcribe_request_default_channel_split_is_false():
    """Back-compat: existing callers without the field get mono behavior."""
    req = TranscribeRequest(**_base_kwargs())
    assert req.channel_split is False


def test_transcribe_request_accepts_channel_split_true():
    req = TranscribeRequest(**_base_kwargs(), channel_split=True)
    assert req.channel_split is True
