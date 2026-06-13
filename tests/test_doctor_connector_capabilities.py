"""Doctor integration for ConnectorProvider reports."""

import importlib.util
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOCTOR = ROOT / "yulu" / "scripts" / "doctor.py"


def load_doctor():
    spec = importlib.util.spec_from_file_location("doctor", DOCTOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_collect_report_includes_connector_capabilities(tmp_path, monkeypatch):
    doctor = load_doctor()
    monkeypatch.setattr(doctor, "_yulu_processes", lambda: [])
    monkeypatch.setattr(doctor, "_check_command", lambda name, args: {"name": name, "ok": True})
    monkeypatch.setattr(doctor, "_socket_status", lambda path: {"exists": False})
    monkeypatch.setattr(doctor, "check_stt_daemon", lambda config_dir: {"ok": False})
    monkeypatch.setattr(doctor, "check_search_index", lambda config_dir: {"ok": False})
    monkeypatch.setattr(doctor, "check_yulu_ui", lambda script_dir, config_dir: {"ok": False})
    monkeypatch.setattr(doctor, "_host_capabilities", lambda config_dir, runtime_root: {"schema_version": 1, "capabilities": {}})

    report = doctor.collect_report(
        source_root=ROOT,
        runtime_root=tmp_path,
        legacy_root=tmp_path / "missing-legacy",
        config_dir=tmp_path / "cfg",
    )

    assert "connector_capabilities" in report
    connectors = report["connector_capabilities"]
    assert connectors["schema_version"] == 1
    assert {"gog", "feishu", "notion", "zulip"} <= set(connectors["connectors"])
    for entry in connectors["connectors"].values():
        assert isinstance(entry["actions"], list)
        assert entry["status"] in {"usable", "present-but-unverified", "absent"}
        assert entry["provenance"] in {"host-path", "yulu-managed", "agent-config", "absent"}
        assert isinstance(entry["config_prefix"], str)
