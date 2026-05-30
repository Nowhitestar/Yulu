---
phase: 03-host-capability-detection-spine
plan: 01
subsystem: infra
tags: [capabilities, detection, host-probes, login-shell-path, daemon-interpreter, tri-state, schema-version, stdlib, pytest]

# Dependency graph
requires:
  - phase: 01-build-foundation
    provides: "Canonical daemon-interpreter resolution in lib/common.sh:124 (PYTHON_BIN -> which python3 -> /usr/bin/python3); removed the venv + dead mlx_python field"
  - phase: 02-cross-platform-abstraction
    provides: "MacOSPathResolver.data_dir() — the recording-dir resolution this plan reuses for writability (D-05)"
provides:
  - "HostCapabilityReport — versioned (schema_version=1), tri-state, provenance-labeled report schema (the four-consumer contract)"
  - "Capability dataclass + Provenance/Status str-enums + absent() helper"
  - "probes.py honest-detection primitives: daemon_python(), resolve_on_login_path(), probe_importable(), probe_command(), probe_mlx_whisper(), probe_llm_command(), scan_models(), probe_recording_dir()"
  - "capabilities/ package (mirrors vocab/prompts/search module shape)"
affects: [03-02-provider, 03-03-doctor-integration, phase-04-settings-ui, phase-05-reuse, phase-07-schema-stamp, phase-08-multi-provider]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Versioned tri-state capability schema (schema_version + provenance + 3-state status, never boolean) — D-01/D-08"
    - "Login-shell PATH binary resolution via $SHELL -lc 'command -v X' (list-form), never shutil.which/launchd PATH — D-02"
    - "Daemon-interpreter importability probe: [daemon_python(), -c, import X] subprocess — D-03/D-04"
    - "Probe functions never raise (degrade to absent(detail)), mirroring doctor's never-raise contract"
    - "Resolve-not-execute for user-configured commands (llm.command head statted, never run) — T-03-01"

key-files:
  created:
    - yulu/scripts/capabilities/report.py
    - yulu/scripts/capabilities/probes.py
    - yulu/scripts/capabilities/__init__.py
    - tests/test_capabilities_report.py
    - tests/test_host_capability_probes.py
  modified: []

key-decisions:
  - "[03-01] HostCapabilityReport.to_dict() coerces both enums to their .value strings so JSON carries human strings (usable/host-path), never enum reprs and never a Python bool for status (D-01/D-08)"
  - "[03-01] daemon_python() = os.environ['PYTHON_BIN'] -> shutil.which('python3') -> '/usr/bin/python3', mirroring lib/common.sh:124 EXACTLY — the single canonical interpreter resolves DETECT-04's mlx_python ambiguity; importability is probed against THAT interpreter"
  - "[03-01] probe_command DOES run a benign --version on an already-resolved binary, but probe_llm_command RESOLVES+STATS only (T-03-01) — the user-configured command is never executed"
  - "[03-01] scan_models globs three FIXED roots only (~/.config/yulu/models, ~/Library/Application Support/whisper.cpp, ~/.cache/huggingface/hub) and dedupes overlapping-glob hits by resolved path; no .. / no user-supplied path (T-03-03)"
  - "[03-01] probe_recording_dir lazily+guardedly imports MacOSPathResolver so probes.py imports on any OS; off-Darwin degrades to absent (never raises)"

patterns-established:
  - "Tri-state Status enum is the downstream gate (Phase 5 reuse keys on usable vs present-but-unverified vs absent); a boolean must never drive a skip-install"
  - "Provenance answers WHERE a capability comes from (host-path / yulu-managed / agent-config / absent); agent-config is the provider seam Phase 8 generalizes"

requirements-completed: [DETECT-01, DETECT-02, DETECT-03, DETECT-04]

# Metrics
duration: 9min
completed: 2026-05-30
---

# Phase 3 Plan 01: Capabilities Schema + Honest Probes Summary

**Versioned tri-state `HostCapabilityReport` (schema_version, provenance, never-boolean status) plus the honest-detection primitives — login-shell-PATH binary resolution, daemon-interpreter import probing, and resolve-not-execute llm.command validity — under stdlib-only, never-raising probes.**

