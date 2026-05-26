# Yulu UI · Phase C — Inbox Pages (Voicemails / Meetings / Search)

> Sub-spec of [`2026-05-26-yulu-frontend-design.md`](2026-05-26-yulu-frontend-design.md). Implements the three pages described in that document's §7.1–§7.3 on top of the Phase B shell (`2026-05-26-yulu-ui-B-frontend-shell-design.md`).

## 1. Goal

Replace the Phase B placeholders for `/inbox/voicemails`, `/inbox/meetings`, and `/inbox/search` with real, production-grade pages. After Phase C the app supports the core daily user flow: browse / play / read voicemails and meeting recordings, jump to any item via full-text search, and have new items appear live without reload.

## 2. Non-goals

- Voicemail / meeting **delete** UI (router exists from Phase A; UI deferred to Phase D or later polish)
- Multi-select + batch operations
- Drag-to-reorder, favoriting, tagging
- In-page transcript search (browser `Cmd+F` is sufficient)
- Audio download button (streaming via `<audio>` is enough)
- Playwright E2E tests (deferred to a single Phase F+ pass once all real pages exist)
- Backend changes outside `voicemails.list` / `meetings.list` (see §6)

## 3. Architecture

Two layout shapes drive three pages:

```
Master-detail (shared)            Single column
├── /inbox/voicemails             /inbox/search
└── /inbox/meetings
```

The master-detail shape lives in a single shared `<MasterDetail>` component (220 px left column, right `<Outlet/>`). Voicemails and Meetings each define a list-item renderer and a reader. Search is a flat column with a TopBar query input — no left list, no right reader.

The Phase A backend is reused unchanged except for one additive tweak: `voicemails.list` and `meetings.list` gain a `firstWords` field so list rows can render a meaningful title without N round-trips. See §6.

## 4. URL Model

```
/inbox/voicemails                       list only ("Select a voicemail" empty pane)
/inbox/voicemails/:stem                 list + reader (default tab = summary if present, else transcript)
/inbox/voicemails/:stem?tab=raw         tab override
/inbox/voicemails/:stem?tab=raw&seek=12.3        also audio seek position (debounced 500 ms)

/inbox/meetings                         same shape; extra tab "realtime" when hasRealtime
/inbox/meetings/:stem

/inbox/search                           empty input, empty results
/inbox/search?q=OKR                     debounced 300 ms after typing settles
/inbox/search?q=OKR&type=voicemail&in=summary&since=7d           full filter state

Cross-page jump (search result click):
/inbox/voicemails/voicemail_20260526_100000?tab=summary&snippet=<encoded>
```

`?snippet=` triggers the reader to scroll the first match into view + apply a 2 s fade highlight after mount.

**Snippet matching is case-insensitive**: the reader strips `[hit]`/`[/hit]` brackets from the URL `?snippet=` value (in case the raw backend snippet leaked through) and does a case-insensitive find of the cleaned text within the active tab's rendered content. First occurrence wins. If not found: no scroll, no highlight (silent — snippet may overlap tab boundaries).

**Audio `?seek=` is a positive float, seconds with 1 decimal** (`12.3`). On reader mount, `<AudioPlayer>` reads the param once and calls `wavesurfer.setTime(parseFloat(seek))` after the `ready` event. On user seek, it fires `onSeek(time)` which the reader debounces (500 ms) and writes via `setSearchParams({ seek: time.toFixed(1) }, { replace: true })` so the browser back stack doesn't fill with seek micro-states.

Selection state lives in route params (idiomatic + bookmarkable + browser back). Query / filter state lives in query params (transient, easily restored). Mixed by deliberate choice; each shape uses the most natural React Router 7 idiom.

## 5. Shared Components

Five new components in `web/src/components/`:

