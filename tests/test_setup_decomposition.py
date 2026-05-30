"""BUILD-01 / SC-3 — the decomposed setup_*.sh concern scripts (and lib/common.sh)
must each:
  (a) declare `set -uo pipefail`,
  (b) be syntactically valid (`bash -n`) AND run standalone in isolation without
      tripping an "unbound variable" abort under `set -u`, and
  (c) be idempotent — a second back-to-back run still succeeds.

The isolation/idempotency checks run each concern script in RELEASE mode behind a
no-op PATH shim (fake brew/launchctl/npm/node/curl/swiftc/nc/tccutil/open/... that
all exit 0) inside a throwaway HOME + CONFIG_DIR. This is hermetic (tmp dirs, no
network, no host mutation, non-interactive) per the plan's T-01-14 mitigation — the
real `python3`/`bash`/coreutils stay on PATH so the inline-python3 config writers
work, only the side-effectful externals are stubbed.

Reuses the repo's shells-out-to-bash subprocess pattern (test_package_release.py),
NOT bats. ROOT is the standard root anchor.
"""

import os
import stat
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"

# The six decomposed concern scripts the thin orchestrator (setup.sh) sequences.
CONCERN_SCRIPTS = [
    "setup_deps.sh",
    "setup_audio.sh",
    "setup_models.sh",
    "setup_capabilities.sh",
    "setup_daemons.sh",
    "setup_ui.sh",
]

# lib/common.sh is the shared foundation every concern script sources; it must also
# carry `set -uo pipefail` and source cleanly.
COMMON_LIB = "lib/common.sh"

# External commands the concern scripts may invoke for side effects. We stub these
# to no-op (exit 0) so a standalone run mutates nothing and never hangs on a prompt.
# `python3`/`bash`/coreutils are deliberately NOT stubbed — the inline-python3
# config writers need the real interpreter.
STUBBED_COMMANDS = [
    "brew",
    "launchctl",
    "npm",
    "node",
    "curl",
    "swiftc",
    "nc",
    "tccutil",
    "open",
    "pkill",
    "pgrep",
    "xattr",
    "gog",
    "terminal-notifier",
    "sw_vers",
]


def run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    child_env = os.environ.copy()
    if env:
        child_env.update(env)
    return subprocess.run(cmd, cwd=cwd, env=child_env, capture_output=True, text=True, check=False)


def _make_shim_dir(tmp_path: Path) -> Path:
    """Create a PATH-shim dir of no-op executables for the side-effectful externals.

    Each stub just `exit 0`. `npm` additionally needs to print a plausible
    `npm ci`/`npm run build` no-op (the scripts only check its exit code). `node`
    is stubbed to fail the version probe path gracefully — setup_ui.sh treats a
    missing/old node as "skip" (returns 0), which keeps the run hermetic without a
    real Node toolchain.
    """
    shim = tmp_path / "shim-bin"
    shim.mkdir()
    for name in STUBBED_COMMANDS:
        stub = shim / name
        # `node -v` returning nothing → setup_ui.sh's node_major guard treats it as
        # too-low/absent and skips the npm build (returncode 0). Everything else is
        # a bare exit-0 no-op.
        stub.write_text("#!/usr/bin/env bash\nexit 0\n")
        stub.chmod(stub.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    return shim


def _hermetic_env(tmp_path: Path, shim: Path) -> dict[str, str]:
    home = tmp_path / "home"
    config_dir = home / ".config" / "yulu"
    config_dir.mkdir(parents=True, exist_ok=True)
    launch_agents = home / "Library" / "LaunchAgents"
    launch_agents.mkdir(parents=True, exist_ok=True)
    return {
        "HOME": str(home),
        "PATH": f"{shim}{os.pathsep}{os.environ.get('PATH', '')}",
        "CONFIG_DIR": str(config_dir),
        "MODEL_DIR": str(config_dir / "models"),
        "LAUNCH_AGENTS_DIR": str(launch_agents),
        "UPGRADE_MODE": "false",
    }


# ─── (a) `set -uo pipefail` present ──────────────────────────────────

@pytest.mark.parametrize("script", CONCERN_SCRIPTS + [COMMON_LIB])
def test_concern_declares_set_uo_pipefail(script):
    text = (SCRIPTS / script).read_text(encoding="utf-8")
    assert "set -uo pipefail" in text, f"{script} must declare 'set -uo pipefail'"


# ─── (b) `bash -n` syntax valid ──────────────────────────────────────

@pytest.mark.parametrize("script", CONCERN_SCRIPTS + [COMMON_LIB])
def test_concern_bash_n_clean(script):
    result = run(["bash", "-n", str(SCRIPTS / script)], cwd=SCRIPTS)
    assert result.returncode == 0, result.stderr + result.stdout


# ─── lib/common.sh sources cleanly and defines its public helpers ────

def test_common_lib_sources_cleanly_under_set_u():
    """Sourcing lib/common.sh under `set -u` defines the helpers with no unbound
    abort. This is the isolation smoke for the sourced-not-executed foundation."""
    snippet = (
        "set -uo pipefail; "
        ". ./lib/common.sh; "
        "declare -f ok >/dev/null && declare -f install_plist >/dev/null "
        "&& declare -f resolve_install_mode >/dev/null && declare -f launch_path >/dev/null "
        "&& echo COMMON_OK"
    )
    result = run(["bash", "-c", snippet], cwd=SCRIPTS)
    assert result.returncode == 0, result.stderr + result.stdout
    assert "COMMON_OK" in result.stdout
    assert "unbound variable" not in result.stderr


# ─── (b)+(c) each concern runs standalone in isolation, idempotently ──

@pytest.mark.parametrize("script", CONCERN_SCRIPTS)
def test_concern_runs_in_isolation_no_unbound(tmp_path, script):
    """`bash setup_X.sh release` behind the no-op shim must exit 0 with no
    'unbound variable' in stderr — proving the Pitfall-5 global audit holds under
    `set -u`."""
    shim = _make_shim_dir(tmp_path)
    env = _hermetic_env(tmp_path, shim)
    result = run(["bash", str(SCRIPTS / script), "release"], cwd=SCRIPTS, env=env)
    assert result.returncode == 0, f"{script} returncode={result.returncode}\n{result.stderr}\n{result.stdout}"
    assert "unbound variable" not in result.stderr, f"{script} tripped set -u:\n{result.stderr}"


@pytest.mark.parametrize("script", CONCERN_SCRIPTS)
def test_concern_is_idempotent(tmp_path, script):
    """Running the same hermetic invocation twice (shared HOME/CONFIG_DIR) yields
    the same success — the second run does not error."""
    shim = _make_shim_dir(tmp_path)
    env = _hermetic_env(tmp_path, shim)
    first = run(["bash", str(SCRIPTS / script), "release"], cwd=SCRIPTS, env=env)
    assert first.returncode == 0, f"{script} first run failed:\n{first.stderr}\n{first.stdout}"
    second = run(["bash", str(SCRIPTS / script), "release"], cwd=SCRIPTS, env=env)
    assert second.returncode == 0, f"{script} second run failed:\n{second.stderr}\n{second.stdout}"
    assert "unbound variable" not in second.stderr


# ─── each concern is standalone-or-sourced (the guard is present) ────

@pytest.mark.parametrize("script", CONCERN_SCRIPTS)
def test_concern_has_standalone_guard(script):
    text = (SCRIPTS / script).read_text(encoding="utf-8")
    assert '[[ "${BASH_SOURCE[0]}" == "${0}" ]]' in text, (
        f"{script} must carry the standalone-or-sourced guard"
    )
