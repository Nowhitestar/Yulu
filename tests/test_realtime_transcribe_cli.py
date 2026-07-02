import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import realtime_transcribe


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
