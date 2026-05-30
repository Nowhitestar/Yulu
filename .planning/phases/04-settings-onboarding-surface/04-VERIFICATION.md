---
phase: 04-settings-onboarding-surface
verified: 2026-05-30T17:14:00Z
status: passed
score: 5/5 must-haves verified
overrides_applied: 0
re_verification:
  previous_status: none
  note: initial verification
---

# Phase 4: Settings & Onboarding Surface Verification Report

**Phase Goal:** The web UI becomes the first consumer of the capability report — surfacing each capability's provenance and letting the user configure transcription mode and model selection — and a skippable first-run walkthrough shows live permission status. Proves the report schema end-to-end.
**Verified:** 2026-05-30T17:14:00Z
**Status:** passed
**Re-verification:** No — initial verification

## Goal Achievement

### Observable Truths (5 ROADMAP Success Criteria)

| # | Truth | Status | Evidence |
|---|-------|--------|----------|
| 1 | Settings page loads `host_capabilities` tRPC endpoint, shows provenance ("reused from your PATH" vs "Yulu-managed") + resolved path | ✓ VERIFIED | `capabilities.ts:75-101` shells `doctor.py --json`, returns `host_capabilities` section; registered `_app.ts:19 capabilities: capabilitiesRouter`. `CapabilitiesSection.tsx:55` consumes `trpc.capabilities.host_capabilities.useQuery()`, renders `provenanceLabel()` (host-path/agent-config→"reused from your PATH", yulu-managed→"Yulu-managed") + `resolved_path` per cap. Tests: CapabilitiesSection 9 + capabilities router (in 339-test suite) green. |
| 2 | Transcription mode local/cloud-fallback/cloud-priority persists to config | ✓ VERIFIED | `TranscriptionSection.tsx:7-11,63-78` radiogroup local(default)/cloud-fallback/cloud-priority → `commit("transcription.mode")`. `config.ts:62 "transcription.mode": "restart:sttdaemon"`. Tests: TranscriptionSection 6 (mode default+persist) + config 6 (classify→["sttdaemon"]) green. |
| 3 | Cloud transcription uses user's own command (llm.command trust model); Yulu holds NO cloud keys — NO api-key/password/token/secret field (HIGH guardrail T-04-KEY) | ✓ VERIFIED | `TranscriptionSection.tsx:89-92` `<CommandEditor>` (array-of-strings) → `transcription.cloud_command`. **SECURITY CONFIRMED:** zero `type=password` / api-key / token / secret / cloud-key INPUT across entire `yulu_ui/src` + `web/src` tree (only match is comment `TranscriptionSection.tsx:82` documenting the *absence*). `config.ts` holds no key field. |
| 4 | Model selector picks among detected models from `trpc.capabilities.detected_models` | ✓ VERIFIED | `TranscriptionSection.tsx:20` `detected_models.useQuery()` → `:104-121` `<select>` options `m.path/m.name`, empty→disabled "no models detected". Sourced from `capabilities.ts:105-120 detected_models` → Python `list_models()` (`probes.py:227-265`, path-bounded, additive). pytest test_list_models 5/5 green. |
| 5 | Skippable browser onboarding reflects live permission status, dismissable without completing | ✓ VERIFIED | `Onboarding.tsx:102` consumes `host_capabilities.useQuery()` for live status; `:119` Skip persists `onboarding_dismissed=true` via config.update + localStorage (`LS_KEY:9`); self-gates → null when dismissed. Mounted `root.tsx:29 <Onboarding />`. Tests: Onboarding 5 (first-run/skip-without-complete/never-reappear/no-flash) green. |

**Score:** 5/5 truths verified

### Required Artifacts (8 — gsd-sdk verify.artifacts: 8/8 passed)

| Artifact | Expected | Status | Details |
|----------|----------|--------|---------|
| `capabilities.ts` (121 ln) | capabilities router | ✓ VERIFIED | host_capabilities + detected_models; spawns ONLY doctor.py/list_models; typed degrade, 10s timeout+SIGKILL |
| `_app.ts` (30 ln) | router registered | ✓ VERIFIED | `:5` import + `:19` `capabilities: capabilitiesRouter` |
| `probes.py` (342 ln) | additive list_models() | ✓ VERIFIED | `:227` list_models; `:185` scan_models untouched (frozen Phase 3 contract preserved) |
| `CapabilitiesSection.tsx` (102 ln) | provenance+path+badge | ✓ VERIFIED | exports CapabilitiesSection + provenanceLabel + statusLabel; display-only/escape-safe |
| `settings.tsx` (80 ln) | section slotted | ✓ VERIFIED | `:11` import + `:69` `<CapabilitiesSection />` (top of stack) |
| `TranscriptionSection.tsx` (209 ln) | mode+command+selector | ✓ VERIFIED | 3 new controls above all pre-existing rows (extended, not replaced) |
| `config.ts` (149 ln) | RESTART_MAP entries | ✓ VERIFIED | `:62-63` mode + cloud_command → restart:sttdaemon; no cloud-key field |
| `Onboarding.tsx` (176 ln) | skippable overlay | ✓ VERIFIED | live status + dual-source dismiss (localStorage + config), self-gating |
| `root.tsx` (32 ln) | overlay mounted | ✓ VERIFIED | `:5` import + `:29` `<Onboarding />` sibling of Pill |

### Key Link Verification (verified via direct grep — authoritative)

