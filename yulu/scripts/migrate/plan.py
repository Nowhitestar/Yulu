#!/usr/bin/env python3
"""The dry-run-able migration plan — names every in-transit correction (MIG-01, D-01, D-04).

``build_plan`` turns a ``migrate.detect.MigrationNeed`` into an ordered
``MigrationPlan``: the authoritative list of in-transit corrections that Plan 03's
``apply.py`` executes, one ``PlanStep`` at a time. For a v0.5.x ``need`` the plan is
exactly three steps, in a STABLE order ``apply`` dispatches on by ``name``:

  1. ``config_correction`` — drop the dead ``transcription.mlx.python`` field
     (CONCERNS §6e: Phase 1 removed the venv; migration clears the stale config
     key on existing installs).
  2. ``path_route``        — route the hardcoded ``~/Movies/Yulu`` recording root
     through ``PathResolver``/``data_dir`` (CONCERNS §1e + the Phase-5 runtime/
     content split).
  3. ``schema_stamp``      — stamp ``schema_version`` (== ``provision.state.SCHEMA_VERSION``,
     the Phase-6 ledger schema) so the install is recognized as up-to-date next time.

An UP-TO-DATE ``need`` (``needs_migration=False``) yields an EMPTY plan — migration
is a no-op and never re-runs destructively against a current install.

DRY-RUN SAFE — ZERO MUTATION (D-04). A ``PlanStep`` is a pure description, never an
action: building and rendering the plan performs NO filesystem I/O whatsoever (it
reads nothing, writes nothing). ``render()`` is the ``yulu migrate --dry-run``
output — one line per step (``name``: ``description``).

stdlib only. ``SCHEMA_VERSION`` is imported from ``provision.state`` so the stamp's
target value is the single-sourced ledger schema, never a duplicated ``2`` literal.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from provision.state import SCHEMA_VERSION

from migrate.detect import MigrationNeed

# The three correction kinds, in apply order. A PlanStep.kind is ALWAYS one of
# these — apply.py dispatches on (name, kind); an unknown kind would be a contract
# break, so build_plan only ever emits these.
KIND_CONFIG_CORRECTION = "config_correction"
KIND_PATH_ROUTE = "path_route"
KIND_SCHEMA_STAMP = "schema_stamp"

# Stable step names — Plan 03's apply.py dispatches on these; keep them constant.
STEP_DROP_MLX_PYTHON = "drop_mlx_python"
STEP_ROUTE_RECORDING_DIR = "route_recording_dir"
STEP_STAMP_SCHEMA_VERSION = "stamp_schema_version"


@dataclass(frozen=True)
class PlanStep:
    """One in-transit correction — a DESCRIPTION, never an action (D-04, zero side effect).

    ``name``        — stable dispatch key Plan 03's ``apply.py`` matches on.
    ``description`` — the human-readable ``--dry-run`` line.
    ``kind``        — one of ``config_correction`` | ``path_route`` | ``schema_stamp``.
    """

    name: str
    description: str
    kind: str


@dataclass(frozen=True)
class MigrationPlan:
    """An ordered, dry-run-able list of corrections built from a ``MigrationNeed``.

    ``steps`` — the ordered ``PlanStep``s (EMPTY when the need is up-to-date).
    ``need``  — the detect verdict this plan was built from (carried so apply/verify
                can read ``from_schema``/``to_schema`` without re-detecting).
    """

    need: MigrationNeed
    steps: list[PlanStep] = field(default_factory=list)

    def render(self) -> str:
        """The ``yulu migrate --dry-run`` summary: one ``name: description`` line per step.

        Pure string assembly — reads/writes NOTHING. An empty plan renders the
        empty string (the CLI prints a "no migration needed" notice around it).
        """
        return "\n".join(f"{step.name}: {step.description}" for step in self.steps)


def build_plan(need: MigrationNeed) -> MigrationPlan:
    """Assemble the ordered correction list for ``need`` — dry-run-safe, ZERO mutation.

    An up-to-date ``need`` returns an EMPTY plan; a v0.5.x ``need`` returns the three
    in-transit corrections in apply order (config → path → schema_stamp). Each step
    is a pure description; this function touches no filesystem.
    """
    if not need.needs_migration:
        return MigrationPlan(need=need, steps=[])

    steps = [
        PlanStep(
            name=STEP_DROP_MLX_PYTHON,
            description=(
                "drop dead transcription.mlx.python field from config.json "
                "(Phase 1 removed the venv; clear the stale key on existing installs)"
            ),
            kind=KIND_CONFIG_CORRECTION,
        ),
        PlanStep(
            name=STEP_ROUTE_RECORDING_DIR,
            description=(
                "route hardcoded ~/Movies/Yulu recording root through "
                "PathResolver.data_dir (Phase 2 seam + Phase 5 runtime/content split)"
            ),
            kind=KIND_PATH_ROUTE,
        ),
        PlanStep(
            name=STEP_STAMP_SCHEMA_VERSION,
            description=f"stamp schema_version={SCHEMA_VERSION} in .yulu-install.json",
            kind=KIND_SCHEMA_STAMP,
        ),
    ]
    return MigrationPlan(need=need, steps=steps)