## Performance

- **Duration:** 9 min
- **Started:** 2026-05-30T07:09:54Z
- **Completed:** 2026-05-30T07:19Z
- **Tasks:** 2 (both TDD: RED -> GREEN)
- **Files modified:** 5 created (3 source + 2 tests)

## Accomplishments
- `report.py`: versioned (`schema_version=1`), tri-state, provenance-labeled `HostCapabilityReport` schema — the four-consumer contract (Phase 4 settings UI, Phase 5 reuse, Phase 7 schema stamp, Phase 8 multi-provider). `to_dict()` is JSON-safe with enum→string coercion and a hard no-boolean-status guarantee (DETECT-01, D-01/D-08).
- `probes.py`: the honest-detection primitives — `daemon_python()` (canonical interpreter mirroring lib/common.sh:124), `resolve_on_login_path()` (`$SHELL -lc 'command -v X'`, D-02), `probe_importable()` (daemon-interpreter subprocess import, D-03/D-04), and five Capability-returning probes (claude/whisper-cli, mlx-whisper, llm.command validity, models, recording-dir).
- DETECT-04 resolved: the `mlx_python` ambiguity is gone — there is ONE canonical daemon interpreter, and mlx-whisper importability is probed against IT, so a green `usable` means the daemon can actually import it.
- Security: `llm.command` resolved-not-executed (T-03-01); subprocess list-form throughout (T-03-02); model scan path-bounded to three fixed roots (T-03-03); every probe degrades to `absent(detail)` rather than raising (T-03-04).
- 27 new tests (7 schema + 20 probe, fully mocked → run on any OS); full suite **640 passed, 1 skipped** (pre-existing skip, no regressions).

## Task Commits

Each task was committed atomically (TDD RED → GREEN):

1. **Task 1 (RED): failing schema test** — `cbc5f93` (test)
2. **Task 1 (GREEN): versioned tri-state HostCapabilityReport schema** — `0a43af0` (feat)
3. **Task 2 (RED): failing probe tests** — `bb4c879` (test)
4. **Task 2 (GREEN): honest host-capability probes** — `f43dafd` (feat)

_No REFACTOR commits needed — implementations were clean on first GREEN (the one in-task fix folded into Task 2's GREEN commit, see Deviations)._

## Files Created/Modified
- `yulu/scripts/capabilities/report.py` — `Provenance`/`Status` str-enums, `Capability` + `HostCapabilityReport(schema_version=1)` dataclasses, JSON-safe `to_dict()`, `absent()` helper.
- `yulu/scripts/capabilities/probes.py` — `daemon_python()`, `resolve_on_login_path()`, `probe_importable()`, `probe_command()`, `probe_mlx_whisper()`, `probe_llm_command()`, `scan_models()`, `probe_recording_dir()`, plus `_model_roots()` / `_load_llm_command()` / `_safe_version()` internals.
- `yulu/scripts/capabilities/__init__.py` — exports `HostCapabilityReport`, `Capability`, `Provenance`, `Status`.
- `tests/test_capabilities_report.py` — schema_version/tri-state/no-boolean Wave-0 assertions (7 tests).
- `tests/test_host_capability_probes.py` — mocked login-PATH/daemon-interpreter/absent-clean/resolve-not-execute Wave-0 assertions (20 tests).

## Decisions Made
- **to_dict() enum→string coercion at the boundary** rather than serializing enum members: keeps the doctor `--json` payload and Phase 4 tRPC reading human strings (`"usable"`, `"host-path"`), and structurally prevents a bool from ever reaching `status`.
- **`probe_command` runs `--version` but `probe_llm_command` does not run its command.** Resolved-host CLIs (claude/whisper-cli) get a benign version probe for the `detail`; the user-configured `llm.command` is only resolved+statted (T-03-01) — these are deliberately different trust levels.
- **`scan_models` dedupes by `Path.resolve()`** so overlapping globs (`*.bin` and `**/*.bin`) never double-count, and symlinks pointing at the same file collapse to one entry.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] scan_models double-counted files matched by overlapping globs**
- **Found during:** Task 2 (GREEN — `test_scan_models_finds_models` failed)
- **Issue:** A single model file (`ggml-large-v3.bin`) matched BOTH the `*.bin` and `**/*.bin` glob patterns, so the count and byte-total were doubled ("2 models, 2048 bytes" for one 1024-byte file). The plan's behavior block specified globbing but did not call out the overlap.
- **Fix:** Collect hits into a `set` keyed by `Path.resolve()` (dedup overlapping globs + symlinks), count `len(seen)`, and pluralize the noun ("model"/"models") for clean output.
- **Files modified:** `yulu/scripts/capabilities/probes.py` (`scan_models`)
- **Verification:** `test_scan_models_finds_models` GREEN; all 20 probe tests pass; full suite 640 passed.
- **Committed in:** `f43dafd` (folded into Task 2 GREEN commit)

