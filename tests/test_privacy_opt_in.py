import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PRIVACY = ROOT / "yulu" / "scripts" / "privacy_opt_in.py"


def load_privacy():
    spec = importlib.util.spec_from_file_location("privacy_opt_in", PRIVACY)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_empty_config_reports_local_first_defaults():
    mod = load_privacy()

    report = mod.privacy_opt_in_report({})

    assert report["ok"] is True
    assert report["transcription"]["mode"] == "local"
    assert report["transcription"]["local_default"] is True
    assert report["transcription"]["cloud_opt_in"] is False
    assert report["summary_delivery"]["auto_channel"] == "file"
    assert report["summary_delivery"]["external_opt_in_channels"] == []


def test_cloud_mode_without_command_is_not_ready():
    mod = load_privacy()

    report = mod.privacy_opt_in_report({
        "transcription": {"mode": "cloud-fallback", "cloud_command": []}
    })

    assert report["ok"] is False
    assert report["transcription"]["cloud_opt_in"] is True
    assert report["transcription"]["cloud_command_configured"] is False


def test_external_summary_opt_ins_are_reported():
    mod = load_privacy()

    report = mod.privacy_opt_in_report({
        "transcription": {"mode": "cloud-priority", "cloud_command": ["my-stt", "{audio}"]},
        "output": {"channel": "zulip"},
        "connectors": {
            "notion": {"send_summary": True},
            "zulip": {"send_summary": False},
        },
    })

    assert report["ok"] is True
    assert report["transcription"]["cloud_command_configured"] is True
    assert report["summary_delivery"]["auto_external_opt_in"] is True
    assert report["summary_delivery"]["external_opt_in_channels"] == ["zulip", "notion"]
    assert report["summary_delivery"]["manual_connector_opt_ins"] == {
        "notion": True,
        "zulip": False,
    }
