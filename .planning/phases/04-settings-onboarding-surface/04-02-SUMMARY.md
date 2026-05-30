---
phase: 04-settings-onboarding-surface
plan: 02
subsystem: ui
tags: [react, trpc, tanstack-query, settings, capabilities, provenance, tri-state, vitest, xss-escape]

# Dependency graph
requires:
  - phase: 04-settings-onboarding-surface (plan 01)
    provides: "capabilities tRPC router — host_capabilities query (shells doctor.py --json, degrades to a typed {error, schema_version, capabilities:{}} shape, never throws). This section is its first UI consumer."
  - phase: 03-host-capability-detection-spine
    provides: "HostCapabilityReport schema (schema_version + per-capability provenance / tri-state status / resolved_path / detail) — the data contract this section renders faithfully."
provides:
  - "CapabilitiesSection.tsx — the first UI surface of the Phase 3 host capability report; renders each capability's provenance label, resolved path, and tri-state status badge (SET-02)."
  - "Exported pure helpers provenanceLabel(p) and statusLabel(s) — the D-02-locked provenance copy + tri-state badge text, unit-testable in isolation."
  - "Settings page wired to live capability data (SET-01 consumer): the report renders end-to-end through trpc.capabilities.host_capabilities, with a manual Refresh and graceful error degradation."
affects: [04-04-onboarding, phase-05-reuse]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Display-only rendering of server data: report strings render as JSX text children only (React auto-escapes) — never dangerouslySetInnerHTML, never interpolated into a command (T-04-XSS mitigated)."
    - "Pure label helpers exported alongside the component so copy/mapping is unit-tested directly (provenanceLabel / statusLabel), decoupled from the render."
    - "Tri-state status badge via a data-attribute pill (.cap-badge[data-status=...]) mirroring the existing DaemonCard .status-pill pattern — three CSS-encoded states, never a boolean."
    - "Manual-refresh-only for subprocess-heavy queries: a Refresh button calls the query's refetch(); no aggressive polling (D-01)."
    - "Graceful degrade in the consumer: isError || data.error renders a friendly single line, so a doctor failure never blanks or crashes the settings page (SET-01)."

key-files:
  created:
    - "yulu/scripts/yulu_ui/web/src/components/settings/CapabilitiesSection.tsx — Capabilities settings section (exports CapabilitiesSection, provenanceLabel, statusLabel)"
    - "yulu/scripts/yulu_ui/tests/web/CapabilitiesSection.test.tsx — 9 Vitest tests (provenance/status mapping, path render, three badges, error degrade, Refresh refetch, XSS-escape)"
  modified:
    - "yulu/scripts/yulu_ui/web/src/routes/settings.tsx — import + render <CapabilitiesSection /> at the top of settings-stack"
    - "yulu/scripts/yulu_ui/web/src/routes/settings.css — added .cap-head / .cap-error / .cap-path / .cap-badge[data-status] tri-state classes (reused existing tokens)"
    - "yulu/scripts/yulu_ui/tests/web/routes/settings.test.tsx — extended the consolidated test for the 7th (Capabilities) section + added the missing trpc mock path (deviation Rule 1/3)"

key-decisions:
  - "statusLabel('absent') returns 'absent' (the literal tri-state name), NOT 'not found' — so the status badge text stays distinct from the absent provenance label ('not found'), keeping both unambiguous in the UI and in getByText assertions."
  - "CapabilitiesSection placed FIRST in settings-stack (above Audio) — surfaces 'what Yulu detected' first per the phase goal, and lets the .settings-section:first-child rule drop its top border cleanly."
  - "Section takes NO tracker prop — it performs no restart-tracked config writes (read-only report), so it omits the SettingsRestartTracker the write-sections use."
  - "Tri-state badge encoded via data-status attribute + CSS (mirroring DaemonCard .status-pill) rather than per-state className strings — one element, three CSS-selected states, asserted structurally in the test."

patterns-established:
  - "Capability-report rendering is display-only and escape-safe: server strings are text children, the report is never echoed into a command or HTML (T-04-XSS)."
  - "Settings Section components that only READ data take no tracker prop; only config-writing sections carry the restart tracker."

requirements-completed: [SET-01, SET-02]

# Metrics
duration: 5min
completed: 2026-05-30
---

# Phase 4 Plan 02: CapabilitiesSection — Surface the Host Capability Report Summary

