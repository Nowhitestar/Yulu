#!/usr/bin/env python3
"""Provision step registry — the named, idempotent step contract (PROV-01).

This module is the interface-defining spine of Phase 6 (D-06): plans 06-02
(state ledger) and 06-04 (CLI) compose against ``Step`` / ``StepResult`` /
``REGISTRY`` defined here.

WRAP, DON'T PORT (D-01 / D-06)
------------------------------
Each step WRAPS one of the four ``setup_*.sh`` concern scripts 1:1 via a
``subprocess.run(["bash", script, mode])`` argv list. It NEVER re-implements the
bash logic. The scripts (deps / audio / daemons / ui)
are already idempotent, non-interactive, mode-parameterized, and hermetically
tested by ``tests/test_setup_decomposition.py``. The registry adds only a Python
``check()`` / ``apply()`` / ``StepResult`` veneer over those exact bodies — so the
agent-driven ``yulu provision <step>`` path and the primary ``curl|bash`` install
path run the *same* tested scripts, with no logic duplicated in Python.

IDEMPOTENCY CONTRACT (D-01)
---------------------------
``check()`` is a READ-ONLY probe of the *resulting* state ("is this already
done?"), never a re-derivation of "did I run the script", and never mutates
anything. ``apply(mode)`` calls ``check()`` first and returns
``StepResult(status="skipped")`` when it is already satisfied — so re-running a
completed step (or a step whose work was finished by a prior interrupted run)
re-does no destructive work. This short-circuit is what makes the kill-at-step-N
resume in 06-02 safe at the registry layer.

uv / uvx — DEFERRED (D-07)
--------------------------
This phase does NOT adopt ``uv`` / ``uvx``. Host ``python3`` is the locked
interpreter since Phase-1 D-01; the registry needs only ``subprocess`` + the
stdlib, so adding ``uv`` would introduce a brand-new bootstrap dependency on every
user machine and expand scope into runtime management that nothing here requires.
Evaluated and deferred — revisit only if a future phase needs reproducible,
isolated tool envs (none in this milestone).

SCOPE BOUNDARY
--------------
This module defines the step contract and the wrapping ONLY. The asset-integrity
attestation gate (06-03 / ``attest.py``) and the resumable ``.yulu-install.json``
ledger (06-02 / ``state.py``) are sibling plans — they are NOT defined here.

Security (T-06-01 / T-06-02): the wrapped script path is always a FIXED REGISTRY
entry joined under ``SCRIPTS_DIR``; ``subprocess.run`` is always called with an
argv LIST (never ``shell=True``); the only caller-influenced value is the ``mode``
literal. ``step_by_name`` resolves only against the fixed table, so an unknown
step name raises rather than executing an arbitrary path.
"""

from __future__ import annotations

import shutil
import subprocess
from abc import ABC, abstractmethod
from dataclasses import dataclass
from pathlib import Path

# yulu/scripts/ — the directory holding the setup concern scripts and
# the lib/common.sh foundation. The registry joins each script name under here so
# the path is never caller-supplied (T-06-01).
SCRIPTS_DIR = Path(__file__).resolve().parent.parent

# How much of a failing script's stderr/stdout to carry in StepResult.detail.
_DETAIL_LIMIT = 500


# ── The result type ──────────────────────────────────────────────────


@dataclass(frozen=True)
class StepResult:
    """The outcome of running (or skipping) one provisioning step.

    ``status`` is exactly one of the three D-01 values: ``"ok"`` (apply ran and
    succeeded), ``"skipped"`` (``check()`` was already satisfied — nothing run),
    or ``"error"`` (apply ran and the wrapped script exited non-zero). ``detail``
    carries a short human message (e.g. the truncated tail of a failing script's
    stderr); it defaults to empty.

    Frozen to mirror ``release_installer.ReleaseAsset`` / ``InstallMetadata`` and
    so a result can be recorded in the ledger without later mutation.
    """

    name: str
    status: str  # "ok" | "skipped" | "error"
    detail: str = ""


# ── The step contract ────────────────────────────────────────────────


class Step(ABC):
    """One named provisioning concern.

    ``check()`` is a read-only probe (``True`` == already done, no mutation).
    ``apply(mode)`` performs the concern for the given install ``mode``
    (``"release"`` | ``"dev"``) and returns a ``StepResult``. Concrete steps wrap
    a Phase-1 ``setup_*.sh`` (see ``ScriptStep``).
    """

    name: str

    @abstractmethod
    def check(self) -> bool:
        """Return True iff this concern is already satisfied. Read-only."""
        raise NotImplementedError

    @abstractmethod
    def apply(self, mode: str, *, force: bool = False) -> StepResult:
        """Perform the concern (or skip it when ``check()`` is already True)."""
        raise NotImplementedError


