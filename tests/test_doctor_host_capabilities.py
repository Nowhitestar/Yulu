"""Wave-0 doctor-integration contract for the host_capabilities section (Plan 03-03).

These tests assert the three load-bearing guarantees of Plan 03's doctor wiring:

1. **DETECT-01/03 surfaced** — ``collect_report()`` / ``doctor --json`` carry a
   ``host_capabilities`` section with an int ``schema_version`` and a ``capabilities`` dict
   covering Agent CLI / command, calendar, and recording-directory readiness,
   each with a string provenance ∈ the 4-set and a tri-state status ∈ the
   3-set — NEVER a Python bool (D-01/D-08).
2. **Existing report shape intact** — every pre-existing top-level doctor key still appears;
   ``host_capabilities`` is purely additive and the assembly never raises (doctor's
   "check functions never raise — return a dict with an error key" contract).
3. **§5d source-vs-runtime root fix** — when ``source_root != runtime_root``, the ``yulu_ui``
   section is derived from the RUNTIME root, so a production install reports the installed UI
   honestly (D-07, CONCERNS §5d).

The doctor module is loaded via the same ``importlib.util.spec_from_file_location`` idiom as
``tests/test_doctor.py`` so it exercises the real source file.
"""

import importlib.util
import json
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DOCTOR = ROOT / "yulu" / "scripts" / "doctor.py"

# Agent and deterministic Host capability coverage.
HOST_KEYS = {"hermes", "claude", "llm_command", "recording_dir", "gog"}

VALID_PROVENANCE = {"host-path", "yulu-managed", "agent-config", "absent"}
VALID_STATUS = {"usable", "present-but-unverified", "absent"}

# Every top-level key collect_report() emitted BEFORE this plan — host_capabilities is additive,
# so all of these must still be present (shape intact).
PRE_EXISTING_TOP_KEYS = {
    "source_root", "source_git", "runtime_root", "runtime_exists",
    "legacy_root", "legacy_root_exists", "config_dir", "config_exists",
    "config_path_exists", "host_tasks", "socket",
    "search_index", "yulu_ui", "processes",
    "legacy_processes", "runtime_processes", "checks",
}


def load_doctor():
    spec = importlib.util.spec_from_file_location("doctor", DOCTOR)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_host_capabilities_present_with_schema_version_and_capabilities(tmp_path):
    """collect_report() gains a host_capabilities section: int schema_version + capabilities dict."""
    doctor = load_doctor()
    report = doctor.collect_report(
        source_root=ROOT,
        runtime_root=tmp_path,
        legacy_root=tmp_path / "missing-legacy",
        config_dir=tmp_path / "cfg",
    )
    assert "host_capabilities" in report
    hc = report["host_capabilities"]
    assert isinstance(hc.get("schema_version"), int)
    assert isinstance(hc.get("capabilities"), dict)


def test_host_capabilities_covers_agent_native_keys_with_valid_provenance_and_tristate(tmp_path):
    """The section covers Agent-native capabilities, each with a valid provenance + a
    tri-state status string (NEVER a boolean) — D-01/D-08."""
    doctor = load_doctor()
    report = doctor.collect_report(
        source_root=ROOT,
        runtime_root=tmp_path,
        legacy_root=tmp_path / "missing-legacy",
        config_dir=tmp_path / "cfg",
    )
    caps = report["host_capabilities"]["capabilities"]
    assert HOST_KEYS <= set(caps), f"missing Host keys: {HOST_KEYS - set(caps)}"
    for name, cap in caps.items():
        assert cap["provenance"] in VALID_PROVENANCE, f"{name}: bad provenance {cap['provenance']!r}"
        assert cap["status"] in VALID_STATUS, f"{name}: bad status {cap['status']!r}"
        # Tri-state must be a string enum value, NEVER a Python bool.
        assert not isinstance(cap["status"], bool), f"{name}: status is a bool"