| Component | Responsibility |
|---|---|
| `<MasterDetail listSlot detailSlot listPending>` | 220 px glass-soft list column + right outlet container. When `listPending` is `true` renders 8 inline grey skeleton rows in the list column. Doesn't know what a "voicemail" or "meeting" is. |
| `<AudioPlayer src initialSeek?>` | Wavesurfer.js v7 wrapper. Renders waveform + play/pause + time read-out. Disposes wavesurfer instance on unmount. Emits a debounced `onSeek(time)` callback so callers can persist seek to URL. |
| `<FilterChips chips activeIds onChange>` | Multi-select chip group. Each chip toggles independently (AND across, OR within an exclusive group when `group` field is set). One special chip "All" deselects all others. |
| `<TranscriptView text>` | Renders plain text with two automatic decorations: (a) glossary terms wrapped in `<span class="vocab">` using a regex built from `trpc.glossary.list()` (`\b(t1|t2|...)\b` case-insensitive, longest-first); (b) speaker labels matching `^Speaker [A-Z]:` wrapped in `<span class="speaker">`. Falls back to plain text if glossary query fails. |
| `<EmptyState icon label cta?>` | Centered icon + label + optional CTA button. Used by every page for the "nothing here" state. |

A sixth abstraction — `<SkeletonRow>` — is **not** extracted; the four grey divs that approximate a list row live inline inside `<MasterDetail>` (single use, simpler to read in place).

## 6. Backend Tweak (one shot, additive)

`yulu/scripts/yulu_ui/src/routers/voicemails.ts` — `list` procedure return rows gain:

```ts
firstWords: string | null   // first 80 chars of <stem>.transcript.txt, trimmed, "…" if longer
```

`yulu/scripts/yulu_ui/src/routers/meetings.ts` — `list` procedure return rows gain:

```ts
firstWords: string | null
attendeeCount?: number      // parsed from filename if extractable; always undefined for v1 (spec defers filename encoding)
```

Reading the transcript per call is acceptable: `voicemails.list` already iterates the dir and does a couple of `existsSync` per file. Adding one `readFileSync` for files whose `hasTranscript === true` is similar cost. If list is large (>500), we'll add an LRU keyed on `(path, mtime)` later — out of scope for C.

No new tRPC routers. No changes to other Phase A files.

## 7. Data Flow

### 7.1 Voicemails / Meetings list

```ts
const { data, isPending } = trpc.voicemails.list.useQuery({});
useWsChannel('sidebar-counts', () => qc.invalidateQueries({ queryKey: [['voicemails','list']] }));
```

Same shape for Meetings. List query cached 30 s. WS event from `sidebar-counts` (already published by router mutations in Phase A; will also be published by status_agent / agent_queue when new items land — see "Out-of-band: §11") triggers invalidate.

### 7.2 Voicemails / Meetings reader

```ts
const { data } = trpc.voicemails.get.useQuery({ stem }, { staleTime: 60_000 });
```

`stem` from route param. Query keyed on stem so navigating between voicemails refetches per item. Tab state in URL via `useSearchParams`; default = `summary` if `data.summary` present else `transcript`.

### 7.3 Search

URL → backend mapping (all params lowercase, URL-decoded):

| URL param | Values | Backend mapping |
|---|---|---|
| `q` | free text | `query` (after debounce + min length 2) |
| `type` | `voicemail` \| `meeting` | half of backend's `kinds` (combine with `in`) |
| `in` | `summary` \| `transcript` | other half — combined as `kinds: ["${type}_${in}"]` (e.g. `voicemail_summary`) |
| `since` | `7d` \| `30d` \| `90d` | `since` (string passed through) |

Both `type` and `in` must be set together to filter — setting one only is the same as setting neither (avoids accidental zero-result states).

```ts
const [params] = useSearchParams();
const q = params.get('q') ?? '';
const debouncedQ = useDebounced(q, 300);
const type = params.get('type');
const inLayer = params.get('in');
const kinds = (type && inLayer) ? [`${type}_${inLayer}`] as const : undefined;
const { data } = trpc.search.run.useQuery(
  { query: debouncedQ, kinds, since: params.get('since') ?? undefined },
  { enabled: debouncedQ.length >= 2 }
);
```

`useDebounced` is a ~6-line custom hook: `useState` + `useEffect` with `setTimeout(setDebounced, delay)` and cleanup. Search fires only when query has ≥2 chars to avoid noise.

### 7.4 Audio

