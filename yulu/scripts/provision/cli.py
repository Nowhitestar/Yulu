#!/usr/bin/env python3
"""``yulu provision`` / ``yulu skill`` CLI — the resume-walk DRIVER (PROV-01 / PROV-02 / PROV-05).

This module is the user-facing (and agent-facing) surface for Phase 6. It does NOT
re-implement any of the three Wave-1 spines — it COMPOSES them:

  * ``registry`` (06-01) — the six named, idempotent steps (``REGISTRY`` /
    ``step_by_name`` / ``StepResult``); the wrapped ``setup_*.sh`` bodies.
  * ``state`` (06-02) — the resumable ``.yulu-install.json`` ledger
    (``mark`` / ``is_done`` / ``resume_order``); the kill-at-step-N durability.
  * ``attest`` (06-03) — the fail-closed asset-integrity gate
    (``verify_asset`` / ``TamperError``); the supply-chain control.

SUBCOMMANDS
-----------
``provision [<step>]``
    Run ONE named registry step: ``mark(running)`` before ``apply(mode)``, then
    ``mark(result.status)`` after, printing the ``StepResult``. An unknown step
    name errors and lists the valid names (T-06-16 — an untrusted name can never
    execute an arbitrary path; ``step_by_name`` resolves only against the fixed
    table).

``provision --all [--asset <zip> --checksums <txt>] [--mode release|dev]``
    The RESUME WALK — the spike's end-to-end driver (PROV-02). When ``--asset`` is
    supplied, the attest gate runs FIRST and FAIL-CLOSED: ``attest.verify_asset``
    is called BEFORE any ``step.apply()``, and a ``TamperError`` ABORTS the whole
    walk before a single step runs (T-06-15, the headline control). With NO
    ``--asset`` the gate is SKIPPED (there is no fresh asset to verify — the
    installed tree's integrity was established at install: RESEARCH Q1/Pitfall 5).
    Then it walks ``REGISTRY`` in order: a step already ``ok`` in the ledger is
    SKIPPED; otherwise ``mark(running)`` (durable, BEFORE ``apply``) → ``apply`` →
    ``mark(result)``; an ``error`` BREAKS the walk so the next invocation resumes
    from the failed step (the prior ``ok`` steps stay skipped — no daemon is
    duplicated, T-06-18).

``provision --list``
    Print the six step names (and exit 0).

``skill install [--agent <name> ...]``
    Delegate to ``skill.skill_install`` (PROV-05) — decoupled, idempotent,
    non-fatal agent-skill registration.

Security: every subprocess (inside the wrapped steps / the gate / the skill
wrapper) is an argv list; this CLI itself never shells out. The only
caller-influenced values are the step name (resolved against the fixed registry),
the agent names (passed as argv elements to the skill wrapper), and the asset/
checksums paths (handed to the gate as ``Path`` objects). Default mode is
``"release"`` (the primary install path — D-02).

stdlib (``argparse`` / ``sys`` / ``pathlib``) + the three provision modules only;
no new third-party import (mirrors ``vocab/cli.py``'s module-main shape).
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path
from typing import Optional

from . import attest, mcp, skill
from .registry import REGISTRY, step_by_name
from .state import default_ledger_path, is_done, mark


def _ledger_path(args: argparse.Namespace) -> Path:
    """The ledger to drive: an explicit ``--ledger`` (tests / advanced callers) or
    the installed tree's ``.yulu-install.json`` (``default_ledger_path``)."""
    if getattr(args, "ledger", None):
        return Path(args.ledger)
    return default_ledger_path()


def _run_step(name: str, mode: str, ledger: Path, *, force: bool = False) -> int:
    """Run a single named step with the running-before-apply / result-after
    ledger contract. Returns 0 on ok|skipped, 1 on error/unknown."""
    try:
        step = step_by_name(name)
    except KeyError as exc:
        # Unknown step → the KeyError message already lists the valid names.
        print(str(exc).strip("'\""), file=sys.stderr)
        return 1
    # Durable "running" BEFORE apply() so a kill mid-apply leaves the step non-ok
    # (resume re-runs exactly it). ``apply`` itself short-circuits to "skipped"
    # when ``check()`` is already satisfied (registry idempotency).
    mark(ledger, name, "running")
    result = step.apply(mode, force=True) if force else step.apply(mode)
    mark(ledger, name, result.status, result.detail)
    _print_result(result)
    return 0 if result.status in ("ok", "skipped") else 1


def _print_result(result) -> None:
    detail = f" — {result.detail}" if result.detail else ""
    print(f"[{result.status}] {result.name}{detail}")


