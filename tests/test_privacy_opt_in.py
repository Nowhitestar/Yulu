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
    # Live notes are on by default; the Host still sends nothing until the
    # live notes disclosure is accepted.
    assert report["live_notes"]["provider"] == "xai"
    assert report["live_notes"]["requires_xai_audio_engine"] is False
    assert "caption_translation" not in report
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


def test_live_notes_report_only_their_own_switch():
    mod = load_privacy()

    selected = mod.privacy_opt_in_report({
        "transcription": {"engine": "local", "live_notes": {"provider": "xai"}},
    })
    explicit_off = mod.privacy_opt_in_report({
        "transcription": {"engine": "xai", "dictation": {"text_provider": "xai"}, "live_notes": {"provider": "none"}},
    })
    retired_captions = mod.privacy_opt_in_report({
        "transcription": {
            "engine": "xai",
            "captions": {"translation_provider": "xai"},
            "live_notes": {"provider": "none"},
        },
    })
    unknown = mod.privacy_opt_in_report({
        "transcription": {"engine": "xai", "live_notes": {"provider": "hermes"}},
    })
    null_provider = mod.privacy_opt_in_report({
        "transcription": {"live_notes": {"provider": None}},
    })

    assert selected["live_notes"]["provider"] == "xai"
    assert selected["live_notes"]["cloud_text_opt_in"] is True
    assert selected["live_notes"]["requires_xai_audio_engine"] is False
    assert selected["transcription"]["cloud_audio_opt_in"] is False
    assert selected["dictation_text"]["cloud_text_opt_in"] is False
    # The dictation switch and retired caption translation never decide live notes.
    assert explicit_off["live_notes"]["provider"] == "none"
    assert explicit_off["live_notes"]["cloud_text_opt_in"] is False
    assert explicit_off["dictation_text"]["cloud_text_opt_in"] is True
    assert retired_captions["live_notes"]["cloud_text_opt_in"] is False
    assert "caption_translation" not in retired_captions
    assert unknown["live_notes"]["provider"] == "none"
    assert unknown["live_notes"]["cloud_text_opt_in"] is False
    assert null_provider["live_notes"]["provider"] == "none"


def test_live_notes_are_on_by_default_and_only_an_explicit_none_turns_them_off():
    mod = load_privacy()

    no_transcription = mod.privacy_opt_in_report({})
    no_live_notes = mod.privacy_opt_in_report({"transcription": {"engine": "local"}})
    no_provider = mod.privacy_opt_in_report({
        "transcription": {"live_notes": {"model": "grok-4.20-0309-non-reasoning", "language": "en"}},
    })
    explicit_none = mod.privacy_opt_in_report({
        "transcription": {"live_notes": {"provider": "none"}},
    })

    for report in (no_transcription, no_live_notes, no_provider):
        assert report["live_notes"]["provider"] == "xai"
        assert report["live_notes"]["cloud_text_opt_in"] is True
        # Text only: the default never selects the xAI audio engine.
        assert report["transcription"]["cloud_audio_opt_in"] is False
    assert explicit_none["live_notes"]["provider"] == "none"
    assert explicit_none["live_notes"]["cloud_text_opt_in"] is False
    assert set(explicit_none["live_notes"]) == set(no_provider["live_notes"])
