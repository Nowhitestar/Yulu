---
phase: 08-multi-agent-providers-codex-openclaw
verified: 2026-05-30T16:05:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: none
final_milestone_phase: true
---

# Phase 8: Multi-Agent Providers (Codex + OpenClaw) Verification Report

**Phase Goal:** The proven ClaudeCode capability-provider is generalized to Codex and OpenClaw, completing the multi-agent-from-v1 lock so Yulu is agent-native, not single-vendor.
**Verified:** 2026-05-30T16:05:00Z
**Status:** passed
**Re-verification:** No — initial verification
**Note:** This is the FINAL milestone phase (8 of 8). All 8 phases marked Complete in ROADMAP.

## Goal Achievement

### Observable Truths

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | CodexProvider contributes correctly-labeled agent-config capabilities when codex present (SC1, AGENT-01, D-01) | ✓ VERIFIED | `provider.py:100-134` — `CodexProvider(CapabilityProvider)`, `agent_name="codex"`, delegates `probe_command("codex",("--version",))` → `codex_cli` (absent→`report.absent`, else `_as_agent_config`), `_as_agent_config(probe_mlx_whisper())` → `codex_mlx_whisper`. Test `test_present_cli_is_relabeled_agent_config[codex]` asserts AGENT_CONFIG/USABLE with resolved_path+detail preserved. |
| 2 | OpenClawProvider implements the same contract end-to-end (SC2, AGENT-02, D-02) | ✓ VERIFIED | `provider.py:137-169` — `OpenClawProvider`, `agent_name="openclaw"`, identical shape → `openclaw_cli` + `openclaw_mlx_whisper`. Parametrized tests cover both providers identically (`_PROVIDERS` list). |
| 3 | All three agents present → doctor aggregates each agent's stack into one report, no re-probe, no schema_version change, no entry collision (SC3, D-03) | ✓ VERIFIED | Runtime fold check: 6 merged entries, all 3 `*_cli` + all 3 `*_mlx_whisper` keys survive last-writer-wins, schema_version=1 unchanged. `doctor.py:269-272` fold UNTOUCHED. Test `test_doctor_aggregates_three_agents_without_collision_or_schema_break` green. |
| 4 | Each new provider only relabels host findings — issues no new subprocess of its own (D-05) | ✓ VERIFIED | AST scan of `provider.py`: zero forbidden imports/calls (no subprocess/os.system/shutil.which/Popen). Test `test_provider_module_has_no_new_exec_surface` (AST-based) + `test_provider_returns_purely_from_the_two_probes[codex/openclaw]` confirm delegation-only. |
| 5 | An absent agent CLI degrades to an absent entry, never an exception (D-01/D-02) | ✓ VERIFIED | `test_absent_cli_degrades_not_crashes[codex/openclaw]` + `test_capabilities_never_raises_on_real_probes` (runs REAL `$SHELL -lc 'command -v codex\|openclaw'`; neither installed on this machine → degraded to ABSENT/ABSENT, no raise). |

**Score:** 5/5 truths verified

### Required Artifacts

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `yulu/scripts/capabilities/provider.py` | CodexProvider + OpenClawProvider + 3-entry default_providers() | ✓ VERIFIED | 192 lines; both subclasses present (`__abstractmethods__` empty → ABC satisfied), namespaced mlx keys, `__all__` updated, `default_providers()` → `[ClaudeCode, Codex, OpenClaw]`. Imported/used by `doctor.py:247,269`. |
| `tests/test_multi_agent_providers.py` | Two-provider contract + three-agent aggregation lock | ✓ VERIFIED | 307 lines; Group A (parametrized per-provider: ABC/agent_name/relabel/absent/namespaced-key/never-raise/delegation-only/AST-guard) + Group B (3-provider count + collision-free doctor fold). 38 targeted tests pass. |

### Key Link Verification

