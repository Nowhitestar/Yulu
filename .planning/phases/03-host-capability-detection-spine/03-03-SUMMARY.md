---
phase: 03-host-capability-detection-spine
plan: 03
subsystem: infra
tags: [capabilities, detection, doctor, host-capabilities, schema-version, tri-state, provider-aggregation, runtime-root, source-vs-runtime, stdlib, pytest, tdd]

# Dependency graph
requires:
  - phase: 03-host-capability-detection-spine
    provides: "Plan 01 probes.py (probe_command/probe_mlx_whisper/probe_llm_command/scan_models/probe_recording_dir) + report.py HostCapabilityReport/to_dict() — the assembly calls these directly"
  - phase: 03-host-capability-detection-spine
    provides: "Plan 02 provider.py default_providers() / ClaudeCodeProvider — the assembly iterates default_providers() and folds each provider.capabilities() into the report (DETECT-05)"
provides:
  - "doctor.py host_capabilities section: collect_report() emits a versioned HostCapabilityReport.to_dict() ({schema_version, capabilities: {name: {provenance, status, resolved_path, detail}}}) — the four-consumer contract surfaces in `yulu doctor --json` (DETECT-01/03)"
  - "_host_capabilities(config_dir, runtime_root) -> dict — lazy-import + never-raise assembly helper (mirrors check_search_index); degrades to {error, schema_version, capabilities} on any failure (T-03-07)"
  - "§5d fix: check_yulu_ui now receives runtime_root (not source_root), so a production install where source_root != runtime_root reports the installed UI dist honestly (D-07, CONCERNS §5d)"
affects: [phase-04-settings-ui, phase-05-reuse, phase-08-multi-provider]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Lazy-import + never-raise doctor section (sys.path.insert + guarded `from capabilities... import`, whole body try/except → {error, schema_version, capabilities}) — mirrors check_search_index"
    - "Additive doctor key: host_capabilities folds in alongside the existing report (no key removed, no type changed, _overall_ok untouched so an absent optional capability never fails doctor)"
    - "Provider aggregation loop: iterate default_providers(), merge provider.capabilities() entries (per-provider try/except so one bad arm can't break the section) — the single Phase-8 fold point"
    - "Source-vs-runtime honesty: runtime-scoped checks (check_yulu_ui) receive runtime_root, not the source checkout (D-07)"

key-files:
  created:
    - tests/test_doctor_host_capabilities.py
  modified:
    - yulu/scripts/doctor.py

key-decisions:
  - "[03-03] _host_capabilities mirrors check_search_index EXACTLY (lazy sys.path.insert + guarded capabilities import, whole body wrapped try/except → {error, schema_version:1, capabilities:{}}) so a broken/missing capabilities module degrades the section but never raises or hangs doctor (T-03-07, doctor never-raise contract)"
  - "[03-03] The provider merge loop wraps each provider.capabilities() in its own try/except (continue on failure) — a single misbehaving Phase-8 arm degrades only its own entries, never the whole host_capabilities section"
  - "[03-03] probe_llm_command receives config_dir/config.json explicitly so a non-standard --config-dir resolves the right llm.command; it RESOLVES+STATS only (T-03-01) — doctor adds zero subprocess.run(llm_command)"
  - "[03-03] §5d fixed by changing ONE line: check_yulu_ui(source_root / 'yulu'...) -> check_yulu_ui(runtime_root / 'yulu'...); dev (source==runtime) behavior unchanged, production (source!=runtime, e.g. ~/.yulu) now checks the runtime UI dist (grep gate: source_root / \"yulu\" == 0)"
  - "[03-03] print_human gains a one-line host-capabilities summary (schema=vN usable=X/Y) — informational only, _overall_ok and exit codes untouched (host_capabilities is informational this phase; Phase 5 gates reuse on the tri-state)"

patterns-established:
  - "Downstream consumers (Phase 4 tRPC host_capabilities endpoint, Phase 5 reuse gating, Phase 8 multi-provider aggregation) bind to THIS exact serialized shape: {schema_version:int, capabilities:{name:{provenance,status,resolved_path,detail}}} with status ∈ {usable, present-but-unverified, absent} and provenance ∈ {host-path, yulu-managed, agent-config, absent}"
  - "A capability can appear twice under different provenance by design: the direct `claude` probe is host-path, the provider's `claude_cli` is agent-config — the same binary framed as 'on the host' vs 'your agent provides it'"

requirements-completed: [DETECT-01, DETECT-03, DETECT-05]

# Metrics
duration: 12min
completed: 2026-05-30
---

# Phase 3 Plan 03: Doctor host_capabilities Integration + §5d Runtime-Root Fix Summary

**`yulu doctor --json` now emits a versioned, tri-state, provenance-labeled `host_capabilities` section — assembled from Plan 01's six DETECT-03 probes plus Plan 02's `default_providers()` agent-config entries via a lazy-import, never-raise helper — purely additively (every existing report key intact), and the §5d source-vs-runtime root bug is fixed so production installs report the running UI honestly.**

## Performance

