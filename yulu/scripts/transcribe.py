#!/usr/bin/env python3
"""Process a recorded meeting: orchestrate transcription via stt_daemon,
optionally polish via LLM, persist summary, and dispatch to agent queue.

This file replaces the previous in-process mlx-whisper / whisper-cli
subprocess invocations with stt_daemon RPC calls. All STT lives in the
daemon now; transcribe.py is the *business* orchestrator.
"""

from __future__ import annotations

import json
import re
import shlex
import subprocess
import sys
from pathlib import Path
from typing import Optional

from transcribe_client import transcribe_file, DaemonUnavailable, DaemonError

CONFIG_PATH = Path.home() / ".config" / "yulu" / "config.json"

FAST_POST_RECORDING_MODE = "fast_summary"
FULL_POST_RECORDING_MODE = "full_transcribe"

NOTIFY_SCRIPT = Path(__file__).parent / "notify.py"


def load_config():
    if not CONFIG_PATH.exists():
        print(f"Config not found at {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    with open(CONFIG_PATH) as f:
        return json.load(f)


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
    return aliases.get(raw, raw if raw in {FAST_POST_RECORDING_MODE, FULL_POST_RECORDING_MODE} else FAST_POST_RECORDING_MODE)


def read_realtime_transcript(path: Path) -> Optional[str]:
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8").strip()
    return text or None


def _notify_agent(event_type: str, **kw):
    try:
        from agent_notify import notify
        notify(event_type, **kw)
    except Exception:
        pass


def _request_final_transcribe(audio_path: Path, trans_cfg: dict, meeting_title: str) -> Optional[str]:
    """Ask the daemon to transcribe the file. Returns text or None on failure."""
    engine = trans_cfg.get("final_engine", "mlx")
    language = trans_cfg.get("language", "zh")
    try:
        response = transcribe_file(
            audio_path=str(audio_path),
            engine=engine,
            language=language,
            meeting_title=meeting_title,
            kind="file_transcribe",
        )
    except DaemonUnavailable as exc:
        print(f"⚠️ stt_daemon unavailable: {exc}", file=sys.stderr)
        return None
    except DaemonError as exc:
        print(f"⚠️ stt_daemon error: {exc}", file=sys.stderr)
        return None
    if response.get("status") != "ok":
        print(f"⚠️ daemon transcribe failed: {response.get('error')}", file=sys.stderr)
        return None
    return response["text"]


def process_audio(audio_path_str: str) -> tuple[str, str]:
    """STUB during refactor — Task 5.2 rewrites the prompt-dispatch portion.

    Transcript acquisition + raw/cleaned write is intentionally left in place
    so 5.2 can build on top.
    """
    raise NotImplementedError("transcribe.py prompt dispatch is being refactored; see Task 5.2")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: transcribe.py <audio_file_path>", file=sys.stderr)
        sys.exit(1)
    process_audio(sys.argv[1])
