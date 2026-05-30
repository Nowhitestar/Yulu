---
phase: 04-settings-onboarding-surface
plan: 03
subsystem: ui
tags: [react, trpc, tanstack-query, settings, transcription, command-editor, config, restart-map, vitest, no-key-guardrail]

# Dependency graph
requires:
  - phase: 04-settings-onboarding-surface (plan 01)
    provides: "capabilities tRPC router — detected_models query ({name,path,size}[] from the path-bounded list_models()); this section's model selector is its first UI consumer."
  - phase: 03-host-capability-detection-spine
    provides: "list_models() probe (the model pick-list source) + the config persistence convention this section writes through."
provides:
  - "TranscriptionSection extended with three controls: mode radios (local default / cloud-fallback / cloud-priority → transcription.mode), a cloud-transcription COMMAND field (CommandEditor → transcription.cloud_command, the llm.command trust model, NO key), and a detected-model selector (from trpc.capabilities.detected_models → transcription.local_model_path)."
  - "RESTART_MAP entries: transcription.mode + transcription.cloud_command → restart:sttdaemon, so Phase 5's STT pipeline picks up the mode/command change."
  - "A keyless-cloud guardrail proven by tests: no api-key/token/secret/password input anywhere on the transcription surface (T-04-KEY)."
affects: [04-04-onboarding, phase-05-reuse]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Cloud transcription credential surface = a user-supplied COMMAND (CommandEditor, array-of-strings), identical trust model to llm.command — Yulu stores it verbatim and never holds a cloud key. Enforced by a source-level grep test + a rendered no-key invariant test (T-04-KEY, the HIGH guardrail for Phase 4)."
    - "Mode as constrained-enum radios bound to config: a radiogroup of {local, cloud-fallback, cloud-priority}, default 'local' when unset, each onChange → config.update('transcription.mode')."
    - "Model selector sourced ONLY from detected_models (path-bounded discovery, 04-01) — the persisted value is one of the discovered .bin paths, never free user text (T-04-MODEL); empty list → disabled select with a 'no models detected' option (no crash)."
    - "passthrough() config + RESTART_MAP: a new transcription key persists via Zod .passthrough() (no schema field needed) while a RESTART_MAP entry declares its daemon impact (restart:sttdaemon)."

key-files:
  created:
    - "yulu/scripts/yulu_ui/tests/web/TranscriptionSection.test.tsx — 6 Vitest tests (mode radios+default+persist, cloud CommandEditor persist, no-key invariant, model selector list+persist, empty-models disabled state, existing-rows-preserved)"
  modified:
    - "yulu/scripts/yulu_ui/src/config.ts — RESTART_MAP += transcription.mode + transcription.cloud_command (both restart:sttdaemon); no Zod field, no cloud-key field"
    - "yulu/scripts/yulu_ui/web/src/components/settings/TranscriptionSection.tsx — added mode radios + cloud command (CommandEditor) + detected-model selector above the existing rows; extended tr typing with mode + cloud_command"
    - "yulu/scripts/yulu_ui/tests/config.test.ts — classify both new keys → ['sttdaemon'] + assert config.ts holds no api-key/token/secret/password (TRANS-02)"
    - "yulu/scripts/yulu_ui/tests/web/routes/settings.test.tsx — added capabilities.detected_models mock path so the consolidated settings render does not crash (deviation Rule 1/3)"

key-decisions:
  - "Model-selector persistence target = transcription.local_model_path (a single deterministic key): list_models() returns whisper model FILES (.bin/.gguf/.safetensors paths), which matches the existing 'Local model path' (.bin) row — so the selector and that row write the same key, no ambiguity. (Plan offered local_model_path OR mlx.final_model; chose local_model_path.)"
  - "Mode rendered as real radio inputs (not an InlineEditRow select): CONTEXT D-03 says 'radios', and a radiogroup makes the three-way choice + 'local is default' visually explicit and trivially assertable by role."
  - "cloud_command is a SEPARATE key from the pre-existing transcription.command: classify() uses longest-prefix matching, so transcription.cloud_command resolves to its own RESTART_MAP entry and never collides with transcription.command."
  - "Cloud command always visible (not hidden behind mode≠local): it is the configuration the cloud modes consume; showing it always lets the user prepare it before switching mode, mirroring how llm.command is always shown."

patterns-established:
  - "Keyless-by-construction cloud integration: any 'cloud' path in Yulu is the user's own command (CommandEditor), never a held credential — guarded by both a source grep test and a rendered no-key test."
  - "A new passthrough() config key ships as: (1) RESTART_MAP entry for daemon impact, (2) UI control writing it via config.update, (3) a classify test asserting the daemon — no Zod field required."

requirements-completed: [TRANS-01, TRANS-02, SET-04]

# Metrics
duration: 4min
completed: 2026-05-30
---

# Phase 4 Plan 03: TranscriptionSection — Mode, Cloud Command, Model Selector Summary

