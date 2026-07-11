"""PROV-01 / PROV-02 — the provision CLI resume-walk driver (Wave 0).

``provision/cli.py`` is the user-facing surface that COMPOSES the three Wave-1
modules — ``registry`` (the steps), ``state`` (the kill-at-step-N ledger), and
``attest`` (the fail-closed gate) — into ``yulu provision`` / ``yulu skill``.

These tests prove the load-bearing properties WITHOUT a real agent or a real
install (every step.apply / gate is monkeypatched):

  (1) ``--list`` prints all four registry step names;
  (2) ``provision <unknown>`` errors and lists the valid step names (an untrusted
      step name never executes an arbitrary path — T-06-16);
  (3) GATE-BEFORE-APPLY (T-06-15, the spike's headline control): ``provision --all
      --asset <zip> --checksums <txt>`` calls ``attest.verify_asset`` FIRST and,
      on a TamperError, ABORTS before ANY step.apply() runs (a monkeypatched apply
      raises if reached, so the test fails if the gate is bypassed);
  (4) a clean ``--all`` with NO asset SKIPS the gate (no fresh asset — RESEARCH
      Q1/Pitfall 5) and walks the registry, marking each step in a tmp ledger
      with running-before-apply / result-after (the resume contract);
  (5) ``--all`` resumes — a ledger with deps+audio already ``ok`` re-applies only
      the remaining two steps (no ok step is re-run);
  (6) a single ``provision <step>`` dispatches to exactly that named step.

Import style mirrors test_provision_registry.py / test_provision_resume.py:
yulu/scripts is placed on sys.path so ``import provision.cli`` works whether
pytest runs from the repo root (``pytest tests``) or from yulu/scripts
(``pytest ../../tests/...``).
"""

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import provision.cli as cli  # noqa: E402
from provision import REGISTRY, StepResult  # noqa: E402
from provision import registry as registry_mod  # noqa: E402

STEP_NAMES = [s.name for s in REGISTRY]


# ── (1) --list prints the four step names ────────────────────────────


def test_list_prints_all_step_names(capsys):
    code = cli.main(["provision", "--list"])
    out = capsys.readouterr().out
    assert code == 0
    for name in STEP_NAMES:
        assert name in out


# ── (2) unknown step errors and lists valid names ────────────────────


def test_unknown_step_errors_and_lists_valid_names(capsys):
    code = cli.main(["provision", "not-a-real-step"])
    captured = capsys.readouterr()
    blob = captured.out + captured.err
    assert code != 0
    # Every valid name is surfaced so the user/agent can self-correct.
    for name in STEP_NAMES:
        assert name in blob


# ── (3) GATE-BEFORE-APPLY: a tampered asset aborts before any apply ──


def test_all_with_tampered_asset_aborts_before_any_apply(tmp_path, monkeypatch):
    """The spike's headline fail-closed control (T-06-15).

    When ``--asset`` is supplied the walk MUST call attest.verify_asset FIRST and,
    on a TamperError, abort before ANY step.apply() runs. We monkeypatch
    verify_asset to raise and EVERY step.apply to explode if reached — so the test
    fails loudly if the gate is bypassed.
    """
    asset = tmp_path / "yulu-macos-arm64-v0.5.1.zip"
    asset.write_bytes(b"tampered bytes")
    checksums = tmp_path / "checksums.txt"
    checksums.write_text("deadbeef  yulu-macos-arm64-v0.5.1.zip\n", encoding="utf-8")
    ledger = tmp_path / ".yulu-install.json"

    def _boom_verify(*_a, **_k):
        raise cli.attest.TamperError("asset did not verify")

    def _apply_must_not_run(self, _mode):  # pragma: no cover - asserts non-execution
        raise AssertionError(f"step {self.name} applied despite a tampered asset")

    monkeypatch.setattr(cli.attest, "verify_asset", _boom_verify)
    monkeypatch.setattr(registry_mod.ScriptStep, "apply", _apply_must_not_run)

    code = cli.main(
        [
            "provision",
            "--all",
            "--asset",
            str(asset),
            "--checksums",
            str(checksums),
            "--ledger",
            str(ledger),
        ]
    )
    assert code != 0  # fail-closed
    # No step ever reached ok in the ledger (the walk never started).
    if ledger.exists():
        steps = json.loads(ledger.read_text()).get("steps", {})
        assert all(v.get("status") != "ok" for v in steps.values())


# ── (4) clean --all (no asset) skips the gate and walks the registry ──