**2. [Rule 3 - Blocking] Reworded two docstrings to satisfy literal grep acceptance criteria (non-functional)**
- **Found during:** Task 1 (AC3) and Task 2 (AC6)
- **Issue:** Two acceptance criteria are crude substring greps: AC3 fails if `status.*bool` appears anywhere in report.py, and AC6 fails if `input=` appears anywhere in `probe_llm_command`'s source. My docstrings used those exact substrings to *describe the constraint* ("status … never a `bool`", "no `subprocess.run(llm_command, input=...)`"), tripping the literal greps even though the code is correct (`status: Status` annotation; command never executed).
- **Fix:** Reworded the docstring prose only (e.g. "never a true/false flag", "no prompt is ever piped to it") — zero behavior change.
- **Files modified:** `yulu/scripts/capabilities/report.py`, `yulu/scripts/capabilities/probes.py` (docstrings)
- **Verification:** AC3 grep → 0; AC6 inline assertion → exit 0; tests still GREEN.
- **Committed in:** `0a43af0` / `f43dafd` (part of the respective GREEN commits)

---

**Total deviations:** 2 auto-fixed (1 bug, 1 blocking-acceptance-criteria).
**Impact on plan:** The scan_models dedup is a real correctness fix (off-by-N count). The docstring rewords are non-functional grep alignment. No scope creep; both stayed within the plan's two-file footprint.

## Issues Encountered
None beyond the deviations above. Both TDD cycles went RED → GREEN cleanly; no architectural questions, no auth gates, no package installs (stdlib-only — T-03-SC accepted).

## TDD Gate Compliance
Plan is `type: execute` with two `tdd="true"` tasks. Both gate sequences verified in git log:
- Task 1: `test(03-01)` `cbc5f93` → `feat(03-01)` `0a43af0` ✓
- Task 2: `test(03-01)` `bb4c879` → `feat(03-01)` `f43dafd` ✓
Each RED commit's test failed before its GREEN (confirmed: `ModuleNotFoundError`/`cannot import name 'probes'`).

## User Setup Required
None — no external service configuration required.

## Next Phase Readiness
- **03-02 (provider seam)** can now build `CapabilityProvider` ABC + `ClaudeCodeProvider` on top of these probes — the provider contributes `agent-config`-provenance capabilities by delegating to `probe_command`/`probe_llm_command`. Contract to bind to: each probe returns a `Capability`; the report assembles `{name: Capability}`.
- **03-03 (doctor integration)** wires `scan_models`/`probe_*` into a `host_capabilities` section of `doctor.py --json`; the never-raise contract and `to_dict()` shape are ready for that.
- **Contract for downstream consumers:** `HostCapabilityReport.to_dict()` → `{"schema_version": int, "capabilities": {name: {"provenance": str, "status": str, "resolved_path": str, "detail": str}}}`. `status` ∈ {usable, present-but-unverified, absent}; `provenance` ∈ {host-path, yulu-managed, agent-config, absent}. `daemon_python()` is the single interpreter both the daemon and the probe must share.
- No blockers.

## Self-Check: PASSED

All 5 created files verified on disk; all 4 task commits (`cbc5f93`, `0a43af0`, `bb4c879`, `f43dafd`) verified in git log.

---
*Phase: 03-host-capability-detection-spine*
*Completed: 2026-05-30*
