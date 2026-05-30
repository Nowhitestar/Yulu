# Phase 4: Settings & Onboarding Surface - Context

**Gathered:** 2026-05-30
**Status:** Ready for planning
**Mode:** Autonomous (Claude decided; research skipped per ROADMAP "tRPC-over-doctor.py follows codebase conventions"; UI/UX decisions captured here in lieu of a standalone UI-SPEC because this EXTENDS the existing yulu_ui, following established React/tRPC/settings-component patterns — not a greenfield visual design)

<domain>
## Phase Boundary

The web UI becomes the FIRST consumer of the Phase 3 `HostCapabilityReport` — surfacing each capability's provenance + resolved path, letting the user configure transcription mode + model selection, and showing a skippable first-run onboarding walkthrough with live permission status. Proves the report schema end-to-end. Covers **SET-01..04, TRANS-01, TRANS-02**.

**Out of scope:** actual capability reuse (Phase 5 acts on these settings), data-folder/cloud-sync safety (Phase 5). This phase SURFACES + CONFIGURES; Phase 5 acts on the config.

</domain>

<decisions>
## Implementation Decisions — all Claude's discretion (autonomous)

### Capability Surfacing (SET-01/02)
- **D-01:** New `capabilities` tRPC router (`src/routers/capabilities.ts`, registered in `_app.ts`) with a `host_capabilities` query that runs `doctor.py --json` and returns the `host_capabilities` section (the Phase 3 report). On-demand `useQuery`; a manual refresh button (no aggressive polling — doctor probes are subprocess-heavy).
- **D-02:** New `CapabilitiesSection.tsx` (in `web/src/components/settings/`) renders each capability with a provenance label — **"reused from your PATH"** (host-path / agent-config) vs **"Yulu-managed"** (yulu-managed) vs **"not found"** (absent) — its resolved path, and a tri-state status badge (usable / present-but-unverified / absent).

### Transcription Config (TRANS-01/02, SET-04) — extend existing `TranscriptionSection.tsx`
- **D-03:** Transcription-mode radios: **local (default)** / cloud-fallback / cloud-priority, persisted to `config.transcription` via the existing `config` router + `ConfigManager`.
- **D-04:** Cloud transcription uses the user's OWN configured command (same trust model as `llm.command`) — a command field, NOT a cloud API key. Yulu holds + asks for no cloud keys (privacy constraint). Mirror the `llm.command` config shape.
- **D-05:** Model selector — pick among the whisper models the Phase 3 report detected across host caches (`host_capabilities.models`); persists the chosen model to config.

### Onboarding (SET-03)
- **D-06:** New skippable first-run onboarding walkthrough (`web/src/routes/` route or overlay) that reflects LIVE permission status (from `host_capabilities` / doctor), and is dismissable WITHOUT completing it. First-run detection via a config flag (`onboarding_dismissed`) or localStorage; never forced/unskippable (Out-of-Scope anti-feature).

### UI/UX (in lieu of UI-SPEC)
- **D-07:** EXTEND the existing yulu_ui — React 18 + tRPC 11 + TanStack Query + React Router 7. Follow the established pattern: tRPC router → `trpc.X.useQuery()` hook → a settings `Section` component slotted into `settings.tsx`. Reuse `settings.css` + existing Section styling. NO new design system. Onboarding = a dismissable overlay/route, visually consistent with existing routes. Provenance labels use plain, friendly copy ("reused from your PATH").
- **D-08 [structure]:** `src/routers/capabilities.ts` (new, register in `_app.ts`); `web/src/components/settings/CapabilitiesSection.tsx` (new) + extend `TranscriptionSection.tsx`; onboarding component under `web/src/routes/`; config persistence via the existing `config` router + `ConfigManager` (`src/config.ts`). Vitest tests follow existing `yulu_ui/tests/` patterns; tRPC procedures typed with Zod (existing convention).

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.** (Research skipped — these + the codebase ARE the spec.)

### Phase scope & requirements
- `.planning/ROADMAP.md` §"Phase 4" — goal + 5 success criteria
- `.planning/REQUIREMENTS.md` — SET-01..04, TRANS-01, TRANS-02

### The contract this phase consumes
- `yulu/scripts/doctor.py` — `--json` `host_capabilities` section (Phase 3); the tRPC endpoint shells to this
- `.planning/phases/03-host-capability-detection-spine/03-CONTEXT.md` — the report schema (provenance / tri-state) the UI renders

### Conventions + source files the planner will touch
- `.planning/codebase/CONVENTIONS.md` — yulu_ui tRPC/React/Zod conventions
- `yulu/scripts/yulu_ui/src/routers/_app.ts` — root router (register new `capabilities` router here)
- `yulu/scripts/yulu_ui/src/routers/config.ts` — existing config read/write router (transcription persistence)
- `yulu/scripts/yulu_ui/src/config.ts` — `ConfigManager`
- `yulu/scripts/yulu_ui/src/trpc.ts` — tRPC context/AppContext
- `yulu/scripts/yulu_ui/web/src/components/settings/TranscriptionSection.tsx` — EXTEND (mode radios + model selector + cloud command)
- `yulu/scripts/yulu_ui/web/src/routes/settings.tsx` — slot the new CapabilitiesSection
- `yulu/scripts/config.example.json` — `transcription` config shape
- *(new)* `src/routers/capabilities.ts`, `web/src/components/settings/CapabilitiesSection.tsx`, onboarding component

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `TranscriptionSection.tsx` ALREADY EXISTS — extend it (mode radios + model selector + cloud command) rather than create a new section.
- The settings router/Section pattern (AudioSection, StorageSection, LlmSection…) is the exact analog for CapabilitiesSection.
- `config` router + `ConfigManager` already read/write config.json — reuse for transcription + onboarding-dismissed persistence.
- `LlmSection.tsx` / `llm` router is the trust-model analog for the cloud-command field (user's own command, no held keys).

### Established Patterns
- tRPC procedure (Zod-typed) → `trpc.X.useQuery/useMutation` → Section component. WebSocket for live updates exists (ws.tsx) if onboarding needs live permission refresh.
- Vitest + @testing-library/react + mock-socket for UI tests.

### Integration Points
- The `capabilities` tRPC endpoint shells `doctor.py --json` — the Phase 3 report is the data contract; render its provenance/tri-state faithfully.
- Settings persist via config router → ConfigManager → config.json; Phase 5 reads these (transcription mode, chosen model) to act.

</code_context>

<specifics>
## Specific Ideas
- Provenance copy: "reused from your PATH" (host-path/agent-config) vs "Yulu-managed".
- Transcription radios: local (default) / cloud-fallback / cloud-priority.
- Cloud = user's own command (llm.command trust model), never a Yulu-held key.
- Onboarding: skippable, dismissable without completing, reflects live permission status.
- Extend TranscriptionSection (exists); add CapabilitiesSection (new); reuse settings.css.

</specifics>

<deferred>
## Deferred Ideas
None new. Acting on the config (capability reuse, data-folder) is Phase 5. This phase only surfaces + persists.

</deferred>

---

*Phase: 4-Settings & Onboarding Surface*
*Context gathered: 2026-05-30 (autonomous, research+ui-phase skipped — UI decisions captured here)*
