---
phase: 04-settings-onboarding-surface
plan: 04
subsystem: ui
tags: [react, trpc, tanstack-query, onboarding, first-run, capabilities, localstorage, vitest, overlay]

# Dependency graph
requires:
  - phase: 04-settings-onboarding-surface (plan 01)
    provides: "capabilities tRPC router — host_capabilities query (shells doctor.py --json, degrades to a typed {error, schema_version, capabilities:{}} shape, never throws). The onboarding overlay consumes it for LIVE permission status."
  - phase: 04-settings-onboarding-surface (plan 02)
    provides: "CapabilitiesSection precedent — the host_capabilities query usage pattern + display-only/escape-safe rendering of report strings the onboarding overlay mirrors."
  - phase: 03-host-capability-detection-spine
    provides: "HostCapabilityReport schema (per-capability tri-state status) the walkthrough collapses into ready/not-found framing."
provides:
  - "Onboarding.tsx — a skippable first-run walkthrough overlay (SET-03) reflecting LIVE permission/capability status from trpc.capabilities.host_capabilities, dismissable WITHOUT completing any step."
  - "First-run detection via BOTH localStorage (yulu_ui.onboarding_dismissed, read synchronously so no flash) AND config.onboarding_dismissed (persisted via the config router, survives across browsers/machines)."
  - "RootLayout mount — Onboarding rendered as a sibling of Pill, self-gating on the dismissed flag so it overlays every route on first run and renders null once dismissed (never forced)."
affects: [phase-05-reuse]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Synchronous localStorage short-circuit before an async config query resolves: useState(() => readLocalDismissed()) so a returning user never flashes the overlay (no-flash invariant)."
    - "Self-gating overlay: the component reads its own dismissal flag and returns null when dismissed, so it can be mounted unconditionally in the layout — the mount site carries no first-run logic."
    - "Tri-state → ready/not-found collapse: the Phase 3 status (usable / present-but-unverified / absent) is mapped to a per-item ready/missing/unknown indicator with friendly copy; a missing/degraded report reads 'couldn't check' rather than implying failure."
    - "Dismiss-then-persist: Skip sets local state + localStorage and hides IMMEDIATELY (no walkthrough step required), then fires config.update — a failed config write can't re-show the overlay this session because localStorage already gates it (SET-03 skip-without-complete)."
    - "Display-only/escape-safe rendering carried from 04-02: report-derived copy renders as JSX text children only; never dangerouslySetInnerHTML (T-04-XSS)."

key-files:
  created:
    - "yulu/scripts/yulu_ui/web/src/components/Onboarding.tsx — exports Onboarding; reads config.get + capabilities.host_capabilities + localStorage; renders a dismissable dialog with per-capability live status; Skip/Got-it persist the flag without completing a step"
    - "yulu/scripts/yulu_ui/web/src/onboarding.css — full-screen scrim + card styling reusing tokens.css (no new design system); status dots colored by data-status (green/accent/red/fg-3)"
    - "yulu/scripts/yulu_ui/tests/web/Onboarding.test.tsx — 5 Vitest tests (first-run-with-live-status, skip-without-complete persists config+localStorage, dismissed renders null, no-flash on pending config, degraded-report still skippable)"
  modified:
    - "yulu/scripts/yulu_ui/web/src/routes/root.tsx — import + render <Onboarding /> as a sibling of <Pill /> in the root shell (self-gating mount)"

key-decisions:
  - "First-run gating uses BOTH sources with localStorage as the synchronous short-circuit (dismissed = localFlag || cfg?.onboarding_dismissed === true): localStorage prevents a flash before config resolves, config persists the dismissal durably. Either source alone keeps it dismissed."
  - "Skip hides immediately via local state and ONLY THEN awaits config.update — skipping must never require completing a walkthrough step (SET-03 core), and a config-write failure cannot re-show the overlay because localStorage already gates it."
  - "Mounted in RootLayout (a sibling of Pill), NOT as a route — the overlay must appear over every route on first run; self-gating makes the unconditional mount correct (renders null when dismissed)."
  - "The walkthrough collapses Phase 3's tri-state into ready/not-found/unknown per item with friendly per-capability copy (recording_dir / claude / whisper_cli / models); an entry missing from the report (or a degraded report) reads 'couldn't check' rather than a failure."

