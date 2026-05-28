# Yulu UI · Phase F — Health Pages + Playwright E2E

> Sub-spec of [`2026-05-26-yulu-frontend-design.md`](2026-05-26-yulu-frontend-design.md). Implements the two Health pages described in §7.12 + §7.13 plus a Playwright E2E sweep covering all real pages built in Phases C–E.

## 1. Goal

Replace the Phase B placeholders for `/health/daemons` and `/health/logs` with two interactive pages. Add a server-side log tailer that publishes new log lines via the existing `logs` WS channel so the Logs page auto-scrolls. Install Playwright and ship one critical-flow E2E spec that exercises voicemails, settings, prompts, glossary, and daemons end-to-end.

## 2. Non-goals

- Per-daemon log rotation tracking (tailer reads from current position only)
- In-log search / filter (browser Cmd+F suffices)
- Daemon crash forensics UI (status + last log line is enough)
- Multi-daemon log multiplex view
- E2E in CI (local-only for now)
- Phase G concerns (setup.sh, doctor, release packaging)

## 3. Architecture

Two pages, one backend module, one E2E sweep:

- **Health/Daemons** — single-pane grid of 8 cards driven by `daemons.health.useQuery({refetchInterval: 5000})`. Each card shows status + PID + last log + 3 action buttons.
- **Health/Logs** — daemon dropdown + auto-scrolling monospace tail. Initial content from `logs.tail({name, limit:500})` then live appends via `useWsChannel("logs", ...)`.
- **`src/logTailer.ts`** — NEW server module. On startup, opens all 8 log files, seeks to end, watches via `fs.watch`. Publishes new lines to the existing `logs` AppChannel (Phase A defined the channel; nothing was publishing to it).
- **Playwright** — adds `@playwright/test` dep, `playwright.config.ts` with auto-`npm run dev` webServer, and one critical-flow E2E spec.

## 4. Backend: `logTailer`

### 4.1 Contract

```ts
// src/logTailer.ts
export interface LogTailerOptions {
  configDir: string;                       // base dir holding *.log files
  pubsub: PubSub<AppChannels>;
}
export interface LogTailer { stop(): void; }
export function startLogTailer(opts: LogTailerOptions): LogTailer;
```

### 4.2 Behavior

On `startLogTailer`:
1. For each of the 8 daemons in `YULU_DAEMONS` (from `src/routers/daemons.ts`), compute log path: `${configDir}/${shortName}.log` where `shortName = name.replace(/^com\.yulu\./, "")`.
2. If file exists: open via `fs.openSync(path, "r")` (read-only), record current size via `fs.statSync(path).size`, then `fs.watch(path, ...)` for change events.
3. On change: read bytes from last position to current size, split on `\n`, drop empty trailing line, emit each line as `pubsub.publish("logs", { name: shortName, line, ts: Date.now() })`. Update tracked position.
4. If file doesn't exist on startup: don't watch it (no fallback file-create watcher in v1 — daemons create their log on first run; UI requires a restart to pick up new files).

On `stop`: close all `FSWatcher` instances + `fs.closeSync` all fds.

Subscriber `name` in published messages is the **short name** (e.g. `"audiodaemon"`), matching what the LogTail client filters on.

### 4.3 Server wiring

`src/server.ts` adds a `startLogTailer({ configDir: paths.configDir, pubsub: appPubSub })` call next to the existing `startInboxWatcher` invocation. The returned tailer's `stop()` is called in the server's `close` function before `http.close()`.

## 5. Components

### 5.1 `<DaemonCard>`

```ts
interface DaemonHealth {
  name: string;          // full label: com.yulu.audiodaemon
  status: "running" | "stopped" | "crashed";
  pid: number;
  exitStatus: number;
  lastLog: string;
}
interface DaemonCardProps {
  daemon: DaemonHealth;
  onRestart: (name: string) => void;
  onStop: (name: string) => void;
}
```

Renders:
- Header row: daemon short name (`audiodaemon`) + `<StatusPill status={daemon.status}/>` (inline span: green `● running`, grey `⏸ stopped`, red `⚠ crashed`)
- Meta row: `PID ${pid}` + last log line (1-line, truncated with ellipsis, monospace 11px)
- Action row: 3 buttons — Restart (accent color), Stop (red), View logs → (links to `/health/logs?name=${shortName}`)

