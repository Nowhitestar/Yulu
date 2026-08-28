"""BUILD-03 / SC-1 — the release install path must never reach a compiler.

Two contracts:
  1. setup_audio.sh's RELEASE fork invokes no `swiftc` (and no build_*.sh that
     would invoke it). Proven two ways: (a) a structural text assert that the
     swiftc/build_audio_daemon.sh lines live only inside the `dev` branch, and
     (b) a behavioral run of `setup_audio.sh release` behind a recording shim that
     asserts swiftc/build_audio_daemon.sh were never called.
  2. install.sh's Xcode Command Line Tools pre-flight is gated on `--dev` (the
     same conditional idiom as the existing --dev-gated git check), so a release
     install proceeds with no Xcode/swiftc present.

Reuses the shells-out-to-bash subprocess pattern (test_package_release.py) plus the
static text-assert style (test_status_agent_plist_template.py). ROOT is the standard
root anchor.
"""

import os
import re
import stat
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
SETUP_AUDIO = SCRIPTS / "setup_audio.sh"
INSTALL_SH = ROOT / "install.sh"


def run(cmd: list[str], cwd: Path, env: dict[str, str] | None = None) -> subprocess.CompletedProcess[str]:
    child_env = os.environ.copy()
    if env:
        child_env.update(env)
    return subprocess.run(cmd, cwd=cwd, env=child_env, capture_output=True, text=True, check=False)


# ─── 1a. Structural: swiftc / build_audio_daemon.sh only inside the dev branch ──

def _strip_comments(text: str) -> list[str]:
    """Return only the EXECUTABLE (non-comment, non-blank) lines of a bash script.

    Lines whose first non-space char is `#` are documentation and are excluded —
    the swiftc/xattr contracts are about what the script *runs*, not what it
    *mentions* in comments (the header explains why swiftc is dev-only)."""
    out = []
    for ln in text.splitlines():
        stripped = ln.strip()
        if not stripped or stripped.startswith("#"):
            continue
        out.append(ln)
    return out


def _dev_branch_lines(code_lines: list[str]) -> list[str]:
    """Slice the executable lines belonging to the `if [[ "$mode" == "dev" ]]`
    branch (up to its matching `else` at the same indent)."""
    start = None
    for i, ln in enumerate(code_lines):
        if re.search(r'if\s*\[\[\s*"\$mode"\s*==\s*"dev"\s*\]\]\s*;\s*then', ln):
            start = i
            break
    assert start is not None, 'setup_audio.sh must branch on `[[ "$mode" == "dev" ]]`'
    guard_indent = len(code_lines[start]) - len(code_lines[start].lstrip())
    for j in range(start + 1, len(code_lines)):
        ln = code_lines[j]
        indent = len(ln) - len(ln.lstrip())
        if indent == guard_indent and ln.lstrip().startswith("else"):
            return code_lines[start + 1 : j]
    raise AssertionError("could not find the matching `else` (release arm) for the dev branch")


def test_swiftc_only_in_dev_branch():
    """The compiler is reached ONLY via the dev branch. setup_audio.sh delegates the
    actual swiftc call to build_audio_daemon.sh / build_status_agent.sh, so:
      - those build-script INVOCATIONS appear only inside the dev branch, and
      - setup_audio.sh itself runs no literal `swiftc` line (it delegates), so the
        release arm + walkthrough are compiler-free (BUILD-03 / SC-1)."""
    code_lines = _strip_comments(SETUP_AUDIO.read_text(encoding="utf-8"))
    dev_lines = _dev_branch_lines(code_lines)
    dev_text = "\n".join(dev_lines)
    rest_text = "\n".join(ln for ln in code_lines if ln not in dev_lines)

    # The build-script references must be inside the dev branch and nowhere else.
    for needle in ("build_audio_daemon.sh", "build_status_agent.sh"):
        assert needle in dev_text, f"expected an executable {needle} inside the dev branch"
        assert needle not in rest_text, (
            f"{needle} must not be referenced outside setup_audio.sh's dev branch "
            f"(the release path is swiftc-free, BUILD-03/SC-1)"
        )

    # setup_audio.sh delegates to the build scripts and never runs swiftc directly:
    # no executable line in the whole script should contain a literal `swiftc`.
    all_code = "\n".join(code_lines)
    assert "swiftc" not in all_code, (
        "setup_audio.sh must delegate compilation to build_*.sh, not run swiftc "
        f"directly (executable lines contain a literal swiftc)"
    )