- **Duration:** ~12 min
- **Tasks:** 1 (TDD: RED → GREEN, no REFACTOR needed)
- **Files modified:** 2 (1 created — test; 1 modified — doctor.py)

## Accomplishments

- **`host_capabilities` in `collect_report()` (DETECT-01/03):** a new `_host_capabilities(config_dir, runtime_root)` helper builds a `HostCapabilityReport` and serializes it via `to_dict()`. It folds in the six DETECT-03 probes directly — `claude` / `whisper_cli` (`probe_command`, login-shell PATH), `mlx_whisper` (`probe_mlx_whisper`, daemon-interpreter import), `llm_command` (`probe_llm_command`, resolved-not-executed), `models` (`scan_models`), `recording_dir` (`probe_recording_dir`, Phase 2 PathResolver writability) — then merges every `default_providers()` entry's `capabilities()` (DETECT-05).
- **Never-raise / never-hang (T-03-07):** the helper mirrors `check_search_index` — `sys.path.insert` + guarded `from capabilities... import`, with the WHOLE body wrapped in `try/except` that degrades to `{"error": str(exc), "schema_version": 1, "capabilities": {}}`. The provider loop additionally wraps each `provider.capabilities()` in its own `try/except` so one bad arm can't break the section. Verified: `collect_report()` with non-existent roots returns `host_capabilities` and never raises.
- **§5d fix (D-07, CONCERNS §5d):** `check_yulu_ui(source_root / "yulu" / "scripts", …)` → `check_yulu_ui(runtime_root / "yulu" / "scripts", …)`. A production install (`source_root != runtime_root`, e.g. `~/.yulu`) now checks the runtime UI dist; dev (`source==runtime`) behavior is unchanged. Grep gate confirms `source_root / "yulu"` is gone (count 0).
- **Additive — existing shape intact:** every pre-existing top-level key (`source_root`, `checks`, `stt_daemon`, `search_index`, `yulu_ui`, `processes`, …) remains; `_overall_ok` is untouched, so an absent optional capability never fails `yulu doctor`. The 9 pre-existing `test_doctor.py` tests still pass.
- **Security:** `llm.command` is resolved-not-executed end-to-end (T-03-01) — doctor issues no `subprocess.run(llm_command)`; the only argv the probe runs is `command -v <head>`. The end-to-end CLI acceptance criterion produced valid JSON without executing the configured command.

## The host_capabilities JSON Shape (the four-consumer contract)

As emitted by `yulu doctor --json` (live example; values reflect the host at capture time):

```json
"host_capabilities": {
  "schema_version": 1,
  "capabilities": {
    "claude":            { "provenance": "host-path",    "status": "usable", "resolved_path": "/opt/homebrew/bin/claude",        "detail": "2.1.143 (Claude Code)" },
    "whisper_cli":       { "provenance": "host-path",    "status": "usable", "resolved_path": "/opt/homebrew/bin/whisper-cli",   "detail": "" },
    "mlx_whisper":       { "provenance": "absent",       "status": "absent", "resolved_path": "",                                 "detail": "ModuleNotFoundError: No module named 'mlx_whisper'" },
    "llm_command":       { "provenance": "absent",       "status": "absent", "resolved_path": "",                                 "detail": "llm.command not configured" },
    "models":            { "provenance": "yulu-managed", "status": "usable", "resolved_path": "~/.config/yulu/models",            "detail": "9 models, 4956337195 bytes" },
    "recording_dir":     { "provenance": "yulu-managed", "status": "usable", "resolved_path": "~/Movies/Yulu",                    "detail": "free=1066747236352" },
    "claude_cli":        { "provenance": "agent-config", "status": "usable", "resolved_path": "/opt/homebrew/bin/claude",        "detail": "2.1.143 (Claude Code)" },
    "agent_mlx_whisper": { "provenance": "absent",       "status": "absent", "resolved_path": "",                                 "detail": "ModuleNotFoundError: No module named 'mlx_whisper'" }
  }
}
```

- **Keys:** six DETECT-03 probes (`claude`, `whisper_cli`, `mlx_whisper`, `llm_command`, `models`, `recording_dir`) + the provider's `claude_cli` / `agent_mlx_whisper`.
- **`status` ∈** `{usable, present-but-unverified, absent}` (tri-state, never a boolean). **`provenance` ∈** `{host-path, yulu-managed, agent-config, absent}`.
- **Note the deliberate dual-framing:** `claude` (host-path, "on the host") and `claude_cli` (agent-config, "your agent provides it") are the same binary surfaced by the direct probe and the provider — exactly what Phase 4 needs to label "reused from your agent" vs "Yulu-managed".

**Downstream consumers bind to THIS shape:** Phase 4 (tRPC `host_capabilities` endpoint), Phase 5 (reuse gating on the tri-state — `usable` vs `present-but-unverified` vs `absent`), Phase 8 (multi-provider aggregation appends arms to `default_providers()`, which this loop already folds in with zero doctor edits).

## Task Commits

TDD RED → GREEN (no REFACTOR — clean on first GREEN):

