"""PROV-01 — the provision/ step registry contract (Wave 0).

The registry WRAPS the four setup_*.sh concerns 1:1; it never ports
their bash logic. Each step exposes:

  * check() -> bool           — a READ-ONLY probe ("is this already done?")
  * apply(mode) -> StepResult — runs the wrapped setup_*.sh via subprocess, but
                                short-circuits to status="skipped" when check()
                                already passed (the idempotency contract).

StepResult is a frozen dataclass {name, status, detail} with status in
{"ok", "skipped", "error"} (the three D-01 statuses).

These tests prove:
  (1) StepResult is frozen and the three statuses are producible;
  (2) check()==True -> apply()=="skipped" and DOES NOT spawn bash;
  (3) check()==False -> subprocess returncode maps ok / error (truncated detail);
  (4) REGISTRY = the four named ScriptSteps in setup.sh order, each wrapping the
      matching setup_*.sh filename;
  (5) step_by_name resolves a known step and raises on an unknown one;
  (6) a hermetic real-bash drive (mark integration) reusing
      test_setup_decomposition's no-op PATH shim proves a ScriptStep.apply()
      returns {ok|skipped} and a SECOND apply() returns "skipped".

Import style mirrors the repo: yulu/scripts is placed on sys.path so
`import provision...` works whether pytest is launched from the repo root
(`pytest tests`) or from yulu/scripts (`pytest ../../tests/...`).
"""

import dataclasses
import os
import stat
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import provision  # noqa: E402
from provision import REGISTRY, ScriptStep, Step, StepResult, step_by_name  # noqa: E402
from provision import registry as registry_mod  # noqa: E402


# The concerns, in setup.sh's documented order, mapped to their script bodies.
EXPECTED_STEPS = [
    ("deps", "setup_deps.sh"),
    ("audio", "setup_audio.sh"),
    ("daemons", "setup_daemons.sh"),
    ("ui", "setup_ui.sh"),
]


def _explode(*args, **kwargs):
    """A subprocess.run replacement that fails the test if bash is ever spawned."""
    raise AssertionError(f"subprocess.run must NOT be called (skipped path): {args!r}")


# ── (1) StepResult shape ─────────────────────────────────────────────


def test_stepresult_is_frozen_dataclass():
    r = StepResult("deps", "ok", "")
    assert dataclasses.is_dataclass(r)
    assert (r.name, r.status, r.detail) == ("deps", "ok", "")
    with pytest.raises(dataclasses.FrozenInstanceError):
        r.status = "error"  # type: ignore[misc]


def test_stepresult_three_statuses_producible():
    for status in ("ok", "skipped", "error"):
        r = StepResult("x", status)
        assert r.status == status
    # detail defaults to empty string
    assert StepResult("x", "ok").detail == ""


# ── (2) check()==True short-circuits to skipped, never spawns bash ───


def test_apply_skips_without_spawning_bash_when_check_true(monkeypatch):
    monkeypatch.setattr(registry_mod.subprocess, "run", _explode)
    step = ScriptStep("deps", "setup_deps.sh", probe=lambda: True)
    assert step.check() is True
    result = step.apply("release")
    assert isinstance(result, StepResult)
    assert result.name == "deps"
    assert result.status == "skipped"


def test_force_apply_bypasses_satisfied_probe(monkeypatch):
    captured = []

    def _ok(cmd, *a, **k):
        captured.append(cmd)
        return subprocess.CompletedProcess(cmd, 0, stdout="done\n", stderr="")

    monkeypatch.setattr(registry_mod.subprocess, "run", _ok)
    step = ScriptStep("daemons", "setup_daemons.sh", probe=lambda: True)
    result = step.apply("release", force=True)
    assert result.status == "ok"
    assert captured == [["bash", str(registry_mod.SCRIPTS_DIR / "setup_daemons.sh"), "release"]]


def test_compatible_node_probe_enforces_toolchain_boundaries(tmp_path):
    def node(name, version):
        path = tmp_path / name
        path.write_text(f"#!/usr/bin/env bash\nprintf '{version}\\n'\n")
        path.chmod(0o755)
        return path

    node20_old = node("node20-old", "v20.17.0")
    node20 = node("node20", "v20.19.0")
    node22_old = node("node22-old", "v22.11.0")
    node22 = node("node22", "v22.12.0")
    node24 = node("node24", "v24.15.0")
    node26 = node("node26", "v26.1.0")
    malformed = node("malformed", "v20")

    for rejected in (node20_old, node22_old, node26, malformed):
        assert registry_mod._compatible_node_present([rejected]) is False
    for accepted in (node20, node22, node24):
        assert registry_mod._compatible_node_present([accepted]) is True


def test_deps_probe_accepts_only_core_postconditions(monkeypatch):
    required = {"ffmpeg", "sox"}
    monkeypatch.setattr(registry_mod, "_compatible_node_present", lambda: True)
    monkeypatch.setattr(registry_mod, "_have", lambda command: command in required)
    assert registry_mod._deps_ready() is True

    for missing in required:
        monkeypatch.setattr(registry_mod, "_have", lambda command, missing=missing: command in required - {missing})
        assert registry_mod._deps_ready() is False

    monkeypatch.setattr(registry_mod, "_have", lambda command: command in required)
    monkeypatch.setattr(registry_mod, "_compatible_node_present", lambda: False)
    assert registry_mod._deps_ready() is False


# ── (3) returncode -> ok / error mapping ─────────────────────────────


def test_apply_returncode_zero_is_ok(monkeypatch):
    def _ok(cmd, *a, **k):
        return subprocess.CompletedProcess(cmd, 0, stdout="done\n", stderr="")

    monkeypatch.setattr(registry_mod.subprocess, "run", _ok)
    step = ScriptStep("ui", "setup_ui.sh", probe=lambda: False)
    result = step.apply("release")
    assert result.status == "ok"