**Extended the existing `TranscriptionSection.tsx` with transcription-mode radios (local default / cloud-fallback / cloud-priority → `transcription.mode`), a cloud-transcription COMMAND field (CommandEditor → `transcription.cloud_command`, the `llm.command` trust model — Yulu holds NO cloud key), and a detected-model selector sourced from `trpc.capabilities.detected_models` persisting the chosen `.bin` path to `transcription.local_model_path`; both new config keys map to an `sttdaemon` restart, and a source-grep + rendered no-key test enforce the HIGH keyless-cloud guardrail (T-04-KEY).**

## Performance

- **Duration:** ~4 min (implementation commit span; ~20 min incl. context reads, full web suite + build runs)
- **Started:** 2026-05-30T16:48Z (local 16:48)
- **Completed:** 2026-05-30T16:53:06+08:00
- **Tasks:** 2 (Task 2 TDD)
- **Files modified:** 4 (1 created, 3 modified) + 1 consolidated test extended (deviation)

## Accomplishments
- **TRANS-01 — mode radios:** a `radiogroup` of local / cloud-fallback / cloud-priority bound to `tr.mode ?? "local"`; "local" is the default selection when `transcription.mode` is unset; selecting any option fires `config.update({ key: "transcription.mode", value })`. The two cloud values are surfaced exactly as `cloud-fallback` / `cloud-priority`.
- **TRANS-02 — cloud COMMAND, not key:** a `CommandEditor` (array-of-strings, the `llm.command` widget) bound to `tr.cloud_command ?? []`; editing it fires `config.update({ key: "transcription.cloud_command", value })`. Help copy: "Your own cloud transcription command — spawned with the audio. Yulu holds no cloud keys." There is **no** `type="password"` and **no** field labelled/placeholdered as api-key/token/secret/password anywhere in the section — proven by a rendered invariant test AND a source-grep gate.
- **SET-04 — model selector:** `trpc.capabilities.detected_models.useQuery()` feeds a `<select aria-label="Detected model">` whose options are `(models ?? []).map(m => ({ value: m.path, label: m.name }))`; choosing one persists the path to `transcription.local_model_path`. Empty `detected_models` → a **disabled** select showing "no models detected" (no crash).
- **RESTART_MAP:** `transcription.mode` and `transcription.cloud_command` both map to `restart:sttdaemon` — so when Phase 5 reads the mode/command, a change correctly cycles the STT daemon. A `config.test.ts` case asserts both classify to `daemonsNeedingRestart: ["sttdaemon"]`.
- **Extend, not replace (D-07):** every pre-existing row (realtime, final engine, language, local model path, all MLX rows, the glossary link) is preserved; the three new controls sit above them.
- No new packages (T-04-SC honored); `npm run typecheck` clean, `npm run build` (server + web bundles) green, full Vitest suite **334 passed**.

## Task Commits

Task 1 was a straight feat; Task 2 was TDD (RED test → GREEN feat, with the in-cycle blocking fixes folded into the GREEN commit):

1. **Task 1: RESTART_MAP entries (transcription.mode + cloud_command)** — `43a04ce` (feat)
2. **Task 2: TranscriptionSection mode radios + cloud command + model selector** — `6de3e63` (feat; RED test → GREEN implementation, single commit)

_No separate REFACTOR commit — the only in-cycle change was a one-line comment rephrase (to keep the strict guardrail grep clean) folded into the GREEN commit. The Task 2 test file (RED) and implementation (GREEN) were committed together as the plan's single `tdd="true"` Task 2 unit; the RED-fails-first / GREEN-passes gate was verified live (4 failing → 6 passing) before committing._

## Files Created/Modified
- `yulu/scripts/yulu_ui/src/config.ts` (modified) — added two `RESTART_MAP` rows: `"transcription.mode": "restart:sttdaemon"` and `"transcription.cloud_command": "restart:sttdaemon"`. No Zod field added (the `transcription` block is `.passthrough()`); deliberately no cloud-key field.
- `yulu/scripts/yulu_ui/tests/config.test.ts` (modified) — new case classifying both new keys to `["sttdaemon"]` and round-tripping their values; a new `describe` asserting `config.ts` source contains no `api_key|token|secret|password`-style identifier (TRANS-02 guardrail).
- `yulu/scripts/yulu_ui/web/src/components/settings/TranscriptionSection.tsx` (modified) — imported `CommandEditor`; added the `TRANSCRIPTION_MODES` constant; wired `trpc.capabilities.detected_models.useQuery()`; extended the `tr` type with `mode` + `cloud_command`; inserted the mode radiogroup, the cloud-command `CommandEditor` row, and the detected-model `<select>` above the existing rows. Existing rows untouched.
- `yulu/scripts/yulu_ui/tests/web/TranscriptionSection.test.tsx` (new) — 6 Vitest tests: mode radios render + "local" default + persist `transcription.mode`; cloud `CommandEditor` present + persist `transcription.cloud_command`; the explicit no-key invariant (no password input, no api-key/token/secret label/placeholder/text); model selector lists detected models by name + persists `local_model_path`; empty `detected_models` → disabled "no models detected"; all prior rows preserved.
- `yulu/scripts/yulu_ui/tests/web/routes/settings.test.tsx` (modified — deviation) — added the `capabilities.detected_models` mock path so the consolidated `<Settings>` render does not crash now that `TranscriptionSection` queries it.

