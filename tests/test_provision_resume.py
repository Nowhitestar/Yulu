"""PROV-02 / PROV-04 — kill-at-step-N resume walk (Wave 0).

The spike's pass bar (1): a provisioning run killed mid-way resumes from the
per-step ``.yulu-install.json`` — steps recorded ``ok`` are skipped, the killed
(non-``ok``) step and everything AFTER it re-run, and no ``ok`` step is ever
re-run (so no daemon is duplicated). The ledger contract that guarantees this is
exercised here without a real agent: the "agent" is just a caller marking steps.

These tests prove:
  (1) kill-at-step-N — seed deps+audio "ok" and daemons "running" (the killed
      step), assert is_done(deps)&&is_done(audio)&&!is_done(daemons), and assert
      resume_order(...) == ["daemons","ui"] (redo the
      killed step + everything after it, NEVER an ok step);
  (2) a corrupt ledger starts fresh (resume_order returns ALL steps);
  (3) Pitfall 3 across the resume path — after marking the killed "daemons" step
      "ok", the installer `source` field still survives.

Source: RESEARCH §"Simulating kill-at-step-N resume in pytest" + Pattern 2 resume
algorithm; corrupt-tolerance from release_installer.read_install_metadata.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import provision.state as state  # noqa: E402

# The setup.sh step sequence the resume walk follows (registry order).
STEP_NAMES = ["deps", "audio", "daemons", "ui"]


def _seed_installer_doc(ledger: Path, source: str = "release") -> None:
    """Write the Phase-1 installer-shaped doc that provisioning extends."""
    ledger.write_text(
        json.dumps(
            {"schema": 1, "source": source, "installed_at": "2026-05-30T00:00:00Z", "version": "0.5.1", "sha256": "abc123"},
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


# ── (1) kill-at-step-N ───────────────────────────────────────────────


def test_resume_skips_done_reruns_killed_and_later(tmp_path):
    ledger = tmp_path / ".yulu-install.json"
    _seed_installer_doc(ledger)

    # Simulate a run killed DURING step "daemons": deps+audio reached "ok", daemons
    # was marked "running" before apply() and never reached "ok" (SIGKILL).
    state.mark(ledger, "deps", "ok")
    state.mark(ledger, "audio", "ok")
    state.mark(ledger, "daemons", "running")  # killed here — never "ok"

    assert state.is_done(ledger, "deps")
    assert state.is_done(ledger, "audio")
    assert not state.is_done(ledger, "daemons")  # NOT ok → will be re-run

    # The resume walk re-runs the killed step + everything after it; the prior ok
    # steps are skipped, and daemons/ui (never reached) also run.
    assert state.resume_order(STEP_NAMES, ledger) == ["daemons", "ui"]


def test_resume_after_error_reruns_from_failed_step(tmp_path):
    # A step that ended in "error" (apply ran, script exited non-zero) is also
    # non-ok → it and everything after it re-run on the next invocation.
    ledger = tmp_path / ".yulu-install.json"
    _seed_installer_doc(ledger)
    state.mark(ledger, "deps", "ok")
    state.mark(ledger, "audio", "error", detail="brew failed")
    assert not state.is_done(ledger, "audio")
    assert state.resume_order(STEP_NAMES, ledger) == ["audio", "daemons", "ui"]


def test_resume_when_killed_before_first_mark(tmp_path):
    # Killed BEFORE the very first step was marked at all (absent in steps): every
    # step is non-ok → the whole walk runs (each check() skips what is satisfied).
    ledger = tmp_path / ".yulu-install.json"
    _seed_installer_doc(ledger)
    assert state.resume_order(STEP_NAMES, ledger) == STEP_NAMES


def test_resume_all_done_runs_nothing(tmp_path):
    ledger = tmp_path / ".yulu-install.json"
    _seed_installer_doc(ledger)
    for name in STEP_NAMES:
        state.mark(ledger, name, "ok")
    assert state.resume_order(STEP_NAMES, ledger) == []  # fully provisioned → no-op resume


# ── (2) corrupt ledger starts fresh ──────────────────────────────────


def test_corrupt_ledger_starts_fresh(tmp_path):
    ledger = tmp_path / ".yulu-install.json"
    ledger.write_text("{ not json", encoding="utf-8")
    assert state.load(ledger) == {}  # safe degrade (== read_install_metadata)
    # A corrupt ledger is treated as fresh: every step runs (NOT a migration; D-08).
    assert state.resume_order(STEP_NAMES, ledger) == STEP_NAMES


# ── (3) Pitfall 3 survives the resume path ───────────────────────────


def test_source_survives_completing_the_killed_step(tmp_path):
    ledger = tmp_path / ".yulu-install.json"
    _seed_installer_doc(ledger)
    state.mark(ledger, "deps", "ok")
    state.mark(ledger, "audio", "ok")
    state.mark(ledger, "daemons", "running")  # killed
    # Resume completes the killed step.
    state.mark(ledger, "daemons", "ok")

    doc = state.load(ledger)
    # The installer source MUST still be intact after the resume path (Pitfall 3) —
    # otherwise the next update flips into the swiftc dev branch.
    assert doc["source"] == "release"
    assert doc["version"] == "0.5.1"
    assert doc["sha256"] == "abc123"
    assert state.is_done(ledger, "daemons")
    # And resume_order now advances past daemons.
    assert state.resume_order(STEP_NAMES, ledger) == ["ui"]


def test_dev_source_also_preserved(tmp_path):
    # The guard is symmetric: a dev install must keep source=="dev" too (otherwise
    # a dev tree would lose its dev fork on the next update).
    ledger = tmp_path / ".yulu-install.json"
    _seed_installer_doc(ledger, source="dev")
    state.mark(ledger, "deps", "ok")
    assert state.load(ledger)["source"] == "dev"
