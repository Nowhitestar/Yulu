import asyncio
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import realtime_transcribe


def test_subscribe_loop_sends_calendar_context(monkeypatch, tmp_path):
    observed = []

    class FakeReader:
        def __init__(self):
            self._lines = [b'{"type":"subscribed"}\n', b""]

        async def readline(self):
            return self._lines.pop(0)

    class FakeWriter:
        def write(self, data):
            observed.append(json.loads(data.decode()))

        async def drain(self):
            pass

        def close(self):
            pass

        async def wait_closed(self):
            pass

    async def fake_open_unix_connection(_socket_path):
        return FakeReader(), FakeWriter()

    monkeypatch.setattr(realtime_transcribe.asyncio, "open_unix_connection", fake_open_unix_connection)

    async def go():
        await realtime_transcribe.subscribe_loop(
            audio_path=tmp_path / "Team.wav",
            output_path=tmp_path / "Team.realtime.transcript.txt",
            socket_path=tmp_path / "stt.sock",
            sid="rt-test",
            engine="mlx",
            language="zh",
            chunk_sec=2.0,
            title="Team",
            context_prompt="参会者姓名：Lewis, Ciel。",
            unsubscribe_reason="stopped",
            stop_event=asyncio.Event(),
        )

    asyncio.run(go())
    assert observed[0]["meeting_title"] == "Team"
    assert observed[0]["context_prompt"] == "参会者姓名：Lewis, Ciel。"


def test_cli_accepts_dictation_realtime_options(monkeypatch, tmp_path):
    observed = {}

    async def fake_async_main(audio_path, title, **kwargs):
        observed["audio_path"] = audio_path
        observed["title"] = title
        observed.update(kwargs)
        return 0

    monkeypatch.setattr(realtime_transcribe, "_async_main", fake_async_main)

    audio = tmp_path / "dictation.wav"
    assert realtime_transcribe.main([
        str(audio),
        "Dictation",
        "--chunk-sec",
        "2",
        "--unsubscribe-reason",
        "dictation_stopped",
    ]) == 0

    assert observed == {
        "audio_path": audio.resolve(),
        "title": "Dictation",
        "chunk_sec_override": 2.0,
        "unsubscribe_reason": "dictation_stopped",
    }