patterns-established:
  - "Self-gating overlays read their own dismissal flag and return null when dismissed, so the layout mounts them unconditionally with no first-run logic at the mount site."
  - "Client-side first-run hints (localStorage) short-circuit BEFORE the authoritative async config flag resolves, eliminating the returning-user flash while config remains the durable source of truth."

requirements-completed: [SET-03]

# Metrics
duration: 3min
completed: 2026-05-30
---

# Phase 4 Plan 04: First-Run Onboarding Overlay Summary

**New `Onboarding.tsx` — a skippable first-run walkthrough overlay (SET-03 / D-06 / D-07) that reflects LIVE permission status via `trpc.capabilities.host_capabilities`, is dismissable WITHOUT completing any step, detects first-run from BOTH localStorage (no-flash) and `config.onboarding_dismissed` (durable), and is mounted self-gating in RootLayout so it overlays every route on first run and never reappears once dismissed.**

## Performance

- **Duration:** ~3 min (implementation commit span; ~25 min incl. context reads + full web suite runs)
- **Started:** 2026-05-30T17:02:13+08:00 (RED test commit)
- **Completed:** 2026-05-30T17:05:22+08:00 (mount commit)
- **Tasks:** 2 (Task 1 TDD)
- **Files modified:** 4 (3 created, 1 modified)