1. **Task 1 (RED): failing host_capabilities + §5d test** — `cabb7c9` (test)
2. **Task 1 (GREEN): wire host_capabilities into doctor + §5d runtime-root fix** — `05c60aa` (feat)

## Files Created/Modified

- `yulu/scripts/doctor.py` — added `_host_capabilities(config_dir, runtime_root)` (lazy-import + never-raise assembly of the six probes + provider merge); wired `"host_capabilities": _host_capabilities(config_dir, runtime_root)` into `collect_report()` additively; fixed §5d (`runtime_root` feeds `check_yulu_ui`); added a one-line host-capabilities summary to `print_human` (no exit-code change).
- `tests/test_doctor_host_capabilities.py` — Wave-0 doctor-integration assertions: schema_version + DETECT-03 coverage + tri-state/no-boolean, provider agent-config entries (DETECT-05), existing-shape-intact, never-raise-with-missing-roots, the §5d runtime-root spy, and the `main(["--json", …])` end-to-end JSON check (7 tests).

## Decisions Made

- **Mirror `check_search_index` exactly** for the lazy-import + never-raise contract rather than inventing a new pattern — the doctor already has a proven "import a sibling module, degrade to `{error}`" idiom, so the new section inherits the same robustness and reads consistently.
- **Per-provider `try/except` inside the merge loop** (not just the outer guard) — a Phase-8 arm that raises in `capabilities()` degrades only its own entries; the rest of the section (and the direct probes) survive.
- **`print_human` summary is informational only** — `_overall_ok` and the exit code are deliberately untouched this phase. host_capabilities surfaces what the daemon can use; it does not (yet) gate `yulu doctor`'s pass/fail. Phase 5 is where the tri-state gates reuse-vs-install.
- **Pass `config_dir / "config.json"` to `probe_llm_command`** so a test (or a non-standard `--config-dir`) resolves the right `llm.command`, keeping the section honest under any config root.

## Deviations from Plan

None - plan executed exactly as written. The single TDD task went RED → GREEN cleanly; all acceptance-criteria gates passed on first GREEN (pytest 16 green, end-to-end CLI OK, `host_capabilities` grep ≥2, `runtime_root / "yulu"` grep ≥1, `source_root / "yulu"` grep == 0, never-raise shape-intact, py_compile exit 0). No bugs, no missing critical functionality, no blocking issues, no architectural changes, no auth gates, no package installs (stdlib-only — T-03-SC accepted, no Package Legitimacy checkpoint required).

## Issues Encountered

None. The `check_yulu_ui` `/healthz` probe makes each `collect_report()`-driven test take ~30s (network timeout to 127.0.0.1:7777) — not a failure, just slow; the existing tests already monkeypatch `urlopen` where determinism matters, and the new tests tolerate the live result.

## TDD Gate Compliance

Task is `tdd="true"`. Gate sequence verified in git log:
- Task 1: `test(03-03)` `cabb7c9` → `feat(03-03)` `05c60aa` ✓

The RED commit's 6 (of 7) failing assertions failed for the right reason — `host_capabilities` was not in the report (`AssertionError: assert 'host_capabilities' in {...}`) and the §5d spy saw the source root — not a test typo. No test passed unexpectedly during RED (the 1 RED-green test, `test_existing_report_shape_intact`, only checks pre-existing keys, which already existed — expected).

## Verification Evidence

- `pytest tests/test_doctor_host_capabilities.py tests/test_doctor.py` → **16 passed** (new + pre-existing, no regression).
- `pytest` (all Phase 3 capability + doctor tests: report + probes + provider + the two doctor files) → **53 passed**.
- End-to-end: `doctor.py --json … | python3 -c "assert host_capabilities, DETECT-03 keys, tri-state, no bool"` → **OK**.
- Grep gates: `host_capabilities` ×5 (≥2 ✓), `runtime_root / "yulu"` ×1 (≥1 ✓), `source_root / "yulu"` ×0 (==0 ✓ — §5d bug gone).
- `python3 -m py_compile yulu/scripts/doctor.py` → exit 0.

## User Setup Required

None — no external service configuration required.

## Next Phase Readiness

- **Phase 4 (settings UI)** can add a tRPC `host_capabilities` endpoint that surfaces this exact serialized shape; the `provenance` field already distinguishes "reused from your agent" (`agent-config`) from "Yulu-managed".
- **Phase 5 (reuse)** gates reuse-vs-install on the tri-state `status` (`usable` skip-install vs `present-but-unverified` re-verify vs `absent` install) — never a boolean (D-08).
- **Phase 8 (multi-provider)** is a drop-in: a `CodexProvider` / `OpenClawProvider` appended to `default_providers()` flows into `host_capabilities` automatically — the merge loop here needs zero edits.
- No blockers.

## Self-Check: PASSED

Created files verified on disk (`tests/test_doctor_host_capabilities.py`, `03-03-SUMMARY.md`) and `yulu/scripts/doctor.py` modified; both task commits (`cabb7c9` RED, `05c60aa` GREEN) verified in git log.

---
*Phase: 03-host-capability-detection-spine*
*Completed: 2026-05-30*
