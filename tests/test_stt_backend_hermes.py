import asyncio
import sys
import types
from pathlib import Path

SCRIPTS = Path(__file__).resolve().parents[1] / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

from stt_daemon.backends.hermes import HermesSTTBackend
from stt_daemon.runtime import CancelToken


def _clear_fake_hermes_modules():
    for name in list(sys.modules):
        if name == "tools" or name.startswith("tools."):
            sys.modules.pop(name, None)


def _write_tools_package(root: Path, transcription_tools: str, xai_http: str = ""):
    tools = root / "tools"
    tools.mkdir()
    (tools / "__init__.py").write_text("", encoding="utf-8")
    (tools / "transcription_tools.py").write_text(transcription_tools, encoding="utf-8")
    (tools / "xai_http.py").write_text(xai_http or "def noop(): pass\n", encoding="utf-8")


def test_hermes_backend_delegates_to_default_hermes_transcribe_audio(tmp_path):
    _clear_fake_hermes_modules()
    audio = tmp_path / "clip.wav"
    audio.write_bytes(b"RIFF")
    _write_tools_package(
        tmp_path,
        """
def _load_stt_config():
    return {"provider": "local"}

def _get_provider(config):
    return config["provider"]

def transcribe_audio(file_path, model=None):
    return {
        "success": True,
        "provider": "local",
        "transcript": "hello from hermes",
        "segments": [{"start": 0.0, "end": 1.0, "text": "hello from hermes"}],
    }
""",
    )

    backend = HermesSTTBackend(agent_dir=str(tmp_path), diarize=False)

    async def go():
        return await backend.transcribe(
            audio_path=str(audio),
            language="en",
            initial_prompt="",
            cancel_token=CancelToken(),
        )

    result = asyncio.run(go())

    assert result.text == "hello from hermes"
    assert result.segments == [
        {
            "start": 0.0,
            "end": 1.0,
            "start_ms": 0,
            "end_ms": 1000,
            "text": "hello from hermes",
            "provider": "local",
        }
    ]


def test_hermes_backend_passes_initial_prompt_when_tool_accepts_it(tmp_path):
    _clear_fake_hermes_modules()
    audio = tmp_path / "clip.wav"
    audio.write_bytes(b"RIFF")
    _write_tools_package(
        tmp_path,
        """
def _load_stt_config():
    return {"provider": "local"}

def _get_provider(config):
    return config["provider"]

def transcribe_audio(file_path, model=None, initial_prompt=""):
    return {
        "success": True,
        "provider": "local",
        "transcript": initial_prompt,
    }
""",
    )

    backend = HermesSTTBackend(agent_dir=str(tmp_path), diarize=False)

    async def go():
        return await backend.transcribe(
            audio_path=str(audio),
            language="zh",
            initial_prompt="使用术语表：AgentKey",
            cancel_token=CancelToken(),
        )

    result = asyncio.run(go())

    assert result.text == "使用术语表：AgentKey"


def test_hermes_backend_uses_xai_stt_diarization_without_yulu_stt(tmp_path, monkeypatch):
    _clear_fake_hermes_modules()
    audio = tmp_path / "clip.wav"
    audio.write_bytes(b"RIFF")
    _write_tools_package(
        tmp_path,
        """
XAI_STT_BASE_URL = "https://api.x.ai/v1"

def _load_stt_config():
    return {"provider": "xai", "xai": {"language": "zh"}}

def _get_provider(config):
    return config["provider"]

def get_env_value(name):
    return None
""",
        """
def resolve_xai_http_credentials():
    return {"api_key": "test-key", "base_url": "https://xai.test/v1"}

def hermes_xai_user_agent():
    return "HermesTest"
""",
    )
    calls = []

    class FakeResponse:
        def raise_for_status(self):
            return None

        def json(self):
            return {
                "text": "你好 世界",
                "language": "zh",
                "duration": 2.0,
                "segments": [
                    {"start": 0.0, "end": 1.0, "text": "你好", "speaker": "Alice"},
                    {"start": 1.0, "end": 2.0, "text": "世界", "speaker": "Bob"},
                ],
            }

    def fake_post(url, *, headers, files, data, timeout):
        calls.append({"url": url, "headers": headers, "data": data, "timeout": timeout})
        assert "file" in files
        return FakeResponse()

    monkeypatch.setitem(sys.modules, "requests", types.SimpleNamespace(post=fake_post))
    backend = HermesSTTBackend(agent_dir=str(tmp_path), diarize=True)

    async def go():
        return await backend.transcribe(
            audio_path=str(audio),
            language="zh",
            initial_prompt="使用术语表：AgentKey",
            cancel_token=CancelToken(),
            options={"job_kind": "final_transcribe", "timeout_sec": 3},
        )

    result = asyncio.run(go())

    assert calls == [
        {
            "url": "https://xai.test/v1/stt",
            "headers": {"Authorization": "Bearer test-key", "User-Agent": "HermesTest"},
            "data": {
                "language": "zh",
                "format": "true",
                "prompt": "使用术语表：AgentKey",
                "diarize": "true",
            },
            "timeout": 3.0,
        }
    ]
    assert result.text == "你好 世界"
    assert result.language == "zh"
    assert result.duration_ms == 2000
    assert [seg["speaker_idx"] for seg in result.segments] == [0, 1]
    assert [seg["speaker_label"] for seg in result.segments] == ["Alice", "Bob"]
    assert all(seg["provider"] == "xai" for seg in result.segments)

    async def live_chunk():
        return await backend.transcribe(
            audio_path=str(audio),
            language="zh",
            initial_prompt="",
            cancel_token=CancelToken(),
            options={"job_kind": "live_chunk"},
        )

    asyncio.run(live_chunk())
    assert calls[-1]["data"] == {"language": "zh", "format": "true"}

    async def fractional_timeout():
        return await backend.transcribe(
            audio_path=str(audio),
            language="zh",
            initial_prompt="cleanup prompt",
            cancel_token=CancelToken(),
            options={"job_kind": "dictation", "timeout_sec": 0.55},
        )

    asyncio.run(fractional_timeout())
    assert calls[-1]["timeout"] == 0.55
    assert calls[-1]["data"] == {"language": "zh", "prompt": "cleanup prompt"}