**New `CapabilitiesSection.tsx` renders the Phase 3 host capability report in the settings page (SET-01 consumer / SET-02): for each detected capability it shows a D-02 provenance label ("reused from your PATH" / "Yulu-managed" / "not found"), the resolved path, and a tri-state status badge — with a manual Refresh and a friendly error degrade — proving the report renders end-to-end through `trpc.capabilities.host_capabilities`.**

## Performance

- **Duration:** ~5 min (implementation commit span; ~30 min incl. context reads + full web suite runs)
- **Started:** 2026-05-30T08:36:41Z
- **Completed:** 2026-05-30T08:42:30Z
- **Tasks:** 2 (Task 1 TDD)
- **Files modified:** 4 (2 created, 2 modified) + 1 consolidated test extended (deviation)

## Accomplishments
- `CapabilitiesSection` consumes `trpc.capabilities.host_capabilities.useQuery()` and iterates `Object.entries(data.capabilities)`, rendering per capability: a provenance label, the `resolved_path` (monospace; `—` placeholder when empty), and a tri-state badge — the first UI consumer of the 04-01 router, proving the Phase 3 report renders end-to-end (SET-01).
- D-02 provenance copy honored exactly: `host-path` and `agent-config` → **"reused from your PATH"**; `yulu-managed` → **"Yulu-managed"**; `absent` → **"not found"** (exported `provenanceLabel` helper, unit-tested directly).
- Tri-state status badge (`usable` / `present, unverified` / `absent`) via `.cap-badge[data-status=...]` — three CSS-encoded states, never a boolean (D-08 spirit carried into the UI).
- T-04-XSS mitigated: every report string (`resolved_path`, name) renders as a JSX text child (React auto-escapes); a path payload of `/x/<img src=x onerror=alert(1)>` renders as literal text with no live `<img>` — proven by a dedicated test.
- Graceful degrade: when the query returns the typed `{ error, capabilities: {} }` shape (or `isError`), the section shows "Couldn't read capabilities right now — try Refresh." instead of blanking or crashing (SET-01). A manual **Refresh** button calls `refetch()` — no aggressive polling (D-01).
- Slotted into `settings.tsx` at the top of the stack without altering any other section; `settings.css` extended with minimal badge/row classes reusing existing tokens — no new design system (D-07/D-08).

## Task Commits

Task 1 was TDD (RED test → GREEN feat); Task 2 was a straight feat; one deviation test fix followed:

1. **Task 1: CapabilitiesSection (provenance + path + tri-state badge)** — `789fcce` (test, RED) → `40a57b8` (feat, GREEN)
2. **Task 2: Slot into settings + badge styles** — `97ec8b7` (feat)
3. **Deviation (Rule 1/3): extend consolidated settings test** — `324192f` (test)

_No REFACTOR commit needed — the component mirrors StorageSection/DaemonCard analogs and was clean on first GREEN (the one in-cycle adjustment, statusLabel('absent') → "absent", is documented under Issues)._

## Files Created/Modified
- `yulu/scripts/yulu_ui/web/src/components/settings/CapabilitiesSection.tsx` (new) — exports `CapabilitiesSection` + pure `provenanceLabel` / `statusLabel`; consumes the host_capabilities query; renders rows with `.row`/`.row-label`/`.row-value`/`.row-status` (existing grid) and a `.cap-badge[data-status]` tri-state pill; degrades to a friendly line on error; Refresh → `refetch()`.
- `yulu/scripts/yulu_ui/tests/web/CapabilitiesSection.test.tsx` (new) — 9 tests: `provenanceLabel`/`statusLabel` mapping, the four-provenance/three-status full-report render, resolved-path rendering, three distinct `data-status` badges, typed-error degradation, Refresh→refetch, and the T-04-XSS escape assertion.
- `yulu/scripts/yulu_ui/web/src/routes/settings.tsx` (modified) — imported `CapabilitiesSection` and rendered it first in `settings-stack` (no tracker prop).
- `yulu/scripts/yulu_ui/web/src/routes/settings.css` (modified) — added `.cap-head` (heading + Refresh row), `.cap-error`, `.cap-path` / `.cap-path--empty`, and `.cap-badge` + the three `[data-status]` variants, all reusing existing color/radius tokens.
- `yulu/scripts/yulu_ui/tests/web/routes/settings.test.tsx` (modified — deviation) — added the `capabilities.host_capabilities` path to the test's trpc mock and asserted the 7th "Capabilities" heading + `#capabilities` anchor.