## Accomplishments
- `Onboarding` consumes `trpc.capabilities.host_capabilities.useQuery()` and renders a per-capability live status (recording_dir, claude, whisper_cli, models) — a usable cap reads a "ready" line + green dot, an absent cap reads a "not found — Yulu will help in setup" line + red dot — the second UI consumer of the 04-01 router (SET-03).
- Skippable without completing: a **Skip** control (and a **Got it** footer button) set localStorage + call `config.update({key:"onboarding_dismissed", value:true})` and hide the overlay immediately via local state — no walkthrough step is required (SET-03 core / T-04-FORCE mitigated).
- Never forced / no reappear: `dismissed = localFlag || cfg?.onboarding_dismissed === true` → renders `null`. A returning user with the localStorage hint set never flashes the overlay even while the config query is still pending (no-flash invariant).
- Graceful degrade: when `host_capabilities` returns the typed `{error,...}` shape (or hasn't resolved), each item shows a "couldn't check this right now — you can do it in setup" placeholder instead of crashing; the overlay still renders so the user can skip.
- Mounted self-gating in `RootLayout` as a sibling of `<Pill />` — overlays every route on first run; because it returns `null` when dismissed, the unconditional mount is correct. `onboarding.css` reuses `tokens.css` (scrim + glass card + tri-state dots) with no new design system (D-07).
- T-04-XSS honored: all report-derived copy renders as JSX text children (React auto-escapes); no `dangerouslySetInnerHTML` (the only match is inside a doc comment).

## Task Commits

Task 1 was TDD (RED test → GREEN feat); Task 2 was a straight feat:

1. **Task 1: Onboarding overlay (live status + skippable dismiss)** — `71ec573` (test, RED) → `34f9767` (feat, GREEN)
2. **Task 2: Mount Onboarding in RootLayout** — `a9f0356` (feat)

**Plan metadata:** _(this SUMMARY's docs commit)_

_No REFACTOR commit needed — the component mirrors the TestPopover overlay + CapabilitiesSection query analogs and was clean on first GREEN. The one in-cycle adjustment (over-greedy test regexes → `getAllByText`) was committed within the Task 1 GREEN commit, documented under Issues._

## Files Created/Modified
- `yulu/scripts/yulu_ui/web/src/components/Onboarding.tsx` (new) — exports `Onboarding`; reads `config.get` + `capabilities.host_capabilities` + a synchronous localStorage hint; renders a `role="dialog"` overlay with a WALKTHROUGH list (per-cap label + status-dependent line + a `data-status` dot); `handleSkip()` writes localStorage, sets local dismissed state, then awaits `config.update`. Returns `null` when dismissed.
- `yulu/scripts/yulu_ui/web/src/onboarding.css` (new) — `.onboarding-scrim` (fixed full-screen backdrop, z-index 1000), `.onboarding-card` (glass panel reusing `--glass-2`/`--blur-glass`/`--radius-panel`/`--shadow`), and `.onboarding-dot[data-status]` tri-state colors (`--green`/`--accent`/`--red`/`--fg-3`).
- `yulu/scripts/yulu_ui/tests/web/Onboarding.test.tsx` (new) — 5 tests driving a mutable trpc mock (`config.get`, `config.update`, `capabilities.host_capabilities`) + the localStorage shim: first-run-shows-live-status, skip-persists-config+localStorage-without-completing, dismissed-renders-null, no-flash-on-pending-config, degraded-report-still-skippable.
- `yulu/scripts/yulu_ui/web/src/routes/root.tsx` (modified) — imported `Onboarding` and rendered `<Onboarding />` as a sibling of `<Pill />` (component imports its own CSS; no layout structure changed).

## Decisions Made
- **Dual first-run gating, localStorage short-circuits config** (`dismissed = localFlag || cfg?.onboarding_dismissed === true`): localStorage is read synchronously on mount so a returning user never flashes the overlay before the async config query resolves; `config.onboarding_dismissed` is the durable cross-browser/machine source. Either source alone keeps it dismissed.
- **Skip hides immediately, persists second:** `handleSkip()` sets local state + localStorage and returns the overlay to `null` before awaiting `config.update` — skipping must not require completing a step (SET-03), and a config-write failure can't re-show the overlay this session because localStorage already gates it.
- **Mounted in RootLayout, not as a route:** the overlay must cover every route on first run; self-gating (returns `null` when dismissed) makes the unconditional mount correct, so the mount site carries no first-run logic.
- **Tri-state collapsed to ready/missing/unknown per item:** `usable` → ready line + green dot, `absent` → missing line + red dot, `present-but-unverified` → accent dot, and a missing-from-report/degraded entry → "couldn't check" + neutral dot — friendly framing (D-07) that never implies a failure when the report simply couldn't be read.

## Deviations from Plan

None — plan executed exactly as written. No production code beyond the plan's `files_modified` was touched; the recurring consolidated-test trap (04-02/04-03) did NOT recur because Task 2 mounts in `RootLayout`, which no test renders directly (`routes.test.tsx` mounts route components individually behind a Proxy trpc mock that returns `{data: undefined}` for any path, and the component guards against an undefined report).

## Issues Encountered
- **In-cycle GREEN adjustment (not a deviation):** the first GREEN run had two failing assertions — `getByText(/recording/i)` matched both the item label ("Recording folder") and its line, and `getByText(/couldn'?t check/i)` matched all four degraded placeholders. The component rendered correctly; the test regexes were over-greedy. Resolved by switching both to `getAllByText(...).length >= 1` (mirrors 04-02's `getByText` collision fix), committed within the Task 1 GREEN commit (`34f9767`), not an out-of-scope change.
- **Vitest workspace deprecation notice** (`vitest.workspace.ts` → use `test.projects`) printed on every run — pre-existing, unrelated to this plan, left untouched (out of scope).

## User Setup Required
None — no new packages (existing React / tRPC / TanStack Query / Vitest only, T-04-SC honored), no external service configuration.

## Next Phase Readiness
- **SET-03 delivered:** a skippable first-run onboarding walkthrough reflects live permission status and is dismissable without completing it; never forced; dismissal persists to config + localStorage and never reappears — proven by `Onboarding.test.tsx` (5 tests).
- **Phase 4 complete:** this is the last plan of Phase 4. The web UI now surfaces the Phase 3 capability report (SET-01/02, 04-02), configures transcription mode/cloud-command/model (TRANS-01/02 + SET-04, 04-03), and shows a skippable first-run onboarding (SET-03, this plan) — proving the `host_capabilities` report end-to-end.
- **Phase 5 (reuse)** reads `config.onboarding_dismissed` only as a UI flag; it acts on the transcription config (mode + chosen model) the settings surface persists. The onboarding overlay introduces no new persisted state Phase 5 must act on beyond that single boolean.
- **No blockers.** Verification green: `npm run typecheck` (0 errors), targeted tests (Onboarding 5 + routes smoke 7 + consolidated settings 4 = 16 passed), full web suite **241 passed / 47 files**, `npm run build` (server + web bundles compile, onboarding.css bundled).

## Self-Check: PASSED

---
*Phase: 04-settings-onboarding-surface*
*Completed: 2026-05-30*