| From | To | Via | Status | Details |
|------|-----|-----|--------|---------|
| `provider.py` | `probes.probe_command` | delegation (no new exec surface) | ✓ WIRED | `probe_command("codex",...)` line 125, `probe_command("openclaw",...)` line 161 — no new subprocess. |
| `provider.py` | `default_providers()` | append both new instances | ✓ WIRED | `return [ClaudeCodeProvider(), CodexProvider(), OpenClawProvider()]` line 182. |
| `doctor.py` | `default_providers()` | existing host_capabilities fold (UNTOUCHED) iterates all three | ✓ WIRED | `for provider in default_providers():` line 269 → `report.capabilities[name] = cap` line 272. Confirmed UNTOUCHED in phase-8 commits. |

### Behavioral Spot-Checks

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Three agents registered | `python3 -c "...default_providers()..."` | `['claude-code', 'codex', 'openclaw']` | ✓ PASS |
| ABC fully implemented (no TypeError) | instantiate Codex/OpenClaw; check `__abstractmethods__` | `frozenset()` for both | ✓ PASS |
| Collision-free 6-key aggregation | merge fold mirror | 3 `*_cli` + 3 `*_mlx_whisper`, 6 total, no clobber | ✓ PASS |
| No new exec surface | AST import/call scan of provider.py | NONE | ✓ PASS |
| Pure addition (git scope) | `git diff --name-only` phase-8 commits | only `provider.py` + test file | ✓ PASS |
| report.py/probes.py/doctor.py untouched | grep diff name-only | UNTOUCHED | ✓ PASS |
| ClaudeCodeProvider byte-for-byte | diff for removed claude_cli/agent_mlx_whisper lines | 0 removals | ✓ PASS |
| Targeted lock suite | `pytest test_multi_agent_providers + test_capability_provider + test_doctor_host_capabilities` | 38 passed | ✓ PASS |
| Full Python suite | `make pytest` | **840 passed, 1 skipped** | ✓ PASS |

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| AGENT-01 | 08-01-PLAN | A `CodexProvider` implements the capability-provider contract | ✓ SATISFIED | `CodexProvider` (provider.py:100-134); REQUIREMENTS.md:72 marked `[x]`, line 145 Complete. |
| AGENT-02 | 08-01-PLAN | An `OpenClawProvider` implements the capability-provider contract | ✓ SATISFIED | `OpenClawProvider` (provider.py:137-169); REQUIREMENTS.md:73 marked `[x]`, line 146 Complete. |

No orphaned requirements — REQUIREMENTS.md maps exactly AGENT-01/02 to Phase 8, both claimed by 08-01-PLAN.

### Anti-Patterns Found

None. No debt markers (TBD/FIXME/XXX/TODO/HACK/PLACEHOLDER), no stub returns, no hardcoded-empty data in `provider.py` or the test file. The `report.absent(...)` returns are correct degradation behavior, not stubs.

### Human Verification Required

None — this phase is fully automatable (mocked-CLI probes for present/absent + in-process doctor aggregation). VALIDATION.md confirms "fully automatable, no human verification needed."

### Gaps Summary

No gaps. All 5 must-haves verified against the actual codebase:

- Both `CodexProvider` and `OpenClawProvider` satisfy the `CapabilityProvider` ABC (empty `__abstractmethods__`, instantiate without TypeError) and implement the full present→agent-config / absent→degrade / never-raise contract.
- The phase honored its **pure-addition** guarantee at the byte level: `git diff` across all phase-8 commits touches ONLY `provider.py` + the new test file; `report.py`/`probes.py`/`doctor.py` are untouched; `ClaudeCodeProvider`'s bare `claude_cli` + `agent_mlx_whisper` keys have zero removals.
- The real D-03 collision risk is handled provider-side (namespaced `codex_mlx_whisper`/`openclaw_mlx_whisper`); the runtime fold produces 6 distinct keys with no clobber and `schema_version` stays `1`.
- No new subprocess/exec surface (AST-verified).
- Full suite **840 passed, 1 skipped** — matches the expected baseline exactly; no regressions.

The summary's single documented deviation (AST-based exec guard replacing the plan's raw-text grep, to avoid a false-positive on docstring prose) is an improvement to the test guard's fidelity and is independently confirmed correct — the AST check trips on real imports/calls only.

**This is the FINAL milestone phase. With Phase 8 verified, the multi-agent-from-v1 lock is complete and all 8 milestone phases are done.**

---

_Verified: 2026-05-30T16:05:00Z_
_Verifier: Claude (gsd-verifier)_