`<audio>` / wavesurfer source: `/files/voicemails/<stem>.wav` (or `/files/meetings/...`). Phase A's `streamAudio` handler honors Range. Wavesurfer v7 uses MediaElement backend by default, which lets the browser handle Range. No client work needed.

## 8. Keyboard Shortcuts

Global listener registered once at the `<InboxLayout>` level (a layout route wrapping all three Inbox pages). Behavior depends on current route + focused element:

| Key | Voicemails / Meetings list | Voicemails / Meetings reader | Search page |
|---|---|---|---|
| `j` | next stem (navigate to next list item) | next stem | next result row |
| `k` | prev stem | prev stem | prev result row |
| `space` | (no-op if no selection) | play / pause audio | (no-op) |
| `[` | (no-op) | previous tab | (no-op) |
| `]` | (no-op) | next tab | (no-op) |
| `/` | focus search nav? (no — already a route) | (no-op) | focus query input |

Implemented via a small `useHotkeys(map)` hook (~25 lines, no library). The hook attaches a window keydown listener that ignores events whose `target` is an `<input>` / `<textarea>` / `[contenteditable]` (so typing in search input doesn't trigger `/`).

## 9. Empty States

| State | Copy |
|---|---|
| No voicemails | "No voicemails yet. Hit ⌘⇧V to record one." (CTA: link to /settings/hotkey) |
| No meetings | "No meetings recorded. The audio daemon captures them automatically when it detects a long-form session." |
| No selection in master-detail | "Select an item to view." |
| No transcript on selected item | "Transcription pending…" (if recording is < 5 min old) or "No transcript available." |
| Search with <2 char query | (no message — neutral empty state) |
| Search with results = [] | "No matches for '<q>'. Try a different query or broaden filters." |

## 10. Loading States

`<MasterDetail>` accepts `listPending`. When true, the list column renders 8 inline skeleton rows (grey divs sized to match a real row, no animation — too noisy at 8 stacked). Reader pane shows nothing extra (the master-detail container's outlet renders normally; the reader inside handles its own pending state with a small `<EmptyState>` "Loading…" if the underlying `get` query is pending).

## 11. Out-of-band concerns

The WS channel `sidebar-counts` is published in Phase A only by router mutations (`voicemails.delete`, `meetings.delete`). For the "new voicemail appears live without reload" behavior, status_agent (Python) and agent_queue (Python) need to also publish to `sidebar-counts` when they finish writing a new file. Two options:

(a) **Add publisher in C** — extend the Python daemons to send a JSON message over an existing socket (or write a sentinel file the UI server watches). This is real work and adds Python touches to a frontend phase.

(b) **Server-side filesystem watch** — Phase A server adds a `chokidar`-style watcher on `paths.voicemailsDir` and `paths.moviesDir`, and on file create publishes `sidebar-counts`. Pure server change, no Python touch.

**Decision for Phase C:** (b). Spec C requires the server to add a single file watcher module (`src/inboxWatcher.ts` — ~40 lines) that emits `sidebar-counts` events on create/delete of `*.wav`, `*.transcript.txt`, `*.summary.md`. This becomes part of Phase C's backend tweak (one new file, no new router).

## 12. File Structure

```
yulu/scripts/yulu_ui/
├── src/
│   ├── routers/
│   │   ├── voicemails.ts          MOD — list returns firstWords
│   │   └── meetings.ts            MOD — list returns firstWords (+ attendeeCount stub)
│   ├── inboxWatcher.ts            NEW — fs.watch + publish sidebar-counts on file change
│   └── server.ts                  MOD — wire inboxWatcher.start() at startup
├── web/src/
│   ├── components/
│   │   ├── MasterDetail.{tsx,css}        NEW
│   │   ├── AudioPlayer.{tsx,css}         NEW
│   │   ├── FilterChips.{tsx,css}         NEW
│   │   ├── TranscriptView.{tsx,css}      NEW
│   │   └── EmptyState.{tsx,css}          NEW
│   ├── hooks/
│   │   ├── useHotkeys.ts                 NEW
│   │   └── useDebounced.ts               NEW
│   └── routes/
│       ├── inbox/_layout.tsx             NEW (registers useHotkeys map for the whole /inbox/* subtree)
│       ├── inbox/voicemails.tsx          MOD — full list view + filters
│       ├── inbox/voicemails.$stem.tsx    NEW — reader as nested route
│       ├── inbox/meetings.tsx            MOD — full list view + filters
│       ├── inbox/meetings.$stem.tsx      NEW — reader as nested route
│       └── inbox/search.tsx              MOD — full search page
└── tests/web/
    ├── MasterDetail.test.tsx       NEW
    ├── AudioPlayer.test.tsx        NEW
    ├── FilterChips.test.tsx        NEW
    ├── TranscriptView.test.tsx     NEW
    ├── EmptyState.test.tsx         NEW
    ├── useHotkeys.test.ts          NEW
    ├── useDebounced.test.ts        NEW
    ├── voicemails.list.test.tsx    NEW (page integration)
    ├── voicemails.reader.test.tsx  NEW
    ├── meetings.list.test.tsx      NEW
    ├── meetings.reader.test.tsx    NEW
    ├── search.test.tsx             NEW
    └── inboxWatcher.test.ts        NEW (server-side, runs in node project)
```

The `voicemails.$stem.tsx` filename uses the `$param` convention (consistent with React Router 7 file-based router conventions, even though we're using `createBrowserRouter` config-based — the filename signals route param shape for human readers).

## 13. Acceptance Criteria

Phase C is shippable when:

1. **List + reader for voicemails**: opening `/inbox/voicemails` shows N rows from `voicemails.list` with each row showing `firstWords` (or the stem if no transcript) + duration in seconds + `MM-DD HH:MM` recorded time + `✓` mark when summary exists. Clicking a row navigates to `/inbox/voicemails/:stem` and renders title + meta + `<AudioPlayer>` + tabs (transcript/summary/raw). Audio plays. Tabs switchable. URL `?tab=X` persists across reload.
2. **List + reader for meetings**: identical, with extra `realtime` tab visible when data has `realtime` content.
3. **Search**: typing 2+ chars in `/inbox/search?q=` fires `search.run` after 300 ms debounce; results render with `[hit]…[/hit]` segments colored `--accent`. Clicking a result navigates to the source page with the matching tab pre-selected.
4. **Snippet auto-scroll**: arriving at a reader via `?snippet=X` scrolls the first match into view + flashes a 2 s `--accent` background highlight.
5. **Vocab highlight**: glossary terms in transcripts render in `--purple`. (If glossary DB missing, plain text renders without error.)
6. **Keyboard**: `j`/`k` navigate selection; `space` toggles audio play; `[`/`]` switch tabs; `/` focuses search input on search page. Keys ignored when focus is inside `<input>`/`<textarea>`.
7. **Live refresh**: dropping a new file into `~/Movies/Yulu/voicemails/` (manually for the smoke test) causes the list to refresh within ~1 s without page reload (driven by `inboxWatcher` → `sidebar-counts` WS → list invalidate).
8. **Filters wired**: Voicemails TopBar shows `All | Summarized | Last 7d` chips; clicking each filters the list (server already supports `since` filter; `Summarized` filter is client-side on `hasSummary`). Meetings shows `All | Summarized | Last 30d | Has realtime`. Search shows `Type` + `In` dropdowns + `Since` chip group, all wired into URL + query as per §7.3.
9. **All previous tests pass + new tests pass + typecheck clean.** Real-machine smoke (dev + prod modes + browser navigation through all three pages, audio playback, search→reader jump, vocab highlight visible if glossary populated) shows no console errors.

## 14. What's deferred to later phases

| Phase | Scope |
|---|---|
| D | Settings pages (Audio / Transcription / LLM / Hotkey / Integrations / Storage) — inline-edit + restart banner |
| E | Knowledge (Prompts master-detail reuses `<MasterDetail>` from C; Glossary inline table) |
| F | Health (Daemons grid + Logs tail via `useWsChannel('logs')`); Playwright E2E sweep after all real pages exist |
| G | setup.sh integration, yulu doctor entry, release packaging |
