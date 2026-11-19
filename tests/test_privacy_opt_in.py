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
    assert "conversation" not in report
    assert report["dictation_text"]["provider"] == "none"
    assert report["dictation_text"]["cloud_text_opt_in"] is False
    assert report["caption_translation"]["provider"] == "none"
    assert report["caption_translation"]["cloud_text_opt_in"] is False
    assert report["summary_delivery"]["auto_channel"] == "file"
    assert report["summary_delivery"]["external_opt_in_channels"] == []


def test_disabled_agent_pipeline_does_not_disable_audio_engine():
    mod = load_privacy()

    report = mod.privacy_opt_in_report({
        "agent_pipeline": {"enabled": False}
    })

    assert report["ok"] is False
    assert report["transcription"]["ok"] is True


def test_legacy_automatic_summary_opt_in_is_retired():
    mod = load_privacy()

    report = mod.privacy_opt_in_report({
        "llm": {"agent": {"provider": "hermes"}},
        "agent_pipeline": {"auto_send_notion": True},
    })

    assert report["ok"] is True
    assert report["transcription"]["provider"] == "local"
    assert report["summary_delivery"]["auto_external_opt_in"] is False
    assert report["summary_delivery"]["external_opt_in_channels"] == []
    assert report["summary_delivery"]["owner"] == "hermes"


def test_general_agent_does_not_change_selected_audio_engine_or_dictation_text():
    mod = load_privacy()

    report = mod.privacy_opt_in_report({
        "llm": {"agent": {"provider": "codex"}},
        "agent_pipeline": {"enabled": True},
        "transcription": {"engine": "xai"},
    })

    assert "conversation" not in report
    assert report["dictation_text"]["provider"] == "none"
    assert report["transcription"]["provider"] == "xai"
    assert report["transcription"]["credential_source"] == "yulu-keychain"
    assert report["transcription"]["cloud_audio_opt_in"] is True


def test_dictation_text_reports_only_the_explicit_xai_switch():
    mod = load_privacy()

    selected = mod.privacy_opt_in_report({
        "transcription": {"engine": "xai", "dictation": {"text_provider": "xai"}},
    })
    retired = mod.privacy_opt_in_report({
        "intelligence": {"conversation": {"provider": "xai"}},
        "transcription": {"engine": "xai", "dictation": {"cleanup_model": "conversation"}},
    })

    assert selected["dictation_text"]["provider"] == "xai"
    assert selected["dictation_text"]["cloud_text_opt_in"] is True
    assert retired["dictation_text"]["provider"] == "none"
    assert retired["dictation_text"]["cloud_text_opt_in"] is False


def test_caption_translation_reports_only_its_own_explicit_switch():
    mod = load_privacy()

    selected = mod.privacy_opt_in_report({
        "transcription": {"engine": "xai", "captions": {"translation_provider": "xai"}},
    })
    dictation_only = mod.privacy_opt_in_report({
        "transcription": {"engine": "xai", "dictation": {"text_provider": "xai"}},
    })
    unknown = mod.privacy_opt_in_report({
        "transcription": {"engine": "xai", "captions": {"translation_provider": "hermes"}},
    })

    assert selected["caption_translation"]["provider"] == "xai"
    assert selected["caption_translation"]["cloud_text_opt_in"] is True
    assert selected["caption_translation"]["requires_xai_audio_engine"] is True
    assert selected["dictation_text"]["cloud_text_opt_in"] is False
    assert dictation_only["caption_translation"]["provider"] == "none"
    assert dictation_only["caption_translation"]["cloud_text_opt_in"] is False
    assert unknown["caption_translation"]["provider"] == "none"