def test_host_capabilities_includes_provider_agent_config_entries(tmp_path):
    """default_providers() entries reach the report end-to-end (DETECT-05): the
    ClaudeCodeProvider contributes its CLI key without inspecting STT internals."""
    doctor = load_doctor()
    report = doctor.collect_report(
        source_root=ROOT,
        runtime_root=tmp_path,
        legacy_root=tmp_path / "missing-legacy",
        config_dir=tmp_path / "cfg",
    )
    caps = report["host_capabilities"]["capabilities"]
    assert "hermes_cli" in caps
    assert "claude_cli" in caps
    assert "agent_mlx_whisper" not in caps


def test_existing_report_shape_intact(tmp_path):
    """host_capabilities is purely additive — every pre-existing top-level key remains."""
    doctor = load_doctor()
    report = doctor.collect_report(
        source_root=ROOT,
        runtime_root=tmp_path,
        legacy_root=tmp_path / "missing-legacy",
        config_dir=tmp_path / "cfg",
    )
    missing = PRE_EXISTING_TOP_KEYS - set(report)
    assert not missing, f"host_capabilities broke the existing shape; missing keys: {missing}"


def test_assembly_never_raises_even_with_missing_roots(tmp_path):
    """The host_capabilities assembly degrades cleanly — even with non-existent roots and an
    empty config dir, collect_report() returns a dict with host_capabilities and never raises."""
    doctor = load_doctor()
    report = doctor.collect_report(
        source_root=ROOT,
        runtime_root=tmp_path / "nope-runtime",
        legacy_root=tmp_path / "nope-legacy",
        config_dir=tmp_path / "nope-config",
    )
    hc = report["host_capabilities"]
    # Either a populated section or a degraded {"error": ..., schema_version, capabilities}.
    assert isinstance(hc.get("schema_version"), int)
    assert isinstance(hc.get("capabilities"), dict)


def test_5d_yulu_ui_derives_from_runtime_root_not_source_root(tmp_path, monkeypatch):
    """§5d fix: when source_root != runtime_root, check_yulu_ui receives the RUNTIME root's
    yulu/scripts dir, not the source checkout's (CONCERNS §5d, D-07)."""
    doctor = load_doctor()
    runtime_root = tmp_path / "runtime"
    captured = {}

    def _spy_check_yulu_ui(script_dir, config_dir, *a, **k):
        captured["script_dir"] = Path(script_dir)
        return {"dist_server_present": False, "spy": True}

    monkeypatch.setattr(doctor, "check_yulu_ui", _spy_check_yulu_ui)
    doctor.collect_report(
        source_root=ROOT,
        runtime_root=runtime_root,
        legacy_root=tmp_path / "missing-legacy",
        config_dir=tmp_path / "cfg",
    )
    assert "script_dir" in captured, "check_yulu_ui was not called"
    # The §5d fix: the script_dir must be rooted under runtime_root, NOT source_root (ROOT).
    assert str(captured["script_dir"]).startswith(str(runtime_root)), (
        f"check_yulu_ui got {captured['script_dir']} — expected it under runtime_root {runtime_root}"
    )
    assert not str(captured["script_dir"]).startswith(str(ROOT)), (
        "§5d regression: check_yulu_ui still receives the SOURCE root"
    )


def test_main_json_emits_host_capabilities_end_to_end(tmp_path, capsys):
    """Success criterion 1 end-to-end: `doctor --json` prints JSON that json.loads parses and
    contains a host_capabilities section with a valid schema_version + tri-state capabilities."""
    doctor = load_doctor()
    code = doctor.main([
        "--json",
        "--source-root", str(ROOT),
        "--runtime-root", str(tmp_path),
        "--legacy-root", str(tmp_path / "missing-legacy"),
        "--config-dir", str(tmp_path / "cfg"),
    ])
    assert code in (0, 1)
    data = json.loads(capsys.readouterr().out)
    assert "host_capabilities" in data
    hc = data["host_capabilities"]
    assert isinstance(hc["schema_version"], int)
    caps = hc["capabilities"]
    assert HOST_KEYS <= set(caps)
    assert all(c["status"] in VALID_STATUS for c in caps.values())
    assert all(not isinstance(c["status"], bool) for c in caps.values())