Restart and Stop buttons disabled when their respective mutations are pending (controlled from page-level state passed as `restartPending`/`stopPending` props).

### 5.2 `<LogTail>`

```ts
interface LogTailProps {
  daemonShortName: string;     // e.g. "audiodaemon"
  daemonLabel: string;         // e.g. "com.yulu.audiodaemon"
  initialLines: string[];
  paused: boolean;
  onClear: () => void;
}
```

Renders:
- `<pre>` block (monospace 11px, max-height fills container, overflow-y: auto)
- Each line in its own div (so per-line styling like timestamp parsing could be added later)
- WS subscription via `useWsChannel("logs", msg => { if (msg.name === daemonShortName) appendLine(msg.line); })`
- Auto-scroll to bottom on new line **unless** user has manually scrolled up (detect via `scrollHeight - scrollTop - clientHeight > 50`)
- `paused` prop suppresses new-line appends (but still records them in a buffer? No — drops them, to keep memory bounded)

Internal state: `lines: string[]` (capped at 2000 — older lines dropped). Reset when `daemonShortName` changes (uses key/effect dep).

### 5.3 `<StatusPill>` (inline)

~10 lines inline in `DaemonCard.tsx`. Maps status → glyph + color class.

## 6. Pages

### 6.1 `/health/daemons`

```tsx
export function HealthDaemons() {
  const { data } = trpc.daemons.health.useQuery(undefined, { refetchInterval: 5_000 });
  const qc = useQueryClient();
  const restartMut = trpc.daemons.restart.useMutation({ onSuccess: invalidate });
  const stopMut    = trpc.daemons.stop.useMutation({ onSuccess: invalidate });

  return (
    <div className="daemons-grid">
      {(data ?? []).map((d) => (
        <DaemonCard
          key={d.name}
          daemon={d}
          onRestart={(n) => restartMut.mutateAsync({ name: n })}
          onStop={(n) => stopMut.mutateAsync({ name: n })}
        />
      ))}
    </div>
  );
}
```

CSS grid: `grid-template-columns: repeat(auto-fill, minmax(280px, 1fr))`, gap 12px.

### 6.2 `/health/logs`

```tsx
export function HealthLogs() {
  const [params, setParams] = useSearchParams();
  const fullName = params.get("name") ?? "com.yulu.audiodaemon";
  const shortName = fullName.replace(/^com\.yulu\./, "");
  const [paused, setPaused] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const { data } = trpc.logs.tail.useQuery({ name: fullName as DaemonName, limit: 500 });

  return (
    <div className="logs-page">
      <div className="logs-header">
        <select value={fullName} onChange={(e) => setParams({ name: e.target.value })}>
          {YULU_DAEMONS.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <button onClick={() => setPaused((p) => !p)}>{paused ? "Resume" : "Pause auto-scroll"}</button>
        <button onClick={() => setResetKey((k) => k + 1)}>Clear scrollback</button>
      </div>
      <LogTail
        key={`${shortName}-${resetKey}`}
        daemonShortName={shortName}
        daemonLabel={fullName}
        initialLines={data?.lines ?? []}
        paused={paused}
        onClear={() => setResetKey((k) => k + 1)}
      />
    </div>
  );
}
```

`YULU_DAEMONS` imported from `src/routers/daemons.ts` (type-only import for client safety; or duplicated as a small const).

## 7. Playwright E2E

### 7.1 Setup

- Add devDep: `@playwright/test`
- Create `playwright.config.ts` at `yulu/scripts/yulu_ui/`:

```ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,        // sequential — sharing one backend
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
```

- npm script: `"e2e": "playwright test"`
- `.gitignore` excludes `test-results/`, `playwright-report/`

### 7.2 Critical-flow spec

`yulu/scripts/yulu_ui/e2e/critical.spec.ts` — one file, ~5 tests, each tests one user journey across the page:

