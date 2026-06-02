"""CloudCommandBackend — the user's own cloud-transcription command (BUG 8).

Mirrors test_stt_backend_whisper_cli's real-stub approach (no internal mocking):
a tiny executable echoes a transcript to stdout, and the test asserts the audio
path reaches it — both via the {{input}} placeholder and via the appended-arg
fallback. Also covers the DaemonConfig loading of transcription.mode /
cloud_command.
"""

import asyncio
import json
import stat
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from stt_daemon.backends.cloud import CloudCommandBackend
from stt_daemon.config import DaemonConfig
from stt_daemon.runtime import CancelToken


def _make_stub(tmp_path: Path, name: str, body: str) -> Path:
    """Create an executable shell stub."""
    script = tmp_path / name
    script.write_text("#!/usr/bin/env bash\n" + body)
    script.chmod(script.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return script


def test_cloud_backend_passes_audio_via_placeholder(tmp_path):
    # The stub writes the path it received (its last positional arg) plus a marker
    # so the test can confirm {{input}} was substituted, not appended.
    stub = _make_stub(tmp_path, "cloud_stt", 'echo "transcribed:$2"\n')
    audio = tmp_path / "rec.wav"
    audio.write_bytes(b"RIFFdummy")
    backend = CloudCommandBackend(command=[str(stub), "--audio", "{{input}}"])

    async def go():
        await backend.warm_up()
        return await backend.transcribe(
            audio_path=str(audio), language="zh",
            initial_prompt="", cancel_token=CancelToken(),
        )

    result = asyncio.run(go())
    assert result.text == f"transcribed:{audio}"


def test_cloud_backend_appends_audio_when_no_placeholder(tmp_path):
    # No {{input}} → the audio path is appended as the final argument.
    stub = _make_stub(tmp_path, "cloud_stt", 'echo "last:${@: -1}"\n')
    audio = tmp_path / "rec.wav"
    audio.write_bytes(b"RIFFdummy")
    backend = CloudCommandBackend(command=[str(stub), "transcribe"])

    async def go():
        await backend.warm_up()
        return await backend.transcribe(
            audio_path=str(audio), language="zh",
            initial_prompt="", cancel_token=CancelToken(),
        )

    result = asyncio.run(go())
    assert result.text == f"last:{audio}"


def test_cloud_backend_nonzero_exit_raises(tmp_path):
    stub = _make_stub(tmp_path, "cloud_stt", 'echo "boom" >&2\nexit 3\n')
    backend = CloudCommandBackend(command=[str(stub)])

    async def go():
        await backend.warm_up()
        with pytest.raises(RuntimeError):
            await backend.transcribe(
                audio_path=str(tmp_path / "x.wav"), language="zh",
                initial_prompt="", cancel_token=CancelToken(),
            )

    asyncio.run(go())


def test_cloud_backend_empty_command_is_not_ready_and_raises():
    backend = CloudCommandBackend(command=[])

    async def go():
        await backend.warm_up()
        assert backend.is_ready() is False
        with pytest.raises(RuntimeError):
            await backend.transcribe(
                audio_path="/x.wav", language="zh",
                initial_prompt="", cancel_token=CancelToken(),
            )

    asyncio.run(go())


def test_cloud_backend_ready_when_command_present():
    backend = CloudCommandBackend(command=["echo"])

    async def go():
        await backend.warm_up()
        return backend.is_ready()

    assert asyncio.run(go()) is True


def test_daemon_config_loads_mode_and_cloud_command(tmp_path):
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps({
        "transcription": {
            "mode": "cloud-fallback",
            "cloud_command": ["my-cloud-stt", "--lang", "zh"],
        }
    }), encoding="utf-8")

    cfg = DaemonConfig.from_user_config(cfg_path)

    assert cfg.mode == "cloud-fallback"
    assert cfg.cloud_command == ["my-cloud-stt", "--lang", "zh"]


def test_daemon_config_defaults_to_local_mode(tmp_path):
    cfg_path = tmp_path / "config.json"
    cfg_path.write_text(json.dumps({"transcription": {}}), encoding="utf-8")

    cfg = DaemonConfig.from_user_config(cfg_path)

    assert cfg.mode == "local"
    assert cfg.cloud_command == []
