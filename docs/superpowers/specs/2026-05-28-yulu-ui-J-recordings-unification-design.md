# Phase J — Recordings Inbox Unification + StatusAgent Menu Sync

**Date:** 2026-05-28
**Status:** Approved (brainstormed via 2-mockup visual companion review)
**Scope:** Collapse the separate Voicemails + Meetings inboxes into one unified "Recordings" inbox across the web UI (backend router, list, reader, routing, sidebar), and sync the macOS StatusAgent menu bar to match. Pure presentation/IA + naming layer — no audio-pipeline changes.

---

## 1. Background

Phases A–I built the Yulu web UI with Voicemails and Meetings as two parallel inboxes — two sidebar entries, two tRPC routers, two list components, two reader components, two route trees. The user determined they're conceptually one thing ("recordings") and should be unified.

Real difference between the two is small: voicemails are short hotkey-captured memos (`voicemail_YYYYMMDD_HHMMSS.wav` in `~/Movies/Yulu/voicemails/`), meetings are calendar-detected/long recordings (`<title>_YYYYMMDD_HHMMSS.wav` in `~/Movies/Yulu/`) with an extra realtime-transcript artifact. Both have transcript + summary + audio. Phase J merges the browsing experience while keeping a subtle type badge + filter so source info isn't lost.

The macOS StatusAgent.app (menu-bar voicemail recorder) gets a parallel naming refresh so it doesn't drift from the web UI's new "recordings" vocabulary.

## 2. Goals & Non-Goals

**Goals**

- New backend `recordings` tRPC router: `list` (merges both directories, tags each row with `type`), `get` / `transcribe` / `summarize` / `audioUrl` / `delete` (dispatch by stem pattern).
- **Delete** the `voicemails` + `meetings` routers entirely (and their tests) — no dead code, no deep-link-compat backend layer. Redirects happen at the React Router layer.
- New `<RecordingsList>` component: one list, recency-sorted, per-row type badge (blue Voicemail / purple Meeting), filter chips (All / Voicemail / Meeting).
- New `<RecordingReader>` component merging VoicemailReader + MeetingReader; Realtime tab renders only when the recording has a realtime artifact (artifact-driven, not type-driven).
- Routing: `/inbox` (list) + `/inbox/:stem` (reader). Old `/inbox/voicemails(/:stem)` + `/inbox/meetings(/:stem)` → `<Navigate replace>` to the new URLs.
- Sidebar: single "Recordings" entry (Mic icon) replacing Voicemails + Meetings. Add Lucide icons to the remaining top-nav items for consistency: Prompts (FileText), Glossary (BookOpen).
- GlobalSearch cross-nav: result clicks navigate to `/inbox/:stem` (was `/inbox/voicemails/:stem` etc.).
- `inboxWatcher.ts`: replace the now-orphaned `sidebar-counts` channel (sidebar counts were removed in Phase H) with a `recordings-changed` channel that RecordingsList subscribes to for live refresh.
- StatusAgent.app (`status_agent.swift`): "Start Voicemail" → "Start Recording"; "Recent voicemails" → "Recent recordings" (reads BOTH `voicemailsDir` + `moviesDir` directly off disk); "Open inbox in Terminal" → "Open inbox" opening `http://127.0.0.1:7777/inbox`.
- Add `status_agent.swift` to the CI Swift-build step (currently not compiled in CI).
- All work lands in the existing PR #24.

**Non-Goals**

- **Voicemail realtime transcription + settings toggle** — **Phase K** (separate; touches the Python audio pipeline `voicemail/recorder.py` + config + Settings UI; higher risk, different test strategy).
- **Moving files between directories** — storage layout is unchanged. `voicemail_*` files stay in `voicemailsDir`, meeting files stay in `moviesDir`. Unification happens in the read layer.
- **Renaming the on-disk `voicemail_*` prefix** — kept; it's the dispatch key.
- **StatusAgent capture semantics** — the ⌘⇧V hotkey still records a `voicemail_*` memo. Only menu labels + the recents data source + the inbox link change.
- **Removing the `/files/voicemails/*` + `/files/meetings/*` static routes** — both stay; `recordings.audioUrl` returns the correct one by type.

