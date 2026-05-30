---
phase: 08-multi-agent-providers-codex-openclaw
plan: 01
subsystem: infra
tags: [capability-provider, multi-agent, codex, openclaw, doctor, agent-native, stdlib]

# Dependency graph
requires:
  - phase: 03-host-capability-detection-spine
    provides: "CapabilityProvider ABC + _as_agent_config + ClaudeCodeProvider reference impl + probe_command/probe_mlx_whisper; doctor host_capabilities fold over default_providers()"
provides:
  - "CodexProvider (agent_name=codex) contributing codex_cli + codex_mlx_whisper agent-config entries"
  - "OpenClawProvider (agent_name=openclaw) contributing openclaw_cli + openclaw_mlx_whisper agent-config entries"
  - "3-entry default_providers() — Claude Code + Codex + OpenClaw, the multi-agent-from-v1 lock"
  - "Collision-free three-agent doctor aggregation (namespaced mlx-whisper keys, schema_version unchanged)"
affects: [multi-agent, capability-provider, doctor, settings-ui, future-agent-arms]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Per-agent CapabilityProvider subclass = pure addition (new subclass + one default_providers() entry, zero edits to report.py/probes.py/doctor.py)"
    - "Namespace per-agent capability keys by agent_name to survive doctor's last-writer-wins fold"
    - "AST-based static guard for no-new-exec-surface (import/call detection, not raw-text grep)"

key-files:
  created:
    - tests/test_multi_agent_providers.py
  modified:
    - yulu/scripts/capabilities/provider.py

key-decisions:
  - "Namespaced ONLY the new providers' mlx-whisper key (codex_mlx_whisper / openclaw_mlx_whisper); ClaudeCodeProvider stays byte-for-byte (bare claude_cli + agent_mlx_whisper) so existing tests stay green"
  - "No-exec-surface guard implemented via AST (import/call detection) instead of the plan's raw-text grep, which false-positives on the pre-existing ClaudeCodeProvider docstring prose 'no new subprocess of its own'"

patterns-established:
  - "Adding a v1 agent = a CapabilityProvider subclass mirroring ClaudeCodeProvider (delegate to probes, relabel to agent-config via _as_agent_config, never raise) + one default_providers() append + namespaced keys"
  - "Three-agent doctor aggregation asserted in-process (mocked probes + spec_from_file_location doctor load) — no live CLI install required"

requirements-completed: [AGENT-01, AGENT-02]

# Metrics
duration: 14min
completed: 2026-05-30
---

# Phase 8 Plan 01: Multi-Agent Providers (Codex + OpenClaw) Summary

**CodexProvider + OpenClawProvider mirror ClaudeCodeProvider as pure-addition CapabilityProvider arms — each relabels host findings to agent-config with a namespaced mlx-whisper key, so doctor aggregates all three agents into one collision-free report (schema_version unchanged) with zero edits to report.py/probes.py/doctor.py.**

## Performance

- **Duration:** 14 min active (excludes the final 6m40s full `make pytest` run)
- **Started:** 2026-05-30T15:20:24Z
- **Completed:** 2026-05-30T15:34:42Z
- **Tasks:** 2
- **Files modified:** 2 (1 source created-on, 1 test created)

## Accomplishments
- `CodexProvider` (agent_name `codex`) — delegates to `probe_command("codex", ("--version",))` → `codex_cli` and `probe_mlx_whisper()` → `codex_mlx_whisper`, reframing present host findings to `agent-config`; degrades to `absent` when the CLI is off the login PATH; never raises.
- `OpenClawProvider` (agent_name `openclaw`) — same contract end-to-end → `openclaw_cli` + `openclaw_mlx_whisper`. If the OpenClaw binary is named differently on a host, the login-PATH probe simply returns absent and the entry degrades safely — the contract is locked, not a live install.
- `default_providers()` now returns all three v1 agents (Claude Code + Codex + OpenClaw) — the multi-agent-from-v1 lock; `__all__` updated to export both new classes.
- Collision handled provider-side (the real D-03 / T-08-01 fix): the new providers namespace their mlx-whisper key by `agent_name`, so doctor's last-writer-wins fold (`doctor.py:271-272`) no longer clobbers three agents' findings into one. `ClaudeCodeProvider` stays byte-for-byte (bare `claude_cli` + `agent_mlx_whisper`), keeping `test_capability_provider.py` + `test_doctor_host_capabilities.py` green.
- `tests/test_multi_agent_providers.py` locks both providers (ABC conformance, agent_name, present→agent-config relabel, absent→degrade, namespaced mlx key, never-raise on real probes, delegation-only) and the collision-free three-agent doctor aggregation (3 providers, `schema_version == 1`, all three `*_cli` + `*_mlx_whisper` keys survive the fold).

## Task Commits

Each task was committed atomically (Task 1 was TDD → test/feat):

1. **Task 1 (RED): failing contract lock** - `fa65c65` (test)
2. **Task 1 (GREEN): CodexProvider + OpenClawProvider + 3-entry default_providers()** - `ed98c2d` (feat)
3. **Task 2: finalize contract lock with AST exec-surface guard** - `bfb5722` (test)