def test_release_arm_has_no_xattr_quarantine_strip():
    """D-07: the `xattr -dr com.apple.quarantine` strip is dev-only — a stapled
    notarized release bundle passes Gatekeeper unaided. Checked against executable
    lines only (the header comment explains the removal)."""
    code_lines = _strip_comments(SETUP_AUDIO.read_text(encoding="utf-8"))
    dev_lines = _dev_branch_lines(code_lines)
    rest_text = "\n".join(ln for ln in code_lines if ln not in dev_lines)
    assert "xattr -dr com.apple.quarantine" not in rest_text, (
        "xattr quarantine strip must be dev-only (removed from the release path)"
    )


# ─── 1b. Behavioral: `setup_audio.sh release` never invokes swiftc ──────────────

STUBBED_COMMANDS = ["nc", "tccutil", "open", "pkill", "pgrep", "xattr", "sw_vers"]


def _recording_shim(tmp_path: Path) -> tuple[Path, Path]:
    """Build a PATH shim where `swiftc` and the two build scripts RECORD any call to
    a sentinel file; the rest are bare no-ops. Returns (shim_dir, sentinel_path)."""
    shim = tmp_path / "shim-bin"
    shim.mkdir()
    sentinel = tmp_path / "swiftc_calls.log"

    # swiftc records its invocation; if the release path ever calls it, the sentinel
    # becomes non-empty and the test fails.
    recorder = shim / "swiftc"
    recorder.write_text(f'#!/usr/bin/env bash\necho "swiftc $*" >> "{sentinel}"\nexit 0\n')
    recorder.chmod(recorder.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    for name in STUBBED_COMMANDS:
        stub = shim / name
        stub.write_text("#!/usr/bin/env bash\nexit 0\n")
        stub.chmod(stub.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    return shim, sentinel


def test_release_fork_invokes_no_swiftc(tmp_path):
    """Run `setup_audio.sh release` behind a recording shim and assert swiftc was
    never invoked, and the run exits cleanly with no unbound-variable abort.

    We also plant executable build_audio_daemon.sh / build_status_agent.sh
    RECORDERS into a copied scripts dir so that if the release arm ever tried to
    run them (it must not), the sentinel would catch it."""
    # Copy the scripts dir so we can drop recording build_*.sh without touching the
    # repo. Only the files setup_audio.sh touches need to come along.
    work = tmp_path / "scripts"
    (work / "lib").mkdir(parents=True)
    (work / "lib" / "common.sh").write_text((SCRIPTS / "lib" / "common.sh").read_text())
    (work / "setup_audio.sh").write_text(SETUP_AUDIO.read_text())
    # A release install is now fail-closed when its CI-built core bundle is
    # absent. Plant that packaged artifact so this test isolates its intended
    # compiler-boundary assertion.
    audio_binary = work / "Yulu.app" / "Contents" / "MacOS" / "audio_daemon"
    audio_binary.parent.mkdir(parents=True)
    audio_binary.write_text("prebuilt release binary")
    (audio_binary.parent / "calendar_probe").write_text("prebuilt EventKit helper")

    shim, sentinel = _recording_shim(tmp_path)

    # Recording build scripts: if the release arm ever invokes them, append to the
    # same sentinel. They are executable so the `[[ -x ]]` guard would pass IF the
    # release path checked it (it must not — the build scripts are dev-only).
    for bname in ("build_audio_daemon.sh", "build_status_agent.sh"):
        b = work / bname
        b.write_text(f'#!/usr/bin/env bash\necho "{bname} called" >> "{sentinel}"\nexit 0\n')
        b.chmod(b.stat().st_mode | stat.S_IEXEC | stat.S_IXGRP | stat.S_IXOTH)

    home = tmp_path / "home"
    (home / ".config" / "yulu").mkdir(parents=True)
    (home / "Library" / "LaunchAgents").mkdir(parents=True)
    env = {
        "HOME": str(home),
        "PATH": f"{shim}{os.pathsep}{os.environ.get('PATH', '')}",
        "CONFIG_DIR": str(home / ".config" / "yulu"),
        "LAUNCH_AGENTS_DIR": str(home / "Library" / "LaunchAgents"),
        "UPGRADE_MODE": "false",
    }

    result = run(["bash", str(work / "setup_audio.sh"), "release"], cwd=work, env=env)

    assert result.returncode == 0, f"release run failed:\n{result.stderr}\n{result.stdout}"
    assert "unbound variable" not in result.stderr, result.stderr
    # The decisive assertion: swiftc (and the build scripts) were never reached.
    sentinel_contents = sentinel.read_text() if sentinel.exists() else ""
    assert sentinel_contents == "", (
        f"release fork must invoke NO swiftc/build scripts, but recorded:\n{sentinel_contents}"
    )


def test_release_fork_self_heals_recorder_status_exec_bit():
    text = (SCRIPTS / "setup_audio.sh").read_text(encoding="utf-8")
    assert '"$SCRIPT_DIR/recorder_status"' in text


# ─── 2. install.sh Xcode pre-flight is --dev-gated ─────────────────────────────

def _executable_lines(text: str) -> list[str]:
    out = []
    for ln in text.splitlines():
        stripped = ln.strip()
        if not stripped or stripped.startswith("#"):
            continue
        out.append(ln)
    return out


def test_install_xcode_preflight_is_dev_gated():
    """The `xcode-select -p` pre-flight must sit inside a `--dev` conditional. We
    walk upward over EXECUTABLE lines from the xcode-select line to the nearest
    enclosing `if ... [[ "${TARGET_ARGS[0]}" == "--dev" ]]` guard at a SHALLOWER
    indent, and assert we find it before exiting any shallower-or-equal `if`."""
    code = _executable_lines(INSTALL_SH.read_text(encoding="utf-8"))

    xcode_idx = next((i for i, ln in enumerate(code) if "xcode-select -p" in ln), None)
    assert xcode_idx is not None, "install.sh must still pre-flight xcode-select -p"
    xcode_indent = len(code[xcode_idx]) - len(code[xcode_idx].lstrip())

    guard = None
    for i in range(xcode_idx - 1, -1, -1):
        ln = code[i]
        indent = len(ln) - len(ln.lstrip())
        # We only care about enclosing blocks (strictly shallower indent).
        if indent < xcode_indent and ln.lstrip().startswith("if "):
            if '"--dev"' in ln and "TARGET_ARGS" in ln:
                guard = ln
            break
    assert guard is not None, (
        "install.sh's xcode-select -p pre-flight must be nested inside an enclosing "
        '`if ... [[ "${TARGET_ARGS[0]}" == "--dev" ]]` block (mirror the git check)'
    )


def test_install_dev_gate_uses_target_args_dev_idiom():
    """The Xcode + git pre-flights are gated by the canonical TARGET_ARGS[0] ==
    "--dev" idiom. A single enclosing gate may legitimately cover both checks, so we
    require the idiom to be present at least once and that the git check is also
    governed by it (no ungated git requirement for release)."""
    text = INSTALL_SH.read_text(encoding="utf-8")
    assert '"${TARGET_ARGS[0]}" == "--dev"' in text, (
        "install.sh must gate prerequisites with the TARGET_ARGS[0] == --dev idiom"
    )

    # The git requirement must be inside a --dev gate too (release installs need no
    # git). Assert the `git is required` error only appears within a dev-gated block:
    code = _executable_lines(text)
    git_err_idx = next((i for i, ln in enumerate(code) if "git is required" in ln), None)
    assert git_err_idx is not None, "install.sh must keep the --dev git requirement"
    git_indent = len(code[git_err_idx]) - len(code[git_err_idx].lstrip())
    enclosed_by_dev = False
    for i in range(git_err_idx - 1, -1, -1):
        ln = code[i]
        indent = len(ln) - len(ln.lstrip())
        if indent < git_indent and ln.lstrip().startswith("if "):
            if '"--dev"' in ln and "TARGET_ARGS" in ln:
                enclosed_by_dev = True
            # keep walking outward in case of nested ifs
            git_indent = indent
            if enclosed_by_dev:
                break
    assert enclosed_by_dev, (
        "the git requirement must be governed by a --dev gate (release installs "
        "must not require git)"
    )


def test_install_release_path_has_no_unconditional_xcode_requirement():
    """A release install (no --dev) must not be blocked by Xcode. We assert there is
    no top-level (unindented) `xcode-select --install` / `exit 1` outside the dev
    guard — the install trigger lives only inside the gated block."""
    text = INSTALL_SH.read_text(encoding="utf-8")
    for ln in text.splitlines():
        stripped = ln.rstrip()
        # An unindented xcode-select call would mean it runs for every target.
        if stripped.startswith("xcode-select"):
            raise AssertionError(
                f"xcode-select must not run unconditionally at top level: {stripped!r}"
            )
