"""Wave-0 reuse-gate proof for REUSE-01/02 (D-04, Pitfall 4).

The reuse decision — "reuse the host's tool and SKIP our install" vs "install Yulu's own"
— is driven by the Phase-3 tri-state report, NEVER by a boolean. This is the load-bearing
honesty constraint: a host tool that is merely *present-but-unverified* (e.g. a broken /
unimportable whisper-cli) must NOT be reused, because reusing it would reintroduce the exact
silent first-recording failure the tri-state exists to prevent (report.py:35 docstring:
"A boolean must never drive a skip-install decision").

This test replicates the SAME lookup the production gate uses — the
``host_capabilities.capabilities.<cap>.status`` ``.get(...)`` chain that
``lib/common.sh:capability_status`` performs (FIXED argv → JSON → status string, default
``absent``) — and asserts the decision table:

    usable                  -> skip   (reuse the host's)
    present-but-unverified  -> install (Yulu's own)
    absent                  -> install (Yulu's own)
    missing key / malformed -> install (safe default; a doctor error degrades to install)

It runs on ANY OS: it builds reports from the frozen ``capabilities.report`` contract (or an
equivalent dict literal) — no real ``doctor.py`` invocation, no daemon, no host binary.
"""

import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "yulu" / "scripts"))

from capabilities.report import (  # noqa: E402
    Capability,
    HostCapabilityReport,
    Provenance,
    Status,
)

# The three capabilities REUSE-01 names and Phase 5 gates (gog added in Task 1).
GATED_CAPS = ("whisper_cli", "mlx_whisper", "gog")

# The full tri-state and the decision each value MUST produce (D-04 / Pitfall 4).
TRI_STATE_DECISIONS = [
    ("usable", "skip"),
    ("present-but-unverified", "install"),
    ("absent", "install"),
]


def _status_for(cap: str, report_dict: dict) -> str:
    """Replicate lib/common.sh:capability_status's lookup against a report dict.

    The production helper parses ``doctor.py --json`` and reads
    ``host_capabilities.capabilities.<cap>.status``, defaulting to ``absent`` on any
    failure. Here the fabricated ``report_dict`` is already the ``host_capabilities``
    value (i.e. ``HostCapabilityReport.to_dict()`` shape: ``{schema_version, capabilities}``),
    so the chain mirrors the inner half of that lookup. A missing key or a malformed
    (non-dict) node yields ``absent`` — the safe default.
    """
    try:
        return (
            report_dict.get("capabilities", {})
            .get(cap, {})
            .get("status", "absent")
        )
    except AttributeError:
        # A malformed node (e.g. capabilities mapped to a non-dict) degrades to absent.
        return "absent"


def _decision(status: str) -> str:
    """The reuse gate, verbatim (Pitfall 4): ONLY ``usable`` skips; everything else installs.

    This is a string-equality gate on the tri-state — NEVER a boolean, NEVER ``-n status``,
    NEVER ``status != "absent"`` (each of those would collapse ``present-but-unverified``
    into "skip" and reintroduce the silent-failure bug).
    """
    return "skip" if status == "usable" else "install"


def _report_with(cap: str, status_value: str) -> dict:
    """Build a real HostCapabilityReport.to_dict() carrying ``cap`` at ``status_value``.

    Uses the frozen ``capabilities.report`` contract so this test binds to the same
    serialization the production gate consumes (status coerced to its string value, never
    a Python bool). Status is reconstructed from its string via the Status enum.
    """
    report = HostCapabilityReport()
    report.capabilities[cap] = Capability(
        Provenance.HOST_PATH, Status(status_value), "/opt/homebrew/bin/" + cap, ""
    )
    return report.to_dict()


# ── The core table: every tri-state value × every gated capability ──


@pytest.mark.parametrize("cap", GATED_CAPS)
@pytest.mark.parametrize("status_value, expected_decision", TRI_STATE_DECISIONS)
def test_tristate_drives_skip_or_install(cap, status_value, expected_decision):
    """usable -> skip; present-but-unverified AND absent -> install (D-04, Pitfall 4)."""
    report_dict = _report_with(cap, status_value)
    status = _status_for(cap, report_dict)
    assert status == status_value, f"{cap}: status extraction lost the tri-state value"
    assert _decision(status) == expected_decision, (
        f"{cap} @ {status_value!r}: expected {expected_decision!r} "
        f"(only 'usable' may skip — never a boolean collapse)"
    )


@pytest.mark.parametrize("cap", GATED_CAPS)
def test_present_but_unverified_never_skips(cap):
    """The defining negative: a present-but-unverified host tool MUST install, not reuse.

    This is the exact bug Pitfall 4 warns about — a boolean ``if present: skip`` would
    wrongly reuse a broken/unimportable host tool. Asserted per-capability.
    """
    report_dict = _report_with(cap, "present-but-unverified")
    assert _decision(_status_for(cap, report_dict)) == "install"


@pytest.mark.parametrize("cap", GATED_CAPS)
def test_missing_capability_key_defaults_to_install(cap):
    """A report missing the capability key -> absent -> install (safe default)."""
    empty_report = HostCapabilityReport().to_dict()  # no capabilities at all
    assert _status_for(cap, empty_report) == "absent"
    assert _decision(_status_for(cap, empty_report)) == "install"


def test_missing_host_capabilities_section_defaults_to_install():
    """A report with no host_capabilities/capabilities section -> absent -> install.

    Models a doctor error envelope ({"error": ...}) or a top level missing the section —
    the production helper echoes ``absent`` on any such failure, which means install.
    """
    error_envelope = {"error": "doctor failed", "schema_version": 1, "capabilities": {}}
    assert _status_for("whisper_cli", error_envelope) == "absent"
    assert _decision(_status_for("whisper_cli", error_envelope)) == "install"
    # And a wholly empty / malformed dict still degrades to install.
    assert _decision(_status_for("whisper_cli", {})) == "install"


def test_malformed_capabilities_node_defaults_to_install():
    """capabilities mapped to a non-dict (malformed JSON) -> absent -> install."""
    malformed = {"schema_version": 1, "capabilities": "not-a-dict"}
    assert _status_for("gog", malformed) == "absent"
    assert _decision(_status_for("gog", malformed)) == "install"


def test_gog_usable_without_version_detail_still_skips():
    """A gog entry usable with empty detail still skips — resolution, not version, drives it.

    probe_command reports USABLE the moment the binary resolves on the login PATH, even if
    ``--version`` yields nothing. The reuse gate must honor that: usable -> skip regardless
    of an empty ``detail``.
    """
    report = HostCapabilityReport()
    report.capabilities["gog"] = Capability(
        Provenance.HOST_PATH, Status.USABLE, "/opt/homebrew/bin/gog", ""  # no version detail
    )
    report_dict = report.to_dict()
    assert _status_for("gog", report_dict) == "usable"
    assert _decision(_status_for("gog", report_dict)) == "skip"


def test_status_value_is_never_a_boolean():
    """Structural guard: the serialized status is always a tri-state string, never a bool.

    Mirrors the report.py contract (D-08). If a future change let a bool leak into status,
    the string-equality gate would silently misbehave; this catches it at the boundary.
    """
    for status_value, _ in TRI_STATE_DECISIONS:
        report_dict = _report_with("whisper_cli", status_value)
        status = report_dict["capabilities"]["whisper_cli"]["status"]
        assert isinstance(status, str) and not isinstance(status, bool)
        assert status in {"usable", "present-but-unverified", "absent"}
