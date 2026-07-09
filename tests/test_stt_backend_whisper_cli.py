import asyncio
import os
import shutil
import stat
import sys
from pathlib import Path
from typing import Optional

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.backends.whisper_cli import WhisperCliBackend
from stt_daemon.runtime import CancelToken


def _make_stub_whisper_cli(tmp_path: Path, transcript_text: str, arg_log: Optional[Path] = None) -> Path:
    """Create a fake whisper-cli that writes <stem>.txt with the desired text."""
    cli = tmp_path / "whisper-cli"
    log_line = f"printf '%s\\n' \"$@\" > {str(arg_log)!r}\n" if arg_log else ""
    cli.write_text(
        "#!/usr/bin/env bash\n"
        f"{log_line}"
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


def test_whisper_cli_resolves_binary_from_path(monkeypatch, tmp_path):
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _make_stub_whisper_cli(bin_dir, "from path")
    monkeypatch.setenv("PATH", f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")

    audio = tmp_path / "in.wav"
    audio.write_bytes(b"RIFFdummy")
    backend = WhisperCliBackend(
        binary="whisper-cli",
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
    assert backend.is_ready()
    assert "from path" in result.text


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


def test_whisper_cli_uses_translate_flag_for_english_dictation(tmp_path):
    audio = tmp_path / "in.wav"
    audio.write_bytes(b"RIFFdummy")
    arg_log = tmp_path / "args.txt"
    cli = _make_stub_whisper_cli(tmp_path, "hello world", arg_log=arg_log)
    backend = WhisperCliBackend(
        binary=str(cli),
        model_path=str(tmp_path / "model.bin"),
    )

    async def go():
        await backend.warm_up()
        await backend.transcribe(
            audio_path=str(audio),
            language="zh",
            initial_prompt="",
            cancel_token=CancelToken(),
            options={"dictation_mode": "translate", "target_language": "English"},
        )

    asyncio.run(go())

    assert "--translate" in arg_log.read_text(encoding="utf-8").splitlines()


def test_whisper_cli_skips_translate_flag_for_non_english_target(tmp_path):
    audio = tmp_path / "in.wav"
    audio.write_bytes(b"RIFFdummy")
    arg_log = tmp_path / "args.txt"
    cli = _make_stub_whisper_cli(tmp_path, "hello world", arg_log=arg_log)
    backend = WhisperCliBackend(
        binary=str(cli),
        model_path=str(tmp_path / "model.bin"),
    )

    async def go():
        await backend.warm_up()
        await backend.transcribe(
            audio_path=str(audio),
            language="zh",
            initial_prompt="",
            cancel_token=CancelToken(),
            options={"dictation_mode": "translate", "target_language": "Japanese"},
        )

    asyncio.run(go())

    assert "--translate" not in arg_log.read_text(encoding="utf-8").splitlines()
