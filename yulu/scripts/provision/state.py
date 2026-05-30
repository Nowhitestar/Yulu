#!/usr/bin/env python3
"""Resumable per-step provisioning ledger backing ``.yulu-install.json`` (PROV-04, D-04).

This module is the durability spine of the kill-at-step-N resume contract
(PROV-02 spike exit criterion 1). It mirrors ``queue_store.py``'s proven local
primitive — ``tempfile.mkstemp`` + ``os.replace`` atomic write (optionally an
``fcntl.flock``) — so a ``SIGKILL`` mid-write leaves either the old or the new
ledger, never a torn file (T-06-05).

EXTENDS, DOES NOT REPLACE, THE INSTALLER DOC
--------------------------------------------
``.yulu-install.json`` is written FIRST by the Phase-1 installer
(``release_installer.write_install_metadata`` → ``{schema:1, source, installed_at,
version, asset, sha256, ...}``). This ledger ADDS a per-step ``steps:{name:
{status, ts}}`` map plus a ``schema_version`` ON TOP of that doc — it never treats
the file as greenfield. ``mark()`` loads the existing doc and PRESERVES the
installer keys via ``setdefault``/merge.

PITFALL 3 — NEVER CLOBBER ``source`` (RESEARCH §"Pitfall 3", T-06-07)
--------------------------------------------------------------------
The installer-written ``source`` field ("release" | "dev") is security-relevant:
``lib/common.sh:detect_source`` reads it to fork dev-vs-release behaviour. A
release install that LOST its ``source`` would, on the next update, fall into the
swiftc **dev** branch (recompiling/re-signing binaries that should be reused).
Dropping ``source`` is therefore a tamper-equivalent regression. ``mark()`` must
load → preserve ``source`` (and ``version``/``sha256``/``installed_at``) → add
only ``steps``/``schema_version``. The PRESERVE test is the guard.

KILL-AT-STEP-N RESUME CONTRACT (PROV-04, RESEARCH §"Pitfall 2")
---------------------------------------------------------------
A step is marked ``running`` durably BEFORE its ``apply()``, and ``ok`` only
AFTER a clean (0-exit) return. So a ``SIGKILL`` during ``apply()`` leaves the
step non-``ok`` (``running`` — or absent if killed before the first mark). On the
next run that step is NOT ``ok`` and is re-run; every step recorded ``ok`` is
skipped. The wrapped bash is idempotent (each ``ScriptStep.check()`` short-circuits
to ``skipped`` + the scripts' own idempotency — ``install_plist`` unloads before
reload, ``brew install`` no-ops, ``npm ci`` is lockfile-gated), so re-running a
half-applied step duplicates no daemons.

Resume walk (driven by the CLI/registry in Plan 04 — NOT implemented here; this
module supplies the primitives + ``resume_order``)::

    for step in REGISTRY:                       # registry order
        if state.is_done(ledger, step.name):    # recorded "ok" → SKIP, redo nothing
            continue
        state.mark(ledger, step.name, "running")  # durable BEFORE mutation
        result = step.apply(mode)               # killed here ⇒ stays non-"ok"
        state.mark(ledger, step.name, result.status, result.detail)
        if result.status == "error":
            break                               # resume picks up here next run

A MISSING ``steps`` key means a FRESH ledger, not a migration (an existing v0.5.x
install simply has no ``steps`` yet — its first ``yulu provision`` walks every step,
each ``check()`` skipping the already-satisfied ones). Cleaning up the legacy
``venv-mlx-whisper`` / stale config is Phase 7 (D-08), explicitly NOT here.

stdlib only: json, os, tempfile, datetime, pathlib (+ optional fcntl for
queue_store parity — ``os.replace`` single-writer atomicity is the correctness
guarantee, the lock is cheap insurance for a concurrent invocation: T-06-08).
"""

from __future__ import annotations

import contextlib
import fcntl
import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterator

# The installer writes ``schema: 1`` (release_installer.py:248). This ledger bumps
# a SEPARATE ``schema_version: 2`` key WITHOUT removing the installer's ``schema``
# — both coexist in the doc (D-04: "schema_version built on the existing source").
SCHEMA_VERSION = 2

# The installer-written keys this ledger MUST carry through untouched on every
# write. ``source`` is the Pitfall-3-critical one (dev/release fork); the rest are
# provenance the installer recorded. ``mark()`` preserves whatever subset is present.
_INSTALLER_KEYS = ("source", "version", "sha256", "installed_at", "asset", "branch", "commit", "schema")

# Default ledger filename, matching release_installer.install_metadata_path
# (runtime_dir / ".yulu-install.json"). The default path resolver lazily imports
# the platform PathResolver so importing state.py stays stdlib-pure and cheap.
_LEDGER_NAME = ".yulu-install.json"


def _now() -> str:
    """ISO-8601 UTC ``...Z`` timestamp, byte-for-byte the form

    ``release_installer.write_install_metadata`` uses (line 250) so ledger
    timestamps read identically to the installer's ``installed_at``.
    """
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def default_ledger_path() -> Path:
    """Resolve the installed tree's ``.yulu-install.json`` (runtime_dir / name).

    Reuses ``release_installer.install_metadata_path`` semantics via the platform
    ``PathResolver.runtime_dir()``. Lazily imported + degrades to ``~/.config/yulu``
    so a probe never crashes on an unusual platform; callers (tests) pass an
    explicit path and never hit this.
    """
    try:
        from yulu_platform import get_platform

        runtime_dir = get_platform().path_resolver().runtime_dir()
    except Exception:
        runtime_dir = Path.home() / ".config" / "yulu"
    return Path(runtime_dir) / _LEDGER_NAME


