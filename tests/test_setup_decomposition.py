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
import shutil
import stat
import subprocess
from pathlib import Path

import pytest


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"

# The four decomposed concern scripts the thin orchestrator sequences.
CONCERN_SCRIPTS = [
    "setup_deps.sh",
    "setup_audio.sh",
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

    The Node/npm/curl stubs model a healthy required Host without launching it:
    Node reports v24, npm materializes the two checked build artifacts, and curl
    returns the /healthz payload. Other commands are successful no-ops.
    """
    shim = tmp_path / "shim-bin"
    shim.mkdir()
    for name in STUBBED_COMMANDS:
        stub = shim / name
        if name == "launchctl":
            # An absent service makes `launchctl print` non-zero; model that
            # separately from successful no-op load/bootout commands.
            stub.write_text(
                "#!/usr/bin/env bash\n"
                "[[ \"${1:-}\" == \"print\" ]] && exit 1\n"
                "exit 0\n"
            )
        elif name == "node":
            stub.write_text(
                "#!/usr/bin/env bash\n"
                "[[ \"${1:-}\" == \"-v\" ]] && printf 'v24.15.0\\n'\n"
                "exit 0\n"
            )
        elif name == "npm":
            stub.write_text(
                "#!/usr/bin/env bash\n"
                "mkdir -p node_modules\n"
                "if [[ \"${1:-}\" == \"run\" && \"${2:-}\" == \"build\" ]]; then\n"
                "  mkdir -p dist/web\n"
                "  printf 'server' > dist/server.js\n"
                "  printf 'web' > dist/web/index.html\n"
                "fi\n"
                "exit 0\n"
            )
        elif name == "curl":
            stub.write_text("#!/usr/bin/env bash\nprintf '{\"status\":\"ok\"}\\n'\n")
        else:
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
        "LAUNCH_AGENTS_DIR": str(launch_agents),
        "UPGRADE_MODE": "false",
    }


def test_setup_ui_accepts_node24_runtime(tmp_path):
    node = tmp_path / "node24"
    node.write_text("#!/usr/bin/env bash\nprintf 'v24.15.0\\n'\n")
    node.chmod(node.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)
    result = run(
        ["bash", "-c", ". ./setup_ui.sh; compatible_node_bin"],
        cwd=SCRIPTS,
        env={"NODE_BIN": str(node)},
    )
    assert result.returncode == 0, result.stderr + result.stdout
    assert result.stdout.strip().splitlines()[-1] == str(node)


def test_setup_ui_fails_when_required_host_node_is_unavailable(tmp_path):
    shim = _make_shim_dir(tmp_path)
    env = _hermetic_env(tmp_path, shim)
    result = run(
        ["bash", "-c", ". ./setup_ui.sh; compatible_node_bin() { return 1; }; setup_ui dev"],
        cwd=SCRIPTS,
        env=env,
    )
    assert result.returncode != 0
    assert "Host" in result.stdout


def test_setup_deps_propagates_brew_failure(tmp_path):
    shim = _make_shim_dir(tmp_path)
    (shim / "brew").write_text("#!/usr/bin/env bash\nexit 42\n")
    (shim / "brew").chmod(0o755)
    env = _hermetic_env(tmp_path, shim)
    result = run(["bash", str(SCRIPTS / "setup_deps.sh"), "release"], cwd=SCRIPTS, env=env)
    assert result.returncode != 0
    assert "安装失败" in result.stdout


def test_orchestrator_propagates_each_core_concern_failure():
    text = (SCRIPTS / "setup.sh").read_text(encoding="utf-8")
    for concern in ("setup_audio.sh", "setup_daemons.sh", "setup_ui.sh"):
        assert f'"$SCRIPT_DIR/{concern}" "$MODE" || return 1' in text


def test_setup_ui_release_uses_prebuilt_dist_without_rebuilding(tmp_path):
    scripts = tmp_path / "scripts"
    (scripts / "lib").mkdir(parents=True)
    (scripts / "yulu_ui" / "dist" / "web").mkdir(parents=True)
    shutil.copy2(SCRIPTS / "setup_ui.sh", scripts / "setup_ui.sh")
    shutil.copy2(SCRIPTS / "lib" / "common.sh", scripts / "lib" / "common.sh")
    shutil.copy2(SCRIPTS / "com.yulu.ui.plist", scripts / "com.yulu.ui.plist")
    shutil.copy2(SCRIPTS / "yulu_ui" / "package-lock.json", scripts / "yulu_ui" / "package-lock.json")
    (scripts / "yulu_ui" / "dist" / "server.js").write_text("signed-server")
    (scripts / "yulu_ui" / "dist" / "web" / "index.html").write_text("signed-web")
    shim = _make_shim_dir(tmp_path)
    calls = tmp_path / "npm-calls"
    (shim / "npm").write_text(
        "#!/usr/bin/env bash\n"
        "mkdir -p node_modules\n"
        f"printf '%s\\n' \"$*\" >> {calls}\n"
        "exit 0\n"
    )
    (shim / "npm").chmod(0o755)
    env = _hermetic_env(tmp_path, shim)
    result = run(["bash", str(scripts / "setup_ui.sh"), "release"], cwd=scripts, env=env)
    assert result.returncode == 0, result.stderr + result.stdout
    assert calls.read_text().splitlines() == ["ci --omit=dev"]
    assert (scripts / "yulu_ui" / "dist" / "server.js").read_text() == "signed-server"
    assert (scripts / "yulu_ui" / "dist" / "web" / "index.html").read_text() == "signed-web"


def test_setup_ui_release_rejects_missing_prebuilt_dist_before_npm(tmp_path):
    scripts = tmp_path / "scripts"
    (scripts / "lib").mkdir(parents=True)
    (scripts / "yulu_ui").mkdir(parents=True)
    shutil.copy2(SCRIPTS / "setup_ui.sh", scripts / "setup_ui.sh")
    shutil.copy2(SCRIPTS / "lib" / "common.sh", scripts / "lib" / "common.sh")
    shim = _make_shim_dir(tmp_path)
    calls = tmp_path / "npm-calls"
    (shim / "npm").write_text(
        "#!/usr/bin/env bash\n"
        f"printf '%s\\n' \"$*\" >> {calls}\n"
        "exit 0\n"
    )
    (shim / "npm").chmod(0o755)
    result = run(
        ["bash", str(scripts / "setup_ui.sh"), "release"],
        cwd=scripts,
        env=_hermetic_env(tmp_path, shim),
    )
    assert result.returncode != 0
    assert "CI" in result.stdout
    assert not calls.exists()


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
    mode = "dev" if script == "setup_ui.sh" else "release"
    result = run(["bash", str(SCRIPTS / script), mode], cwd=SCRIPTS, env=env)
    assert result.returncode == 0, f"{script} returncode={result.returncode}\n{result.stderr}\n{result.stdout}"
    assert "unbound variable" not in result.stderr, f"{script} tripped set -u:\n{result.stderr}"


@pytest.mark.parametrize("script", CONCERN_SCRIPTS)
def test_concern_is_idempotent(tmp_path, script):
    """Running the same hermetic invocation twice (shared HOME/CONFIG_DIR) yields
    the same success — the second run does not error."""
    shim = _make_shim_dir(tmp_path)
    env = _hermetic_env(tmp_path, shim)
    mode = "dev" if script == "setup_ui.sh" else "release"
    first = run(["bash", str(SCRIPTS / script), mode], cwd=SCRIPTS, env=env)
    assert first.returncode == 0, f"{script} first run failed:\n{first.stderr}\n{first.stdout}"
    second = run(["bash", str(SCRIPTS / script), mode], cwd=SCRIPTS, env=env)
    assert second.returncode == 0, f"{script} second run failed:\n{second.stderr}\n{second.stdout}"
    assert "unbound variable" not in second.stderr


# ─── each concern is standalone-or-sourced (the guard is present) ────

@pytest.mark.parametrize("script", CONCERN_SCRIPTS)
def test_concern_has_standalone_guard(script):
    text = (SCRIPTS / script).read_text(encoding="utf-8")
    assert '[[ "${BASH_SOURCE[0]}" == "${0}" ]]' in text, (
        f"{script} must carry the standalone-or-sourced guard"
    )
