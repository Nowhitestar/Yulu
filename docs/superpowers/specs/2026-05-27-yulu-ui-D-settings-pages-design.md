# Yulu UI · Phase D — Settings Pages

> Sub-spec of [`2026-05-26-yulu-frontend-design.md`](2026-05-26-yulu-frontend-design.md). Implements the six Settings pages described in that document's §7.6–§7.11 + the §11 config-restart map on top of the Phase B shell and Phase A backend.

## 1. Goal

Replace the Phase B placeholders for `/settings/{audio,transcription,llm,hotkey,integrations,storage}` with real, fully-interactive pages. After Phase D the user can tune every knob in `~/.config/yulu/config.json` from the browser, see exactly which daemons need to restart for a change to take effect, and trigger those restarts with one click.

## 2. Non-goals

- Adding new calendar providers (spec covers `feishu` / `google`; new providers require a `config.json` edit by hand for now)
- Visualizing SIGHUP-only changes — they apply automatically (Phase A's routers send `kill -HUP` on the relevant mutations). The UI only surfaces *restart-required* changes.
- Hotkey conflict detection (user is responsible for picking non-conflicting combos)
- Per-row revert button (banner clears when the user reverts to original)
- Field-level validation beyond the existing zod schemas in `ConfigManager`
- Playwright E2E (single pass after Phase F)
- Backend changes outside the new procedures listed in §6

## 3. Architecture

Two layers:

**Backend**: 5 new procedures on the existing `system` router + 2 new routers (`integrations`, `llm`). All read-only except `integrations.test`, `llm.test`, `system.pickFile`, `system.openInFinder`. Adds no new tables or files.

**Frontend**: One shared `<InlineEditRow>` covers 90% of the surface area across all six pages (six variants: text / number / select / toggle / path / readonly). A `<RestartBanner>` aggregates `daemonsNeedingRestart` returned by `config.update` mutations across all rows on the active page and offers a single "Restart now" action. Special editors (`<HotkeyCapture>`, `<CommandEditor>`, `<TestPopover>`, `<DbStatsRow>`) handle the cases where inline-edit doesn't fit.

No new routes — the six Settings paths exist from Phase B as placeholders and get their bodies replaced.

## 4. Technology Decisions

- **File pickers**: native macOS dialogs via `osascript` (`choose file`, `choose folder`), invoked by a new `system.pickFile` tRPC procedure. Returns the absolute POSIX path. Browser `<input type="file">` is useless here because it only exposes file contents, not the host path. The osascript dialog appears as the user's frontmost app.
- **Drag-to-reorder** for the LLM `Command` array: HTML5 native drag-and-drop API. No library — the spec calls for ~5 items max, so a 30-line implementation beats a dependency.
- **Test popover for `integrations.test` and `llm.test`**: rendered inline below the trigger button, glass-styled, dismisses on outside-click. Reuses Phase B's `--glass` tokens. No portal needed (popover sits in normal flow).
- **Restart tracker state**: per-page `useReducer` keyed by config dotted-key path. On every `config.update.mutate(...)` success, the reducer ingests `daemonsNeedingRestart` from the response and the key from the call args. Banner reads aggregated `Map<daemonName, Set<keyPath>>`. Click "Restart now" → call `daemons.restart` for each unique daemon, then clear the tracker.

## 5. New Backend Procedures

### 5.1 `system.pickFile({ mode, filter? })`

```ts
input:  { mode: "file" | "folder"; filter?: "wav" | "bin" | "json" | "pem" }
output: { path: string | null }  // null = user cancelled
```

Implementation: spawns `osascript -e '<applescript>'`. For folder: `POSIX path of (choose folder with prompt "Choose a folder")`. For file: `POSIX path of (choose file with prompt "Choose a file" of type {"wav"})`. The `filter` arg maps to the `of type` clause.

The dialog runs synchronously in the spawned process; the procedure returns when the user picks or cancels. Cancel → null. macOS-only (Phase A is macOS-only); Linux/Windows would need a different implementation later.

### 5.2 `system.openInFinder({ path, reveal? })`

```ts
input:  { path: string; reveal?: boolean }   // reveal=true → -R
output: { ok: true }
```

Spawns `open <path>` or `open -R <path>` (reveal selects the file in Finder). No path traversal guard needed — local app, user-driven.

### 5.3 `system.audioDevices()`

```ts
output: { input: AudioDevice[]; output: AudioDevice[] }
type AudioDevice = { uid: string; name: string }
```

Spawns `system_profiler SPAudioDataType -json`, parses, returns input + output device lists. Caches for 60 s (devices rarely change). Empty arrays on parse failure (don't crash the Settings page).

### 5.4 `system.dbStats()`

```ts
output: Array<{ name: "prompts" | "vocab" | "search"; path: string; size: number; rows: number | null }>
```

For each of `~/.config/yulu/{prompts,vocab,search}.sqlite`: `fs.stat` for size, open with `better-sqlite3`, run `SELECT COUNT(*) FROM <main_table>` (main_table = `prompts` / `vocab` / `docs` respectively). On missing or unreadable DB: `{ size: 0, rows: null }` (don't throw). 1 s cache.

### 5.5 `system.logPaths()`

```ts
output: Array<{ name: string; path: string }>
```

Returns the 8 daemon log paths from `paths.configDir`: `audiodaemon.log`, `sttdaemon.log`, `agentqueue.log`, `statusagent.log`, `scheduler.log`, `detector.log`, `calendar.log`, `ui.log`. No size/rows — that's for the Storage page's DB rows.

### 5.6 `integrations.test({ provider })`

```ts
input:  { provider: "feishu" | "google" }
output: { ok: boolean; stdout: string; stderr: string }
```

New router `src/routers/integrations.ts`. Spawns `python3 -m yulu.calendar.detect --provider <provider> --json`, captures stdout + stderr + exit code. Returns `ok=true` when exit 0, else `false`. 10-second timeout — kill if exceeded.

If the user's Python module isn't installed: stderr will say so; `ok=false`. The UI shows the stderr in the popover. No special-casing.

### 5.7 `llm.test()`

```ts
output: { ok: boolean; stdout: string; stderr: string }
```

New router `src/routers/llm.ts`. Reads `config.llm.command` (e.g., `["claude", "--print"]`), spawns it with stdin `"hello, world\n"`, captures stdout + stderr. 30-second timeout.

If `config.llm.enabled === false` → return `{ ok: false, stdout: "", stderr: "llm.enabled is false in config" }` without spawning.

### 5.8 Router registration

`src/routers/_app.ts` adds `integrations` and `llm` to the merged AppRouter:

```ts
export const appRouter = router({
  // ...existing
  integrations: integrationsRouter,
  llm: llmRouter,
});
```

## 6. Frontend Components

All in `web/src/components/` unless noted.

### 6.1 `<SettingsPage>`

```tsx
<SettingsPage banner={<RestartBanner ... /> | null}>
  <InlineEditRow ... />
  <InlineEditRow ... />
  ...
</SettingsPage>
```

Renders the optional banner stuck to the top of the body, then `children` in a vertical list with token-spaced gaps. Pure layout; no state.

### 6.2 `<InlineEditRow>`

Six variants distinguished by the `type` prop:

```tsx
type RowProps = { label: string; help?: string; status?: RowStatus } & (
  | { type: "text"; value: string; onCommit: (v: string) => void }
  | { type: "number"; value: number; min?: number; max?: number; step?: number; onCommit: (v: number) => void }
  | { type: "select"; value: string; options: Array<{ value: string; label: string }>; onCommit: (v: string) => void }
  | { type: "toggle"; value: boolean; onCommit: (v: boolean) => void }
  | { type: "path"; value: string; mode: "file" | "folder"; filter?: string; onCommit: (v: string) => void }
  | { type: "readonly"; value: string; revealInFinder?: boolean }
);
type RowStatus = "saved" | "restart" | "typing" | null;
```

Behavior:
- `text` / `number` / `select`: click value → swap to `<input>` / `<select>`; blur or Enter commits via `onCommit(parsedValue)`.
- `toggle`: clicking the toggle commits immediately (no edit mode).
- `path`: shows the path + "Choose…" + "Reveal" buttons. "Choose…" calls `system.pickFile({mode, filter})` → if non-null, `onCommit(path)`. "Reveal" calls `system.openInFinder({path, reveal: true})`.
- `readonly`: just displays value. If `revealInFinder=true`, shows a "Reveal" button.

`status` icon (top-right of value cell):
- `null` / `"saved"`: `✓` (green) — value matches what's on disk
- `"restart"`: `⟳` (accent) — value saved but daemon needs restart
- `"typing"`: small grey dot — user is editing, not committed

### 6.3 `<RestartBanner>`

```tsx
<RestartBanner
  daemons={Array<{ name: string; keys: string[] }>}
  onRestart={(daemon: string) => Promise<void>}
  onRestartAll={() => Promise<void>}
/>
```

Sticky bar at the top of `<SettingsPage>` body. Renders something like:

```
● Changes saved. audiodaemon needs restart to apply: silence_threshold, silence_duration_sec
  [Restart now]   [×]
```

`Restart now` calls `onRestartAll` (which restarts every daemon in the list). The `[×]` button just hides the banner (doesn't actually undo restart-needed-ness — useful when the user has already decided to defer).

When multiple daemons need restart, the banner shows them as a list and offers per-daemon restart buttons.

### 6.4 `useSettingsRestartTracker` hook

```ts
type DaemonsByKey = Map<string, Set<string>>;  // daemon name → keys

interface SettingsRestartTracker {
  daemons: DaemonsByKey;
  record(key: string, daemonsNeedingRestart: string[]): void;
  statusFor(key: string): RowStatus;     // "restart" if key is in the tracker, else "saved"
  clearDaemon(name: string): void;       // after successful restart
  clearKey(key: string): void;           // after user reverts to original
  clearAll(): void;
}

export function useSettingsRestartTracker(): SettingsRestartTracker;
```

State via `useReducer`. The reducer's actions are `record(key, daemons)`, `clearDaemon`, `clearKey`, `clearAll`.

### 6.5 `<HotkeyCapture>`

For the Hotkey & UI page only. Renders the current hotkey as a glyph (e.g. `⌘⇧V`); clicking enters capture mode: replaces label with "press your hotkey now"; the next non-modifier keydown (with modifiers held) captures `{ key, modifiers }`; shows preview; user clicks `Save` to commit via `config.update({ key: "status_agent.hotkey", value: {key, modifiers} })`. Click outside or Escape cancels.

### 6.6 `<CommandEditor>`

For the LLM page only. Edits `string[]`. UI:

```
[arg 0: "claude"        ] [×]
[arg 1: "--print"       ] [×]
[arg 2: "--model"       ] [×]
[arg 3: "claude-opus-4-7"] [×]
[+ Add arg]
```

Each row is draggable (HTML5 `draggable={true}` + `onDragStart`/`onDragOver`/`onDrop`). Reorders update the array. `[×]` removes. `[+ Add arg]` appends `""`. Blur / commit happens on any modification (no separate Save button — keep it inline).

### 6.7 `<TestPopover>`

Triggered by the `Test command` / `Test connection` buttons. Renders a glass popover anchored below the button with:

```
[● running... / ✓ ok / ✗ failed]
<stdout in mono, scrollable>
<stderr in mono red, if non-empty>
```

Dismisses on outside-click or Escape. State: pending / success / failed. Powered by `useState` + the relevant `useMutation` from tRPC.

### 6.8 `<DbStatsRow>`

For the Storage page. Renders a path + size (formatted as KB/MB) + row count + optional action button. Used 3 times for prompts/vocab/search SQLites. The search entry has a "Reindex" button that fires `trpc.search.reindex.useMutation()`.

## 7. Page Compositions

### 7.1 `/settings/audio`

```tsx
<SettingsPage banner={tracker.daemons.size > 0 && <RestartBanner ... />}>
  <InlineEditRow label="Mic device" type="select" options={micOptions} ... />
  <InlineEditRow label="System audio device" type="select" options={sysOptions} ... />
  <InlineEditRow label="Output dir" type="path" mode="folder" ... />
  <InlineEditRow label="Silence threshold" type="number" min={0} max={1} step={0.01} help="RMS below this counts as silence" ... />
  <InlineEditRow label="Silence duration sec" type="number" min={1} step={1} ... />
  <InlineEditRow label="Backend" type="select" options={[{value:"daemon",label:"daemon"}]} ... />
</SettingsPage>
```

`micOptions` and `sysOptions` come from `trpc.system.audioDevices.useQuery()`.

### 7.2 `/settings/transcription`

```tsx
<SettingsPage banner={...}>
  <InlineEditRow label="Final engine" type="select" options={[{value:"mlx"},{value:"whisper-cli"}]} ... />
  <InlineEditRow label="Language" type="select" options={[{value:"zh"},{value:"en"},{value:"ja"},{value:"auto"}]} ... />
  <InlineEditRow label="Local model path" type="path" mode="file" filter="bin" ... />
  <InlineEditRow label="MLX model" type="text" ... />   {/* spec also wants a select of installed mlx models; deferred — text input for v1 */}
  <InlineEditRow label="MLX final model" type="text" ... />
  <InlineEditRow label="MLX preprocess audio" type="toggle" ... />
  <InlineEditRow label="MLX passthrough max sec" type="number" ... />
  <InlineEditRow label="MLX passthrough max bytes" type="number" ... />
  <Link to="/knowledge/glossary">Manage glossary →</Link>
</SettingsPage>
```

The spec calls for a select of installed mlx models (parsed from `~/.cache/huggingface`). Deferring to a follow-up — text input is functional for v1.

### 7.3 `/settings/llm`

```tsx
<SettingsPage banner={...}>
  <InlineEditRow label="Enabled" type="toggle" ... />
  <Row label="Command" help="Spawned with stdin = your turn text">
    <CommandEditor value={config.llm.command} onChange={...} />
  </Row>
  <Row label="Test">
    <button onClick={...}>Test command</button>
    {showPopover && <TestPopover ... />}
  </Row>
</SettingsPage>
```

`<Row>` is a plain layout sibling — same visual structure as `<InlineEditRow>` but with a generic ReactNode body.

### 7.4 `/settings/hotkey`

```tsx
<SettingsPage banner={...}>
  <InlineEditRow label="Status agent enabled" type="toggle" ... />
  <Row label="Hotkey">
    <HotkeyCapture value={config.status_agent.hotkey} onCommit={...} />
  </Row>
  <Row label="UI theme">
    <ThemeToggle />   {/* reuse from Phase B */}
  </Row>
  <InlineEditRow label="UI port" type="readonly" value="7777" help="Edit com.yulu.ui.plist and `yulu restart yulu_ui` to change" />
</SettingsPage>
```

### 7.5 `/settings/integrations`

```tsx
<SettingsPage banner={...}>
  {(config.calendars ?? []).map((cal) => (
    <CalendarCard key={cal.type} cal={cal} onTest={...} onUpdate={...} />
  ))}
</SettingsPage>
```

`<CalendarCard>` is page-local (not in shared components since it's coupled to the calendar schema). Renders:

- Provider name (e.g. `feishu`)
- Enabled toggle
- Credentials path (path-variant inline row)
- Account (text-variant inline row)
- Test connection button → `<TestPopover>`

### 7.6 `/settings/storage`

```tsx
<SettingsPage banner={null}>   {/* Storage page has no restart-tracked rows */}
  <InlineEditRow label="Output dir" type="path" mode="folder" ... />  {/* mirrors audio.output_dir */}
  <Section label="Databases">
    <DbStatsRow name="prompts" ... />
    <DbStatsRow name="vocab" ... />
    <DbStatsRow name="search" actionLabel="Reindex" onAction={() => trpc.search.reindex.useMutation()} ... />
  </Section>
  <Section label="Logs">
    {logPaths.map(({name, path}) => (
      <InlineEditRow key={name} type="readonly" value={path} revealInFinder label={name} />
    ))}
  </Section>
</SettingsPage>
```

`<Section>` is a tiny page-local component for the labeled section headers.

## 8. Data Flow

```ts
// shared across all 6 pages
const { data: config } = trpc.config.get.useQuery();
const tracker = useSettingsRestartTracker();
const qc = useQueryClient();

const updateMutation = trpc.config.update.useMutation({
  onSuccess: (res, vars) => {
    tracker.record(vars.key, res.daemonsNeedingRestart);
    qc.invalidateQueries({ queryKey: [["config", "get"]] });
  },
});

const restartMutation = trpc.daemons.restart.useMutation({
  onSuccess: (_res, vars) => tracker.clearDaemon(vars.name),
});
```

Pages then pass `(key, value) => updateMutation.mutate({key, value})` as `onCommit` to each row.

The `restart-required → daemon-restart-completes → row flips back to ✓` flow is purely tracker-driven; no extra round-trips.

## 9. URL Model

Unchanged from Phase B: 6 routes already exist, no params, no query state needed. Each page is a leaf route.

## 10. Loading States

`config.get` query pending: `<EmptyState label="Loading config…" />` for the whole page body.

`audioDevices` query pending (Audio page only): the two device selects show `Loading devices…` as the only option until data arrives.

`dbStats` pending (Storage page only): each row shows `…` for size/rows.

## 11. Error Handling

- `config.update` fails (validation error from ConfigManager's zod schema): the row's status flips to "error" (red `✗`) + hover-tooltip shows the error message. Existing value reverts.
- `system.pickFile` returns null: no-op (user cancelled).
- `daemons.restart` fails: tracker keeps the daemon flagged + banner shows the error inline (`Restart failed: <stderr>`).
- `integrations.test` / `llm.test` fail or time out: popover shows the stderr and red ✗ status; user dismisses by click-outside.

## 12. Testing Strategy

Each shared component gets its own test file (5 component tests). Pages get integration smoke tests (mock trpc, mount, assert key interactions: row commits → tracker records → banner renders → restart clears).

Backend procedure tests:
- `system.pickFile`: mock `child_process.spawn` to inject osascript stdout; assert path returned + null on cancel
- `system.openInFinder`: mock spawn; assert `open` command shape
- `system.audioDevices`: mock `system_profiler` stdout (fixture JSON); assert input + output split
- `system.dbStats`: use `tests/helpers/tmpDb.ts` to create real sqlite files; assert size + rows
- `system.logPaths`: assert path shape
- `integrations.test`: mock spawn; assert command + parsing
- `llm.test`: mock spawn; assert stdin written + stdout captured + config.enabled gate

## 13. Acceptance Criteria

Phase D ships when:

1. **All 6 pages render** without error when `config.json` has the canonical shape; missing optional fields default cleanly (no crashes).
2. **Inline edit commit flow**: click a row → type new value → Enter or blur → value persists across reload. Verify with at least one row per variant (text, number, select, toggle, path, readonly).
3. **Restart banner**: changing `audio.silence_threshold` flips the row to `⟳` and shows the banner listing `audiodaemon` + `silence_threshold`. Clicking `Restart now` calls `daemons.restart` and the banner clears within ~1 s of the restart succeeding.
4. **`system.pickFile`**: clicking "Choose…" on a path row opens an OS-native dialog; picking a folder fills the row + commits to config; canceling leaves the row unchanged.
5. **`system.openInFinder`**: clicking "Reveal" on a path or log row opens Finder at that location.
6. **Hotkey capture**: clicking the hotkey value enters capture mode; pressing `⌘⇧F1` shows the captured combo; clicking Save commits to `status_agent.hotkey` + the SIGHUP fires automatically (verified in `~/.config/yulu/statusagent.log`).
7. **LLM Test command**: clicking Test runs the configured command with stdin "hello, world", popover shows stdout. If `llm.enabled = false`, popover shows the "llm.enabled is false" message + ✗ status.
8. **Integrations Test connection**: clicking Test for the feishu provider runs the Python detector probe + popover shows result. If Python module missing, the stderr is shown.
9. **Storage page**: DB sizes + row counts visible; clicking Reindex fires `search.reindex` mutation (button shows pending state).
10. **All previous tests pass + new tests pass + `npm run typecheck` clean.** Real-machine smoke (dev + prod modes + browser navigation through all 6 pages) shows no console errors beyond expected `vocab.sqlite` missing case.

## 14. File Structure

```
yulu/scripts/yulu_ui/
├── src/
│   ├── routers/
│   │   ├── system.ts             MOD — add pickFile/openInFinder/audioDevices/dbStats/logPaths
│   │   ├── integrations.ts       NEW
│   │   ├── llm.ts                NEW
│   │   └── _app.ts               MOD — register integrations + llm routers
│   └── (other src files unchanged)
├── web/src/
│   ├── components/
│   │   ├── SettingsPage.{tsx,css}            NEW
│   │   ├── InlineEditRow.{tsx,css}           NEW
│   │   ├── RestartBanner.{tsx,css}           NEW
│   │   ├── HotkeyCapture.{tsx,css}           NEW
│   │   ├── CommandEditor.{tsx,css}           NEW
│   │   ├── TestPopover.{tsx,css}             NEW
│   │   └── DbStatsRow.{tsx,css}              NEW
│   ├── hooks/
│   │   └── useSettingsRestartTracker.ts      NEW
│   └── routes/
│       └── settings/
│           ├── audio.tsx                     MOD — replace placeholder
│           ├── transcription.tsx             MOD
│           ├── llm.tsx                       MOD
│           ├── hotkey.tsx                    MOD
│           ├── integrations.tsx              MOD
│           └── storage.tsx                   MOD
└── tests/
    ├── routers/
    │   ├── system.test.ts                    MOD — append tests for new procedures
    │   ├── integrations.test.ts              NEW
    │   └── llm.test.ts                       NEW
    └── web/
        ├── SettingsPage.test.tsx             NEW
        ├── InlineEditRow.test.tsx            NEW
        ├── RestartBanner.test.tsx            NEW
        ├── HotkeyCapture.test.tsx            NEW
        ├── CommandEditor.test.tsx            NEW
        ├── TestPopover.test.tsx              NEW
        ├── DbStatsRow.test.tsx               NEW
        ├── useSettingsRestartTracker.test.ts NEW
        ├── settings.audio.test.tsx           NEW
        ├── settings.transcription.test.tsx   NEW
        ├── settings.llm.test.tsx             NEW
        ├── settings.hotkey.test.tsx          NEW
        ├── settings.integrations.test.tsx    NEW
        └── settings.storage.test.tsx         NEW
```

## 15. What's deferred to later phases

| Phase | Scope |
|---|---|
| E | Knowledge pages (Prompts master-detail reuses `<MasterDetail>` from C; Glossary inline table reuses `<InlineEditRow>` from D's text variant) |
| F | Health pages (Daemons grid + Logs tail via `useWsChannel('logs')`); Playwright E2E sweep |
| G | setup.sh integration, yulu doctor entry, release packaging |

Future polish (out of scope for D):
- MLX model select with `~/.cache/huggingface` parser
- Add/remove calendar providers via UI
- Per-row revert button
- Drag-to-reorder calendar providers