def test_apply_returncode_nonzero_is_error_with_truncated_detail(monkeypatch):
    long_err = "E" * 2000

    def _fail(cmd, *a, **k):
        return subprocess.CompletedProcess(cmd, 1, stdout="", stderr=long_err)

    monkeypatch.setattr(registry_mod.subprocess, "run", _fail)
    step = ScriptStep("daemons", "setup_daemons.sh", probe=lambda: False)
    result = step.apply("release")
    assert result.status == "error"
    assert result.detail  # carries the stderr
    assert len(result.detail) <= 500
    assert result.detail.endswith("E")


def test_apply_passes_argv_list_no_shell(monkeypatch):
    """T-06-01: the wrapped script must be invoked as an argv LIST (no shell=True),
    with the script path joined under SCRIPTS_DIR and only the mode literal variable."""
    captured = {}

    def _spy(cmd, *a, **k):
        captured["cmd"] = cmd
        captured["shell"] = k.get("shell", False)
        return subprocess.CompletedProcess(cmd, 0, stdout="", stderr="")

    monkeypatch.setattr(registry_mod.subprocess, "run", _spy)
    step = ScriptStep("deps", "setup_deps.sh", probe=lambda: False)
    step.apply("release")
    cmd = captured["cmd"]
    assert isinstance(cmd, list)
    assert cmd[0] == "bash"
    assert cmd[1] == str(registry_mod.SCRIPTS_DIR / "setup_deps.sh")
    assert cmd[2] == "release"
    assert captured["shell"] is False


# ── (4) REGISTRY = four steps, setup.sh order, 1:1 script map ────────


def test_registry_four_steps_in_order():
    assert [s.name for s in REGISTRY] == [name for name, _ in EXPECTED_STEPS]


def test_registry_each_is_scriptstep_wrapping_matching_script():
    by_name = {s.name: s for s in REGISTRY}
    for name, script in EXPECTED_STEPS:
        step = by_name[name]
        assert isinstance(step, ScriptStep)
        assert isinstance(step, Step)
        assert step.script == script
        assert (SCRIPTS / script).exists(), f"{script} must exist on disk"


# ── (5) step_by_name ────────────────────────────────────────────────


def test_step_by_name_resolves_known():
    step = step_by_name("ui")
    assert step.name == "ui"
    assert step is step_by_name("ui")  # the same registry instance


def test_step_by_name_raises_on_unknown():
    with pytest.raises((KeyError, ValueError)) as exc:
        step_by_name("not-a-step")
    # the error surfaces the valid names so a caller can recover
    msg = str(exc.value)
    assert "deps" in msg and "ui" in msg


# ── (6) hermetic real-bash drive + idempotency at the registry layer ─


STUBBED_COMMANDS = [
    "brew", "cloudflared", "ffmpeg", "launchctl", "npm", "node", "curl", "swiftc", "nc",
    "tccutil", "open", "pkill", "pgrep", "xattr", "gog",
    "sox", "terminal-notifier", "sw_vers",
]


def _make_shim_dir(tmp_path: Path) -> Path:
    shim = tmp_path / "shim-bin"
    shim.mkdir()
    for name in STUBBED_COMMANDS:
        stub = shim / name
        if name == "node":
            stub.write_text("#!/usr/bin/env bash\n[[ \"${1:-}\" == \"-v\" ]] && printf 'v24.15.0\\n'\nexit 0\n")
        else:
            stub.write_text("#!/usr/bin/env bash\nexit 0\n")
        stub.chmod(stub.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return shim


def _hermetic_env(tmp_path: Path, shim: Path) -> dict:
    home = tmp_path / "home"
    config_dir = home / ".config" / "yulu"
    config_dir.mkdir(parents=True, exist_ok=True)
    launch_agents = home / "Library" / "LaunchAgents"
    launch_agents.mkdir(parents=True, exist_ok=True)
    env = os.environ.copy()
    env.update({
        "HOME": str(home),
        "PATH": f"{shim}{os.pathsep}{os.environ.get('PATH', '')}",
        "CONFIG_DIR": str(config_dir),
        "LAUNCH_AGENTS_DIR": str(launch_agents),
        "UPGRADE_MODE": "false",
    })
    return env


@pytest.mark.integration
def test_scriptstep_drives_real_bash_hermetically_and_second_apply_skips(tmp_path, monkeypatch):
    """Reuse test_setup_decomposition's no-op PATH shim: drive a real
    ScriptStep.apply("release") behind the shim + a throwaway HOME, assert the
    status is in {ok, skipped}, and that a SECOND apply() on the same step (once
    its probe reports done) returns "skipped" — idempotency at the registry layer.

    The wrapped setup_deps.sh runs the real bash body; the side-effectful externals
    (brew/curl/...) are no-op stubs, so nothing on the host mutates.
    """
    shim = _make_shim_dir(tmp_path)
    env = _hermetic_env(tmp_path, shim)
    # Drive the registry's real subprocess against the hermetic environment.
    for key, value in env.items():
        monkeypatch.setenv(key, value)

    # A probe we control: first run "not done", then flip to "done".
    state = {"done": False}
    step = ScriptStep("deps", "setup_deps.sh", probe=lambda: state["done"])

    first = step.apply("release")
    assert first.status in {"ok", "skipped"}, first

    # Once the concern reports done, a re-apply must short-circuit to skipped
    # without re-invoking bash.
    state["done"] = True
    monkeypatch.setattr(registry_mod.subprocess, "run", _explode)
    second = step.apply("release")
    assert second.status == "skipped"