1. **Inbox/Voicemails flow** — navigate to list, count >=0 rows, click first row (skip if empty), assert reader rendered (looks for audio + tabs)
2. **Settings/Audio edit** — navigate, find silence_threshold row, click → input → type new value → blur → assert restart banner shows
3. **Knowledge/Prompts flow** — navigate, click "+ New prompt", fill name+slug+content, click Save, assert URL changes to `/knowledge/prompts/:newId`, click Delete, confirm, assert URL back at `/knowledge/prompts`
4. **Knowledge/Glossary flow** — navigate, click + Add term, assert new row appeared (count went up by 1)
5. **Health/Daemons flow** — navigate, assert 8 cards render, assert at least one card shows status pill

Tests use `data-testid` and ARIA roles consistently. Tests do NOT assert specific data values (e.g., "voicemail X exists") — they assert structure.

Run via `npm run e2e` locally. **CI integration deferred.**

## 8. URL & Routing

`App.tsx` has no structural change for the Health routes — both `/health/daemons` and `/health/logs` are existing flat routes from Phase B. The implementations just replace the Placeholder with the real page component.

## 9. Test Strategy

### 9.1 Per-component vitest

- `logTailer.test.ts` (server, node env): create tmp dir + 2 fake log files; start tailer; append to one; assert pubsub.publish called with `{name, line, ts}` and the right `name`/`line`.
- `DaemonCard.test.tsx`: renders short name + status pill + last log; restart button click fires onRestart; status pill class matches `data-status`.
- `LogTail.test.tsx`: renders initial lines; WS event with matching name appends; WS event with non-matching name ignored; paused=true ignores new events.

### 9.2 Page integration tests

- `health.daemons.test.tsx`: 8 cards render from mocked health data; restart button fires `daemons.restart` mutation with the right name.
- `health.logs.test.tsx`: dropdown defaults to audiodaemon, changing dropdown updates URL, LogTail receives initial lines.

### 9.3 E2E

Playwright spec described in §7.2.

## 10. Acceptance Criteria

1. `/health/daemons` renders 8 cards (one per daemon in `YULU_DAEMONS`), each showing status + PID + last log + 3 buttons. Auto-refreshes every 5s.
2. Clicking Restart on a card fires `daemons.restart` and the card's status reflects the new state on next poll.
3. Clicking View logs → navigates to `/health/logs?name=<daemon>` and the dropdown shows the right daemon selected.
4. `/health/logs` initial render fetches last 500 lines for the selected daemon.
5. When server-side `logTailer` publishes a new line for the selected daemon, the LogTail appends it and (unless paused or user scrolled up) auto-scrolls to bottom.
6. "Pause auto-scroll" button toggles label between Pause/Resume and stops new appends.
7. "Clear scrollback" button empties the LogTail.
8. `npm run e2e` runs the Playwright critical-flow spec to completion locally (all 5 tests pass when backend is up and has at least minimal data).
9. All previous vitest tests + new vitest tests pass; `npm run typecheck` clean.

## 11. File Structure

```
yulu/scripts/yulu_ui/
├── src/
│   ├── logTailer.ts                              NEW (F.1)
│   └── server.ts                                  MOD (start tailer)
├── web/src/
│   ├── components/
│   │   ├── DaemonCard.{tsx,css}                   NEW (F.2)
│   │   └── LogTail.{tsx,css}                      NEW (F.3)
│   └── routes/health/
│       ├── daemons.tsx                            MOD (F.4)
│       └── logs.tsx                               MOD (F.5)
├── e2e/
│   └── critical.spec.ts                           NEW (F.7)
├── playwright.config.ts                           NEW (F.6)
├── package.json                                   MOD (add @playwright/test + e2e script)
└── tests/
    ├── logTailer.test.ts                          NEW (F.1, server project)
    └── web/
        ├── DaemonCard.test.tsx                    NEW (F.2)
        ├── LogTail.test.tsx                       NEW (F.3)
        ├── health.daemons.test.tsx                NEW (F.4)
        └── health.logs.test.tsx                   NEW (F.5)
```

## 12. What's deferred to Phase G

- `setup.sh` integration (UI built + LaunchAgent install)
- `yulu doctor` entry
- Release packaging
- E2E in CI (GitHub Actions)
- Log rotation detection in tailer
