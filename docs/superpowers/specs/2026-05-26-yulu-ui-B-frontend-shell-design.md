# Yulu UI · Phase B — Frontend Shell

> Sub-spec of [`2026-05-26-yulu-frontend-design.md`](2026-05-26-yulu-frontend-design.md). Implements the shell described in that document's §5 (visual design), §6 (information architecture), and §8 (floating pill) on top of the Phase A backend (`2026-05-26-yulu-ui-A-backend-shell.md` plan).

## 1. Goal

Deliver the React + Vite shell at `yulu/scripts/yulu_ui/web/` so subsequent phases (C–F) drop page bodies into ready-made route slots. After this phase, navigating to any of the 13 routes renders the full chrome (Sidebar + TopBar + Pill) with a placeholder body that proves the backend wire is live.

## 2. Non-goals

- Real page bodies for Inbox / Settings / Knowledge / Health (Phases C–F own those)
- `wavesurfer.js` integration (package installed in B; wired in C's voicemail reader)
- Per-page filter widgets (B leaves the TopBar filter slot empty; C–F populate)
- Playwright E2E (added in Phase C once real pages exist)
- Responsive / mobile layout (spec is desktop-only)
- i18n (spec is mono-locale)
- Keyboard shortcut layer beyond what React Router gives for free

## 3. Architecture

Single npm package (`yulu_ui/package.json`) houses both the Node server (`src/`) and the React client (`web/`). Same `node_modules`, same lockfile, same `npm install`, single git diff per phase.

```
yulu/scripts/yulu_ui/
├── src/                            (server, Phase A)
├── web/                            NEW — React client
├── dist/server.js                  (esbuild bundle)
├── dist/web/                       (vite bundle, served by Node in prod)
├── package.json                    (shared deps + scripts)
├── vitest.config.ts                (projects: server=node, web=jsdom)
└── esbuild.config.mjs              (server bundler, unchanged)
```

**Dev mode** (`npm run dev`): `concurrently` runs the Node server on :7777 and Vite on :5173. Vite proxies `/trpc`, `/ws`, `/files` to :7777. HMR works for the React side; tsx watch restarts the server side.

**Prod mode** (LaunchAgent): Node serves the SPA. `server.ts` gets one new fallback route (`*` → `dist/web/index.html`) plus a `/assets/*` static handler for Vite's hashed chunks. No process changes; no plist change.

## 4. Technology Stack

| Layer | Choice | Version |
|---|---|---|
| Framework | React + Vite + TypeScript | 18 / 5 / 5 |
| Router | React Router (data router mode) | 7 |
| Data | `@tanstack/react-query` + `@trpc/react-query` | 5 / 11 |
| Types | `import type { AppRouter } from "../../src/routers/_app.js"` | nothing to publish, same package |
| Audio | `wavesurfer.js` (installed B, wired C) | 7 |
| Validation | `zod` (already) | 3 |
| Style | Vanilla CSS + CSS custom properties | — |
| Test | `vitest` (already) + `jsdom` + `@testing-library/react` + `@testing-library/user-event` | — |
| Dev orchestration | `concurrently` | — |

No Tailwind, no CSS Modules, no styled-components, no Zustand. The spec's design system is built on CSS custom properties; we keep the runtime that close to the spec.

## 5. Directory Layout

```
web/
├── index.html
├── vite.config.ts                  — server proxy, build outDir = "../dist/web"
├── tsconfig.json                   — extends root, jsx: react-jsx
├── public/favicon.svg
└── src/
    ├── main.tsx                    — createRoot + <App/>
    ├── App.tsx                     — <ThemeProvider><QueryClientProvider><WsProvider><RouterProvider/></></></>
    ├── trpc.ts                     — createTRPCReact<AppRouter>() + httpBatchLink
    ├── ws.ts                       — WsProvider + useWsChannel + nextBackoff
    ├── theme.ts                    — ThemeProvider + useTheme
    ├── tokens.css                  — Ayu palette + glass tokens (spec §5.1, §5.2)
    ├── wallpaper.css               — page background (spec §5.4)
    ├── routes/
    │   ├── root.tsx                — layout: <Sidebar/> + <TopBar/> + <Outlet/> + <Pill/>
    │   ├── inbox/{voicemails,meetings,search}.tsx
    │   ├── knowledge/{prompts,glossary}.tsx
    │   ├── settings/{audio,transcription,llm,hotkey,integrations,storage}.tsx
    │   └── health/{daemons,logs}.tsx
    └── components/
        ├── Sidebar.{tsx,css}       — nav (13 items) + count badges + ThemeToggle mount
        ├── TopBar.{tsx,css}        — breadcrumb + count pill + filters slot
        ├── Pill.{tsx,css}          — 4 states: idle, recording, processing, meetingBusy, daemonDown
        ├── ThemeToggle.{tsx,css}   — Auto / Light / Dark segmented control
        └── Placeholder.{tsx,css}   — "Coming in Phase X · backend wired: …"

tests/web/                          — jsdom tests, see §8
```

Each route file is ~10 lines:

```ts
// web/src/routes/inbox/voicemails.tsx
import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";

export const handle = { breadcrumb: "Inbox / Voicemails", filters: null };

export default function Voicemails() {
  const { data } = trpc.voicemails.list.useQuery({});
  return <Placeholder phase="C" backendNote={`voicemails.list returned ${data?.length ?? "…"} rows`} />;
}
```

## 6. Data Flow & Contracts

### 6.1 tRPC client

```ts
// web/src/trpc.ts
import type { AppRouter } from "../../src/routers/_app.js";
import { createTRPCReact, httpBatchLink } from "@trpc/react-query";

export const trpc = createTRPCReact<AppRouter>();
export const trpcClient = trpc.createClient({
  links: [httpBatchLink({ url: "/trpc" })],
});
```

No code generation, no separate type publish. Server-side router signature changes immediately error in client code at typecheck time.

### 6.2 WebSocket multiplexer client

```ts
// web/src/ws.ts
export const WsProvider: React.FC<{ children: React.ReactNode }>;
export function useWsChannel<K extends keyof AppChannels>(
  channel: K,
  onMessage: (payload: AppChannels[K]) => void,
): void;
export function nextBackoff(attempt: number): number;   // pure, unit-tested
```

`WsProvider` lazily opens one WebSocket when the **first** `useWsChannel` subscribes; it stays open until the tree unmounts (effectively page lifetime). `useWsChannel` deduplicates subscriptions per channel and tracks listener counts so the `{type:"unsubscribe"}` frame is sent only when the last listener unmounts.

`nextBackoff(attempt)` is a pure function: `attempt=0 → 1000 ms`, `1 → 2000`, `2 → 4000`, …, capped at `30_000 ms`. Reconnect attempts reset to 0 on a clean WebSocket `open` event.

`AppChannels` type imported from `../../src/pubsub.js` (type-only) so server-side channel changes propagate to clients at typecheck time.

### 6.3 Theme

```ts
// web/src/theme.ts
export type ThemeChoice = "auto" | "light" | "dark";

export const ThemeProvider: React.FC<{ children: React.ReactNode }>;
export function useTheme(): { choice: ThemeChoice; resolved: "light" | "dark"; set: (c: ThemeChoice) => void };
```

`ThemeProvider` on mount:
1. Reads `localStorage.yulu_theme`; if absent, falls back to `matchMedia("(prefers-color-scheme: dark)")`.
2. Subscribes to media-query changes (Auto mode tracks system).
3. Writes `<html data-theme="light|dark">` so `tokens.css` `[data-theme="..."]` rules apply.

`set("auto")` clears localStorage. `set("light"|"dark")` writes it.

### 6.4 Pill state machine

Spec §8.1–§8.3 lists two primary states (idle, recording) plus three special states (processing, meetingBusy, daemonDown). We flatten that to a single 5-variant union — the rendering branch is identical either way.

```ts
// web/src/components/Pill.tsx
type PillState = "idle" | "recording" | "processing" | "meetingBusy" | "daemonDown";

function Pill() {
  const initial = trpc.recording.state.useQuery();      // bootstrap, in case WS hasn't connected
  const [state, setState] = useState<PillState>(...);   // hydrated from initial.data
  useWsChannel("recording", (msg) => setState(...));    // live updates
  useWsChannel("daemons",  (msg) => { if (msg.name === "com.yulu.audiodaemon" && msg.status !== "running") setState("daemonDown"); });

  switch (state) {
    case "idle":         return <IdlePill/>;
    case "recording":    return <RecordingPill/>;
    case "processing":   return <ProcessingPill/>;
    case "meetingBusy":  return <MeetingBusyPill/>;
    case "daemonDown":   return <DaemonDownPill/>;
  }
}
```

All five branches live in the same `Pill.tsx` file (~120 lines total). Splitting into separate component files is over-abstraction: each branch is ~20 lines, mostly markup.

Clicking `IdlePill` or `RecordingPill`'s stop button fires `trpc.recording.toggle.useMutation()`. The state change comes back via WS — no optimistic update needed; spec §8 mandates the WS-driven flip.

### 6.5 Sidebar count badges

```ts
// web/src/components/Sidebar.tsx
const { data } = trpc.sidebar.counts.useQuery();
const qc = useQueryClient();
useWsChannel("sidebar-counts", () => qc.invalidateQueries(["sidebar","counts"]));
```

Badge for `Voicemails`/`Meetings`/`Prompts`/`Glossary` shows `?` until first response, then the count. Items without counts (`Search`, `Settings/*`, `Logs`, `Daemons`) don't render badges (`Daemons` shows `7` as a static fact from the spec).

### 6.6 TopBar breadcrumb + filters slot

Each route exports a `handle`:

```ts
export const handle = { breadcrumb: "Inbox / Voicemails", filters: null };
```

`TopBar` reads `useMatches()` and renders the deepest match's `handle.breadcrumb` + `handle.filters`. In Phase B all `filters` are `null`; C–F supply real filter components.

## 7. Server-side Changes (additive)

`src/server.ts` gets one new static handler and one SPA fallback, added **after** all existing routes. A new module `src/staticFile.ts` reuses the Range-aware streaming logic already in Phase A's `streamAudio` but defaults to `text/html; charset=utf-8` and resolves MIME via a small map (`.html`, `.js`, `.css`, `.svg`, `.woff2`, `.png`, `.jpg`).

```ts
// served from disk, hash-cached
app.get("/assets/*", (c) => streamStatic(c.req.raw, join(__dirname, "../dist/web")));

// SPA fallback — must be last
app.get("*", (c) => {
  const indexPath = join(__dirname, "../dist/web/index.html");
  if (!existsSync(indexPath)) return c.text("UI not built — run `npm run build` or use `npm run dev:web`", 503);
  return streamStatic(c.req.raw, dirname(indexPath), "index.html");
});
```

Path resolution uses `__dirname` derived from `import.meta.url`. In dev (`npm run dev`), the React side runs from the Vite dev server (:5173); the Node server doesn't need to serve `dist/web/` and the 503 is informative.

No LaunchAgent plist change — Node startup invocation is unchanged.

## 8. Testing Strategy

`vitest.config.ts` switches to `projects`:

```ts
export default defineConfig({
  test: {
    projects: [
      { test: { include: ["tests/**/*.test.ts", "!tests/web/**"], environment: "node", pool: "forks" } },
      { test: { include: ["tests/web/**/*.test.{ts,tsx}"], environment: "jsdom", setupFiles: ["tests/web/setup.ts"] } },
    ],
  },
});
```

`tests/web/setup.ts` imports `@testing-library/jest-dom/vitest` so matchers like `.toBeInTheDocument()` resolve.

### 8.1 Web test inventory

| File | Coverage |
|---|---|
| `Sidebar.test.tsx` | 13 nav items render; active route highlighted; count badge shows `?` then real number; click navigates |
| `TopBar.test.tsx` | reads `useMatches().handle.breadcrumb`; filters slot renders when handle.filters is set, hides when null |
| `Pill.test.tsx` | `it.each` parameterized across 4 states (idle/recording/processing/meetingBusy/daemonDown); click idle pill fires `recording.toggle` mutation |
| `ThemeToggle.test.tsx` | three-state segmented control; click writes localStorage; document.documentElement data-theme flips |
| `theme.test.tsx` | useTheme returns resolved="dark" when localStorage missing + matchMedia dark; set("auto") clears storage |
| `ws.test.ts` | `nextBackoff(attempt)` returns 1s, 2s, 4s, 8s, 16s, 30s capped; useWsChannel sends subscribe on mount, unsubscribe on unmount; second component subscribing to same channel reuses (no duplicate WS message) |
| `routes.test.tsx` | `it.each(13 routes)`: each is mountable inside `<MemoryRouter>` with mocked trpc client (smoke) |

What we do **not** test in Phase B:
- Real tRPC round-trips (each phase's pages will own this)
- Actual WebSocket connection (`ws.test.ts` uses `mock-socket`)
- `wavesurfer.js` (installed, not wired)
- Cross-page user flows (Playwright in Phase C onward)

## 9. Build & Dev Workflow

`package.json` scripts:

```json
{
  "scripts": {
    "dev":          "concurrently -k -n server,web -c blue,magenta 'npm:dev:server' 'npm:dev:web'",
    "dev:server":   "tsx watch src/server.ts",
    "dev:web":      "vite --config web/vite.config.ts",
    "build":        "npm run build:server && npm run build:web",
    "build:server": "node esbuild.config.mjs",
    "build:web":    "vite build --config web/vite.config.ts",
    "start":        "node dist/server.js",
    "test":         "vitest run",
    "test:watch":   "vitest",
    "typecheck":    "tsc --noEmit"
  }
}
```

`vite.config.ts`:

```ts
export default defineConfig({
  root: "web",
  build: { outDir: "../dist/web", emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/trpc":  "http://127.0.0.1:7777",
      "/ws":    { target: "ws://127.0.0.1:7777", ws: true },
      "/files":   "http://127.0.0.1:7777",
      "/healthz": "http://127.0.0.1:7777",
    },
  },
  plugins: [react()],
});
```

Dev: open `http://127.0.0.1:5173`. Prod: open `http://127.0.0.1:7777`. Same code; only the host differs.

## 10. Acceptance Criteria

A Phase B branch is shippable when all of these are true:

1. `npm install && npm test` — all server + web tests pass; ~48 total (A's 41 + B's 7 web files, see §8.1).
2. `npm run typecheck` — clean across `src/`, `tests/`, and `web/src/`.
3. `npm run dev` — both processes start; opening `http://127.0.0.1:5173` shows the shell with the sidebar's first route (`/inbox/voicemails`) preselected, count badge `?` then a real number, Pill in `idle` state.
4. Clicking every sidebar item navigates without console errors; each page body shows the `Placeholder` with a backend wire confirmation (`"voicemails.list returned <N> rows"`, etc.).
5. Theme toggle: clicking Light or Dark flips `<html data-theme>` and persists across reload; clicking Auto clears `localStorage.yulu_theme` and the resolved theme tracks `prefers-color-scheme` (changes when the OS does, no reload needed).
6. `npm run build` — produces `dist/server.js` and `dist/web/{index.html, assets/*}`. Bundle sizes reasonable (web bundle < 500 KB gzip).
7. `YULU_UI_PORT=17777 node dist/server.js` — running the prod bundle and curling `http://127.0.0.1:17777/` returns the SPA `index.html`; `/healthz`, `/trpc/system.version`, etc. continue to work.
8. WebSocket integration: with `npm run dev` running, opening browser devtools shows a single `/ws` connection per page load; restarting the Node server triggers reconnect with exponential backoff visible in console.

## 11. Out of Scope (deferred)

| Phase | Owns |
|---|---|
| C | Inbox bodies (Voicemails / Meetings / Search); first `wavesurfer.js` integration; first TopBar filter group |
| D | Settings bodies (Audio / Transcription / LLM / Hotkey / Integrations / Storage); inline-edit pattern; restart banner |
| E | Knowledge bodies (Prompts / Glossary); inline-edit table |
| F | Health bodies (Daemons grid / Logs tail); live log subscription via `useWsChannel("logs", …)` |
| G | `setup.sh` integration; `yulu doctor` entry; release packaging |
