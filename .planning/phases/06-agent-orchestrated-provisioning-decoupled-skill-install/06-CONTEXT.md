# Phase 6: Agent-Orchestrated Provisioning + Decoupled Skill Install - Context

**Gathered:** 2026-05-30
**Status:** Ready for planning (needs-research / spike — see canonical_refs)
**Mode:** Autonomous (Claude decided; the spike-gated WHO-calls-provisioning question is self-resolved below per ROADMAP's "step registry is BUILD NOW regardless; if the spike fails, the signed-zip path stays primary")

<domain>
## Phase Boundary

Provisioning becomes a registry of named, idempotent, status-reporting steps the host agent can drive and re-run safely — composing layers 1–5 — with asset integrity verified before execution, resumable per-step state, and skill install decoupled from core install. Covers **PROV-01..05**.

**Out of scope:** seamless auto-migration of existing installs (Phase 7); multi-agent providers beyond ClaudeCode (Phase 8); `uv`/`uvx` adoption (evaluated in the spike, recommended DEFER — host python3 is locked since Phase 1; adding uv is a new dep + scope creep).

</domain>

<decisions>
## Implementation Decisions — all Claude's discretion (autonomous)

### Step Registry (PROV-01)
- **D-01:** A registry of named steps, each exposing `check()` / `apply()` → `StepResult{status: ok|skipped|error, detail}`, invocable via `yulu provision <step>`. The Phase 1 decomposed `setup_*.sh` (deps / audio / models / daemons / capabilities / ui) map **1:1** onto steps (the registry wraps them). Idempotent: `check()` reporting already-done → `apply()` returns `skipped`, never re-does destructive work.

### WHO Calls Provisioning — *spike-gated, self-resolved*
- **D-02 [spike resolution]:** **DUAL caller.** The step registry is BUILD NOW; the host agent CAN drive `yulu provision <step>`. BUT the verified signed-zip + `curl|bash` path stays the **PRIMARY, non-negotiable fallback** — we do NOT make agent-orchestration the primary install (FEATURES.md flags agent-as-primary-UX as LOW confidence; ROADMAP: "if the spike fails, the signed-zip path stays primary"). The spike VALIDATES the agent path against its explicit exit criteria (below); it does not bet the install on it.
- **D-02b [informational — spike exit criteria]:** the spike's pass bar is the FAILURE paths, not the happy path — realized by other plans, NOT a standalone task: (1) **kill-at-step-N resume** (implemented + tested in 06-02 / PROV-04) and (2) **tampered-asset rejection** (implemented + tested in 06-03 / PROV-03). Both testable WITHOUT a real agent (simulate a kill mid-run; corrupt an asset). `uv`/`uvx`: evaluate, recommend DEFER (D-07).

### Asset Integrity Gate (PROV-03)
- **D-03:** Provisioning verifies asset integrity via `gh attestation verify` (against the Phase 1 CI attestation) BEFORE executing any step. The verified signed-zip + `checksums.txt` SHA-256 path remains a working non-negotiable fallback when `gh` is absent. A tampered asset is REJECTED before any step executes (fail-closed).

### Resumable State (PROV-04)
- **D-04:** Per-step state file `.yulu-install.json` (schema: per-step `{status, ts}` + a `schema_version`). A run killed mid-way → re-running resumes from the last incomplete step, redoing NO completed steps and duplicating NO daemons. Builds on the existing `.yulu-install.json` `source` field (Phase 1).

### Decoupled Skill Install (PROV-05)
- **D-05:** `yulu skill install [--agent <name>]` installs/updates the agent skill independently of core install (idempotent). EXTRACT `setup.sh:install_agent_skill()` (line 620, CONCERNS §3a) into this standalone subcommand; REMOVE it from the main `setup.sh` flow. The agent can call it directly after core install.

### Structure
- **D-06:** New `provision/` module (mirrors vocab/prompts/search): `registry.py` (Step ABC + StepResult + the named-step table), `state.py` (`.yulu-install.json` read/write + resume), `attest.py` (`gh attestation verify` + signed-zip/checksum fallback + tamper rejection). `yulu provision <step>` + `yulu skill install` CLI subcommands. Steps wrap the Phase 1 `setup_*.sh` (do not duplicate their logic).
- **D-07 [uv/uvx]:** Do NOT adopt `uv`/`uvx` this phase — host python3 is locked (Phase 1 D-01); adding uv is a new dependency + scope creep. The spike evaluates and records the recommendation; no adoption.
- **D-08 [scope guard]:** build registry + attestation + resumable state + skill decouple. Agent-as-caller is VALIDATED but signed-zip stays PRIMARY. NO uv adoption. Migration is Phase 7.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope & requirements
- `.planning/ROADMAP.md` §"Phase 6" — goal + 5 success criteria + the spike-gated open question + explicit failure-path exit criteria
- `.planning/REQUIREMENTS.md` — PROV-01..05

### The layers this composes (read the contracts)
- Phase 1: `yulu/scripts/setup_deps.sh` / `setup_audio.sh` / `setup_models.sh` / `setup_daemons.sh` / `setup_capabilities.sh` / `setup_ui.sh` + `lib/common.sh` (the 1:1 step map) + the CI attestation (`packaging/scripts/sign_and_notarize.sh`, `release-publish.yml`)
- `yulu/scripts/release_installer.py` (signed-zip + checksums fallback path), `yulu/scripts/setup.sh` (`install_agent_skill` line 620 to extract; main sequence)
- Phase 3 report, Phase 5 reuse gating (`capability_status()` in lib/common.sh)
- `.planning/codebase/CONCERNS.md` §3a (skill-install coupling), §2b (curl|bash trust)

### Research targets (spike IS the research)
- Step-registry `check`/`apply`→`StepResult` shape; `.yulu-install.json` resume schema; `gh attestation verify` + tamper-rejection + signed-zip fallback; `yulu skill install` extraction; `uv`/`uvx` evaluate-then-defer; WHO-calls (dual, signed-zip primary)
- Exit criteria: kill-at-step-N resume + tampered-asset rejection (simulatable without a real agent)

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- The Phase 1 `setup_*.sh` ARE the step bodies — the registry wraps them with `check`/`apply`, doesn't rewrite them. Each is already idempotent + isolated (BUILD-01).
- `release_installer.py` already does SHA-256 verify + extract — the attestation gate extends it (add `gh attestation verify`, keep checksums as fallback).
- `.yulu-install.json` already carries a `source` field (Phase 1) — extend it with per-step state.
- `install_agent_skill()` (setup.sh:620) is the exact body to lift into `yulu skill install`.

### Established Patterns
- `yulu` CLI is a bash dispatcher — add `provision` + `skill` subcommands.
- stdlib-first Python; subprocess for `gh`/`shasum`.

### Integration Points
- The registry composes layers 1–5; Phase 7 migration drives these same steps; keep `StepResult` stable.
- Signed-zip path is the non-negotiable fallback — never remove `curl|bash` + checksums.

</code_context>

<specifics>
## Specific Ideas
- Named idempotent steps (check/apply → StepResult{ok|skipped|error}); setup_*.sh map 1:1.
- `gh attestation verify` before execution; signed-zip + checksums non-negotiable fallback; tampered → reject before any step.
- `.yulu-install.json` per-step resume (kill-at-step-N).
- `yulu skill install [--agent]` extracted from setup.sh.
- Dual caller; signed-zip stays PRIMARY (don't bet install on LOW-confidence agent-UX). No uv adoption.

</specifics>

<deferred>
## Deferred Ideas
- Making agent-orchestration the PRIMARY install (vs validated-but-secondary) → future, contingent on agent-UX confidence.
- `uv`/`uvx` adoption → evaluated, deferred (new dep).
- Auto-migration of existing installs → Phase 7.

</deferred>

---

*Phase: 6-Agent-Orchestrated Provisioning + Decoupled Skill Install*
*Context gathered: 2026-05-30 (autonomous; spike WHO-calls self-resolved = dual, signed-zip primary)*
