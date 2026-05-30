#!/usr/bin/env python3
"""Decoupled, idempotent agent-skill installer (PROV-05, D-05 / D-08).

``yulu skill install [--agent <name>]`` registers/refreshes the Yulu agent skill
INDEPENDENTLY of the core install. This module LIFTS the ``npx skills add``
invocation out of ``setup.sh:install_agent_skill`` (the body at setup.sh:620-676),
DROPPING every interactive prompt / ``read -r`` / header, keeping only the two
load-bearing behaviours:

  * NPX-ABSENT IS NON-FATAL — if ``npx`` is not on PATH we print a skip note and
    return 0 (setup.sh:623-627 parity). The skill is optional; its absence can
    never fail the caller.
  * NPX-FAILURE IS NON-FATAL — a nonzero ``npx skills add`` exit is a WARN, not a
    failure: we still return 0 (setup.sh:673-674 parity). Decoupling means a
    skill-install hiccup can NEVER break the core install path (T-06-19).

CANONICAL SKILL SOURCE + IDEMPOTENCY (RESEARCH Pitfall 4)
--------------------------------------------------------
The canonical skill lives in the repo at ``skills/yulu/`` (with its ``SKILL.md``).
``npx skills add`` creates a per-agent SYMLINK (``~/.<agent>/skills/yulu/`` ->
``<repo>/skills/yulu/``). ``vercel-labs/skills`` is NOT upstream-idempotent in the
"re-run is a clean no-op" sense — but ``add`` OVERWRITES the symlink, so
re-invoking this wrapper simply re-points/refreshes it. Idempotency is therefore
the Yulu WRAPPER's property: re-invoke == refresh, and a failure (e.g. the symlink
already exists in a way npx dislikes) is swallowed to a warn so the caller is never
failed. This is exactly the contract ``yulu skill install`` advertises.

REPO_DIR resolves to the repo ROOT (the directory that CONTAINS ``skills/yulu/``),
mirroring setup.sh's ``REPO_DIR``. From ``yulu/scripts/provision/skill.py`` that is
three parents up (``provision`` -> ``scripts`` -> ``yulu`` -> repo root).

Security (T-06-17): ``subprocess.run`` is ALWAYS called with an argv LIST (never
``shell=True``); ``repo_dir`` is the fixed repo root and each agent name is passed
as its OWN argv element after a ``-a`` flag — no shell metacharacter is ever
exposed and no arbitrary package is installed (the package is the literal
``skills`` invoked through ``npx -y``).
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

# Repo ROOT = the directory containing skills/yulu/. This file is
# <repo>/yulu/scripts/provision/skill.py → parents[3] is the repo root (mirrors
# setup.sh REPO_DIR). A literal derivation — never caller-supplied.
REPO_DIR = Path(__file__).resolve().parents[3]


def _default_repo_dir() -> str:
    """The canonical skill source root (the dir holding ``skills/yulu/``)."""
    return str(REPO_DIR)


def skill_install(agents: list[str], repo_dir: str | None = None) -> int:
    """Install/refresh the Yulu agent skill for each agent in ``agents``.

    Builds and runs ``npx -y skills add <repo_dir> -g -a <agent> ... -y`` as an
    argv LIST. Returns 0 ALWAYS on a benign outcome:

      * ``npx`` absent on PATH  -> print a skip note, return 0 (non-fatal).
      * ``npx`` present, add succeeds -> return 0.
      * ``npx`` present, add exits nonzero -> print a warn, return 0 (non-fatal).

    The only non-zero return would be an unexpected internal error, which is left
    to propagate; the documented skill-install outcomes are all non-fatal so this
    subcommand can never break the core install (D-05, T-06-19).

    Idempotent: re-invoking re-runs ``add`` (overwrites the per-agent symlink).
    """
    target = repo_dir or _default_repo_dir()

    if shutil.which("npx") is None:
        print("npx (Node.js) not found — skipping agent skill registration.")
        print(
            "  To install later: install Node.js, then run "
            f"`npx skills add {target} -g -a <agent> -y`"
        )
        return 0

    # Build the argv list: npx -y skills add <repo> -g  [-a <agent>]...  -y
    argv = ["npx", "-y", "skills", "add", target, "-g"]
    for agent in agents:
        argv += ["-a", agent]
    argv += ["-y"]

    proc = subprocess.run(argv, text=True)
    if proc.returncode != 0:
        agent_list = " ".join(agents) if agents else "(default)"
        print(
            f"⚠ agent skill registration failed for {agent_list} "
            "(does not affect Yulu core). "
            f"Retry: npx skills add {target} -g "
            + " ".join(f"-a {a}" for a in agents)
        )
        return 0  # non-fatal (setup.sh:673 parity)

    if agents:
        print(f"✓ Yulu skill registered for: {' '.join(agents)}")
    else:
        print("✓ Yulu skill registered (global).")
    print(f"  Location: ~/.<agent>/skills/yulu/  (symlink → {target}/skills/yulu/)")
    return 0
