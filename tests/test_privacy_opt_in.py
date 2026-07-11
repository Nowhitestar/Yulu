import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRIVACY = ROOT / "yulu" / "scripts" / "privacy_opt_in.py"


def load_privacy():
    spec = importlib.util.spec_from_file_location("privacy_opt_in", PRIVACY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_empty_config_reports_agent_owned_defaults():
    mod = load_privacy()

    report = mod.privacy_opt_in_report({})

    assert report["ok"] is True
    assert report["transcription"]["owner"] == "agent"
    assert report["transcription"]["provider"] == "hermes"
    assert report["transcription"]["yulu_executor"] is False
    assert report["conversation"]["provider"] == "hermes"
    assert report["conversation"]["yulu_executor"] is False
    assert report["summary_delivery"]["auto_channel"] == "file"
    assert report["summary_delivery"]["external_opt_in_channels"] == []


def test_disabled_agent_pipeline_is_not_ready():
    mod = load_privacy()

    report = mod.privacy_opt_in_report({
        "agent_pipeline": {"enabled": False}
    })

    assert report["ok"] is False
    assert report["transcription"]["ok"] is False


def test_external_summary_opt_ins_are_reported():
    mod = load_privacy()

    report = mod.privacy_opt_in_report({
        "llm": {"agent": {"provider": "hermes"}},
        "agent_pipeline": {"auto_send_notion": True},
    })

    assert report["ok"] is True
    assert report["transcription"]["provider"] == "hermes"
    assert report["summary_delivery"]["auto_external_opt_in"] is True
    assert report["summary_delivery"]["external_opt_in_channels"] == ["notion"]
    assert report["summary_delivery"]["owner"] == "hermes"


def test_conversation_agent_does_not_change_hermes_transcription_owner():
    mod = load_privacy()

    report = mod.privacy_opt_in_report({
        "llm": {"agent": {"provider": "codex"}},
        "agent_pipeline": {"enabled": True},
    })

    assert report["conversation"]["provider"] == "codex"
    assert report["transcription"]["provider"] == "hermes"
