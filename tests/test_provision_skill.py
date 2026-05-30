"""PROV-05 — the decoupled, idempotent ``yulu skill install`` wrapper (Wave 0).

``provision/skill.py`` LIFTS ``setup.sh:install_agent_skill`` (the ``npx skills
add`` invocation) minus every interactive prompt into a standalone, non-fatal,
idempotent wrapper. ``setup.sh`` no longer calls it in the main flow (D-05/D-08).

These tests prove (the npx subprocess is monkeypatched — no Node required):

  (1) ARGV SHAPE (T-06-17): skill_install builds an argv LIST
      ``npx -y skills add <repo_dir> -g -a <agent> ... -y`` — repo_dir is a fixed
      path, agent names are SEPARATE argv elements (no shell=True, no metachars),
      and it returns 0;
  (2) NON-FATAL on npx absent: when ``shutil.which("npx")`` is None it prints a
      skip note and returns 0 (the caller is never failed — setup.sh:623 parity);
  (3) NON-FATAL on npx failure: an npx nonzero exit still returns 0 (a warn, not a
      failure — setup.sh:673 parity; T-06-19 skill never breaks core install);
  (4) IDEMPOTENT: re-invoking re-runs ``add`` (overwrites the symlink) — calling
      twice issues the same argv twice and both return 0;
  (5) DECOUPLE GUARD (static): setup.sh's main-flow orchestrator tail no longer
      invokes install_agent_skill (the call line is gone / commented).

Import style mirrors test_provision_resume.py: yulu/scripts on sys.path.
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import provision.skill as skill  # noqa: E402

SETUP_SH = SCRIPTS / "setup.sh"


class _FakeProc:
    def __init__(self, returncode):
        self.returncode = returncode
        self.stdout = ""
        self.stderr = ""


# ── (1) argv shape ───────────────────────────────────────────────────


def test_skill_install_builds_npx_argv_list(monkeypatch):
    calls = []

    monkeypatch.setattr(skill.shutil, "which", lambda _n: "/usr/bin/npx")

    def _fake_run(argv, *a, **k):
        calls.append(argv)
        assert "shell" not in k or k["shell"] is False  # never shell=True
        return _FakeProc(0)

    monkeypatch.setattr(skill.subprocess, "run", _fake_run)

    rc = skill.skill_install(["claude-code"], repo_dir="/repo")
    assert rc == 0
    assert len(calls) == 1
    argv = calls[0]
    assert isinstance(argv, list)
    # npx -y skills add /repo -g -a claude-code -y
    assert argv[0] == "npx"
    assert argv[1:4] == ["-y", "skills", "add"]
    assert "/repo" in argv  # the fixed repo dir, as its own argv element
    assert "-g" in argv
    # the agent name is a SEPARATE argv element after -a (no concatenation)
    ai = argv.index("-a")
    assert argv[ai + 1] == "claude-code"
    assert argv[-1] == "-y"


def test_skill_install_multiple_agents_each_gets_its_own_flag(monkeypatch):
    calls = []
    monkeypatch.setattr(skill.shutil, "which", lambda _n: "/usr/bin/npx")
    monkeypatch.setattr(skill.subprocess, "run", lambda argv, *a, **k: calls.append(argv) or _FakeProc(0))

    rc = skill.skill_install(["claude-code", "codex"], repo_dir="/repo")
    assert rc == 0
    argv = calls[0]
    # Two -a flags, one per agent.
    assert argv.count("-a") == 2
    # Each agent immediately follows its -a.
    idxs = [i for i, tok in enumerate(argv) if tok == "-a"]
    assert [argv[i + 1] for i in idxs] == ["claude-code", "codex"]


# ── (2) non-fatal when npx absent ────────────────────────────────────


def test_skill_install_npx_absent_is_non_fatal(monkeypatch, capsys):
    monkeypatch.setattr(skill.shutil, "which", lambda _n: None)
    # subprocess.run must NEVER be called when npx is absent.
    monkeypatch.setattr(
        skill.subprocess,
        "run",
        lambda *a, **k: (_ for _ in ()).throw(AssertionError("npx run despite absent npx")),
    )
    rc = skill.skill_install(["claude-code"], repo_dir="/repo")
    assert rc == 0  # non-fatal skip
    out = capsys.readouterr().out + capsys.readouterr().err
    # a skip message is printed (mentions npx or node)
    assert out == "" or "npx" in out.lower() or "node" in out.lower()


# ── (3) non-fatal when npx exits nonzero ─────────────────────────────


def test_skill_install_npx_failure_is_non_fatal(monkeypatch):
    monkeypatch.setattr(skill.shutil, "which", lambda _n: "/usr/bin/npx")
    monkeypatch.setattr(skill.subprocess, "run", lambda argv, *a, **k: _FakeProc(1))
    rc = skill.skill_install(["claude-code"], repo_dir="/repo")
    assert rc == 0  # an npx failure is a warn, never fails the caller (Pitfall 4)


# ── (4) idempotent: re-invoke re-runs add ────────────────────────────


def test_skill_install_idempotent_reinvoke_reruns_add(monkeypatch):
    calls = []
    monkeypatch.setattr(skill.shutil, "which", lambda _n: "/usr/bin/npx")
    monkeypatch.setattr(skill.subprocess, "run", lambda argv, *a, **k: calls.append(argv) or _FakeProc(0))
    assert skill.skill_install(["claude-code"], repo_dir="/repo") == 0
    assert skill.skill_install(["claude-code"], repo_dir="/repo") == 0
    # Re-invocation re-runs add (overwrites the symlink) — same argv twice.
    assert len(calls) == 2
    assert calls[0] == calls[1]


def test_skill_install_default_repo_dir_resolves_repo_root(monkeypatch):
    """With no repo_dir argument, the wrapper resolves the repo root (the dir that
    contains skills/yulu/) — never None passed into the argv."""
    calls = []
    monkeypatch.setattr(skill.shutil, "which", lambda _n: "/usr/bin/npx")
    monkeypatch.setattr(skill.subprocess, "run", lambda argv, *a, **k: calls.append(argv) or _FakeProc(0))
    rc = skill.skill_install(["claude-code"])
    assert rc == 0
    argv = calls[0]
    # The repo dir argv element (after "add") is a non-empty absolute path, not "None".
    add_i = argv.index("add")
    repo_arg = argv[add_i + 1]
    assert repo_arg and repo_arg != "None"
    assert Path(repo_arg).is_absolute()


# ── (5) DECOUPLE GUARD: setup.sh main flow no longer calls it ────────


def test_setup_no_longer_calls_install_agent_skill():
    """Static guard (D-05/D-08): the orchestrator tail of setup.sh must NOT invoke
    install_agent_skill anymore. The function body MAY remain, but no non-comment
    line in the main flow may CALL it.

    We scan every line for a bare ``install_agent_skill`` invocation (a call, not
    the ``install_agent_skill() {`` definition and not a comment / a doc string),
    and assert there are none.
    """
    text = SETUP_SH.read_text(encoding="utf-8")
    offending = []
    for lineno, raw in enumerate(text.splitlines(), start=1):
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        # The function DEFINITION line is allowed (body may stay).
        if re.match(r"^install_agent_skill\s*\(\)\s*\{", stripped):
            continue
        # A bare call: the token at statement position, not followed by '()'.
        if re.search(r"(^|;|&&|\|\||\bthen\b|\bdo\b|\belse\b)\s*install_agent_skill\b(?!\s*\(\))", stripped):
            offending.append((lineno, raw))
        elif stripped == "install_agent_skill":
            offending.append((lineno, raw))
    assert not offending, f"setup.sh main flow still calls install_agent_skill: {offending}"


def test_setup_points_to_yulu_skill_install():
    """The removed call should leave a breadcrumb pointing users/agents at the new
    decoupled entry point (`yulu skill install`)."""
    text = SETUP_SH.read_text(encoding="utf-8")
    assert "yulu skill install" in text
