import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRIVACY = ROOT / "yulu" / "scripts" / "privacy_opt_in.py"


def load_privacy():
    spec = importlib.util.spec_from_file_location("privacy_opt_in", PRIVACY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_empty_config_reports_local_yulu_audio_defaults():
    mod = load_privacy()

    report = mod.privacy_opt_in_report({})

    assert report["ok"] is True
    assert report["transcription"]["owner"] == "yulu"
    assert report["transcription"]["provider"] == "local"
    assert report["transcription"]["yulu_executor"] is True
    assert report["transcription"]["cloud_audio_opt_in"] is False
    assert report["conversation"]["provider"] == "hermes"
    assert report["conversation"]["yulu_executor"] is False
    assert report["summary_delivery"]["auto_channel"] == "file"
    assert report["summary_delivery"]["external_opt_in_channels"] == []


def test_disabled_agent_pipeline_does_not_disable_audio_engine():
    mod = load_privacy()

    report = mod.privacy_opt_in_report({
        "agent_pipeline": {"enabled": False}
    })

    assert report["ok"] is False
    assert report["transcription"]["ok"] is True


def test_external_summary_opt_ins_are_reported():
    mod = load_privacy()

    report = mod.privacy_opt_in_report({
        "llm": {"agent": {"provider": "hermes"}},
        "agent_pipeline": {"auto_send_notion": True},
    })

    assert report["ok"] is True
    assert report["transcription"]["provider"] == "local"
    assert report["summary_delivery"]["auto_external_opt_in"] is True
    assert report["summary_delivery"]["external_opt_in_channels"] == ["notion"]
    assert report["summary_delivery"]["owner"] == "hermes"


def test_conversation_agent_does_not_change_selected_audio_engine():
    mod = load_privacy()

    report = mod.privacy_opt_in_report({
        "llm": {"agent": {"provider": "codex"}},
        "agent_pipeline": {"enabled": True},
        "transcription": {"engine": "xai", "xai_credential_source": "openclaw"},
    })

    assert report["conversation"]["provider"] == "codex"
    assert report["transcription"]["provider"] == "xai"
    assert report["transcription"]["credential_source"] == "openclaw"
    assert report["transcription"]["cloud_audio_opt_in"] is True