def test_all_no_asset_skips_gate_and_walks_marking_ledger(tmp_path, monkeypatch):
    ledger = tmp_path / ".yulu-install.json"
    applied: list[str] = []

    def _fake_apply(self, _mode):
        applied.append(self.name)
        return StepResult(self.name, "ok", "")

    # If the gate is consulted at all without an asset, fail — there is nothing to
    # verify (RESEARCH Q1/Pitfall 5).
    def _gate_must_not_run(*_a, **_k):  # pragma: no cover - asserts non-execution
        raise AssertionError("verify_asset called with no --asset")

    monkeypatch.setattr(registry_mod.ScriptStep, "apply", _fake_apply)
    monkeypatch.setattr(cli.attest, "verify_asset", _gate_must_not_run)

    code = cli.main(["provision", "--all", "--ledger", str(ledger)])
    assert code == 0
    # Every step ran, in registry order.
    assert applied == STEP_NAMES
    # And every step is recorded ok in the ledger.
    doc = json.loads(ledger.read_text())
    for name in STEP_NAMES:
        assert doc["steps"][name]["status"] == "ok"


# ── (5) --all resumes: ok steps are skipped, the rest re-apply ───────


def test_all_resumes_skipping_already_ok_steps(tmp_path, monkeypatch):
    ledger = tmp_path / ".yulu-install.json"
    # Pre-seed deps + audio as already ok (a prior partial run).
    ledger.write_text(
        json.dumps(
            {
                "schema": 1,
                "source": "release",
                "steps": {
                    "deps": {"status": "ok", "ts": "2026-05-30T00:00:00Z"},
                    "audio": {"status": "ok", "ts": "2026-05-30T00:00:00Z"},
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    applied: list[str] = []

    def _fake_apply(self, _mode):
        applied.append(self.name)
        return StepResult(self.name, "ok", "")

    monkeypatch.setattr(registry_mod.ScriptStep, "apply", _fake_apply)

    code = cli.main(["provision", "--all", "--ledger", str(ledger)])
    assert code == 0
    # deps + audio were skipped (already ok); only the rest re-applied.
    assert applied == ["daemons", "ui"]
    # The installer source survived the walk (Pitfall 3).
    assert json.loads(ledger.read_text())["source"] == "release"


def test_all_stops_and_records_error_for_resume(tmp_path, monkeypatch):
    """A step that errors breaks the walk; later steps stay non-ok so the next
    invocation resumes from the failed step."""
    ledger = tmp_path / ".yulu-install.json"
    applied: list[str] = []

    def _fake_apply(self, _mode):
        applied.append(self.name)
        if self.name == "daemons":
            return StepResult(self.name, "error", "boom")
        return StepResult(self.name, "ok", "")

    monkeypatch.setattr(registry_mod.ScriptStep, "apply", _fake_apply)

    code = cli.main(["provision", "--all", "--ledger", str(ledger)])
    assert code != 0  # an errored step makes the walk fail
    # Walk stopped at daemons — UI never ran.
    assert applied == ["deps", "audio", "daemons"]
    doc = json.loads(ledger.read_text())
    assert doc["steps"]["daemons"]["status"] == "error"
    assert "ui" not in doc["steps"]


# ── (6) a single named step dispatches to exactly that step ──────────


def test_single_step_dispatch_runs_only_that_step(tmp_path, monkeypatch):
    ledger = tmp_path / ".yulu-install.json"
    applied: list[str] = []

    def _fake_apply(self, _mode):
        applied.append(self.name)
        return StepResult(self.name, "ok", "")

    monkeypatch.setattr(registry_mod.ScriptStep, "apply", _fake_apply)

    code = cli.main(["provision", "audio", "--ledger", str(ledger)])
    assert code == 0
    assert applied == ["audio"]  # only the named step ran
    assert json.loads(ledger.read_text())["steps"]["audio"]["status"] == "ok"


def test_force_single_step_bypasses_probe_and_records_fresh_result(tmp_path, monkeypatch):
    ledger = tmp_path / ".yulu-install.json"
    ledger.write_text(
        json.dumps({"steps": {"daemons": {"status": "ok", "ts": "old"}}}) + "\n",
        encoding="utf-8",
    )
    calls: list[tuple[str, bool]] = []

    def _fake_apply(self, _mode, *, force=False):
        calls.append((self.name, force))
        return StepResult(self.name, "ok", "refreshed")

    monkeypatch.setattr(registry_mod.ScriptStep, "apply", _fake_apply)
    code = cli.main(["provision", "daemons", "--force", "--ledger", str(ledger)])
    assert code == 0
    assert calls == [("daemons", True)]
    assert json.loads(ledger.read_text())["steps"]["daemons"]["detail"] == "refreshed"


# ── skill install dispatches through the cli to skill_install ────────


def test_skill_install_dispatches_to_skill_module(monkeypatch):
    captured = {}

    def _fake_skill_install(agents, repo_dir=None):
        captured["agents"] = agents
        captured["repo_dir"] = repo_dir
        return 0

    monkeypatch.setattr(cli.skill, "skill_install", _fake_skill_install)
    code = cli.main(["skill", "install", "--agent", "claude-code", "--agent", "codex"])
    assert code == 0
    assert captured["agents"] == ["claude-code", "codex"]
