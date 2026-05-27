# Phase H — Yulu UI Information Architecture + Visual Polish

**Date:** 2026-05-27
**Status:** Approved (brainstormed via 4-mockup visual companion review)
**Scope:** Restructure sidebar IA, consolidate Settings + Health into single pages, replace `/inbox/search` with a TopBar global search popover, rewrite token system to canonical Ayu palette, migrate emoji to Lucide icons, and a handful of targeted polish fixes.

---

## 1. Background

Phases A–G shipped a fully functional Yulu UI at `http://127.0.0.1:7777/`. Real-machine review surfaced ~14 polish + IA issues, summarized below. None block functionality, but together they accumulate into a feeling of "this works but feels rough".

The fixes naturally cluster around three themes:

- **Visual system correctness** — current Ayu Light/Dark tokens are close to but not exactly the [official Ayu palette](https://github.com/ayu-theme/ayu-colors); inconsistent emoji icons; logo is a bare unicode `语` instead of the actual brand mark.
- **Navigation simplification** — Settings has 6 sidebar entries (one per sub-page); Health has 2; the sidebar HEALTH section grows linearly with daemons; `/inbox/search` is a full page when it could be a popover; sidebar counts are unreliable.
- **Layout flexibility** — sidebar and master-list widths are hard-coded; long content overflows; users can't resize.

Phase H bundles all three into one coherent change to the visual + IA layer, leaving the underlying functionality unchanged.

## 2. Goals & Non-Goals

**Goals**

- Sidebar restructure: 2 top groups (Inbox + Knowledge), Settings + Health pinned at bottom with Lucide icons, no count badges, draggable width.
- Replace `/inbox/search` with a TopBar `<GlobalSearch>` popover (keyword input only, no filter chips).
- Merge 6 Settings sub-routes into one `/settings` page with section anchors; redirect old URLs.
- Merge `/health/daemons` + `/health/logs` into one `/health` page with tab UI; redirect old URLs.
- Rewrite `tokens.css` Light + Dark to canonical Ayu palette.
- Migrate every emoji in the UI to Lucide icons (stroke 1.75, currentColor).
- Use `assets/logo.svg` (saffron-dot 语) in the sidebar logo slot.
- TopBar: breadcrumb works on list routes (no more `—` placeholder); ThemeToggle moves here from sidebar (3 buttons visible).
- Inbox MasterDetail: resizable master-list column with localStorage persistence.
- Health sidebar entry shows live health state via a colored dot (green/amber/red).
- Touch-up: filter chip spacing, settings label readability.
- All Playwright critical-flow tests updated to the new IA.

**Non-Goals**

- **Audio playback bug + manual Transcription/Summary triggers** — deferred to **Phase I** (separate spec; touches `<AudioPlayer>` reader state machine + new tRPC procedures).
- **Merge Voicemails + Meetings into a single Recordings inbox** — deferred to **Phase J** (separate spec; backend router unification + URL scheme + filter UX).
- **Light/Dark theme accessibility audit** — current contrast issues are mostly resolved by adopting canonical Ayu Light values; a separate full WCAG audit is out of scope.
- **Help docs / FAQ** — "Health" replaces the misnamed "Help" entry. We don't add separate help documentation in this phase.
- **Per-row hover/focus animations, transition timing, motion design** — defer until interaction design is settled.

## 3. Architecture

Phase H touches the React frontend only (`yulu/scripts/yulu_ui/web/src/`). No backend routers change. No tRPC procedures added or removed. One new dependency: `lucide-react`. No state-management libraries added.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Phase H surface map                                                      │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  visual                  ia                          layout              │
│  ───────                 ──                          ──────              │
│  tokens.css rewrite ────▶ Sidebar restructure ──────▶ ResizableSplit     │
│       ↓                       ↓                            ↓             │
│  Logo (logo.svg)         Settings merge            sidebar width persist │
│  Icon migration          Health merge              master list width     │
│  (lucide-react)          GlobalSearch popover            persist         │
│                          (delete /inbox/search)                          │
│       ↓                       ↓                            ↓             │
│       └───────────────────────┴────────────────────────────┘             │
│                              ↓                                           │
│                  TopBar (breadcrumb + search + theme)                    │
│                              ↓                                           │
│                  Inbox / Knowledge / Settings / Health pages             │
└──────────────────────────────────────────────────────────────────────────┘
```

## 4. Components

### 4.1 `tokens.css` rewrite

Replace existing Light + Dark token values with canonical [Ayu palette](https://github.com/ayu-theme/ayu-colors/blob/master/themes/light.yaml):

**Light:**
- `--wp-1 #F8F9FA` (surface.base)
- `--wp-2 #FAFAFA` (ui.panel.bg)
- `--wp-3 #EBEEF0` (surface.sunk)
- `--accent #F29718` (saffron) → was `#F2AE49`
- `--accent-on #C16A00`
- `--fg #5C6166` (editor.fg)
- `--fg-2 #828E9F` (ui.fg)
- `--fg-3 rgba(107,125,143,0.5)` (derived from ui.line)
- `--edge rgba(107,125,143,0.12)` (ui.line)
- `--green #6CBF43` (vcs.added)
- `--blue #478ACC` (vcs.modified)
- `--red #E65050`
- `--purple #A37ACC`

**Dark:**
- `--wp-1 #0D1017` (surface.base)
- `--wp-2 #141821` (ui.panel.bg)
- `--wp-3 #070A11` (surface.sunk, ~base -L0.1)
- `--accent #E6B450` → was `#FFCC66`
- `--accent-on #5C3F00`
- `--fg #BFBDB6` (editor.fg)
- `--fg-2 #5A6378` (ui.fg)
- `--green #70BF56` (vcs.added)
- `--blue #73B8FF` (vcs.modified)
- `--red #D95757`
- `--purple #D2A6FF`

`--glass`, `--glass-2`, `--glass-3`, `--edge-top`, `--shadow`, `--row-hover` recalibrated for each theme. Mirage variant (third option) deferred.

### 4.2 `<Logo>` component

`web/src/components/Logo.tsx` + `.css`. Renders a 30×30 saffron-on-parchment box using the SVG source from `assets/logo.svg`. The SVG is inlined (not loaded via `<img src>`) so it inherits `currentColor` and survives offline.

Sidebar `Sidebar.tsx` swaps the current `<span>语</span>` for `<Logo />` followed by `<span class="sidebar-brand">Yulu</span>` (16px, weight 600, capitalized).

### 4.3 Icon system migration (lucide-react)

Add `lucide-react` to `package.json`. Replace every emoji with a Lucide component:

| File:line | Was | Becomes |
|---|---|---|
| `components/AudioPlayer.tsx:70` | `▶` / `❚❚` | `<Play />` / `<Pause />` |
| `components/DaemonCard.tsx:23` | `⏸` (stopped pill) | `<Pause />` |
| `components/Pill.tsx:51` | `🎤` | `<Mic />` |
| `routes/inbox/voicemails.index.tsx:5` | `🎙️` | `<Voicemail />` |
| `routes/knowledge/prompts.tsx:47` | `📝` | `<FileText />` |
| `routes/knowledge/prompts.index.tsx:5` | `📝` | `<FileText />` |
| Sidebar bottom (new) | — | `<Settings />` + `<HeartPulse />` |
| TopBar search (new) | — | `<Search />` |
| Sidebar nav (kept) | (no icons currently) | (still no icons — only the bottom Settings + Health get icons) |

Convention: `strokeWidth={1.75}`, color via `currentColor`, size from a `<Icon name size={16} />` wrapper or used inline. `<EmptyState>` accepts a Lucide element as the `icon` prop (or a fallback emoji string for back-compat).

### 4.4 `<Sidebar>` restructure

Single component file, new layout from top to bottom:

```
┌─ logo row (Logo + "Yulu" 16px) ──────────┐
│                                          │
├─ section "INBOX" ────────────────────────┤
│   Voicemails                             │
│   Meetings                               │
├─ section "KNOWLEDGE" ────────────────────┤
│   Prompts                                │
│   Glossary                               │
│                                          │
├─ flex-spacer ────────────────────────────┤
├─ divider ────────────────────────────────┤
│  ⚙  Settings                             │
│  ❤  Health    ●                          │
└──────────────────────────────────────────┘
```

Removed: SETTINGS section (6 entries), HEALTH section (2 entries), Search nav entry, all `?` count badges, ThemeToggle (moved to TopBar).

Sidebar is wrapped in `<ResizableSplit>` (§4.10).

### 4.5 `<TopBar>` rewrite

New layout:

```
┌─ breadcrumb ─────────── flex ─ <GlobalSearch> ─ <ThemeToggle> ─┐
│ Inbox / Voicemails                Search [⌘K]    Auto Light Dark │
└─────────────────────────────────────────────────────────────────┘
```

**Breadcrumb fix:** Each route's React Router config gains a `handle: { breadcrumb: "Voicemails" }` (or a `breadcrumb(params)` fn for dynamic stems). TopBar reads `useMatches()` and joins handle labels with " / ". List routes now contribute their own segment so the page no longer shows a bare `—`. Reader routes contribute the stem-derived title (e.g. "voicemail_20260526" → "05-26 17:23"); but the breadcrumb stops at the parent page name per user feedback — no metadata trail like "330s · 05-26 17:24".

**ThemeToggle relocated:** the existing `<ThemeToggle>` component moves from the sidebar header to the TopBar right edge. All 3 buttons visible (Auto/Light/Dark); the Dark button being clipped by sidebar width is the bug we resolve.

### 4.6 `<GlobalSearch>` popover

New `web/src/components/GlobalSearch.tsx` + `.css`. A pill-shaped input in the TopBar (placeholder `Search`, `⌘K` kbd hint), focusing opens an absolutely-positioned popover below.

**Behavior:**
- Cmd/Ctrl-K from any route focuses the input (using the existing `useHotkeys` hook).
- Type → 200ms debounced `search.query` tRPC call (existing procedure, unchanged).
- Result list shows: kind badge (Voicemail/Meeting/Summary, color-coded via blue/purple/green), title, right-aligned timestamp, single-line snippet with `<mark>` highlights.
- ↑↓ navigate focused result; ↵ opens via cross-nav (existing pattern from `search.tsx`); Esc closes; click-outside closes.
- **No filter chips.** No Type/In/Since dropdowns. Keyword input only.
- Empty query: popover shows "Start typing to search" or recent searches (deferred — for now just hide the result list).
- Popover footer: `↑↓ navigate · ↵ open · esc close · <N> results`.

**`/inbox/search` route deletion:** the existing `routes/inbox/search.tsx` file, its e2e test, and the sidebar nav entry are all removed. The cross-nav logic for navigating from a result to a reader route is preserved (extracted into a tiny helper if needed).

### 4.7 `useDaemonHealthState` hook + Health sidebar color dot

`web/src/hooks/useDaemonHealthState.ts` wraps `trpc.daemons.health.useQuery(undefined, { refetchInterval: 5_000 })`. Aggregates the 8-daemon status array into a single state value:

```ts
type HealthState = "ok" | "warn" | "crit" | "loading";
// ok    = all 8 running
// warn  = ≥1 stopped, 0 crashed
// crit  = ≥1 crashed
// loading = query in flight, no cached data yet
```

`<Sidebar>` consumes this hook for the bottom Health row; a 7px circular dot beside the label gets:
- `ok` → `var(--green)` with a soft glow
- `warn` → `var(--accent)` (saffron)
- `crit` → `var(--red)`
- `loading` → `var(--fg-3)` (no glow)

`<HealthPage>` (§4.9) also consumes it for its top summary card.

### 4.8 `<SettingsPage>` consolidation

Currently 6 routes (`/settings/audio` … `/settings/storage`), each rendering one form. Consolidate into:

- One route `/settings` rendering `routes/settings.tsx`.
- Page layout: max-width 820px centered column.
- 6 sections in order: Audio, Transcription, LLM, Hotkey & UI, Integrations, Storage.
- Each section has an `id` attribute (`#audio`, `#transcription`, `#llm`, `#hotkey`, `#integrations`, `#storage`) and an `<h2>` title with a thin top divider above.
- **No inner TOC sidebar.** All sections are part of one continuous vertical scroll. (User explicitly rejected the TOC in mockup review.)
- The existing 6 sub-page files (`routes/settings/audio.tsx` etc.) are kept as exported section components (renamed `components/settings/AudioSection.tsx` etc.) so each section's form logic stays modular; the page route just composes them.
- `<RestartBanner>` is sticky at the bottom (unchanged behavior).

**Deep-link redirects** (Phase G left these as separate routes):

| Old route | New route |
|---|---|
| `/settings/audio` | `/settings#audio` |
| `/settings/transcription` | `/settings#transcription` |
| `/settings/llm` | `/settings#llm` |
| `/settings/hotkey` | `/settings#hotkey` |
| `/settings/integrations` | `/settings#integrations` |
| `/settings/storage` | `/settings#storage` |

Implementation: a thin `<Navigate replace to="/settings#audio" />` wrapper per old path, plus a `useEffect` on `/settings` that reads `window.location.hash` after mount and calls `scrollIntoView({ behavior: "smooth" })`. The Sidebar's Settings link points to `/settings` (no hash).

### 4.9 `<HealthPage>` consolidation

Currently 2 routes (`/health/daemons`, `/health/logs`). Consolidate into one `/health` route with:

- Top summary card: HeartPulse icon (color matches `useDaemonHealthState` state), one-sentence status (e.g. "All systems nominal" / "1 daemon stopped" / "1 daemon crashed"), polling cadence note, 3 counters (running / stopped / crashed) right-aligned.
- Tab bar: `Daemons` (default) and `Logs`, controlled via URL hash (`#daemons` / `#logs`).
- `Daemons` tab content: the existing `routes/health/daemons.tsx` body (8 `<DaemonCard>` in a CSS grid).
- `Logs` tab content: the existing `routes/health/logs.tsx` body (daemon dropdown + `<LogTail>` + Pause/Clear).
- Each `<DaemonCard>` "View logs →" button now switches to the `#logs` tab and pre-selects that daemon in the dropdown (via `useNavigate` + sessionStorage handshake, or URL search param `?name=<daemon>`).

Redirects:

| Old | New |
|---|---|
| `/health/daemons` | `/health#daemons` |
| `/health/logs` | `/health#logs` (with `?name=...` preserved if present) |

### 4.10 `<ResizableSplit>` + `usePersistedSize`

`web/src/components/ResizableSplit.tsx` + `.css`: a horizontal-only split component that takes a single child + a target side (`"left"` or `"right"`) and renders a 4px grab handle on that side. The handle gets `cursor: col-resize` on hover. On mousedown it captures global mousemove + mouseup, throttles updates with `requestAnimationFrame`, commits final width to `localStorage` on mouseup. Double-clicking the handle resets to the default width.

`web/src/hooks/usePersistedSize.ts`: a hook keyed by a string (`yulu_ui.sidebar.width`, `yulu_ui.inbox.list.width`) returning `[size, setSize]` and reading from `localStorage` synchronously on mount.

Two integration points:

- `<RootLayout>` wraps the sidebar with `<ResizableSplit side="right" storageKey="yulu_ui.sidebar.width" min={150} max={360} defaultWidth={220}>`.
- `<MasterDetail>` wraps the master list with `<ResizableSplit side="right" storageKey="yulu_ui.inbox.list.width" min={240} max={520} defaultWidth={360}>`.

Both honor a CSS minimum + maximum that prevents the user from collapsing the panel to zero width (worst-case escape: localStorage reset via doctor).

### 4.11 Filter chips spacing fix

`components/FilterChips.css`: change `gap: 0` (or whatever clusters them) to `gap: 8px`, and add a small bottom margin (`12px`) so the chip row visually separates from the list below. Confirmed on `/inbox/voicemails`, `/inbox/meetings`. (The Search page no longer exists, so the spacing fix is just for Inbox.)

### 4.12 Settings labels rewrite

A one-time audit of every settings field's display label. Current labels (in `components/settings/AudioSection.tsx` etc.) inherit `snake_case` field names verbatim. Rewrite for human readability + add unit hints:

| Field key | Old label | New label | Hint |
|---|---|---|---|
| `audio.silence_threshold` | `Silence threshold` | `Silence threshold` | `RMS below this counts as silence` |
| `audio.silence_duration_sec` | `Silence duration sec` | `Silence duration` | `seconds` |
| `audio.mic_device` | `Mic device` | `Microphone device` | `system default input` |
| `audio.system_audio_device` | `System audio device` | `System audio device` | `ScreenCaptureKit channel` |
| `audio.output_dir` | `Output dir` | `Output directory` | — |
| `transcription.post_recording_mode` | `Post recording mode` | `Post-recording mode` | `stop 后的处理方式` |
| `transcription.final_engine` | `Final engine` | `Final engine` | — |
| `transcription.mlx.model` | `Mlx model` | `MLX model` | — |
| `transcription.realtime.chunk_sec` | `Realtime chunk sec` | `Realtime chunk` | `seconds per chunk` |
| `llm.enabled` | `Enabled` | `Enabled` | — |
| `llm.command` | `Command` | `Command` | `null = 写入 agent-queue.json` |
| `meeting_detection.interval_sec` | `Interval sec` | `Poll interval` | `seconds` |
| `meeting_detection.stable_sec` | `Stable sec` | `Stable window` | `seconds` |
| `meeting_detection.prompt_cooldown_sec` | `Prompt cooldown sec` | `Prompt cooldown` | `seconds` |

Implementation strategy: a single shared label-formatting helper isn't worth the abstraction overhead for ~14 fields. Just hard-code the human labels in the 6 section components.

### 4.13 Playwright e2e updates

Tests touching the IA must be updated to match:

- `e2e/critical.spec.ts` — delete the `/inbox/search` test case; add a `<GlobalSearch>` test (click input → type → assert popover → click result → assert navigation).
- Settings test — visit `/settings`; assert all 6 section h2's are present; assert `/settings/audio` redirects.
- Health test — visit `/health`; assert summary card + Daemons tab + Logs tab; assert old `/health/daemons` redirects.
- Sidebar test — assert no count badges; assert Settings + Health are in the bottom region (use a `data-testid="sidebar-bottom"` selector).

Smoke (manual or scripted) confirms no console errors, ⌘K works, drag-resize works and persists across reload.

## 5. Data Flow

**Theme**: unchanged from current. `ThemeProvider` writes `data-theme="light|dark"` to `<html>`; tokens.css just changes the values that selector resolves to.

**Search**: unchanged at the data layer. Existing `search.query` tRPC procedure (input `{ q, filters, since }`) keeps working. The frontend just stops sending non-keyword filters (filters arg is always `{}` in `<GlobalSearch>`).

**Daemon health**: unchanged. `daemons.health` tRPC + 5s `refetchInterval` is the canonical source. New `useDaemonHealthState` hook is a derived view over that.

**Sidebar counts**: removed entirely. No backend call to drop; the `sidebar` tRPC router and `sidebar-counts` WS channel are simply not subscribed anymore by the Sidebar component. (Keep them on the backend — they may be useful later in Phase J for the merged Recordings inbox.)

**Routing redirects**: handled by `<Navigate replace>` in the React Router config; no server-side redirect needed since this is a SPA. URL hash scroll on mount uses `IntersectionObserver` for the active-section indicator (used by the no-TOC Settings page only if we want a visual marker — but per user feedback we're not adding any inner navigation, so just `scrollIntoView` on first mount suffices).

## 6. Error Handling

- **Logo SVG missing at `/assets/logo.svg`** → render the legacy unicode `语` as a fallback inside `<Logo>`.
- **Lucide icon import fails (e.g. typo)** → TypeScript catches at build time; runtime safety not needed.
- **`useDaemonHealthState` query in error state** → return `"loading"` (defensive — avoid showing a red dot just because the query is in flight).
- **`<GlobalSearch>` search.query fails** → render "Search failed: <message>" inside the popover; do not silently empty the result list.
- **`localStorage` unavailable (privacy mode)** → `usePersistedSize` falls back to in-memory state; sizes don't persist but app still works.
- **Old route hit via bookmark** (e.g. `/settings/audio`) → `<Navigate replace>` swaps to `/settings#audio`; `useEffect` scrolls; no infinite loop.

## 7. Testing Strategy

| Layer | Test |
|---|---|
| Unit (vitest) | `useDaemonHealthState` aggregation logic (4 states × N daemon-statuses fixtures); `usePersistedSize` localStorage interaction; `<ResizableSplit>` drag → commit flow |
| Component (jsdom) | `<Logo>` renders SVG; `<GlobalSearch>` opens on ⌘K, navigates with arrows, closes on Esc; `<HealthPage>` switches tabs on hash change |
| Route redirects | Test that `/settings/audio` ends up at `/settings` with `#audio` in URL and the section is scrolled into view |
| E2E (Playwright, local-only) | Updated critical-flow spec across new IA |

Existing tests that touch the removed/changed surfaces will need migration (about 8 tests across `components/Sidebar.test.tsx`, `routes/inbox/search.test.tsx`, settings sub-page tests, etc.). Estimated 1 task slot.

## 8. Task Breakdown (preview for plan)

14 tasks. Order respects dependencies (tokens before everything; icons + Logo before Sidebar/TopBar; ResizableSplit before MasterDetail integration; etc.):

| # | Task |
|---|---|
| H.1 | `tokens.css` rewrite to canonical Ayu palette (Light + Dark) |
| H.2 | `lucide-react` install + emoji migration (6 files + EmptyState contract) |
| H.3 | `<Logo>` component + sidebar logo slot |
| H.4 | `usePersistedSize` hook + `<ResizableSplit>` component (+ unit tests) |
| H.5 | `useDaemonHealthState` hook (+ unit tests) |
| H.6 | `<Sidebar>` restructure (top groups + bottom Settings/Health + remove counts + remove SETTINGS/HEALTH sections + remove ThemeToggle + wrap in ResizableSplit) |
| H.7 | `<TopBar>` rewrite (breadcrumb via `useMatches`/`handle` + ThemeToggle relocated + GlobalSearch entry) |
| H.8 | `<GlobalSearch>` component + ⌘K hotkey + popover behavior |
| H.9 | Delete `routes/inbox/search.tsx` + its test + sidebar entry + e2e test case |
| H.10 | `routes/settings.tsx` consolidated page + 6 section components + redirects |
| H.11 | `routes/health.tsx` consolidated page + Daemons/Logs tabs + redirects |
| H.12 | `<MasterDetail>` integration with `<ResizableSplit>` |
| H.13 | `FilterChips.css` gap fix + Settings label rewrites (14 fields) |
| H.14 | Real-machine smoke + Playwright e2e migration + PR description update |

## 9. Open Questions

None. All resolved during 4-mockup brainstorming review:

- ✅ Use canonical Ayu palette (#F29718 saffron, not the previous #F2AE49).
- ✅ Search popover has no filter chips — keyword input only.
- ✅ Settings page has no inner TOC — single scrolling column.
- ✅ Sidebar bottom uses Lucide icons + text labels (gear + heart-pulse).
- ✅ Health (not "Help") is the page name; "Help" was a typo.
- ✅ Voicemails + Meetings merge is deferred to Phase J.
- ✅ Audio playback bug + manual triggers are deferred to Phase I.

## 10. Future Phases

This spec deliberately does NOT include the following — they belong in their own specs:

**Phase I — Reader bug fix + manual triggers** (~5 tasks)

- Audio playback regression: switching to another item then back loses the player state / can't restart.
- New tRPC procedures: `voicemails.reprocess` / `meetings.reprocess` (re-run transcription on demand); `voicemails.summarize` / `meetings.summarize` (re-run summary on demand).
- UI: Reader detail pane gets "Re-transcribe" + "Re-generate summary" buttons with running/done/failed state.
- WebSocket progress channel (or polling) for in-flight reprocessing jobs.

**Phase J — Recordings inbox unification** (~5 tasks)

- Backend: introduce a unified `recordings.list` facade (or refactor existing routers behind a common interface). Add `type: "voicemail" | "meeting"` field.
- Frontend: replace `<VoicemailsList>` + `<MeetingsList>` with a single `<RecordingsList>` taking a `?type=` filter; add a "type" badge per row.
- Routing: `/inbox/voicemails` + `/inbox/meetings` → `/inbox?type=voicemail` + `/inbox?type=meeting` (or keep three URLs as aliases of one component); reader at `/inbox/:stem` regardless of type.
- Realtime tab in reader: conditional render based on the recording's type (meetings only).
- inboxWatcher.ts: simplify to one watcher with type tagging at publish time.

Phase J should not start until Phase I is in. Phase I should not start until Phase H is merged (Phase I's UI sits in the Inbox Reader which Phase H may still be polishing).

---