_Note: Task 1 is `tdd="true"` — RED (failing test) then GREEN (implementation). No REFACTOR commit needed (the implementation is a clean mirror of the reference)._

## Files Created/Modified
- `yulu/scripts/capabilities/provider.py` - Added `CodexProvider` + `OpenClawProvider` (near-verbatim mirrors of `ClaudeCodeProvider`, namespaced mlx-whisper keys), registered both in `default_providers()`, updated `__all__`. `ClaudeCodeProvider` unchanged.
- `tests/test_multi_agent_providers.py` - New repo-root test (collected by `pytest tests`): Group A (per-provider contract for Codex + OpenClaw) + Group B (collision-free three-agent doctor aggregation).

## Decisions Made
- **Namespacing scope:** Only the NEW providers' mlx-whisper key was namespaced (`codex_mlx_whisper` / `openclaw_mlx_whisper`). `ClaudeCodeProvider`'s bare `agent_mlx_whisper` + `claude_cli` are asserted by existing tests, so it was left byte-for-byte — making the doctor fold collision-free (three distinct `*_mlx_whisper`, three distinct `*_cli`) WITHOUT editing `doctor.py`. The one allowed adjustment landed provider-side because the collision is real.
- **Pure addition honored:** `report.py` / `probes.py` / `doctor.py` untouched (verified via `git diff --name-only` across all three task commits → only `provider.py`). Providers add no new resolution or execution surface (D-04 / D-05).

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] No-exec-surface guard false-positives on docstring prose**
- **Found during:** Task 1 (GREEN — first guard run)
- **Issue:** The plan's `<verify>`/threat-model guard greps `provider.py` with `grep -vE '^\s*#' | grep -E "subprocess..."` to assert no new exec surface. This matches the word `subprocess` anywhere except comment lines — but the **pre-existing** `ClaudeCodeProvider` docstring (line 77) already contains the prose "no new subprocess of its own (T-03-05)", and my two new provider docstrings echoed that phrasing. The raw-text grep therefore reports a (false) exec surface even though no `subprocess`/`Popen`/`os.system`/`shutil.which` is ever imported or called. The guard as literally written would have failed against the reference impl too.
- **Fix:** (a) Reworded the two NEW docstrings to drop the literal word `subprocess` ("issues no new process of its own, adding no exec surface"); the reference `ClaudeCodeProvider` line 77 was left untouched (must stay byte-for-byte). (b) Replaced the test's raw-text guard `test_provider_module_has_no_new_exec_surface` with an **AST-based** check that flags only a real `import subprocess` / `from subprocess import …` or a real call to `subprocess.*` / `os.system` / `shutil.which` / `*.Popen` — so benign docstring prose is never a false positive while a genuine exec call still trips the gate.
- **Files modified:** `yulu/scripts/capabilities/provider.py` (docstrings only), `tests/test_multi_agent_providers.py` (AST guard)
- **Verification:** AST guard passes (no import/call of any exec primitive in `provider.py`); 38/38 targeted tests + full `make pytest` (840 passed, 1 skipped) green. Phase-level no-exec check re-run as an intent-correct AST one-liner → "OK: no exec import/call in provider.py".
- **Committed in:** `ed98c2d` (docstring wording, in the feat task commit) + `bfb5722` (AST guard, in the Task 2 test commit)

---

**Total deviations:** 1 auto-fixed (1 bug — broken acceptance guard).
**Impact on plan:** The deviation only hardened the *test guard* to match its own stated intent (no new EXEC surface, not no prose mention). Zero impact on the shipped providers; no scope creep. The plan's literal grep would have false-failed against the Phase-3 reference impl it was meant to protect; the AST guard is the correct expression of T-08-04.

## Issues Encountered
None beyond the deviation above. The slow real-probe tests (`*_never_raises_on_real_probes` for codex/openclaw) run actual `$SHELL -lc 'command -v codex|openclaw'` and correctly degrade to `absent` (neither CLI is installed on this machine) without raising — exactly the locked contract.

## User Setup Required
None — no external service configuration required. (Codex/OpenClaw CLIs are optional host agents; absent ones degrade to `absent` entries, never errors.)

## Next Phase Readiness
- **Milestone complete.** Phase 8 was the FINAL milestone phase. The multi-agent-from-v1 lock is in place: Yulu reuses whichever of Claude Code / Codex / OpenClaw the user already runs, with each agent's configured stack honestly aggregated into one report.
- Further agents are future drop-ins via the same seam: a new `CapabilityProvider` subclass + one `default_providers()` append + namespaced keys (no edits to `report.py` / `probes.py` / `doctor.py`).
- No blockers or concerns.

## Self-Check: PASSED

- FOUND: `yulu/scripts/capabilities/provider.py`
- FOUND: `tests/test_multi_agent_providers.py`
- FOUND: `.planning/phases/08-multi-agent-providers-codex-openclaw/08-01-SUMMARY.md`
- FOUND commit: `fa65c65` (test RED), `ed98c2d` (feat GREEN), `bfb5722` (test finalize)

---
*Phase: 08-multi-agent-providers-codex-openclaw*
*Completed: 2026-05-30*