## 3. Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│ Phase J surface map                                                  │
├──────────────────────────────────────────────────────────────────────┤
│ backend (TS)              frontend (TS)            StatusAgent (Swift)│
│ ─────────────             ─────────────            ──────────────────│
│ recordings.ts (NEW)       RecordingsList (NEW)     status_agent.swift │
│  - list merges dirs        - type badge + filter    - menu labels     │
│  - dispatch by stem        - WS live refresh        - read both dirs  │
│                           RecordingReader (NEW)     - open web inbox   │
│ DELETE voicemails.ts        - merge VM+MTG readers                     │
│ DELETE meetings.ts          - realtime tab if                         │
│ _app.ts: mount recordings     artifact exists      ci.yml: +swift     │
│                           Sidebar: 1 entry + icons   build status_agent│
│ inboxWatcher.ts                                                       │
│  sidebar-counts →         App.tsx routing:                            │
│  recordings-changed        /inbox + /inbox/:stem                      │
│ pubsub.ts: channel swap    + 4 redirects                              │
│                           GlobalSearch cross-nav → /inbox/:stem       │
└──────────────────────────────────────────────────────────────────────┘
```

## 4. Components

### 4.1 `recordings` router (backend)

New `yulu/scripts/yulu_ui/src/routers/recordings.ts`. A `dispatchType(stem)` helper returns `"voicemail"` for stems matching `^voicemail_\d{8}_\d{6}$`, else `"meeting"`. Each procedure uses it to pick the directory + behavior.

- **`list({ limit?, since?, type? })`** — reads `voicemailsDir` (voicemail files) + `moviesDir` (meeting files, excluding `voicemail_*`), produces a unified row array sorted by `mtimeMs` desc. Optional `type` filter (`"voicemail" | "meeting"`). Row shape:

  ```ts
  {
    stem: string;
    type: "voicemail" | "meeting";
    title: string | null;          // meeting title, or null for voicemails
    recordedAt: string;            // ISO timestamp parsed from stem
    wavPath: string;
    sizeBytes: number;
    mtimeMs: number;
    hasTranscript: boolean;
    hasSummary: boolean;
    hasRealtime: boolean;          // only meetings will have this true
    firstWords: string | null;
    status: "idle" | "transcribing" | "summarizing" | "failed";  // from JobRegistry (Phase I)
    statusError?: string;
  }
  ```

- **`get({ stem })`** — dispatch by type. Returns `{ stem, type, title, recordedAt, wavPath, sizeBytes, mtimeMs, transcript, summary, realtime, status, statusError }`. `realtime` is the realtime-transcript text (meetings only; `null` otherwise).
- **`transcribe({ stem })` / `summarize({ stem })`** — dispatch by type, reuse Phase I's `runTranscribe` / `runSummarize` from `jobRunner.ts`. Same NOT_FOUND / PRECONDITION_FAILED / CONFLICT guards.
- **`audioUrl({ stem })`** — returns `/files/voicemails/${stem}.wav` for voicemails, `/files/meetings/${stem}.wav` for meetings.
- **`delete({ stem })`** — dispatch by type, remove the WAV + sidecars; publish `recordings-changed`.

The dir-reading + stem-parsing logic is lifted from the old voicemails/meetings routers into shared helpers in `recordings.ts` (so we delete the old routers without losing logic).

`_app.ts`: remove `voicemails` + `meetings` router mounts, add `recordings`.

### 4.2 Delete voicemails + meetings routers

Remove `src/routers/voicemails.ts`, `src/routers/meetings.ts`, and their test files. Update `_app.ts`. Search the whole `src/` + `web/src/` tree for any remaining `trpc.voicemails.*` / `trpc.meetings.*` references and migrate them to `trpc.recordings.*` (the readers + list components are rewritten in §4.4–4.5 anyway, so the only stragglers should be already-handled).

### 4.3 `inboxWatcher.ts` + pubsub channel swap

`pubsub.ts`: remove the `sidebar-counts` channel (no subscriber since Phase H removed counts), add:

```ts
"recordings-changed": { reason: "added" | "removed" | "changed" };
```

`inboxWatcher.ts`: keep watching both directories; on any change, publish `recordings-changed` instead of `sidebar-counts`. The `recordings.delete` mutation also publishes it.

`<RecordingsList>` subscribes via `useWsChannel("recordings-changed", …)` and invalidates `recordings.list` — so a newly-finished recording (or a deletion) refreshes the list live.

### 4.4 `<RecordingsList>` (frontend)

New `web/src/routes/inbox/recordings.tsx` (the `/inbox` list route). Reuses `<MasterDetail>` + `<FilterChips>`. Per the H.12 pattern, the master list is resizable (`storageKey="yulu_ui.inbox.recordings.width"`).

- Query `trpc.recordings.list.useQuery({ type })` where `type` comes from the active filter chip.
- Filter chips: `All` / `Voicemail` / `Meeting` (drives the `type` arg; `All` omits it).
- Each row: type badge (blue `Voicemail` via `--blue`, purple `Meeting` via `--purple` — matching GlobalSearch kind colors), title-or-stem, firstWords (2-line clamp), meta (duration · timestamp), and a `transcribing…` / `summarizing…` chip when `row.status !== "idle"`.
- WS subscription to `recordings-changed` → invalidate the list query.
- `data-testid="recording-row"` on each row for e2e.

### 4.5 `<RecordingReader>` (frontend)

New `web/src/routes/inbox/recordings.$stem.tsx` (the `/inbox/:stem` reader route). Merges the logic of the two existing readers. Tabs: `Summary` / `Transcript` / `Realtime` / `Raw`, where **Realtime only renders when `data.hasRealtime` is true** (artifact-driven). Default tab: `summary` if present else `transcript`.

- Query `trpc.recordings.get.useQuery({ stem })`.
- `<AudioPlayer>` (Phase I fix already in), `<TranscriptView>`, snippet auto-scroll (carried over from the existing readers).
- 2× `<ReprocessButton>` (Phase I) wired to `trpc.recordings.transcribe` / `.summarize`, with the `jobs` WS subscription for live status.
- Type badge in the header.
- `handle.breadcrumb = (params) => params.stem ?? "Recording"`.

The two old reader files (`voicemails.$stem.tsx`, `meetings.$stem.tsx`) and the two list files (`voicemails.tsx` + index, `meetings.tsx` + index) and `_layout.tsx`'s voicemail/meeting-specific bits are removed/superseded.

### 4.6 Routing + Sidebar

`App.tsx`:
- `/inbox` → `<RecordingsList>` (replaces the redirect-to-voicemails index).
- `/inbox/:stem` → `<RecordingReader>`.
- Redirects: `/inbox/voicemails` → `/inbox`; `/inbox/voicemails/:stem` → `/inbox/:stem`; `/inbox/meetings` → `/inbox`; `/inbox/meetings/:stem` → `/inbox/:stem`. Implemented via `<Navigate>` wrappers that preserve the `:stem` param + query string (`?seek`, `?snippet`).
- The `inbox/_layout.tsx` keeps `handle.breadcrumb = "Inbox"` — but since there's now a single Recordings page, the breadcrumb reads "Inbox / Recordings" (or just "Recordings" — decide in plan based on whether we keep the layout wrapper).

`Sidebar.tsx`: INBOX section becomes a single item — `{ to: "/inbox", label: "Recordings", icon: <Mic /> }`. Add icons to Knowledge items: Prompts `<FileText />`, Glossary `<BookOpen />`. All top-nav items now carry a Lucide icon (size 15, strokeWidth 1.8) consistent with the bottom Settings/Health icons.

### 4.7 StatusAgent.app (Swift)

`yulu/scripts/status_agent.swift`:
- Menu item "Start Voicemail" label → "Start Recording" (action unchanged; still spawns `voicemail.cli new`).
- "Recent voicemails" label → "Recent recordings". The `loadRecentVoicemails` Swift helper is rewritten (or a new `loadRecentRecordings`) to enumerate **both** `~/Movies/Yulu/voicemails/*.wav` and `~/Movies/Yulu/*.wav` (excluding `voicemail_*` from the latter), merge, sort by mtime desc, take top 5, each tagged VM/MTG. **Direct directory read — no dependency on the web server being up.**
- "Open inbox in Terminal" → "Open inbox", action opens `http://127.0.0.1:7777/inbox` via `NSWorkspace.shared.open(URL(string:)!)`.
- Rebuild via `build_status_agent.sh`.

`.github/workflows/ci.yml`: add `status_agent.swift` to the Swift-build loop (alongside audio_daemon, window_scanner, recorder_status) so it at least compiles in CI.

## 5. Data Flow

```
List load:
 /inbox → RecordingsList → trpc.recordings.list({ type })
   → reads voicemailsDir + moviesDir, tags type, merges, sorts
   → rows with status from JobRegistry
 inboxWatcher detects new file → publishes recordings-changed
   → RecordingsList invalidates list query → live refresh

Reader load:
 /inbox/:stem → RecordingReader → trpc.recordings.get({ stem })
   → dispatchType(stem) picks dir → reads transcript/summary/realtime
   → Realtime tab shown iff hasRealtime

Old URL hit:
 /inbox/voicemails/voicemail_X → <Navigate replace to=/inbox/voicemail_X>
 /inbox/meetings/TeamSync_X    → <Navigate replace to=/inbox/TeamSync_X>

StatusAgent menu open:
 menuWillOpen → loadRecentRecordings() reads both dirs off disk
   → 5 most-recent, VM/MTG tagged
 "Open inbox" → NSWorkspace opens http://127.0.0.1:7777/inbox
```

## 6. Error Handling

- **Stem matches neither pattern** — `dispatchType` defaults to `"meeting"` (moviesDir); `get` throws NOT_FOUND if the file isn't there. Harmless.
- **Old `/inbox/voicemails/:stem` for a deleted recording** — redirect to `/inbox/:stem`, reader shows its own not-found empty state.
- **`recordings.list` when a directory is missing** — each dir read is guarded by `existsSync`; missing dir contributes zero rows.
- **StatusAgent reads dirs while a recording is mid-write** — partial file shows up with a small size; harmless (it's just a recents label).
- **StatusAgent opens web inbox while yulu_ui is down** — `NSWorkspace.open` still launches the browser; the browser shows a connection error. Acceptable; the menu's primary capture function doesn't depend on the web UI.
- **GlobalSearch result for a stem whose type changed** — cross-nav goes to `/inbox/:stem`; the reader dispatches correctly regardless.

## 7. Testing Strategy

| Layer | Test |
|---|---|
| Backend unit | `recordings` router: list merges both dirs + type tag; `dispatchType` voicemail-vs-meeting; get/transcribe/summarize dispatch + guards; status field from JobRegistry |
| Backend cleanup | Confirm `voicemails`/`meetings` routers gone, `_app.ts` only mounts recordings, no dangling imports (typecheck) |
| Frontend unit | `<RecordingsList>`: renders rows + type badges, filter chips drive `type` arg, recordings-changed invalidates; `<RecordingReader>`: realtime tab only when hasRealtime |
| Routing | `/inbox/voicemails/X` redirects to `/inbox/X` preserving query; `/inbox/meetings` → `/inbox` |
| E2E (Playwright) | `/inbox` list renders with type badges; clicking a row opens reader; old URL redirects; filter chips work |
| Swift | CI compiles `status_agent.swift`; menu behavior verified by **manual real-machine smoke** (rebuild + click menu) |
| Real machine | Unified inbox loads with mixed voicemails+meetings; StatusAgent menu shows "Recent recordings" with both types; "Open inbox" launches browser at /inbox |

## 8. Open Questions

None. Resolved during brainstorming:

- ✅ Unified name: **Recordings**.
- ✅ Keep a subtle type badge + filter chips (All / Voicemail / Meeting) — not a full flatten.
- ✅ Routing: `/inbox` + `/inbox/:stem` with old URLs redirecting.
- ✅ StatusAgent reads directories directly (no web-server dependency).
- ✅ voicemails + meetings routers deleted cleanly (no backend compat layer).
- ✅ All in PR #24 (no separate StatusAgent PR).
- ✅ Sidebar icons: Recordings = Mic, Prompts = FileText, Glossary = BookOpen.
- ✅ Voicemail realtime transcription deferred to **Phase K**.

## 9. Task Breakdown (preview for plan)

7 tasks. TDD where applicable.

| # | Task |
|---|---|
| J.1 | Backend: `recordings` router (list merge + type tag + dispatch get/transcribe/summarize/audioUrl/delete) + tests; mount in `_app.ts` |
| J.2 | Backend: delete `voicemails` + `meetings` routers + tests; `pubsub` sidebar-counts → recordings-changed; `inboxWatcher` rewire |
| J.3 | `<RecordingsList>` route component (type badge + filter chips + MasterDetail resizable + recordings-changed WS refresh) |
| J.4 | `<RecordingReader>` route component (merged reader, realtime-tab artifact-driven, ReprocessButtons → recordings.*) |
| J.5 | Routing convergence (`/inbox` + `/inbox/:stem` + 4 redirects), Sidebar single Recordings entry + Prompts/Glossary icons, GlobalSearch cross-nav → `/inbox/:stem`; delete old reader/list/index files |
| J.6 | StatusAgent Swift (menu labels + read both dirs + open web inbox) + `ci.yml` add status_agent.swift to Swift build |
| J.7 | E2E migration (/inbox list + reader + redirects + filter) + real-machine smoke (web + StatusAgent rebuild) + push + PR → A–J |

## 10. Future Phases

- **Phase K — Voicemail realtime transcription + settings toggle** (~5 tasks):
  - `voicemail/recorder.py`: honor `realtime_enabled()` — start/stop `realtime_transcribe.py` around recording; fall back to current post-stop whole-file transcribe when disabled.
  - Config: add `transcription.realtime_enabled: true` (default on); `record_audio.realtime_enabled()` already reads this key.
  - `setup.sh`: include the flag in the default config template.
  - Settings UI: a toggle row in the Transcription section.
  - Tests: pytest for the recorder branch; vitest for the settings toggle.

Phase K should not start until Phase J is merged (its settings row sits in the Settings page; its recorder change is independent but logically follows the unification).

---
