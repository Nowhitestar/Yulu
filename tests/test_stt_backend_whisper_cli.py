import asyncio
import os
import shutil
import stat
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.backends.whisper_cli import WhisperCliBackend
from stt_daemon.runtime import CancelToken


def _make_stub_whisper_cli(tmp_path: Path, transcript_text: str) -> Path:
    """Create a fake whisper-cli that writes <stem>.txt with the desired text."""
    cli = tmp_path / "whisper-cli"
    cli.write_text(
        "#!/usr/bin/env bash\n"
        "while [[ $# -gt 0 ]]; do\n"
        "  case \"$1\" in\n"
        "    -of) OUT_STEM=\"$2\"; shift 2 ;;\n"
        "    *) shift ;;\n"
        "  esac\n"
        "done\n"
        f"echo {transcript_text!r} > \"$OUT_STEM.txt\"\n"
        "exit 0\n"
    )
    cli.chmod(cli.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return cli


def test_whisper_cli_runs_and_reads_output(tmp_path):
    audio = tmp_path / "in.wav"
    audio.write_bytes(b"RIFFdummy")
    cli = _make_stub_whisper_cli(tmp_path, "hello world")
    backend = WhisperCliBackend(
        binary=str(cli),
        model_path=str(tmp_path / "model.bin"),
    )

    async def go():
        await backend.warm_up()
        result = await backend.transcribe(
            audio_path=str(audio),
            language="zh",
            initial_prompt="",
            cancel_token=CancelToken(),
        )
        return result
    result = asyncio.run(go())
    assert "hello world" in result.text


def test_whisper_cli_missing_binary_raises(tmp_path):
    backend = WhisperCliBackend(
        binary=str(tmp_path / "does-not-exist"),
        model_path=str(tmp_path / "model.bin"),
    )

    async def go():
        await backend.warm_up()
        with pytest.raises(RuntimeError):
            await backend.transcribe(
                audio_path=str(tmp_path / "x.wav"),
                language="zh",
                initial_prompt="",
                cancel_token=CancelToken(),
            )
    asyncio.run(go())


def test_whisper_cli_respects_pre_cancel(tmp_path):
    audio = tmp_path / "in.wav"
    audio.write_bytes(b"RIFFdummy")
    cli = _make_stub_whisper_cli(tmp_path, "x")
    backend = WhisperCliBackend(
        binary=str(cli),
        model_path=str(tmp_path / "model.bin"),
    )

    async def go():
        await backend.warm_up()
        tok = CancelToken()
        tok.cancel()
        with pytest.raises(asyncio.CancelledError):
            await backend.transcribe(
                audio_path=str(audio),
                language="zh",
                initial_prompt="",
                cancel_token=tok,
            )
    asyncio.run(go())