class ScriptStep(Step):
    """A ``Step`` that WRAPS one Phase-1 ``setup_*.sh`` 1:1 (D-01).

    ``check()`` delegates to a read-only ``probe`` callable (filesystem /
    launchctl / config inspection — never a mutation). ``apply(mode)``
    short-circuits to ``status="skipped"`` when ``check()`` is already True; only
    otherwise does it invoke ``bash <SCRIPTS_DIR/script> <mode>`` via an argv-list
    ``subprocess.run`` (the same idiom as ``release_installer._run_setup_script``;
    no ``shell=True``). A zero exit maps to ``"ok"``; a non-zero exit maps to
    ``"error"`` carrying the truncated tail of stderr (or stdout).
    """

    def __init__(self, name: str, script: str, probe) -> None:
        self.name = name
        self.script = script
        self._probe = probe

    def check(self) -> bool:
        try:
            return bool(self._probe())
        except Exception:
            # A probe must never crash provisioning; an unknowable state means
            # "not confirmed done" → let apply() run (the script is idempotent).
            return False

    def apply(self, mode: str, *, force: bool = False) -> StepResult:
        # Idempotency contract: never re-do destructive work when already done.
        # Package upgrades deliberately force lifecycle reconciliation: the
        # packaged runtime can be new while the loaded LaunchAgents still point
        # at old code. In that case a state probe is not proof that the active
        # process is current, and the wrapped scripts are already idempotent.
        if not force and self.check():
            return StepResult(self.name, "skipped", "check() satisfied")
        proc = subprocess.run(
            ["bash", str(SCRIPTS_DIR / self.script), mode],
            cwd=str(SCRIPTS_DIR),
            capture_output=True,
            text=True,
        )
        if proc.returncode != 0:
            detail = (proc.stderr or proc.stdout or "").strip()[-_DETAIL_LIMIT:]
            return StepResult(self.name, "error", detail)
        return StepResult(self.name, "ok", "")


# ── Read-only probes for the concerns (check() bodies) ──────────────
#
# Each probe answers "is this concern already satisfied?" by INSPECTING state —
# never by mutating it. The probes intentionally degrade to False (run the step)
# rather than raise, so a probe failure never blocks provisioning; the wrapped
# bash is idempotent, so an unnecessary run is safe.


def _have(cmd: str) -> bool:
    """True iff ``cmd`` resolves on PATH (read-only, no execution)."""
    return shutil.which(cmd) is not None


def _compatible_node_present(candidates: list[Path] | None = None) -> bool:
    if candidates is None:
        candidates = []
        resolved = shutil.which("node")
        if resolved:
            candidates.append(Path(resolved))
        home = Path.home()
        for major in (20, 22, 24):
            candidates.extend((home / ".nvm" / "versions" / "node").glob(f"v{major}*/bin/node"))
            candidates.extend([
                Path(f"/opt/homebrew/opt/node@{major}/bin/node"),
                Path(f"/usr/local/opt/node@{major}/bin/node"),
            ])

    seen: set[Path] = set()
    for candidate in candidates:
        if candidate in seen or not candidate.is_file():
            continue
        seen.add(candidate)
        try:
            result = subprocess.run(
                [str(candidate), "-v"],
                capture_output=True,
                text=True,
                timeout=2,
                check=False,
            )
            major = int(result.stdout.strip().lstrip("v").split(".", 1)[0])
        except (OSError, ValueError, subprocess.SubprocessError):
            continue
        if result.returncode == 0 and 20 <= major <= 24:
            return True
    return False


def _deps_ready() -> bool:
    """deps: the brew-managed system tooling the steps rely on is on PATH."""
    return _have("brew") and _have("cloudflared") and _compatible_node_present()


def _audio_ready() -> bool:
    """audio: the compiled Yulu.app audio_daemon binary exists and is executable."""
    binary = SCRIPTS_DIR / "Yulu.app" / "Contents" / "MacOS" / "audio_daemon"
    return binary.is_file() and (binary.stat().st_mode & 0o111) != 0


def _launchagents_loaded() -> bool:
    """daemons: launchctl reports at least one com.yulu.* agent loaded."""
    if not _have("launchctl"):
        return False
    try:
        proc = subprocess.run(
            ["launchctl", "list"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except Exception:
        return False
    return proc.returncode == 0 and "com.yulu" in proc.stdout


def _ui_built() -> bool:
    """ui: the built yulu_ui server bundle exists on disk. A /healthz curl is also
    acceptable, but a file-existence probe is sufficient and hermetic-test-safe."""
    return (SCRIPTS_DIR / "yulu_ui" / "dist" / "server.js").is_file()


# ── The ordered registry (setup.sh sequence) ─────────────────────────
#
# Order mirrors setup.sh:894-919 exactly:
#   deps → audio → daemons → ui
# Each entry wraps its setup_*.sh 1:1 with the matching read-only probe.

REGISTRY: list[Step] = [
    ScriptStep("deps", "setup_deps.sh", probe=_deps_ready),
    ScriptStep("audio", "setup_audio.sh", probe=_audio_ready),
    ScriptStep("daemons", "setup_daemons.sh", probe=_launchagents_loaded),
    ScriptStep("ui", "setup_ui.sh", probe=_ui_built),
]

_BY_NAME = {step.name: step for step in REGISTRY}


def step_by_name(name: str) -> Step:
    """Resolve a step by name against the FIXED registry table (T-06-02).

    Raises ``KeyError`` (with the list of valid names) on an unknown name — an
    untrusted step name can therefore never execute an arbitrary script path.
    """
    try:
        return _BY_NAME[name]
    except KeyError:
        valid = ", ".join(s.name for s in REGISTRY)
        raise KeyError(f"unknown step {name!r}; valid steps: {valid}") from None
