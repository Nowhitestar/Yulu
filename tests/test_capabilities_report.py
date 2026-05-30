"""Wave-0 schema lock for the capabilities/ HostCapabilityReport (DETECT-01, D-01/D-08).

Asserts the report is versioned, every entry carries a provenance from the 4-set and a
TRI-STATE status from the 3-set, and — the defining negative constraint — NO status value
is ever a Python boolean (D-08: tri-state, never a boolean, drives every downstream
skip-install decision).
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "yulu" / "scripts"))

from capabilities.report import (  # noqa: E402
    Capability,
    HostCapabilityReport,
    Provenance,
    Status,
)

PROVENANCE_VALUES = {"host-path", "yulu-managed", "agent-config", "absent"}
STATUS_VALUES = {"usable", "present-but-unverified", "absent"}


def _sample_report() -> HostCapabilityReport:
    report = HostCapabilityReport()
    report.capabilities["claude"] = Capability(
        Provenance.HOST_PATH, Status.USABLE, "/usr/local/bin/claude", "claude v1.2.3"
    )
    report.capabilities["whisper-cli"] = Capability(
        Provenance.ABSENT, Status.ABSENT, "", "not found"
    )
    report.capabilities["recording-dir"] = Capability(
        Provenance.YULU_MANAGED, Status.PRESENT_BUT_UNVERIFIED, "/Users/x/Movies/Yulu", "not writable"
    )
    return report


def test_schema_version_present_and_int():
    report = _sample_report()
    d = report.to_dict()
    assert "schema_version" in d
    assert isinstance(d["schema_version"], int)
    assert d["schema_version"] == 1


def test_report_is_json_serializable():
    # A round-trip through json.dumps must succeed (enums coerced to their string values).
    d = _sample_report().to_dict()
    text = json.dumps(d)  # must not raise
    reloaded = json.loads(text)
    assert reloaded["capabilities"]["claude"]["status"] == "usable"
    assert reloaded["capabilities"]["claude"]["resolved_path"] == "/usr/local/bin/claude"


def test_every_entry_has_constrained_provenance_and_status():
    d = _sample_report().to_dict()
    assert d["capabilities"], "expected at least one capability entry"
    for name, entry in d["capabilities"].items():
        assert entry["provenance"] in PROVENANCE_VALUES, f"{name}: bad provenance {entry['provenance']!r}"
        assert entry["status"] in STATUS_VALUES, f"{name}: bad status {entry['status']!r}"
        assert isinstance(entry["resolved_path"], str)
        assert isinstance(entry["detail"], str)


def test_status_is_never_a_boolean():
    # DETECT-01's defining negative: walk the serialized dict, assert no status is a bool.
    d = _sample_report().to_dict()
    for name, entry in d["capabilities"].items():
        assert not isinstance(entry["status"], bool), f"{name}: status must not be a bool"
        # A bool would also serialize to true/false in JSON — guard the string-ness too.
        assert isinstance(entry["status"], str), f"{name}: status must serialize to a string"


def test_status_enum_members_are_all_strings():
    # The enum itself must never carry a True/False-typed member.
    assert all(isinstance(s.value, str) for s in Status)
    assert all(not isinstance(s.value, bool) for s in Status)


def test_provenance_and_status_enums_cover_the_contract():
    assert {p.value for p in Provenance} == PROVENANCE_VALUES
    assert {s.value for s in Status} == STATUS_VALUES


def test_absent_helper_builds_a_clean_missing_entry():
    from capabilities.report import absent

    cap = absent("no such tool")
    assert cap.provenance == Provenance.ABSENT
    assert cap.status == Status.ABSENT
    assert cap.resolved_path == ""
    assert cap.detail == "no such tool"