## Decisions Made
- **`statusLabel('absent')` → "absent"** (not "not found"): the absent *provenance* already reads "not found"; making the *status badge* read the literal tri-state name keeps the two labels distinct in the UI (and lets `getByText("not found")` resolve unambiguously to the provenance label).
- **Section placed first in the stack** (above Audio): the phase goal is to surface "what Yulu detected" first; first-child also drops the top border via the existing CSS rule.
- **No tracker prop**: the section is read-only (no config writes), so it omits the `SettingsRestartTracker` that the write-sections (Audio/LLM/Storage…) carry.
- **Badge via `data-status` attribute + CSS** (mirroring DaemonCard's `.status-pill`): one element, three CSS-selected states, asserted structurally (`querySelector('.cap-badge[data-status="usable"]')`) rather than by brittle text.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug / Rule 3 - Blocking] Slotting the section broke the consolidated settings test (missing trpc mock path + section-count assertions)**
- **Found during:** Task 2 (after slotting `<CapabilitiesSection />` into `settings.tsx`)
- **Issue:** `tests/web/routes/settings.test.tsx` (a consolidated render test NOT listed in Task 2's `read_first` — the plan pointed at `tests/web/routes.test.tsx`) mocks `trpc` but did not include `capabilities.host_capabilities`. The new section calls `trpc.capabilities.host_capabilities.useQuery()` on mount, so with the path absent the mock returned `undefined` and `.useQuery` threw — crashing the entire `<Settings>` render and failing all 4 tests in that file (not only the section-count one). The test also hard-asserted exactly six section headings / six anchors.
- **Fix:** Added `capabilities.host_capabilities.useQuery → { data: { schema_version: 1, capabilities: {} }, refetch, isError: false }` to the test's trpc mock, and extended the assertions to include the 7th "Capabilities" heading + `#capabilities` anchor. The test's intent (all sections render on one page, correct anchors, no TOC, realtime toggle on) is preserved and strengthened, not weakened.
- **Files modified:** `yulu/scripts/yulu_ui/tests/web/routes/settings.test.tsx`
- **Verification:** `npx vitest run tests/web/routes/settings.test.tsx` → 4 passed; full web suite `npx vitest run --project web` → 45 files / 230 tests passed (no other regressions).
- **Committed in:** `324192f`

---

**Total deviations:** 1 auto-fixed (1 bug/blocking — a test directly broken by the planned `settings.tsx` edit).
**Impact on plan:** Necessary — the new section is a hard dependency of the consolidated settings render, so its mock path and the section enumeration had to move with it. No scope change; no production code beyond the plan's `files_modified` was touched (the fix is test-only).

## Issues Encountered
- **In-cycle GREEN adjustment (not a deviation):** the first GREEN run had one failing assertion — `getByText("not found")` matched two nodes because `statusLabel('absent')` and `provenanceLabel('absent')` both returned "not found". Resolved by making `statusLabel('absent')` return "absent" (distinct tri-state text). This was a same-task RED→GREEN refinement, committed within the Task 1 GREEN commit (`40a57b8`), not an out-of-scope fix.
- **Vitest workspace deprecation notice** (`vitest.workspace.ts` → use `test.projects`) printed on every run — pre-existing, unrelated to this plan, left untouched (out of scope).

## User Setup Required
None — no new packages (existing React / tRPC / TanStack Query / Vitest only, T-04-SC honored), no external service configuration.

## Next Phase Readiness
- **SET-01 (consumer) + SET-02 delivered:** the settings page loads the Phase 3 report via `trpc.capabilities.host_capabilities` and renders provenance + resolved path + tri-state badge for every capability, with a manual Refresh and a non-blanking error path.
- **04-04 (onboarding)** can reuse the same `host_capabilities` query for live permission status, and may reuse `provenanceLabel` / `statusLabel` for consistent copy.
- **Phase 5 (reuse)** reads the same tri-state the UI now surfaces; the UI faithfully shows the three distinct states a reuse decision will gate on.
- **No blockers.** Verification green: `npm run typecheck` (0 errors), targeted tests (CapabilitiesSection 9 + routes smoke 7 + consolidated settings 4 = 20 passed), full web suite 230 passed, `npm run build` (server + web bundles compile).
- 04-03 (TranscriptionSection model selector) and 04-04 (onboarding) are parallel siblings — untouched, per the scope boundary.

## Self-Check: PASSED

---
*Phase: 04-settings-onboarding-surface*
*Completed: 2026-05-30*