## Decisions Made
- **Model selector persists to `transcription.local_model_path`** (one deterministic key, per the plan's instruction to pick one and document it): `list_models()` returns whisper model *files* (`.bin`/`.gguf`/`.safetensors` paths), which is exactly what the existing "Local model path" (`filter="bin"`) row already targets — so selector and that row write the same key. (The plan offered `local_model_path` OR `mlx.final_model`; `local_model_path` is the file-path-shaped match.)
- **Real radio inputs for mode** (not an `InlineEditRow` select): CONTEXT D-03 says "radios," and a `role="radiogroup"` makes "three options, local is default" explicit and assertable by role.
- **`transcription.cloud_command` is a distinct key from the pre-existing `transcription.command`**: `classify()` does longest-prefix matching, so the new key resolves to its own entry with zero collision risk.
- **Cloud command always visible** (not gated behind `mode ≠ local`): it is the config the cloud modes consume; always showing it lets the user prepare the command before switching mode, mirroring how `llm.command` is always shown.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug / Rule 3 - Blocking] Querying detected_models broke the consolidated settings render test**
- **Found during:** Task 2 (after wiring `trpc.capabilities.detected_models.useQuery()` into `TranscriptionSection`)
- **Issue:** `tests/web/routes/settings.test.tsx` (the consolidated `<Settings>` render — flagged in STATE.md as the recurring trap when a section gains a new query) mocks `trpc` but lacked `capabilities.detected_models`. With the path absent the mock returned `undefined`, so `.useQuery()` threw on mount and crashed the whole `<Settings>` render (all 4 tests in that file).
- **Fix:** Added `capabilities.detected_models.useQuery → { data: [], isPending: false }` to the test's trpc mock (alongside the existing `host_capabilities` mock). The test's intent (all 7 sections render, correct anchors, no TOC, realtime toggle on) is preserved, not weakened.
- **Files modified:** `yulu/scripts/yulu_ui/tests/web/routes/settings.test.tsx`
- **Verification:** `npx vitest run tests/web/routes/settings.test.tsx` → 4 passed; full suite → 71 files / 334 tests passed (no other regressions).
- **Committed in:** `6de3e63` (part of the Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug/blocking — a shared test directly broken by the planned new query in `TranscriptionSection`).
**Impact on plan:** Necessary — the consolidated render mounts `TranscriptionSection`, so its new query path had to be mocked there. Test-only; no production code beyond the plan's `files_modified` was touched.

## Issues Encountered
- **In-cycle GREEN refinements (not out-of-scope):** the first GREEN run had two issues, both fixed within the Task 2 cycle before committing — (1) the test mock fn `updateMutate` was typed with zero params, so `c[0]?.key` failed `tsc`; gave it an explicit `(_vars: { key; value })` signature; (2) the consolidated settings test crash above. Both resolved, then the comment in the cloud-command block was rephrased away from the literal tokens `api-key`/`token` so the strict guardrail grep over the component source returns truly nothing. All folded into the GREEN commit.
- **Vitest workspace deprecation notice** (`vitest.workspace.ts` → use `test.projects`) prints on every run — pre-existing, unrelated, left untouched (out of scope).

## User Setup Required
None — no new packages (existing React / tRPC / TanStack Query / CommandEditor / Vitest only, T-04-SC honored), no external service configuration. Cloud transcription requires the user to supply their OWN command in the new field; Yulu asks for and stores no cloud credentials.

## Next Phase Readiness
- **TRANS-01 / TRANS-02 / SET-04 delivered:** the user can set transcription mode (persists `transcription.mode`), configure cloud transcription via their own command (persists `transcription.cloud_command`, no key held), and pick a detected model (persists `transcription.local_model_path`).
- **Phase 5 (reuse / act)** reads `transcription.mode` + `transcription.cloud_command` + the chosen model to act; the `restart:sttdaemon` mapping ensures a change cycles the STT daemon. NOTE: this phase only SURFACES + PERSISTS — `cloud_command` is stored verbatim and NOT executed here (T-04-CMD accept; Phase 5 wires execution through the existing `llm.command` subprocess boundary). This is the documented phase boundary, not a stub.
- **04-04 (onboarding)** is a parallel sibling — untouched, per the scope boundary. It may reuse the same `config.update` pattern.
- **No blockers.** Verification green: `npm run typecheck` (0 errors), plan command (`config.test.ts` 6 + `TranscriptionSection.test.tsx` 6 = 12 passed), full Vitest suite **334 passed (71 files)**, `npm run build` (server + web bundles compile).

## Known Stubs
None. The `cloud_command` value is intentionally persisted-but-not-executed in this phase — that is the explicit SET-vs-ACT boundary (Phase 5 executes it), not an unwired stub. The model selector and mode radios are fully wired to live data (`detected_models`) and persist real config.

## Self-Check: PASSED

---
*Phase: 04-settings-onboarding-surface*
*Completed: 2026-05-30*
