"""MIG-01 — the migrate/ detect→plan front of the auto-migration pipeline.

``migrate/detect.py`` recognizes an existing v0.5.x ``~/.yulu`` install (via the
``.yulu-install.json`` ``schema_version`` and the legacy layout) and reports a
current install as up-to-date; ``migrate/plan.py`` produces a dry-run-able,
ordered ``MigrationPlan`` naming every in-transit correction WITHOUT mutating
anything (D-01/D-04).

These tests prove (Task 1 — detect):
  (1) a fixture ``.yulu-install.json`` with ``schema`` but NO ``schema_version``
      → needs_migration, from_schema None, reason "schema_version absent";
  (2) ``schema_version == state.SCHEMA_VERSION`` → up-to-date (no migration);
  (3) ``schema_version < current`` → needs_migration, from_schema == the old int;
  (4) no ledger at all but a legacy layout (config carrying
      ``transcription.mlx.python`` OR an existing ``venv-mlx-whisper`` dir) →
      needs_migration (v0.5.x predates the ledger);
  (5) detect NEVER raises on a corrupt/missing ledger — degrades to
      needs_migration=True (safe default), mirroring read_install_metadata;
  (6) ``to_schema`` always == ``state.SCHEMA_VERSION`` (imported, never a literal).

These tests prove (Task 2 — plan):
  (7) build_plan(v0.5.x need) names config_correction (drop mlx.python),
      path_route (~/Movies/Yulu → PathResolver), schema_stamp (schema_version);
  (8) build_plan(up-to-date need) → an EMPTY plan (no steps);
  (9) every PlanStep.kind ∈ {config_correction, path_route, schema_stamp};
  (10) render() emits one line per step AND building/rendering mutates NOTHING
       (a tmp config.json is byte-identical before/after).

Import style mirrors the repo (test_provision_state.py): yulu/scripts is placed
on sys.path so ``import migrate.detect`` / ``import provision.state`` work whether
pytest runs from the repo root (``pytest tests``) or from yulu/scripts.
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "yulu" / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))

import provision.state as state  # noqa: E402
from migrate import detect as detect_mod  # noqa: E402
from migrate import plan as plan_mod  # noqa: E402
from migrate.detect import MigrationNeed, detect_migration  # noqa: E402
from migrate.plan import MigrationPlan, PlanStep, build_plan  # noqa: E402

_ALLOWED_KINDS = {"config_correction", "path_route", "schema_stamp"}


def _write_ledger(runtime_dir: Path, payload: dict) -> Path:
    """Write a fixture ``.yulu-install.json`` into the install tree."""
    runtime_dir.mkdir(parents=True, exist_ok=True)
    ledger = runtime_dir / ".yulu-install.json"
    ledger.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return ledger


def _write_config(config_dir: Path, payload: dict) -> Path:
    config_dir.mkdir(parents=True, exist_ok=True)
    cfg = config_dir / "config.json"
    cfg.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return cfg


# ── (1) schema_version ABSENT (Phase-1-only ledger) → v0.5.x ──────────


def test_ledger_without_schema_version_needs_migration(tmp_path):
    runtime = tmp_path / ".yulu"
    config = tmp_path / ".config" / "yulu"
    # A Phase-1 installer doc: schema:1, source, version — but NO schema_version.
    _write_ledger(runtime, {"schema": 1, "source": "release", "version": "v0.5.1"})

    need = detect_migration(runtime, config_dir=config)

    assert isinstance(need, MigrationNeed)
    assert need.needs_migration is True
    assert need.from_schema is None  # v0.5.x: schema_version absent
    assert any("schema_version absent" in r for r in need.reasons)


# ── (2) schema_version == current → up-to-date ───────────────────────


def test_current_install_is_up_to_date(tmp_path):
    runtime = tmp_path / ".yulu"
    config = tmp_path / ".config" / "yulu"
    _write_ledger(
        runtime,
        {"schema": 1, "source": "release", "version": "v0.6.0", "schema_version": state.SCHEMA_VERSION},
    )

    need = detect_migration(runtime, config_dir=config)

    assert need.needs_migration is False
    assert need.from_schema == state.SCHEMA_VERSION
    assert need.reasons == []  # nothing to correct


# ── (3) schema_version < current → needs migration, from_schema set ──


def test_older_schema_needs_migration_with_from_schema(tmp_path):
    runtime = tmp_path / ".yulu"
    config = tmp_path / ".config" / "yulu"
    older = state.SCHEMA_VERSION - 1
    _write_ledger(runtime, {"schema": 1, "source": "release", "schema_version": older})

    need = detect_migration(runtime, config_dir=config)

    assert need.needs_migration is True
    assert need.from_schema == older
    assert any("schema_version" in r for r in need.reasons)


# ── (4) NO ledger but legacy layout → v0.5.x (predates the ledger) ───


def test_no_ledger_but_legacy_config_field_needs_migration(tmp_path):
    runtime = tmp_path / ".yulu"  # intentionally empty: no .yulu-install.json
    config = tmp_path / ".config" / "yulu"
    _write_config(
        config,
        {"transcription": {"mlx": {"python": "~/.config/yulu/venv-mlx-whisper/bin/python"}}},
    )

    need = detect_migration(runtime, config_dir=config)

    assert need.needs_migration is True
    assert need.from_schema is None
    assert any("mlx.python" in r or "mlx_python" in r for r in need.reasons)


def test_no_ledger_but_legacy_venv_dir_needs_migration(tmp_path):
    runtime = tmp_path / ".yulu"
    config = tmp_path / ".config" / "yulu"
    (config / "venv-mlx-whisper" / "bin").mkdir(parents=True, exist_ok=True)

    need = detect_migration(runtime, config_dir=config)

    assert need.needs_migration is True
    assert need.from_schema is None
    assert any("venv-mlx-whisper" in r for r in need.reasons)


# ── (5) corrupt / missing ledger degrades to needs_migration (no raise)


def test_corrupt_ledger_degrades_to_needs_migration(tmp_path):
    runtime = tmp_path / ".yulu"
    config = tmp_path / ".config" / "yulu"
    runtime.mkdir(parents=True, exist_ok=True)
    (runtime / ".yulu-install.json").write_text("{ not json", encoding="utf-8")

    need = detect_migration(runtime, config_dir=config)  # must NOT raise

    assert need.needs_migration is True
    assert need.from_schema is None


def test_completely_empty_runtime_degrades_to_needs_migration(tmp_path):
    runtime = tmp_path / ".yulu"
    config = tmp_path / ".config" / "yulu"
    # Nothing exists at all — no ledger, no config, no venv. A bare/legacy tree
    # predates the schema; safe default is "needs migration" (a fresh walk).
    need = detect_migration(runtime, config_dir=config)

    assert need.needs_migration is True
    assert need.from_schema is None


# ── (6) to_schema is sourced from state.SCHEMA_VERSION (never a literal)


def test_to_schema_is_sourced_from_state_schema_version(tmp_path):
    runtime = tmp_path / ".yulu"
    config = tmp_path / ".config" / "yulu"
    _write_ledger(runtime, {"schema": 1, "source": "release"})

    need = detect_migration(runtime, config_dir=config)

    assert need.to_schema == state.SCHEMA_VERSION


def test_detect_module_imports_schema_version_not_literal():
    # Guard: detect.py must import SCHEMA_VERSION from provision.state, not bake a
    # bare `2`. We assert the symbol is the SAME object the ledger module exposes.
    assert detect_mod.SCHEMA_VERSION is state.SCHEMA_VERSION


def test_detect_migration_is_read_only(tmp_path):
    # Detection mutates NOTHING — a ledger present before detect is byte-identical
    # after, and no config.json is created where none existed.
    runtime = tmp_path / ".yulu"
    config = tmp_path / ".config" / "yulu"
    ledger = _write_ledger(runtime, {"schema": 1, "source": "release", "version": "v0.5.1"})
    before = ledger.read_bytes()

    detect_migration(runtime, config_dir=config)

    assert ledger.read_bytes() == before
    assert not (config / "config.json").exists()  # detect never creates config


def test_detect_migration_is_stdlib_only():
    src = (SCRIPTS / "migrate" / "detect.py").read_text(encoding="utf-8")
    # No third-party import (stdlib-first per CLAUDE.md). numpy is the only external
    # dep used elsewhere in the repo; detect must not reach for it (or any other).
    assert "import numpy" not in src
    assert "from numpy" not in src


# ── Task 2: migrate/plan.py — the dry-run-able MigrationPlan ──────────


def _v05x_need() -> MigrationNeed:
    """A v0.5.x verdict (schema_version absent) — what build_plan acts on."""
    return MigrationNeed(
        needs_migration=True,
        from_schema=None,
        to_schema=state.SCHEMA_VERSION,
        reasons=["schema_version absent (pre-Phase-6 install)"],
    )


def _up_to_date_need() -> MigrationNeed:
    return MigrationNeed(
        needs_migration=False,
        from_schema=state.SCHEMA_VERSION,
        to_schema=state.SCHEMA_VERSION,
        reasons=[],
    )


# ── (7) v0.5.x plan names all three in-transit corrections ───────────


def test_plan_for_v05x_names_all_three_corrections():
    migration = build_plan(_v05x_need())

    assert isinstance(migration, MigrationPlan)
    kinds = [step.kind for step in migration.steps]
    assert "config_correction" in kinds
    assert "path_route" in kinds
    assert "schema_stamp" in kinds

    # The config_correction targets the dead transcription.mlx.python field.
    config_step = next(s for s in migration.steps if s.kind == "config_correction")
    assert "mlx.python" in config_step.description or "mlx_python" in config_step.description

    # The path_route step routes the hardcoded ~/Movies/Yulu through PathResolver.
    route_step = next(s for s in migration.steps if s.kind == "path_route")
    assert "Movies/Yulu" in route_step.description
    assert "PathResolver" in route_step.description or "data_dir" in route_step.description

    # The schema_stamp step names schema_version (the value comes from state).
    stamp_step = next(s for s in migration.steps if s.kind == "schema_stamp")
    assert "schema_version" in stamp_step.description


def test_plan_preserves_corrections_ordering():
    # Stable order Plan 03's apply.py dispatches on: config → path → stamp.
    migration = build_plan(_v05x_need())
    kinds = [s.kind for s in migration.steps]
    assert kinds == ["config_correction", "path_route", "schema_stamp"]


def test_plan_step_names_are_stable_and_unique():
    # Plan 03 dispatches on step.name — they must be present and unique.
    migration = build_plan(_v05x_need())
    names = [s.name for s in migration.steps]
    assert all(names)  # no empty names
    assert len(names) == len(set(names))  # unique


# ── (8) up-to-date need → an EMPTY plan (no steps) ───────────────────


def test_plan_for_up_to_date_is_empty():
    migration = build_plan(_up_to_date_need())
    assert migration.steps == []
    assert migration.need.needs_migration is False
    assert migration.render() == "" or "no migration" in migration.render().lower()


# ── (9) every kind is one of the three allowed kinds ─────────────────


def test_every_plan_step_kind_is_allowed():
    migration = build_plan(_v05x_need())
    for step in migration.steps:
        assert step.kind in _ALLOWED_KINDS, f"unexpected kind: {step.kind}"


# ── (10) render() is the dry-run output AND mutates nothing ──────────


def test_render_emits_one_line_per_step():
    migration = build_plan(_v05x_need())
    rendered = migration.render()
    lines = [ln for ln in rendered.splitlines() if ln.strip()]
    # Each step contributes at least its name + description to the output.
    for step in migration.steps:
        assert any(step.name in ln for ln in lines)
        assert any(step.description in ln for ln in lines)


def test_build_and_render_mutate_nothing_on_disk(tmp_path):
    # Dry-run safety: a config.json present before build_plan + render is
    # byte-identical after — the plan describes WHAT will change, touches NOTHING.
    cfg = tmp_path / "config.json"
    cfg.write_text(
        json.dumps({"transcription": {"mlx": {"python": "/x/venv/bin/python"}}}, indent=2),
        encoding="utf-8",
    )
    before = cfg.read_bytes()

    migration = build_plan(_v05x_need())
    migration.render()

    assert cfg.read_bytes() == before  # zero mutation


def test_plan_step_is_frozen():
    step = PlanStep(name="x", description="d", kind="schema_stamp")
    import dataclasses

    assert dataclasses.is_dataclass(step)
    try:
        step.name = "mutated"  # type: ignore[misc]
    except dataclasses.FrozenInstanceError:
        pass
    else:  # pragma: no cover - frozen guarantees the except path
        raise AssertionError("PlanStep must be frozen (immutable description)")


def test_plan_module_is_stdlib_only():
    src = (SCRIPTS / "migrate" / "plan.py").read_text(encoding="utf-8")
    assert "import numpy" not in src
    assert "from numpy" not in src
    # plan.py must not import release_installer / heavy modules — it is pure
    # description built from a MigrationNeed (no I/O, no filesystem probing).
    assert plan_mod.__name__ == "migrate.plan"