| From | To | Via | Status | Details |
|------|----|----|--------|---------|
| capabilities.ts | doctor.py --json | spawn | ✓ WIRED | `:76-79` spawn(python3,[doctorPy,--json]) |
| _app.ts | capabilitiesRouter | registration | ✓ WIRED | `:19` (gsd-sdk regex false-negative; literal grep confirms) |
| CapabilitiesSection | host_capabilities | useQuery | ✓ WIRED | `:55` (gsd-sdk regex false-negative; literal grep confirms) |
| TranscriptionSection | transcription.mode | config.update | ✓ WIRED | `:71` commit("transcription.mode") |
| TranscriptionSection | detected_models | useQuery | ✓ WIRED | `:20` (gsd-sdk regex false-negative; literal grep confirms) |
| Onboarding | host_capabilities | useQuery | ✓ WIRED | `:102` (gsd-sdk regex false-negative; literal grep confirms) |
| Onboarding | onboarding_dismissed | config.update+localStorage | ✓ WIRED | `:119` mutateAsync + `:9` LS_KEY |

**Note on gsd-sdk verify.key-links:** the tool reported 4 false-negative FAILs (double-escaped regex patterns `\\.`/`\\s` did not match). Direct literal greps against the actual source confirm ALL 7 links are present and correctly wired. Direct grep is authoritative here.

### Data-Flow Trace (Level 4)

| Artifact | Data Variable | Source | Produces Real Data | Status |
|----------|---------------|--------|--------------------|--------|
| CapabilitiesSection | `data.capabilities` | host_capabilities → doctor.py --json | Yes (real subprocess report) | ✓ FLOWING |
| TranscriptionSection | `models` | detected_models → Python list_models() globbing real model roots | Yes (path-bounded file list) | ✓ FLOWING |
| Onboarding | `capsQuery.data` | host_capabilities → doctor.py --json | Yes (live permission status) | ✓ FLOWING |

### Behavioral Spot-Checks (full automated suite — task-mandated commands)

| Behavior | Command | Result | Status |
|----------|---------|--------|--------|
| Typecheck 0 errors | `npm run typecheck` | clean exit, no diagnostics | ✓ PASS |
| Vitest all green | `npm test` | 72 files / 339 tests passed (expected ~241+) | ✓ PASS |
| Build OK | `npm run build` | server 461.6kb + web 1747 modules/445kb compiled | ✓ PASS |
| list_models (SET-04, T-04-01) | `pytest tests/test_list_models.py` | 5/5 passed incl. path-bounding | ✓ PASS |
| make pytest collects test | `grep pytest Makefile` | `pytest tests -q` → test IS collected | ✓ PASS |

New Phase-4 test files all green: CapabilitiesSection.test.tsx (9), TranscriptionSection.test.tsx (6), Onboarding.test.tsx (5), capabilities.test.ts (router), settings.test.tsx consolidated (4, all 7 sections render).

### Requirements Coverage

| Requirement | Source Plan | Description | Status | Evidence |
|-------------|-------------|-------------|--------|----------|
| SET-01 | 04-01, 04-02 | host_capabilities tRPC endpoint serves doctor report | ✓ SATISFIED | router + CapabilitiesSection wired, tests green |
| SET-02 | 04-02 | settings shows provenance + resolved path | ✓ SATISFIED | provenanceLabel + resolved_path rendered, 9 tests |
| SET-03 | 04-04 | skippable first-run onboarding, live status | ✓ SATISFIED | Onboarding overlay, 5 tests |
| SET-04 | 04-01, 04-03 | model selector among detected models | ✓ SATISFIED | detected_models→selector, list_models 5 pytest |
| TRANS-01 | 04-03 | mode local/cloud-fallback/cloud-priority | ✓ SATISFIED | radiogroup + config persist, tests green |
| TRANS-02 | 04-03 | cloud = user command, no Yulu keys | ✓ SATISFIED | CommandEditor; ZERO key-field confirmed tree-wide |

All 6 declared requirement IDs map to Phase 4 in REQUIREMENTS.md (lines 126-131). No orphaned requirements.

### Anti-Patterns Found

| File | Line | Pattern | Severity | Impact |
|------|------|---------|----------|--------|
| — | — | none | — | Zero TBD/FIXME/XXX debt markers; zero TODO/HACK/placeholder in phase source |

The `return [] / return {...DEGRADED, error}` paths in capabilities.ts are the documented never-throw degrade contract required by SET-01 (doctor failure must not blank the page), explicitly covered by tests — not stubs.

### Human Verification Required

None blocking. The 2 manual items in 04-VALIDATION.md (browser visual settings render; onboarding UX feel) are explicitly OPTIONAL non-blocking confirmations: "Most behavior is covered by Vitest + @testing-library/react; these are visual/UX confirmations, NOT blocking." All 5 automatable success criteria pass, so per the VALIDATION contract this phase is `passed` without the optional manual confirmations.

### Gaps Summary

No gaps. All 5 ROADMAP success criteria are observably true in the codebase and proven by the full automated suite (typecheck 0 errors, 339 Vitest tests green, build OK, 5 pytest list_models green). The HIGH-severity security guardrail (TRANS-02 / D-04 / T-04-KEY) is confirmed: no cloud api-key/password/token/secret input field exists anywhere in yulu_ui src or web/src — cloud transcription is a user-supplied command (CommandEditor), mirroring the llm.command trust model. The Phase 3 `host_capabilities` report renders end-to-end through three independent UI consumers (CapabilitiesSection, TranscriptionSection model selector, Onboarding), proving the report schema.

---

_Verified: 2026-05-30T17:14:00Z_
_Verifier: Claude (gsd-verifier)_