@contextlib.contextmanager
def _ledger_lock(path: Path) -> Iterator[None]:
    """Optional ``fcntl.flock`` parity with ``queue_store.locked_queue``.

    Single-writer provisioning makes ``os.replace`` atomicity sufficient on its
    own (T-06-08); the lock is cheap insurance against a concurrent ``yulu
    provision`` invocation. Best-effort — a lock failure never blocks a write.
    """
    lock_path = path.parent / f".{path.name}.lock"
    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        with lock_path.open("a+") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    except OSError:
        # Lock unavailable (read-only dir, exotic FS) → fall through unlocked;
        # os.replace is still atomic. Correctness does not depend on the lock.
        yield


def _atomic_write(path: Path, doc: dict) -> None:
    """Write ``doc`` to ``path`` atomically — == ``queue_store._write_queue_atomic``.

    ``tempfile.mkstemp`` in the SAME directory (so ``os.replace`` is a same-filesystem
    rename, hence atomic on POSIX), ``json.dump`` indent=2 ensure_ascii=False +
    trailing newline, then ``os.replace(tmp, path)``; the temp file is unlinked in
    ``finally`` so a mid-write failure leaves no ``.tmp`` litter. A kill between the
    write and the replace leaves the OLD doc fully intact (never a partial file).
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
            f.write("\n")
        os.replace(tmp, path)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def load(path: Path) -> dict:
    """Read the ledger; degrade missing/corrupt → ``{}`` (matches

    ``release_installer.read_install_metadata:262-270``). A corrupt ledger is
    treated as a FRESH one (safe: every step is non-``ok`` so the first run walks
    them all, each ``check()`` skipping what is already satisfied) — never a crash.
    """
    path = Path(path)
    if not path.exists():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def mark(path: Path, step: str, status: str, detail: str = "") -> dict:
    """Record ``step`` at ``status`` (with ``ts``), PRESERVING the installer keys.

    THE PITFALL-3-CRITICAL FUNCTION. It loads the existing installer-written doc and
    keeps ``source``/``version``/``sha256``/``installed_at`` (et al.) via
    ``setdefault`` — DROPPING ``source`` would flip ``lib/common.sh:detect_source``
    into the swiftc **dev** branch on the next update (RESEARCH Pitfall 3 / T-06-07).
    It adds only ``schema_version`` and the ``steps`` entry, then writes atomically.

    ``status`` is one of the StepResult values ("running" | "ok" | "skipped" |
    "error"); ``is_done`` treats only ``"ok"`` as done. ``detail`` (when given) is
    stored alongside the entry. Returns the persisted doc (handy for tests/CLI).
    """
    path = Path(path)
    with _ledger_lock(path):
        doc = load(path)
        # schema_version is ADDED; the installer's own `schema:1` is preserved (it
        # lives in _INSTALLER_KEYS and is never touched here).
        doc.setdefault("schema_version", SCHEMA_VERSION)
        # PRESERVE the Phase-1 installer keys — never clobber (Pitfall 3 / T-06-07).
        # `setdefault(key, doc.get(key))` is a deliberate idempotent preserve: when
        # the key is present it keeps the installer-written value untouched; when
        # absent it stays absent (a ledger created before the installer ran simply
        # has no `source` yet — the fresh case, not a regression). The whole-doc
        # `load → add-only → write` shape already guarantees nothing is dropped; this
        # loop makes the source-clobber guard explicit and grep-visible.
        for key in _INSTALLER_KEYS:
            if key in doc:
                doc.setdefault(key, doc[key])
        steps = doc.setdefault("steps", {})
        entry: dict = {"status": status, "ts": _now()}
        if detail:
            entry["detail"] = detail
        steps[step] = entry
        _atomic_write(path, doc)
        return doc


def is_done(path: Path, step: str) -> bool:
    """True only when ``steps[step].status == "ok"``.

    "running"/"skipped"/"error"/absent are all NOT done → the step is re-run on
    resume. This is the kill-at-step-N invariant: a killed step (left "running"
    before it reached "ok") is never reported done, so resume re-applies exactly it.
    """
    steps = load(path).get("steps", {})
    entry = steps.get(step) if isinstance(steps, dict) else None
    return isinstance(entry, dict) and entry.get("status") == "ok"


def resume_order(registry_names: list[str], path: Path) -> list[str]:
    """The steps NOT yet ``ok``, in registry order — drives the resume walk.

    A MISSING ``steps`` key (fresh / corrupt ledger, or a pre-Phase-6 install) →
    every name is non-``ok`` → all are returned (NOT a migration; D-08). A run
    killed at step N returns step N and every step AFTER it (the prior ``ok`` steps
    are skipped, an in-flight non-``ok`` step is redone, and resume never re-runs an
    ``ok`` step). Order is preserved exactly so the walk respects setup.sh sequence.
    """
    return [name for name in registry_names if not is_done(path, name)]
