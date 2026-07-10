import sys
import wave
import json
import asyncio
import threading
import time
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
sys.path.insert(0, str(SCRIPTS))

import dictate
from prompts import PromptsRepo, Category, Source, open_db


def _write_silent_wav(path: Path, *, seconds: float = 1.0, rate: int = 16000) -> None:
    with wave.open(str(path), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(rate)
        wav.writeframes(b"\x00\x00" * int(seconds * rate))


def test_resolve_engine_prefers_dictation_config():
    cfg = {
        "transcription": {
            "final_engine": "mlx",
            "realtime": {"engine": "whisper"},
            "dictation": {"engine": "hermes"},
        }
    }
    assert dictate.resolve_engine(cfg, None) == "hermes"
    assert dictate.resolve_engine(cfg, "mlx") == "mlx"


def test_resolve_engine_auto_inherits_realtime_then_final():
    cfg = {
        "transcription": {
            "final_engine": "mlx",
            "realtime": {"engine": "whisper"},
            "dictation": {"engine": "auto"},
        }
    }
    assert dictate.resolve_engine(cfg, None) == "whisper"
    assert dictate.resolve_engine(cfg, "auto") == "whisper"

    cfg["transcription"]["realtime"] = {"engine": "auto"}
    assert dictate.resolve_engine(cfg, None) == "mlx"


def test_resolve_engine_missing_dictation_block_inherits_selected_stt():
    cfg = {
        "transcription": {
            "final_engine": "hermes",
            "realtime": {"engine": "hermes"},
        }
    }
    assert dictate.resolve_engine(cfg, None) == "hermes"


def test_translate_defaults_to_native_whisper_when_dictation_engine_is_hermes():
    cfg = {"transcription": {"dictation": {"engine": "hermes"}}}

    assert dictate.resolve_translation_engine(cfg, None, "English") == "mlx"
    assert dictate.resolve_translation_engine(cfg, "hermes", "English") == "hermes"


def test_render_context_prompt_uses_selected_prompt(tmp_path):
    db = tmp_path / "prompts.sqlite"
    repo = PromptsRepo(open_db(db))
    repo.add(
        slug="quick-dictation",
        name="Quick Dictation",
        category=Category.CLEANUP,
        content="直接粘贴：{{meeting_title}} {{date}} {{transcript}}",
        source=Source.MANUAL,
    )
    text = dictate.render_context_prompt(
        prompt_slug="quick-dictation",
        prompts_db=db,
        limit=80,
    )
    assert "直接粘贴" in text
    assert "Dictation" in text
    assert "{{transcript}}" not in text


def test_default_context_prompt_falls_back_to_seed_when_db_missing(tmp_path):
    text = dictate.render_context_prompt(
        prompt_slug="dictation-cleanup",
        prompts_db=tmp_path / "missing.sqlite",
    )
    assert "语音输入模式" in text
    assert "术语表" in text


def test_translate_context_prompt_uses_target_language(tmp_path):
    text = dictate.render_context_prompt(
        prompt_slug="dictation-translate",
        prompts_db=tmp_path / "missing.sqlite",
        target_language="Japanese",
    )
    assert "Japanese" in text
    assert "{{target_language}}" not in text


def test_prompt_id_does_not_fall_back_to_default_seed(tmp_path):
    try:
        dictate.render_context_prompt(
            prompt_slug="dictation-cleanup",
            prompt_id="missing-id",
            prompts_db=tmp_path / "missing.sqlite",
        )
    except dictate.DictationError as exc:
        assert "missing-id" in str(exc)
    else:
        raise AssertionError("expected missing prompt id to fail")


def test_start_recording_persists_prompt_id(monkeypatch, tmp_path):
    state_path = tmp_path / "dictation" / "state.json"
    calls = []

    def fake_socket_send(socket_path, payload, **kwargs):
        calls.append(payload["action"])
        if payload["action"] == "status":
            return {"recording": False}
        return {"status": "recording", "file": str(tmp_path / "dictation.wav")}

    monkeypatch.setattr(dictate, "DICTATION_DIR", tmp_path / "dictation")
    monkeypatch.setattr(dictate, "STATE_PATH", state_path)
    monkeypatch.setattr(dictate, "_socket_send", fake_socket_send)
    monkeypatch.setattr(dictate, "start_dictation_realtime", lambda *args, **kwargs: None)
    monkeypatch.setattr(
        dictate,
        "current_frontmost_app",
        lambda: {"target_app_name": "TextEdit", "target_bundle_id": "com.apple.TextEdit"},
    )

    state = dictate.start_recording(
        engine="hermes",
        language="zh",
        prompt_slug="dictation-cleanup",
        prompt_id="prompt-123",
        target_language="",
        silence_seconds=2.0,
    )
    assert calls == ["status", "start"]
    assert state["prompt_id"] == "prompt-123"
    assert state["intent"] == "dictation"
    assert state["target_bundle_id"] == "com.apple.TextEdit"
    assert '"prompt_id": "prompt-123"' in state_path.read_text(encoding="utf-8")


def test_start_recording_uses_supplied_target_without_frontmost_lookup(monkeypatch, tmp_path):
    state_path = tmp_path / "dictation" / "state.json"

    def fake_socket_send(socket_path, payload, **kwargs):
        if payload["action"] == "status":
            return {"recording": False}
        return {"status": "recording", "file": str(tmp_path / "dictation.wav")}

    def fail_frontmost():
        raise AssertionError("frontmost lookup should not run")

    monkeypatch.setattr(dictate, "DICTATION_DIR", tmp_path / "dictation")
    monkeypatch.setattr(dictate, "STATE_PATH", state_path)
    monkeypatch.setattr(dictate, "_socket_send", fake_socket_send)
    monkeypatch.setattr(dictate, "start_dictation_realtime", lambda *args, **kwargs: None)
    monkeypatch.setattr(dictate, "current_frontmost_app", fail_frontmost)

    state = dictate.start_recording(
        engine="mlx",
        language="zh",
        prompt_slug="dictation-cleanup",
        prompt_id=None,
        target_language="",
        silence_seconds=2.0,
        target_bundle_id="com.apple.TextEdit",
        target_app_name="TextEdit",
    )

    assert state["target_bundle_id"] == "com.apple.TextEdit"
    assert state["target_app_name"] == "TextEdit"


def test_start_recording_can_skip_target_capture(monkeypatch, tmp_path):
    state_path = tmp_path / "dictation" / "state.json"

    def fake_socket_send(socket_path, payload, **kwargs):
        if payload["action"] == "status":
            return {"recording": False}
        return {"status": "recording", "file": str(tmp_path / "dictation.wav")}

    def fail_frontmost():
        raise AssertionError("target capture should be skipped")

    monkeypatch.setattr(dictate, "DICTATION_DIR", tmp_path / "dictation")
    monkeypatch.setattr(dictate, "STATE_PATH", state_path)
    monkeypatch.setattr(dictate, "_socket_send", fake_socket_send)
    monkeypatch.setattr(dictate, "start_dictation_realtime", lambda *args, **kwargs: None)
    monkeypatch.setattr(dictate, "current_frontmost_app", fail_frontmost)

    state = dictate.start_recording(
        engine="hermes",
        language="zh",
        prompt_slug="dictation-cleanup",
        prompt_id=None,
        target_language="",
        silence_seconds=2.0,
        capture_target=False,
    )

    assert state["audio_path"].endswith("dictation.wav")
    assert "target_bundle_id" not in state


def test_start_recording_persists_state_when_target_capture_fails(monkeypatch, tmp_path):
    state_path = tmp_path / "dictation" / "state.json"

    def fake_socket_send(socket_path, payload, **kwargs):
        if payload["action"] == "status":
            return {"recording": False}
        return {"status": "recording", "file": str(tmp_path / "dictation.wav")}

    def fail_frontmost():
        raise subprocess.TimeoutExpired(["osascript"], 2.5)

    monkeypatch.setattr(dictate, "DICTATION_DIR", tmp_path / "dictation")
    monkeypatch.setattr(dictate, "STATE_PATH", state_path)
    monkeypatch.setattr(dictate, "_socket_send", fake_socket_send)
    monkeypatch.setattr(dictate, "start_dictation_realtime", lambda *args, **kwargs: None)
    monkeypatch.setattr(dictate, "current_frontmost_app", fail_frontmost)

    state = dictate.start_recording(
        engine="mlx",
        language="en",
        prompt_slug="dictation-cleanup",
        prompt_id=None,
        target_language="",
        silence_seconds=2.0,
        capture_target=True,
    )

    assert state["audio_path"].endswith("dictation.wav")
    assert state_path.exists()
    assert "target_bundle_id" not in state


def test_start_recording_starts_realtime_sidecar(monkeypatch, tmp_path):
    state_path = tmp_path / "dictation" / "state.json"
    audio_path = tmp_path / "dictation.wav"
    observed = {}

    def fake_socket_send(socket_path, payload, **kwargs):
        if payload["action"] == "status":
            return {"recording": False}
        return {"status": "recording", "file": str(audio_path)}

    def fake_start_realtime(path, **kwargs):
        observed["path"] = path
        observed["config"] = kwargs["config"]

    monkeypatch.setattr(dictate, "DICTATION_DIR", tmp_path / "dictation")
    monkeypatch.setattr(dictate, "STATE_PATH", state_path)
    monkeypatch.setattr(dictate, "_socket_send", fake_socket_send)
    monkeypatch.setattr(dictate, "current_frontmost_app", lambda: {})
    monkeypatch.setattr(dictate, "_config", lambda: {"transcription": {"realtime_enabled": True}})
    monkeypatch.setattr(dictate, "start_dictation_realtime", fake_start_realtime)

    state = dictate.start_recording(
        engine="mlx",
        language="zh",
        prompt_slug="dictation-cleanup",
        prompt_id=None,
        target_language="",
        silence_seconds=2.0,
        capture_target=False,
    )

    assert state["audio_path"] == str(audio_path)
    assert observed["path"] == str(audio_path)
    assert observed["config"]["transcription"]["realtime_enabled"] is True


def test_stop_recording_stops_realtime_sidecar(monkeypatch, tmp_path):
    state_path = tmp_path / "dictation" / "state.json"
    audio_path = tmp_path / "dictation.wav"
    stopped = []

    state_path.parent.mkdir(parents=True)
    state_path.write_text(json.dumps({"audio_path": str(audio_path)}), encoding="utf-8")

    def fake_socket_send(socket_path, payload, **kwargs):
        if payload["action"] == "status":
            return {"recording": True, "file": str(audio_path)}
        return {"status": "stopped", "file": str(audio_path), "duration": 1.2}

    monkeypatch.setattr(dictate, "STATE_PATH", state_path)
    monkeypatch.setattr(dictate, "_socket_send", fake_socket_send)
    monkeypatch.setattr(dictate, "stop_dictation_realtime", lambda **kwargs: stopped.append(kwargs))

    state = dictate.stop_recording()

    assert state["audio_path"] == str(audio_path)
    assert state["recording_duration_sec"] == 1.2
    assert stopped == [{"wait": True}]


def test_cancel_recording_stops_dictation_without_transcribing(monkeypatch, tmp_path):
    state_path = tmp_path / "dictation" / "state.json"
    dictation_dir = tmp_path / "dictation"
    audio_path = dictation_dir / "dictation.wav"
    calls = []
    stopped = []

    state_path.parent.mkdir(parents=True)
    state_path.write_text(json.dumps({"audio_path": str(audio_path)}), encoding="utf-8")

    def fake_socket_send(socket_path, payload, **kwargs):
        calls.append(payload["action"])
        if payload["action"] == "status":
            return {"recording": True, "file": str(audio_path)}
        return {"status": "stopped", "file": str(audio_path), "duration": 2.5}

    monkeypatch.setattr(dictate, "DICTATION_DIR", dictation_dir)
    monkeypatch.setattr(dictate, "STATE_PATH", state_path)
    monkeypatch.setattr(dictate, "_socket_send", fake_socket_send)
    monkeypatch.setattr(dictate, "stop_dictation_realtime", lambda **kwargs: stopped.append(kwargs))

    result = dictate.cancel_recording()

    assert calls == ["status", "stop"]
    assert result["action"] == "cancel"
    assert result["canceled"] is True
    assert result["stopped_recording"] is True
    assert result["text"] == ""
    assert stopped == [{"wait": False}]


def test_cancel_recording_refuses_meeting_recording(monkeypatch, tmp_path):
    state_path = tmp_path / "dictation" / "state.json"
    meeting_path = tmp_path / "meeting.wav"
    calls = []

    def fake_socket_send(socket_path, payload, **kwargs):
        calls.append(payload["action"])
        return {"recording": True, "file": str(meeting_path)}

    monkeypatch.setattr(dictate, "DICTATION_DIR", tmp_path / "dictation")
    monkeypatch.setattr(dictate, "STATE_PATH", state_path)
    monkeypatch.setattr(dictate, "_socket_send", fake_socket_send)
    monkeypatch.setattr(dictate, "stop_dictation_realtime", lambda **kwargs: None)

    with pytest.raises(dictate.DictationError, match="not dictation"):
        dictate.cancel_recording()
    assert calls == ["status"]


def test_cli_pastes_by_default():
    args = dictate.build_parser().parse_args(["once"])
    assert args.no_paste is False
    args = dictate.build_parser().parse_args(["once", "--no-paste"])
    assert args.no_paste is True


def test_manual_toggle_does_not_auto_stop_on_short_silence_by_default():
    args = dictate.build_parser().parse_args(["toggle"])
    assert args.silence_seconds == dictate.MANUAL_SILENCE_SECONDS


def test_no_copy_requires_no_paste(capsys):
    assert dictate.main(["once", "--no-copy"]) == 1
    assert "--no-copy requires --no-paste" in capsys.readouterr().err


def test_toggle_starts_when_no_active_dictation(monkeypatch, tmp_path):
    observed = {}

    monkeypatch.setattr(dictate, "_config", lambda: {"transcription": {"dictation": {"engine": "hermes"}}})
    monkeypatch.setattr(dictate, "active_dictation_state", lambda: None)

    def fake_start(**kwargs):
        observed.update(kwargs)
        return {"audio_path": str(tmp_path / "dictation.wav")}

    monkeypatch.setattr(dictate, "start_recording", fake_start)

    assert dictate.main(["toggle", "--no-paste", "--no-copy"]) == 0
    assert observed["engine"] == "hermes"
    assert observed["capture_target"] is False


def test_toggle_stops_active_dictation(monkeypatch, tmp_path):
    observed = {}
    state_path = tmp_path / "dictation" / "state.json"
    state = {
        "audio_path": str(tmp_path / "dictation.wav"),
        "engine": "hermes",
        "language": "en",
        "prompt_slug": "dictation-cleanup",
    }

    monkeypatch.setattr(dictate, "_config", lambda: {"transcription": {"dictation": {"engine": "hermes"}}})
    monkeypatch.setattr(dictate, "STATE_PATH", state_path)
    monkeypatch.setattr(dictate, "active_dictation_state", lambda: state)
    monkeypatch.setattr(dictate, "stop_recording", lambda: state)

    def fake_process(**kwargs):
        observed.update(kwargs)
        return {
            "text": "hello",
            "audio_path": str(tmp_path / "dictation.wav"),
            "engine": "hermes",
            "language": "en",
            "prompt_slug": "dictation-cleanup",
            "prompt_id": None,
            "copied": False,
            "pasted": False,
            "context_ms": 0,
            "post_stop_ms": 1,
        }

    monkeypatch.setattr(dictate, "process_audio", fake_process)

    assert dictate.main(["toggle", "--no-paste", "--no-copy"]) == 0
    assert observed["state"] == state
    assert observed["copy"] is False
    assert observed["paste"] is False


def test_main_persists_stopped_state_before_transcribe_failure(monkeypatch, tmp_path):
    state_path = tmp_path / "dictation" / "state.json"
    stopped = {
        "audio_path": str(tmp_path / "dictation.wav"),
        "engine": "mlx",
        "language": "zh",
        "prompt_slug": "dictation-cleanup",
        "stopped_at": "2026-06-30T17:50:00",
    }

    monkeypatch.setattr(dictate, "STATE_PATH", state_path)
    monkeypatch.setattr(
        dictate,
        "start_recording",
        lambda **kwargs: {"audio_path": str(tmp_path / "dictation.wav")},
    )
    monkeypatch.setattr(dictate.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(dictate, "stop_recording", lambda: stopped)

    def fail_process(**kwargs):
        raise dictate.DictationError("response timeout")

    monkeypatch.setattr(dictate, "process_audio", fail_process)

    assert dictate.main(["once", "--no-paste", "--no-copy"]) == 1
    saved = state_path.read_text(encoding="utf-8")
    assert "stopped_at" in saved
    assert "last_result" not in saved


def test_main_uses_context_limit_from_dictation_config(monkeypatch, tmp_path):
    observed = {}
    stopped = {
        "audio_path": str(tmp_path / "dictation.wav"),
        "engine": "hermes",
        "language": "en",
        "prompt_slug": "dictation-cleanup",
        "stopped_at": "2026-06-30T18:30:00",
    }

    monkeypatch.setattr(
        dictate,
        "_config",
        lambda: {"transcription": {"dictation": {"engine": "hermes", "context_limit": 123}}},
    )
    monkeypatch.setattr(
        dictate,
        "start_recording",
        lambda **kwargs: {"audio_path": str(tmp_path / "dictation.wav")},
    )
    monkeypatch.setattr(dictate.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(dictate, "stop_recording", lambda: stopped)

    def fake_process(**kwargs):
        observed.update(kwargs)
        return {
            "text": "hello",
            "audio_path": str(tmp_path / "dictation.wav"),
            "engine": "hermes",
            "language": "en",
            "prompt_slug": "dictation-cleanup",
            "prompt_id": None,
            "copied": False,
            "pasted": False,
            "context_ms": 0,
            "post_stop_ms": 1,
        }

    monkeypatch.setattr(dictate, "process_audio", fake_process)

    assert dictate.main(["once", "--no-paste", "--no-copy"]) == 0
    assert observed["context_limit"] == 123
    assert observed["timeout_sec"] > 25


def test_translate_to_uses_translate_prompt(monkeypatch, tmp_path):
    observed = {}
    state = {
        "audio_path": str(tmp_path / "dictation.wav"),
        "engine": "hermes",
        "language": "en",
        "prompt_slug": "dictation-translate",
        "target_language": "Japanese",
        "stopped_at": "2026-06-30T18:32:00",
    }

    monkeypatch.setattr(
        dictate,
        "_config",
        lambda: {"transcription": {"dictation": {"engine": "hermes", "timeout_sec": 8, "deadline_sec": 8}}},
    )
    monkeypatch.setattr(dictate, "start_recording", lambda **kwargs: state)
    monkeypatch.setattr(dictate, "stop_recording", lambda: state)
    monkeypatch.setattr(dictate.time, "sleep", lambda seconds: None)

    def fake_process(**kwargs):
        observed.update(kwargs)
        return {
            "text": "こんにちは",
            "audio_path": str(tmp_path / "dictation.wav"),
            "engine": "hermes",
            "language": "en",
            "prompt_slug": "dictation-translate",
            "prompt_id": None,
            "target_language": "Japanese",
            "copied": False,
            "pasted": False,
            "context_ms": 0,
            "post_stop_ms": 1,
        }

    monkeypatch.setattr(dictate, "process_audio", fake_process)

    assert dictate.main(["once", "--translate-to", "Japanese", "--no-paste", "--no-copy"]) == 0
    assert observed["engine"] == "hermes"
    assert observed["prompt_slug"] == "dictation-translate"
    assert observed["target_language"] == "Japanese"
    assert observed["timeout_sec"] > 15


def test_english_translate_defaults_to_native_whisper(monkeypatch, tmp_path):
    observed = {}
    state = {
        "audio_path": str(tmp_path / "dictation.wav"),
        "engine": "mlx",
        "language": "zh",
        "prompt_slug": "dictation-translate",
        "target_language": "English",
        "stopped_at": "2026-06-30T18:32:00",
    }

    monkeypatch.setattr(dictate, "_config", lambda: {"transcription": {"dictation": {"engine": "hermes"}}})
    monkeypatch.setattr(dictate, "start_recording", lambda **kwargs: state)
    monkeypatch.setattr(dictate, "stop_recording", lambda: state)
    monkeypatch.setattr(dictate.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(dictate, "process_audio", lambda **kwargs: observed.update(kwargs) or {
        "text": "hello",
        "audio_path": str(tmp_path / "dictation.wav"),
        "engine": kwargs["engine"],
        "language": "zh",
        "prompt_slug": kwargs["prompt_slug"],
        "prompt_id": None,
        "target_language": kwargs["target_language"],
        "copied": False,
        "pasted": False,
        "context_ms": 0,
        "post_stop_ms": 1,
    })

    assert dictate.main(["once", "--translate-to", "English", "--no-paste", "--no-copy"]) == 0
    assert observed["engine"] == "mlx"
    assert observed["timeout_sec"] > 15


def test_successful_dictation_appends_history(monkeypatch, tmp_path):
    history_path = tmp_path / "history.jsonl"
    state = {
        "audio_path": str(tmp_path / "dictation.wav"),
        "engine": "hermes",
        "language": "zh",
        "prompt_slug": "dictation-cleanup",
        "target_language": "",
        "stopped_at": "2026-06-30T18:32:00",
    }

    monkeypatch.setattr(dictate, "HISTORY_PATH", history_path)
    monkeypatch.setattr(dictate, "_config", lambda: {"transcription": {"dictation": {"engine": "hermes"}}})
    monkeypatch.setattr(dictate, "start_recording", lambda **kwargs: state)
    monkeypatch.setattr(dictate, "stop_recording", lambda: state)
    monkeypatch.setattr(dictate.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(
        dictate,
        "process_audio",
        lambda **kwargs: {
            "text": "测试历史",
            "audio_path": str(tmp_path / "dictation.wav"),
            "engine": "hermes",
            "language": "zh",
            "prompt_slug": "dictation-cleanup",
            "prompt_id": None,
            "target_language": "",
            "copied": False,
            "pasted": False,
            "context_ms": 0,
            "post_stop_ms": 1,
        },
    )

    assert dictate.main(["once", "--no-paste", "--no-copy"]) == 0
    rows = [json.loads(line) for line in history_path.read_text(encoding="utf-8").splitlines()]
    assert rows[0]["action"] == "dictate"
    assert rows[0]["text"] == "测试历史"


def test_plain_dictation_ignores_configured_translate_target(monkeypatch, tmp_path):
    observed = {}
    state = {
        "audio_path": str(tmp_path / "dictation.wav"),
        "engine": "hermes",
        "language": "en",
        "prompt_slug": "dictation-cleanup",
        "target_language": "",
        "stopped_at": "2026-06-30T18:32:00",
    }

    monkeypatch.setattr(
        dictate,
        "_config",
        lambda: {
            "transcription": {
                "dictation": {
                    "engine": "hermes",
                    "target_language": "English",
                    "prompt_slug": "dictation-cleanup",
                    "translate_prompt_slug": "dictation-translate",
                }
            }
        },
    )
    monkeypatch.setattr(dictate, "start_recording", lambda **kwargs: state)
    monkeypatch.setattr(dictate, "stop_recording", lambda: state)
    monkeypatch.setattr(dictate.time, "sleep", lambda seconds: None)

    def fake_process(**kwargs):
        observed.update(kwargs)
        return {
            "text": "hello",
            "audio_path": str(tmp_path / "dictation.wav"),
            "engine": "hermes",
            "language": "en",
            "prompt_slug": kwargs["prompt_slug"],
            "prompt_id": None,
            "target_language": kwargs["target_language"],
            "copied": False,
            "pasted": False,
            "context_ms": 0,
            "post_stop_ms": 1,
        }

    monkeypatch.setattr(dictate, "process_audio", fake_process)

    assert dictate.main(["once", "--no-paste", "--no-copy"]) == 0
    assert observed["prompt_slug"] == "dictation-cleanup"
    assert observed["target_language"] == ""


def test_ask_sends_voice_chat_without_clipboard(monkeypatch, tmp_path):
    observed = {}
    state = {
        "audio_path": str(tmp_path / "dictation.wav"),
        "engine": "hermes",
        "language": "en",
        "prompt_slug": "dictation-cleanup",
        "stopped_at": "2026-06-30T18:33:00",
    }

    monkeypatch.setattr(dictate, "_config", lambda: {"transcription": {"dictation": {"engine": "hermes"}}})
    monkeypatch.setattr(dictate, "start_recording", lambda **kwargs: state)
    monkeypatch.setattr(dictate, "stop_recording", lambda: state)
    monkeypatch.setattr(dictate.time, "sleep", lambda seconds: None)

    def fake_process(**kwargs):
        observed["process"] = kwargs
        return {
            "text": "what did we decide yesterday?",
            "audio_path": str(tmp_path / "dictation.wav"),
            "engine": "hermes",
            "language": "en",
            "prompt_slug": "dictation-cleanup",
            "prompt_id": None,
            "target_language": "",
            "copied": False,
            "pasted": False,
            "context_ms": 0,
            "post_stop_ms": 1,
        }

    def fake_send_voice_chat(**kwargs):
        observed["chat"] = kwargs
        return {"ok": True, "sessionId": "s1", "url": "/voice-chat?session=s1"}

    monkeypatch.setattr(dictate, "process_audio", fake_process)
    monkeypatch.setattr(dictate, "send_voice_chat", fake_send_voice_chat)

    assert dictate.main(["ask", "--session-id", "s1", "--ui-url", "http://127.0.0.1:7777", "--no-open"]) == 0
    assert observed["process"]["copy"] is False
    assert observed["process"]["paste"] is False
    assert observed["chat"]["question"] == "what did we decide yesterday?"
    assert observed["chat"]["session_id"] == "s1"
    assert observed["chat"]["open_console"] is False


def test_ask_reuses_previous_voice_chat_session(monkeypatch, tmp_path):
    observed = {"writes": []}
    state = {
        "audio_path": str(tmp_path / "dictation.wav"),
        "engine": "hermes",
        "language": "en",
        "prompt_slug": "dictation-cleanup",
        "stopped_at": "2026-06-30T18:34:00",
    }

    monkeypatch.setattr(dictate, "_state", lambda: {"voice_chat_session_id": "prev-session"})
    monkeypatch.setattr(dictate, "_config", lambda: {"transcription": {"dictation": {"engine": "hermes"}}})
    monkeypatch.setattr(dictate, "start_recording", lambda **kwargs: state)
    monkeypatch.setattr(dictate, "stop_recording", lambda: state)
    monkeypatch.setattr(dictate.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(dictate, "_write_json", lambda path, payload: observed["writes"].append(payload))
    monkeypatch.setattr(dictate, "process_audio", lambda **kwargs: {
        "text": "continue this chat",
        "audio_path": str(tmp_path / "dictation.wav"),
        "engine": "hermes",
        "language": "en",
        "prompt_slug": "dictation-cleanup",
        "prompt_id": None,
        "target_language": "",
        "copied": False,
        "pasted": False,
        "context_ms": 0,
        "post_stop_ms": 1,
    })

    def fake_send_voice_chat(**kwargs):
        observed["chat"] = kwargs
        return {"ok": True, "sessionId": "prev-session", "url": "/voice-chat?session=prev-session"}

    monkeypatch.setattr(dictate, "send_voice_chat", fake_send_voice_chat)

    assert dictate.main(["ask", "--no-open"]) == 0
    assert observed["chat"]["session_id"] == "prev-session"
    assert observed["writes"][-1]["voice_chat_session_id"] == "prev-session"


def test_ask_toggle_starts_voice_chat_recording(monkeypatch, tmp_path):
    observed = {}

    monkeypatch.setattr(dictate, "_config", lambda: {"transcription": {"dictation": {"engine": "hermes"}}})
    monkeypatch.setattr(dictate, "active_dictation_state", lambda: None)

    def fake_start(**kwargs):
        observed.update(kwargs)
        return {"audio_path": str(tmp_path / "dictation.wav"), "intent": kwargs["intent"]}

    monkeypatch.setattr(dictate, "start_recording", fake_start)

    assert dictate.main(["ask-toggle", "--no-paste", "--no-copy"]) == 0
    assert observed["intent"] == "voice_chat"
    assert observed["capture_target"] is False


def test_ask_toggle_stops_and_sends_voice_chat(monkeypatch, tmp_path):
    observed = {}
    state = {
        "audio_path": str(tmp_path / "dictation.wav"),
        "engine": "hermes",
        "language": "en",
        "prompt_slug": "dictation-cleanup",
        "intent": "voice_chat",
    }

    monkeypatch.setattr(dictate, "_config", lambda: {"transcription": {"dictation": {"engine": "hermes"}}})
    monkeypatch.setattr(dictate, "active_dictation_state", lambda: state)
    monkeypatch.setattr(dictate, "stop_recording", lambda: state)

    def fake_process(**kwargs):
        observed["process"] = kwargs
        return {
            "text": "continue this chat",
            "audio_path": str(tmp_path / "dictation.wav"),
            "engine": "hermes",
            "language": "en",
            "prompt_slug": "dictation-cleanup",
            "prompt_id": None,
            "target_language": "",
            "copied": False,
            "pasted": False,
            "context_ms": 0,
            "post_stop_ms": 1,
        }

    def fake_send_voice_chat(**kwargs):
        observed["chat"] = kwargs
        return {"ok": True, "sessionId": "s1", "url": "/voice-chat?session=s1"}

    monkeypatch.setattr(dictate, "process_audio", fake_process)
    monkeypatch.setattr(dictate, "send_voice_chat", fake_send_voice_chat)

    assert dictate.main(["ask-toggle", "--session-id", "s1", "--no-open"]) == 0
    assert observed["process"]["copy"] is False
    assert observed["process"]["paste"] is False
    assert observed["chat"]["question"] == "continue this chat"
    assert observed["chat"]["session_id"] == "s1"


def test_ask_toggle_rejects_plain_dictation(monkeypatch, tmp_path, capsys):
    state = {"audio_path": str(tmp_path / "dictation.wav"), "intent": "dictation"}

    monkeypatch.setattr(dictate, "_config", lambda: {"transcription": {"dictation": {"engine": "hermes"}}})
    monkeypatch.setattr(dictate, "active_dictation_state", lambda: state)
    monkeypatch.setattr(dictate, "stop_recording", lambda: (_ for _ in ()).throw(AssertionError("unexpected stop")))

    assert dictate.main(["ask-toggle"]) == 1
    assert "active dictation is not voice chat" in capsys.readouterr().err


def test_send_voice_chat_requests_deferred_answer(monkeypatch):
    observed = {}

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            return False

        def read(self):
            return b'{"ok":true,"sessionId":"s1","url":"/voice-chat?session=s1","answer":"","deferred":true}'

    def fake_urlopen(req, timeout):
        observed["timeout"] = timeout
        observed["url"] = req.full_url
        observed["body"] = json.loads(req.data.decode("utf-8"))
        return FakeResponse()

    monkeypatch.setattr(dictate.urllib.request, "urlopen", fake_urlopen)
    monkeypatch.setattr(dictate, "open_voice_chat_url", lambda url: observed.setdefault("opened", url))

    result = dictate.send_voice_chat(question="hello", session_id="s1", base_url="http://127.0.0.1:7777")

    assert result["ok"] is True
    assert observed["url"] == "http://127.0.0.1:7777/api/voice-chat/ask"
    assert observed["body"] == {"question": "hello", "defer": True, "sessionId": "s1"}
    assert observed["opened"] == "http://127.0.0.1:7777/voice-chat?session=s1"


def test_warm_resolves_dictation_engine(monkeypatch, capsys):
    observed = {}

    monkeypatch.setattr(dictate, "_config", lambda: {"transcription": {"dictation": {"engine": "hermes"}}})
    monkeypatch.setattr(dictate, "warm_dictation_engine", lambda **kwargs: observed.update(kwargs) or {
        "text": "warmed hermes",
        "engine": "hermes",
        "ok": True,
    })

    assert dictate.main(["warm", "--json"]) == 0
    assert observed == {"engine": "hermes", "timeout_sec": 60.0, "target_language": ""}
    assert json.loads(capsys.readouterr().out)["engine"] == "hermes"


def test_warm_translate_resolves_translation_engine(monkeypatch, capsys):
    observed = {}

    monkeypatch.setattr(dictate, "_config", lambda: {"transcription": {"dictation": {"engine": "hermes"}}})
    monkeypatch.setattr(dictate, "warm_dictation_engine", lambda **kwargs: observed.update(kwargs) or {
        "text": "warmed mlx",
        "engine": kwargs["engine"],
        "warmed_engine": kwargs["engine"],
        "target_language": kwargs["target_language"],
        "ok": True,
    })

    assert dictate.main(["warm", "--translate-to", "English", "--json"]) == 0
    assert observed == {"engine": "mlx", "timeout_sec": 60.0, "target_language": "English"}
    assert json.loads(capsys.readouterr().out)["warmed_engine"] == "mlx"


def test_warm_mlx_prewarms_realtime_backend(monkeypatch):
    import stt_cli

    observed = []

    async def fake_request(socket_path, payload, timeout):
        observed.append(payload)
        return {"type": "ok", "detail": f"warmed {payload['engine']}"}

    monkeypatch.setattr(stt_cli, "_request_response", fake_request)

    result = dictate.warm_dictation_engine(engine="mlx", timeout_sec=30)
    assert observed == [{"type": "warm_up", "engine": "mlx-realtime"}]
    assert result["engine"] == "mlx"
    assert result["warmed_engine"] == "mlx-realtime"


def test_warm_mlx_translate_prewarms_final_backend(monkeypatch):
    import stt_cli

    observed = []

    async def fake_request(socket_path, payload, timeout):
        observed.append(payload)
        return {"type": "ok", "detail": f"warmed {payload['engine']}"}

    monkeypatch.setattr(stt_cli, "_request_response", fake_request)

    result = dictate.warm_dictation_engine(engine="mlx", target_language="English", timeout_sec=30)
    assert observed == [{"type": "warm_up", "engine": "mlx"}]
    assert result["engine"] == "mlx"
    assert result["warmed_engine"] == "mlx"


def test_voice_chat_opens_status_agent_window(monkeypatch):
    observed = {}

    def fake_socket_send(path, payload, **kwargs):
        observed["path"] = path
        observed["payload"] = payload
        observed["kwargs"] = kwargs
        return {"ok": True}

    monkeypatch.setattr(dictate, "_socket_send", fake_socket_send)
    monkeypatch.setattr(dictate.subprocess, "run", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("unexpected fallback")))

    dictate.open_voice_chat_url("http://127.0.0.1:7777/voice-chat?session=s1")
    assert observed["path"] == dictate.STATUS_AGENT_SOCKET
    assert observed["payload"] == {
        "action": "open_voice_chat",
        "url": "http://127.0.0.1:7777/voice-chat?session=s1",
    }


def test_voice_chat_open_falls_back_to_browser(monkeypatch):
    observed = {}

    def fail_socket_send(*args, **kwargs):
        raise dictate.DictationError("status agent down")

    def fake_run(cmd, **kwargs):
        observed["cmd"] = cmd
        return None

    monkeypatch.setattr(dictate, "_socket_send", fail_socket_send)
    monkeypatch.setattr(dictate.subprocess, "run", fake_run)

    dictate.open_voice_chat_url("http://127.0.0.1:7777/voice-chat?session=s1")
    assert observed["cmd"] == ["open", "http://127.0.0.1:7777/voice-chat?session=s1"]


def test_paste_uses_status_agent_ipc(monkeypatch):
    observed = {}

    def fake_socket_send(path, payload, **kwargs):
        observed["path"] = path
        observed["payload"] = payload
        observed["kwargs"] = kwargs
        return {"ok": True}

    monkeypatch.setattr(dictate, "_socket_send", fake_socket_send)
    monkeypatch.setattr(
        dictate,
        "current_frontmost_app",
        lambda: {"target_app_name": "TextEdit", "target_bundle_id": "com.apple.TextEdit"},
    )
    monkeypatch.setattr(dictate.subprocess, "run", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("unexpected fallback")))

    dictate.paste_current_clipboard(text="hello", target_bundle_id="com.apple.TextEdit", target_app_name="TextEdit")
    assert observed["path"] == dictate.STATUS_AGENT_SOCKET
    assert observed["payload"] == {
        "action": "paste_clipboard",
        "target_bundle_id": "com.apple.TextEdit",
        "target_app_name": "TextEdit",
        "text": "hello",
    }
    assert observed["kwargs"]["timeout"] == 2.0


def test_paste_fallback_copies_provided_text_before_keystroke(monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return None

    monkeypatch.setattr(dictate, "_socket_send", lambda *args, **kwargs: (_ for _ in ()).throw(dictate.DictationError("down")))
    monkeypatch.setattr(dictate, "copy_to_clipboard", lambda text: calls.append(["pbcopy", text]))
    monkeypatch.setattr(dictate.subprocess, "run", fake_run)

    dictate.paste_current_clipboard(text="fresh text")

    assert calls == [
        ["pbcopy", "fresh text"],
        ["osascript", "-e", 'tell application "System Events" to keystroke "v" using command down'],
    ]


def test_paste_fallback_rejects_target_that_is_not_frontmost(monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        if cmd[0] == "osascript":
            raise AssertionError("unexpected paste keystroke")
        return None

    monkeypatch.setattr(dictate, "_socket_send", lambda *args, **kwargs: (_ for _ in ()).throw(dictate.DictationError("down")))
    monkeypatch.setattr(dictate, "copy_to_clipboard", lambda text: calls.append(["pbcopy", text]))
    monkeypatch.setattr(
        dictate,
        "current_frontmost_app",
        lambda: {"target_app_name": "loginwindow", "target_bundle_id": "com.apple.loginwindow"},
    )
    monkeypatch.setattr(dictate.subprocess, "run", fake_run)

    with pytest.raises(dictate.DictationError, match="target app not frontmost: loginwindow"):
        dictate.paste_current_clipboard(
            text="fresh text",
            target_bundle_id="dev.yulu.PasteTarget",
            target_app_name="YuluPasteTarget",
        )

    assert calls == [
        ["pbcopy", "fresh text"],
        ["open", "-b", "dev.yulu.PasteTarget"],
    ]


def test_paste_aborts_when_target_is_not_frontmost(monkeypatch):
    def fake_socket_send(*args, **kwargs):
        return {
            "ok": False,
            "error": "target_not_front",
            "front_app_name": "Tabbit",
            "front_bundle_id": "app.tabbit",
        }

    monkeypatch.setattr(dictate, "_socket_send", fake_socket_send)
    monkeypatch.setattr(
        dictate.subprocess,
        "run",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("unexpected fallback")),
    )

    with pytest.raises(dictate.DictationError, match="target app not frontmost: Tabbit"):
        dictate.paste_current_clipboard(target_bundle_id="com.apple.TextEdit", target_app_name="TextEdit")


def test_paste_falls_back_when_status_agent_sees_loginwindow(monkeypatch):
    calls = []

    def fake_socket_send(*args, **kwargs):
        return {
            "ok": False,
            "error": "target_not_front",
            "front_app_name": "loginwindow",
            "front_bundle_id": "com.apple.loginwindow",
        }

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        return None

    monkeypatch.setattr(dictate, "_socket_send", fake_socket_send)
    monkeypatch.setattr(dictate, "copy_to_clipboard", lambda text: calls.append(["pbcopy", text]))
    monkeypatch.setattr(
        dictate,
        "current_frontmost_app",
        lambda: {"target_app_name": "TextEdit", "target_bundle_id": "com.apple.TextEdit"},
    )
    monkeypatch.setattr(dictate.subprocess, "run", fake_run)

    dictate.paste_current_clipboard(text="fresh text", target_bundle_id="com.apple.TextEdit", target_app_name="TextEdit")

    assert calls == [
        ["pbcopy", "fresh text"],
        ["open", "-b", "com.apple.TextEdit"],
        ["osascript", "-e", 'tell application "System Events" to keystroke "v" using command down'],
    ]


def test_once_uses_remaining_deadline_as_timeout(monkeypatch, tmp_path):
    observed = {}
    state = {
        "audio_path": str(tmp_path / "dictation.wav"),
        "engine": "hermes",
        "language": "en",
        "prompt_slug": "dictation-cleanup",
        "stopped_at": "2026-06-30T18:35:00",
    }
    ticks = iter([100.0, 101.2, 101.6])

    monkeypatch.setattr(dictate, "_config", lambda: {"transcription": {"dictation": {"engine": "hermes"}}})
    monkeypatch.setattr(dictate, "start_recording", lambda **kwargs: state)
    monkeypatch.setattr(dictate, "stop_recording", lambda: state)
    monkeypatch.setattr(dictate.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(dictate.time, "monotonic", lambda: next(ticks))

    def fake_process(**kwargs):
        observed.update(kwargs)
        return {
            "text": "hello",
            "audio_path": str(tmp_path / "dictation.wav"),
            "engine": "hermes",
            "language": "en",
            "prompt_slug": "dictation-cleanup",
            "prompt_id": None,
            "copied": False,
            "pasted": False,
            "context_ms": 0,
            "post_stop_ms": 1,
        }

    monkeypatch.setattr(dictate, "process_audio", fake_process)

    assert dictate.main(["once", "--duration", "1.0", "--deadline-sec", "3", "--no-paste", "--no-copy"]) == 0
    assert 1.75 < observed["timeout_sec"] < 1.85


def test_once_reserves_budget_for_default_paste(monkeypatch, tmp_path):
    observed = {}
    state = {
        "audio_path": str(tmp_path / "dictation.wav"),
        "engine": "hermes",
        "language": "en",
        "prompt_slug": "dictation-cleanup",
        "stopped_at": "2026-06-30T18:35:00",
    }
    ticks = iter([100.0, 101.2, 101.6])

    monkeypatch.setattr(dictate, "_config", lambda: {"transcription": {"dictation": {"engine": "hermes"}}})
    monkeypatch.setattr(dictate, "start_recording", lambda **kwargs: state)
    monkeypatch.setattr(dictate, "stop_recording", lambda: state)
    monkeypatch.setattr(dictate.time, "sleep", lambda seconds: None)
    monkeypatch.setattr(dictate.time, "monotonic", lambda: next(ticks))

    def fake_process(**kwargs):
        observed.update(kwargs)
        return {
            "text": "hello",
            "audio_path": str(tmp_path / "dictation.wav"),
            "engine": "hermes",
            "language": "en",
            "prompt_slug": "dictation-cleanup",
            "prompt_id": None,
            "copied": True,
            "pasted": True,
            "context_ms": 0,
            "post_stop_ms": 1,
        }

    monkeypatch.setattr(dictate, "process_audio", fake_process)

    assert dictate.main(["once", "--duration", "1.0", "--deadline-sec", "3"]) == 0
    assert observed["copy"] is True
    assert observed["paste"] is True
    assert 0.95 < observed["timeout_sec"] < 1.05


def test_stop_uses_remaining_deadline_as_timeout(monkeypatch, tmp_path):
    observed = {}
    state_path = tmp_path / "dictation" / "state.json"
    state = {
        "audio_path": str(tmp_path / "dictation.wav"),
        "engine": "hermes",
        "language": "en",
        "prompt_slug": "dictation-cleanup",
    }
    ticks = iter([200.0, 200.4, 200.6])

    monkeypatch.setattr(dictate, "STATE_PATH", state_path)
    monkeypatch.setattr(dictate, "_config", lambda: {"transcription": {"dictation": {"engine": "hermes"}}})
    monkeypatch.setattr(dictate, "stop_recording", lambda: state)
    monkeypatch.setattr(dictate.time, "monotonic", lambda: next(ticks))

    def fake_process(**kwargs):
        observed.update(kwargs)
        return {
            "text": "hello",
            "audio_path": str(tmp_path / "dictation.wav"),
            "engine": "hermes",
            "language": "en",
            "prompt_slug": "dictation-cleanup",
            "prompt_id": None,
            "copied": False,
            "pasted": False,
            "context_ms": 0,
            "post_stop_ms": 1,
        }

    monkeypatch.setattr(dictate, "process_audio", fake_process)

    assert dictate.main(["stop", "--deadline-sec", "3", "--no-paste", "--no-copy"]) == 0
    assert 2.55 < observed["timeout_sec"] < 2.65


def test_extract_response_text_prefers_mic_channel():
    response = {
        "text": "",
        "channels": {
            "mic": {"text": " hello from mic "},
            "sys": {"text": "sys"},
        },
    }
    assert dictate.extract_response_text(response) == "hello from mic"


def test_transcribe_dictation_preserves_fractional_timeout(monkeypatch, tmp_path):
    observed = {}

    def fake_transcribe_file(**kwargs):
        observed.update(kwargs)
        return {"text": "ok"}

    import transcribe_client

    monkeypatch.setattr(transcribe_client, "transcribe_file", fake_transcribe_file)

    dictate.transcribe_dictation(
        audio_path=str(tmp_path / "a.wav"),
        engine="hermes",
        language="en",
        context_prompt="cleanup prompt",
        dictation_mode="dictate",
        target_language="",
        timeout_sec=1.55,
    )

    assert abs(observed["timeout_sec"] - 1.55) < 0.001
    assert observed["response_timeout_sec"] == 1.55
    assert observed["channel_split"] is False
    assert observed["context_prompt"] == "cleanup prompt"
    assert observed["meeting_title"] == ""
    assert observed["dictation_mode"] == "dictate"
    assert observed["target_language"] == ""


def test_prepare_dictation_audio_rejects_empty_wav(tmp_path):
    empty = tmp_path / "empty.wav"
    with wave.open(str(empty), "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(16000)

    with pytest.raises(dictate.DictationError, match="empty dictation audio"):
        dictate.prepare_dictation_audio(str(empty))


def test_transcribe_dictation_extracts_stereo_mic_channel(monkeypatch, tmp_path):
    stereo = tmp_path / "dictation.wav"
    left = [1000, -2000]
    right = [0, 0]
    frames = bytearray()
    for l, r in zip(left, right):
        frames += int(l).to_bytes(2, "little", signed=True)
        frames += int(r).to_bytes(2, "little", signed=True)
    with wave.open(str(stereo), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(16000)
        wav.writeframes(bytes(frames))

    observed = {}

    def fake_transcribe_file(**kwargs):
        observed.update(kwargs)
        with wave.open(kwargs["audio_path"], "rb") as wav:
            raw = wav.readframes(wav.getnframes())
            observed["channels"] = wav.getnchannels()
            observed["samples"] = [
                int.from_bytes(raw[i : i + 2], "little", signed=True)
                for i in range(0, len(raw), 2)
            ]
        observed["temp_exists_during_call"] = Path(kwargs["audio_path"]).exists()
        return {"text": "ok"}

    import transcribe_client

    monkeypatch.setattr(transcribe_client, "transcribe_file", fake_transcribe_file)

    dictate.transcribe_dictation(
        audio_path=str(stereo),
        engine="hermes",
        language="en",
        context_prompt="",
        dictation_mode="translate",
        target_language="English",
        timeout_sec=3.0,
    )

    assert observed["audio_path"] != str(stereo)
    assert observed["channels"] == 1
    assert observed["samples"] == left
    assert observed["temp_exists_during_call"] is True
    assert observed["dictation_mode"] == "translate"
    assert observed["target_language"] == "English"
    assert not Path(observed["audio_path"]).exists()


def test_prepare_dictation_audio_downsamples_48k_stereo(monkeypatch, tmp_path):
    stereo = tmp_path / "dictation.wav"
    with wave.open(str(stereo), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(48000)
        wav.writeframes(b"\x01\x00\x00\x00" * 480)

    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        out = Path(cmd[-1])
        with wave.open(str(out), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b"\x01\x00" * 160)
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(dictate.subprocess, "run", fake_run)

    out_path, tmp_path_out = dictate.prepare_dictation_audio(str(stereo))
    try:
        assert tmp_path_out is not None
        assert out_path != str(stereo)
        assert Path(calls[0][0][0]).name == "ffmpeg"
        assert calls[0][0][calls[0][0].index("-af") + 1] == "pan=mono|c0=c0"
        assert calls[0][0][calls[0][0].index("-ar") + 1] == "16000"
        with wave.open(out_path, "rb") as wav:
            assert wav.getnchannels() == 1
            assert wav.getframerate() == 16000
    finally:
        if tmp_path_out is not None:
            tmp_path_out.unlink(missing_ok=True)


def test_resolve_ffmpeg_uses_fallback_when_path_is_minimal(monkeypatch, tmp_path):
    ffmpeg = tmp_path / "ffmpeg"
    ffmpeg.write_text("#!/bin/sh\n", encoding="utf-8")
    ffmpeg.chmod(0o755)

    monkeypatch.setenv("PATH", "")
    monkeypatch.setattr(dictate, "FFMPEG_FALLBACKS", (ffmpeg,))

    assert dictate._resolve_ffmpeg() == str(ffmpeg)


def test_prepare_dictation_audio_trims_outer_silence_after_downsample(monkeypatch, tmp_path):
    stereo = tmp_path / "dictation.wav"
    with wave.open(str(stereo), "wb") as wav:
        wav.setnchannels(2)
        wav.setsampwidth(2)
        wav.setframerate(48000)
        wav.writeframes(b"\x01\x00\x00\x00" * 48000 * 3)

    def fake_run(cmd, **kwargs):
        out = Path(cmd[-1])
        silence = b"\x00\x00" * 16000
        active_sample = int(6000).to_bytes(2, "little", signed=True)
        active = active_sample * 16000
        with wave.open(str(out), "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(silence + active + silence)
        return subprocess.CompletedProcess(cmd, 0)

    monkeypatch.setattr(dictate.subprocess, "run", fake_run)

    out_path, tmp_path_out, stats = dictate._prepare_dictation_audio_with_stats(str(stereo))
    try:
        assert tmp_path_out is not None
        assert out_path != str(stereo)
        with wave.open(out_path, "rb") as wav:
            assert wav.getnchannels() == 1
            assert wav.getframerate() == 16000
            assert wav.getnframes() < 16000 * 3
        assert stats["audio_input_ms"] == 3000
        assert 0 < stats["stt_audio_ms"] < stats["audio_input_ms"]
        assert stats["trim_leading_ms"] > 0
        assert stats["stt_audio_bytes"] < stats["audio_input_bytes"]
    finally:
        if tmp_path_out is not None:
            tmp_path_out.unlink(missing_ok=True)


def test_normalize_text_removes_cjk_spacing_but_keeps_words():
    assert dictate.normalize_text("差 嘛 ， 包 括 AgentKey test") == "差嘛，包括 AgentKey test"


def test_process_audio_copies_text(monkeypatch, tmp_path):
    copied = []

    monkeypatch.setattr(
        dictate,
        "render_context_prompt",
        lambda **kwargs: "context",
    )
    monkeypatch.setattr(
        dictate,
        "transcribe_dictation",
        lambda **kwargs: {
            "text": " hello   github ",
            "engine_used": "hermes",
            "language_used": "zh",
            "prepare_ms": 11,
            "stt_ms": 22,
            "audio_input_bytes": 300,
            "stt_audio_bytes": 120,
            "audio_input_ms": 3000,
            "stt_audio_ms": 1400,
            "trim_leading_ms": 700,
        },
    )
    monkeypatch.setattr(dictate, "postprocess_dictation", lambda **kwargs: kwargs["text"])
    monkeypatch.setattr(dictate, "copy_to_clipboard", lambda text: copied.append(text))

    result = dictate.process_audio(
        state={"audio_path": str(tmp_path / "a.wav")},
        engine="hermes",
        language="zh",
        prompt_slug="dictation-cleanup",
        prompt_id=None,
        target_language="",
        timeout_sec=3.0,
        copy=True,
        paste=False,
        context_limit=800,
    )
    assert result["text"] == "hello github"
    assert result["copied"] is True
    assert result["post_stop_ms"] >= 0
    assert result["prepare_ms"] == 11
    assert result["stt_ms"] == 22
    assert result["postprocess_ms"] == 0
    assert result["copy_ms"] >= 0
    assert result["paste_ms"] == 0
    assert result["audio_input_bytes"] == 300
    assert result["stt_audio_bytes"] == 120
    assert result["audio_input_ms"] == 3000
    assert result["stt_audio_ms"] == 1400
    assert result["trim_leading_ms"] == 700
    assert copied == ["hello github"]


def test_process_audio_reuses_realtime_transcript(monkeypatch, tmp_path):
    audio = tmp_path / "dictation.wav"
    _write_silent_wav(audio, seconds=1.0)
    audio.with_suffix(".realtime.transcript.txt").write_text(
        "[Me] hello realtime\n[Me] from sidecar",
        encoding="utf-8",
    )
    copied = []

    monkeypatch.setattr(dictate, "render_context_prompt", lambda **kwargs: "context")
    monkeypatch.setattr(
        dictate,
        "transcribe_dictation",
        lambda **kwargs: pytest.fail("full STT should not run when realtime transcript is reusable"),
    )
    monkeypatch.setattr(dictate, "postprocess_dictation", lambda **kwargs: kwargs["text"])
    monkeypatch.setattr(dictate, "copy_to_clipboard", lambda text: copied.append(text))

    result = dictate.process_audio(
        state={"audio_path": str(audio)},
        engine="mlx",
        language="zh",
        prompt_slug="dictation-cleanup",
        prompt_id=None,
        target_language="",
        timeout_sec=3.0,
        copy=True,
        paste=False,
        context_limit=800,
    )

    assert result["text"] == "hello realtime from sidecar"
    assert result["engine"] == "realtime"
    assert result["stt_ms"] == 0
    assert copied == ["hello realtime from sidecar"]


@pytest.mark.parametrize(
    ("seconds", "covered_ms", "realtime_text"),
    [
        (60.0, 1_000, "[Me] partial only"),
        (120.0, 120_000, "[Me] ok"),
    ],
    ids=["coverage-short", "text-sparse"],
)
def test_process_audio_falls_back_when_realtime_is_untrustworthy(
    monkeypatch, tmp_path, seconds, covered_ms, realtime_text
):
    audio = tmp_path / "dictation.wav"
    _write_silent_wav(audio, seconds=seconds)
    audio.with_suffix(".realtime.transcript.txt").write_text(realtime_text, encoding="utf-8")
    audio.with_suffix(".realtime.coverage.json").write_text(
        json.dumps({"covered_ms": covered_ms}), encoding="utf-8"
    )

    monkeypatch.setattr(dictate, "render_context_prompt", lambda **kwargs: "context")
    monkeypatch.setattr(
        dictate,
        "transcribe_dictation",
        lambda **kwargs: {"text": " full result ", "engine_used": "mlx", "language_used": "zh"},
    )
    monkeypatch.setattr(dictate, "postprocess_dictation", lambda **kwargs: kwargs["text"])

    result = dictate.process_audio(
        state={"audio_path": str(audio)},
        engine="mlx",
        language="zh",
        prompt_slug="dictation-cleanup",
        prompt_id=None,
        target_language="",
        timeout_sec=3.0,
        copy=False,
        paste=False,
        context_limit=800,
    )

    assert result["text"] == "full result"
    assert result["engine"] == "mlx"


def test_process_audio_runs_dictation_prompt_postprocess(monkeypatch, tmp_path):
    copied = []

    monkeypatch.setattr(dictate, "render_context_prompt", lambda **kwargs: "cleanup context")
    monkeypatch.setattr(
        dictate,
        "transcribe_dictation",
        lambda **kwargs: {"text": "github, 呃, codex", "engine_used": "mlx", "language_used": "zh"},
    )
    monkeypatch.setattr(dictate, "glossary_hint", lambda **kwargs: "常见术语：GitHub => GitHub")
    monkeypatch.setattr(dictate, "_run_hermes_xai_chat_prompt", lambda *args, **kwargs: "GitHub Codex")
    monkeypatch.setattr(dictate, "copy_to_clipboard", lambda text: copied.append(text))

    result = dictate.process_audio(
        state={"audio_path": str(tmp_path / "a.wav")},
        engine="mlx",
        language="zh",
        prompt_slug="dictation-cleanup",
        prompt_id=None,
        target_language="",
        timeout_sec=3.0,
        copy=True,
        paste=False,
        context_limit=800,
    )

    assert result["text"] == "GitHub Codex"
    assert result["postprocess_ms"] >= 0
    assert copied == ["GitHub Codex"]


def test_process_audio_translate_runs_agent_postprocess(monkeypatch, tmp_path):
    copied = []
    calls = []

    monkeypatch.setattr(dictate, "render_context_prompt", lambda **kwargs: "translate context")
    monkeypatch.setattr(
        dictate,
        "transcribe_dictation",
        lambda **kwargs: {"text": "也不容易，也是，呃", "engine_used": "hermes", "language_used": "zh"},
    )
    monkeypatch.setattr(dictate, "glossary_hint", lambda **kwargs: "常见术语：AgentKey => AgentKey")
    monkeypatch.setattr(dictate, "_config", lambda: {"llm": {"enabled": True, "agent": {"provider": "hermes"}}})
    monkeypatch.setattr(dictate, "_run_hermes_xai_chat_prompt", lambda *args, **kwargs: "")
    monkeypatch.setattr(dictate, "copy_to_clipboard", lambda text: copied.append(text))

    def fake_run(cmd, **kwargs):
        calls.append([cmd, kwargs])
        assert cmd[:2] == ["hermes", "-z"]
        assert "translate context" in cmd[2]
        assert "AgentKey => AgentKey" in cmd[2]
        assert "也不容易" in cmd[2]
        return subprocess.CompletedProcess(cmd, 0, stdout="It's not easy either.", stderr="")

    monkeypatch.setattr(dictate.subprocess, "run", fake_run)

    result = dictate.process_audio(
        state={"audio_path": str(tmp_path / "a.wav")},
        engine="hermes",
        language="zh",
        prompt_slug="dictation-translate",
        prompt_id=None,
        target_language="English",
        timeout_sec=3.0,
        copy=True,
        paste=False,
        context_limit=800,
    )

    assert result["text"] == "It's not easy either."
    assert copied == ["It's not easy either."]
    assert calls


def test_hermes_postprocess_uses_xai_fast_path(monkeypatch):
    monkeypatch.setattr(dictate, "_run_hermes_xai_chat_prompt", lambda *args, **kwargs: "Fast translation")
    monkeypatch.setattr(dictate.subprocess, "run", lambda *args, **kwargs: pytest.fail("subprocess should be skipped"))

    result = dictate._run_agent_prompt(
        "Translate this.",
        config={"llm": {"enabled": True, "agent": {"provider": "hermes"}}},
        timeout_sec=3.0,
    )

    assert result == "Fast translation"


def test_hermes_postprocess_falls_back_when_xai_fast_path_unavailable(monkeypatch):
    calls = []
    monkeypatch.setattr(dictate, "_run_hermes_xai_chat_prompt", lambda *args, **kwargs: "")

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        assert str(Path.home() / ".local/bin") in kwargs["env"]["PATH"].split(":")
        return subprocess.CompletedProcess(cmd, 0, stdout="Fallback translation", stderr="")

    monkeypatch.setattr(dictate.subprocess, "run", fake_run)

    result = dictate._run_agent_prompt(
        "Translate this.",
        config={"llm": {"enabled": True, "agent": {"provider": "hermes"}}},
        timeout_sec=3.0,
    )

    assert result == "Fallback translation"
    assert calls and calls[0][:2] == ["hermes", "-z"]


def test_dictation_postprocess_prompt_discourages_homophone_rewrites(monkeypatch):
    captured = {}

    def fake_fast(prompt, **kwargs):
        captured["prompt"] = prompt
        return "清理后"

    monkeypatch.setattr(dictate, "glossary_hint", lambda **kwargs: "")
    monkeypatch.setattr(dictate, "_run_hermes_xai_chat_prompt", fake_fast)

    assert dictate.postprocess_dictation(
        text="把请求路由到另外一个",
        context_prompt="听写清理",
        timeout_sec=3.0,
        config={},
    ) == "清理后"
    assert "近音词" in captured["prompt"]
    assert "已经识别出的词" in captured["prompt"]


def test_dictation_postprocess_preserves_short_recognized_cjk_terms(monkeypatch):
    monkeypatch.setattr(dictate, "glossary_hint", lambda **kwargs: "")
    monkeypatch.setattr(
        dictate,
        "_run_hermes_xai_chat_prompt",
        lambda *args, **kwargs: "把进球自动路由到另外一个",
    )

    assert dictate.postprocess_dictation(
        text="把请求自动路由到另外一个",
        context_prompt="听写清理",
        timeout_sec=3.0,
        config={},
    ) == "把请求自动路由到另外一个"


def test_process_audio_uses_native_english_translation(monkeypatch, tmp_path):
    copied = []

    monkeypatch.setattr(dictate, "render_context_prompt", lambda **kwargs: "translate context")
    monkeypatch.setattr(
        dictate,
        "transcribe_dictation",
        lambda **kwargs: {"text": "It's not easy either.", "engine_used": "mlx", "language_used": "zh"},
    )
    monkeypatch.setattr(dictate, "postprocess_translation", lambda **kwargs: pytest.fail("postprocess should be skipped"))
    monkeypatch.setattr(dictate, "copy_to_clipboard", lambda text: copied.append(text))

    result = dictate.process_audio(
        state={"audio_path": str(tmp_path / "a.wav")},
        engine="mlx",
        language="zh",
        prompt_slug="dictation-translate",
        prompt_id=None,
        target_language="English",
        timeout_sec=3.0,
        copy=True,
        paste=False,
        context_limit=800,
    )

    assert result["text"] == "It's not easy either."
    assert copied == ["It's not easy either."]


def test_process_audio_does_not_send_template_to_mlx_stt(monkeypatch, tmp_path):
    observed = {}

    monkeypatch.setattr(dictate, "render_context_prompt", lambda **kwargs: "语音输入模式：清理文本。")

    def fake_transcribe(**kwargs):
        observed.update(kwargs)
        return {"text": "Clean text.", "engine_used": "mlx", "language_used": "zh"}

    monkeypatch.setattr(dictate, "transcribe_dictation", fake_transcribe)
    monkeypatch.setattr(dictate, "postprocess_translation", lambda **kwargs: pytest.fail("native English translation should skip postprocess"))

    result = dictate.process_audio(
        state={"audio_path": str(tmp_path / "a.wav")},
        engine="mlx",
        language="zh",
        prompt_slug="dictation-translate",
        prompt_id=None,
        target_language="English",
        timeout_sec=3.0,
        copy=False,
        paste=False,
        context_limit=800,
    )

    assert result["text"] == "Clean text."
    assert observed["context_prompt"] == ""


def test_process_audio_falls_back_when_native_translation_returns_source(monkeypatch, tmp_path):
    copied = []

    monkeypatch.setattr(dictate, "render_context_prompt", lambda **kwargs: "translate context")
    monkeypatch.setattr(
        dictate,
        "transcribe_dictation",
        lambda **kwargs: {"text": "这还是中文", "engine_used": "mlx", "language_used": "zh"},
    )
    monkeypatch.setattr(dictate, "postprocess_translation", lambda **kwargs: "This is still Chinese.")
    monkeypatch.setattr(dictate, "copy_to_clipboard", lambda text: copied.append(text))

    result = dictate.process_audio(
        state={"audio_path": str(tmp_path / "a.wav")},
        engine="mlx",
        language="zh",
        prompt_slug="dictation-translate",
        prompt_id=None,
        target_language="English",
        timeout_sec=30.0,
        copy=True,
        paste=False,
        context_limit=800,
    )

    assert result["text"] == "This is still Chinese."
    assert result["postprocess_ms"] >= 0
    assert copied == ["This is still Chinese."]


def test_process_audio_skips_english_translation_when_already_english(monkeypatch, tmp_path):
    copied = []

    monkeypatch.setattr(dictate, "render_context_prompt", lambda **kwargs: "translate context")
    monkeypatch.setattr(
        dictate,
        "transcribe_dictation",
        lambda **kwargs: {"text": "Hello AgentKey", "engine_used": "hermes", "language_used": "en"},
    )
    monkeypatch.setattr(dictate, "postprocess_translation", lambda **kwargs: pytest.fail("postprocess should be skipped"))
    monkeypatch.setattr(dictate, "copy_to_clipboard", lambda text: copied.append(text))

    result = dictate.process_audio(
        state={"audio_path": str(tmp_path / "a.wav")},
        engine="hermes",
        language="zh",
        prompt_slug="dictation-translate",
        prompt_id=None,
        target_language="English",
        timeout_sec=3.0,
        copy=True,
        paste=False,
        context_limit=800,
    )

    assert result["text"] == "Hello AgentKey"
    assert copied == ["Hello AgentKey"]


def test_process_audio_translate_does_not_copy_source_on_postprocess_timeout(monkeypatch, tmp_path):
    copied = []

    monkeypatch.setattr(dictate, "render_context_prompt", lambda **kwargs: "translate context")
    monkeypatch.setattr(
        dictate,
        "transcribe_dictation",
        lambda **kwargs: {"text": "也不容易，也是，呃", "engine_used": "hermes", "language_used": "zh"},
    )
    monkeypatch.setattr(dictate, "_config", lambda: {"llm": {"enabled": True, "agent": {"provider": "hermes"}}})
    monkeypatch.setattr(dictate, "_run_hermes_xai_chat_prompt", lambda *args, **kwargs: "")
    monkeypatch.setattr(dictate, "copy_to_clipboard", lambda text: copied.append(text))

    def fail_run(cmd, **kwargs):
        raise subprocess.TimeoutExpired(cmd, kwargs["timeout"])

    monkeypatch.setattr(dictate.subprocess, "run", fail_run)

    with pytest.raises(dictate.DictationError, match="postprocess timeout"):
        dictate.process_audio(
            state={"audio_path": str(tmp_path / "a.wav")},
            engine="hermes",
            language="zh",
            prompt_slug="dictation-translate",
            prompt_id=None,
            target_language="English",
            timeout_sec=3.0,
            copy=True,
            paste=False,
            context_limit=800,
        )
    assert copied == []


def test_process_audio_round_trips_through_stt_daemon(monkeypatch, tmp_path):
    from socket_helpers import short_socket_dir
    from stt_daemon.app import STTDaemonApp
    from stt_daemon.config import DaemonConfig
    from stt_daemon.runtime import MockSTTBackend
    from vocab import VocabRepo, open_db

    db = tmp_path / "vocab.sqlite"
    VocabRepo(open_db(db))
    cfg = DaemonConfig(
        socket_path=short_socket_dir() / "stt.sock",
        vocab_db_path=db,
        pid_file=tmp_path / "stt.pid",
        log_path=None,
        sessions_dir=tmp_path / "sessions",
    )
    backend = MockSTTBackend(canned_text=" hello   github ")
    app_ref = {}
    stop = threading.Event()
    started = threading.Event()

    def worker():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        app = STTDaemonApp(cfg, backends={"mlx": backend})
        app_ref["loop"] = loop
        app_ref["app"] = app
        loop.run_until_complete(app.start())
        started.set()

        async def wait_stop():
            while not stop.is_set():
                await asyncio.sleep(0.05)
            await app.stop()

        loop.run_until_complete(wait_stop())
        loop.close()

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()
    assert started.wait(timeout=5)
    deadline = time.time() + 5
    while time.time() < deadline and not cfg.socket_path.exists():
        time.sleep(0.05)
    assert cfg.socket_path.exists()

    audio = tmp_path / "dictation.wav"
    audio.write_bytes(b"RIFFstub")
    monkeypatch.setattr(dictate, "STT_SOCKET", cfg.socket_path)
    monkeypatch.setattr(dictate, "postprocess_dictation", lambda **kwargs: kwargs["text"])
    try:
        result = dictate.process_audio(
            state={"audio_path": str(audio)},
            engine="mlx",
            language="en",
            prompt_slug="dictation-cleanup",
            prompt_id=None,
            target_language="",
            timeout_sec=3.0,
            copy=False,
            paste=False,
            context_limit=240,
        )
    finally:
        stop.set()
        thread.join(timeout=5)

    assert result["text"] == "hello github"
    assert result["copied"] is False
    assert result["pasted"] is False
    assert backend.last_options["job_kind"] == "dictation"
    assert backend.last_options["dictation_mode"] == "dictate"
    assert "语音输入模式" not in (backend.last_initial_prompt or "")


def test_process_audio_pastes_to_recorded_target(monkeypatch, tmp_path):
    writes = []

    monkeypatch.setattr(
        dictate,
        "render_context_prompt",
        lambda **kwargs: "context",
    )
    monkeypatch.setattr(
        dictate,
        "transcribe_dictation",
        lambda **kwargs: {"text": " hello ", "engine_used": "hermes", "language_used": "en"},
    )
    monkeypatch.setattr(dictate, "postprocess_dictation", lambda **kwargs: kwargs["text"])
    monkeypatch.setattr(dictate, "copy_to_clipboard", lambda text: None)
    monkeypatch.setattr(
        dictate,
        "write_current_text",
        lambda **kwargs: writes.append(kwargs) or {
            "pasted": True,
            "paste_method": "accessibility",
        },
    )

    result = dictate.process_audio(
        state={
            "audio_path": str(tmp_path / "a.wav"),
            "target_bundle_id": "com.apple.TextEdit",
            "target_app_name": "TextEdit",
        },
        engine="hermes",
        language="en",
        prompt_slug="dictation-cleanup",
        prompt_id=None,
        target_language="",
        timeout_sec=3.0,
        copy=True,
        paste=True,
        context_limit=800,
    )
    assert result["pasted"] is True
    assert result["paste_method"] == "accessibility"
    assert writes == [{"text": "hello", "target_bundle_id": "com.apple.TextEdit", "target_app_name": "TextEdit"}]


def test_write_current_text_preserves_unverified_keystroke_result(monkeypatch):
    monkeypatch.setattr(
        dictate,
        "paste_current_clipboard",
        lambda **kwargs: {"ok": True, "method": "keystroke", "verified": False},
    )
    result = dictate.write_current_text(text="hello")
    assert result["paste_method"] == "keystroke"
    assert result["paste_verified"] is False


def test_clipboard_and_paste_helpers_have_timeouts(monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append((cmd, kwargs))
        class R:
            returncode = 0
            stdout = "TextEdit\ncom.apple.TextEdit\n"
        return R()

    monkeypatch.setattr(dictate.subprocess, "run", fake_run)
    monkeypatch.setattr(dictate, "_socket_send", lambda *args, **kwargs: (_ for _ in ()).throw(dictate.DictationError("down")))
    monkeypatch.setattr(
        dictate,
        "current_frontmost_app",
        lambda: {"target_app_name": "TextEdit", "target_bundle_id": "com.apple.TextEdit"},
    )

    dictate.copy_to_clipboard("hello")
    dictate.paste_current_clipboard(target_bundle_id="com.apple.TextEdit")

    assert calls[0][0] == ["pbcopy"]
    assert calls[0][1]["timeout"] == 0.5
    assert calls[1][0] == ["open", "-b", "com.apple.TextEdit"]
    assert calls[1][1]["timeout"] == 0.8
    assert calls[2][1]["timeout"] == 0.8


def test_activate_timeout_does_not_block_paste(monkeypatch):
    calls = []

    def fake_run(cmd, **kwargs):
        calls.append(cmd)
        if cmd[:2] == ["open", "-b"]:
            raise dictate.subprocess.TimeoutExpired(cmd, kwargs["timeout"])
        return None

    monkeypatch.setattr(dictate.subprocess, "run", fake_run)
    monkeypatch.setattr(dictate, "_socket_send", lambda *args, **kwargs: (_ for _ in ()).throw(dictate.DictationError("down")))
    monkeypatch.setattr(
        dictate,
        "current_frontmost_app",
        lambda: {"target_app_name": "TextEdit", "target_bundle_id": "com.apple.TextEdit"},
    )

    dictate.paste_current_clipboard(target_bundle_id="com.apple.TextEdit")
    assert calls[-1] == ["osascript", "-e", 'tell application "System Events" to keystroke "v" using command down']