def _run_all(args: argparse.Namespace) -> int:
    """The resume walk (PROV-02). Gate FIRST (fail-closed) when an asset is given,
    then walk REGISTRY skipping ok steps; break on the first error so a re-run
    resumes from it."""
    ledger = _ledger_path(args)
    mode = args.mode

    # ── GATE FIRST (T-06-15) — only when a fresh asset is supplied ──
    # With no --asset there is nothing to verify (the installed tree's integrity
    # was established at install — RESEARCH Q1/Pitfall 5), so we SKIP the gate.
    if args.asset:
        if not args.checksums:
            print(
                "--asset requires --checksums (the SHA-256 floor for the gate)",
                file=sys.stderr,
            )
            return 1
        asset = Path(args.asset)
        checksums = Path(args.checksums)
        try:
            method = attest.verify_asset(asset, checksums, asset.name)
        except attest.TamperError as exc:
            # FAIL-CLOSED: abort BEFORE any step.apply() runs.
            print(f"✗ asset integrity check FAILED: {exc}", file=sys.stderr)
            return 1
        except Exception as exc:  # noqa: BLE001 - any gate error is fail-closed
            print(f"✗ asset integrity check errored: {exc}", file=sys.stderr)
            return 1
        print(f"✓ asset verified via {method}")

    # ── RESUME WALK ──
    had_error = False
    for step in REGISTRY:
        if not args.force and is_done(ledger, step.name):
            print(f"[skipped] {step.name} — already ok (resume)")
            continue
        mark(ledger, step.name, "running")  # durable BEFORE mutation
        result = step.apply(mode, force=True) if args.force else step.apply(mode)
        mark(ledger, step.name, result.status, result.detail)
        _print_result(result)
        if result.status == "error":
            # Resume picks up here next run; leave later steps non-ok.
            had_error = True
            break
    return 1 if had_error else 0


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="yulu provision",
        description="Run named, idempotent, resumable provisioning steps.",
    )
    sub = p.add_subparsers(dest="cmd", required=True)

    # provision [<step>] / --all / --list
    pp = sub.add_parser(
        "provision",
        help="run a named step, --all to resume-walk all six, or --list",
    )
    pp.add_argument(
        "step",
        nargs="?",
        help="a single step to run (deps|audio|daemons|ui)",
    )
    pp.add_argument("--all", action="store_true", help="resume-walk all steps in order")
    pp.add_argument("--list", action="store_true", help="list the step names and exit")
    pp.add_argument(
        "--asset",
        help="downloaded release zip to verify FIRST (fail-closed) before the walk",
    )
    pp.add_argument(
        "--checksums",
        help="checksums.txt accompanying --asset (the SHA-256 floor)",
    )
    pp.add_argument(
        "--mode",
        choices=["release", "dev"],
        default="release",
        help="install mode passed to each step (default: release)",
    )
    pp.add_argument(
        "--ledger",
        help="path to the .yulu-install.json ledger (default: the installed tree)",
    )
    pp.add_argument(
        "--force",
        action="store_true",
        help="run the selected step(s) even when probes or the resume ledger report them done",
    )

    # skill install [--agent ...]
    ps = sub.add_parser("skill", help="install/refresh the agent skill (decoupled)")
    ssub = ps.add_subparsers(dest="skill_cmd", required=True)
    psi = ssub.add_parser("install", help="install/refresh the Yulu agent skill")
    psi.add_argument(
        "--agent",
        action="append",
        default=None,
        dest="agents",
        help="target agent (repeatable, e.g. --agent claude-code --agent codex)",
    )
    psi.add_argument(
        "--repo-dir",
        default=None,
        help="override the repo root containing skills/yulu/ (default: resolved)",
    )

    # mcp ...
    pm = sub.add_parser("mcp", help="install/remove the Yulu HTTP MCP server in local agents")
    pm.add_argument("mcp_args", nargs=argparse.REMAINDER)

    return p


def _cmd_provision(args: argparse.Namespace) -> int:
    if args.list:
        for step in REGISTRY:
            print(step.name)
        return 0
    if args.all:
        return _run_all(args)
    if args.step:
        return _run_step(args.step, args.mode, _ledger_path(args), force=args.force)
    # Nothing chosen → show the valid steps (and a hint).
    names = ", ".join(s.name for s in REGISTRY)
    print(
        "provision: specify a step name, --all, or --list. "
        f"valid steps: {names}",
        file=sys.stderr,
    )
    return 1


def _cmd_skill(args: argparse.Namespace) -> int:
    if args.skill_cmd == "install":
        agents = args.agents or []
        return skill.skill_install(agents, repo_dir=args.repo_dir)
    return 1


def _cmd_mcp(args: argparse.Namespace) -> int:
    return mcp.main(args.mcp_args)


def main(argv: Optional[list[str]] = None) -> int:
    if argv is None:
        argv = sys.argv[1:]
    parser = _build_parser()
    args = parser.parse_args(argv)
    if args.cmd == "provision":
        return _cmd_provision(args)
    if args.cmd == "skill":
        return _cmd_skill(args)
    if args.cmd == "mcp":
        return _cmd_mcp(args)
    return 1


if __name__ == "__main__":
    sys.exit(main())
