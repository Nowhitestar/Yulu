# Yulu UI · Phase B — Frontend Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the React + Vite shell at `yulu/scripts/yulu_ui/web/` so subsequent phases (C–F) drop page bodies into ready-made route slots. After Phase B, navigating to any of the 13 routes renders the full Liquid Glass chrome (Sidebar + TopBar + Pill) with a placeholder body that confirms the backend wire is live.

**Architecture:** Single npm package (`yulu_ui/package.json`) shared between the Node server (`src/`) and the React client (`web/`). Dev mode runs `tsx watch src/server.ts` on :7777 and Vite dev on :5173 with `/trpc`, `/ws`, `/files` proxied to the server. Prod mode: Vite builds to `dist/web/`, and Node's `server.ts` adds a `/assets/*` static handler and an SPA fallback. tRPC client and WebSocket multiplexer share types with the server via in-package type imports — no codegen, no publish.

**Tech Stack:** React 18 · Vite 5 · TypeScript 5 · React Router 7 (data router) · @tanstack/react-query 5 · @trpc/react-query 11 · wavesurfer.js 7 (installed, wired in Phase C) · zod · vanilla CSS + CSS custom properties · vitest + jsdom + @testing-library/react + mock-socket · concurrently

**Spec reference:** [`docs/superpowers/specs/2026-05-26-yulu-ui-B-frontend-shell-design.md`](../specs/2026-05-26-yulu-ui-B-frontend-shell-design.md) (all sections) — that doc supersedes the high-level [`2026-05-26-yulu-frontend-design.md`](../specs/2026-05-26-yulu-frontend-design.md) §5/§6/§8 for Phase-B specifics.

**Out of scope (deferred to Phases C–G):** real page bodies (each phase owns its pages); `wavesurfer.js` wiring (installed in B, used in C's voicemail reader); per-page filter widgets (B leaves TopBar filter slot empty); Playwright E2E (added when C has real pages); mobile / responsive; i18n.

**Path conventions:** Paths in this plan are relative to the repo root. Most work is in `yulu/scripts/yulu_ui/web/` (new) and `yulu/scripts/yulu_ui/src/` (Phase A's server, lightly modified). Commands run from `yulu/scripts/yulu_ui/` unless noted otherwise.

---

## File Structure

```
yulu/scripts/yulu_ui/
├── package.json                    Modified: add React deps + scripts
├── tsconfig.json                   Modified: jsx + include web/
├── vitest.config.ts                Modified: defaults for both projects
├── vitest.workspace.ts             NEW: server (node) + web (jsdom)
├── esbuild.config.mjs              Unchanged
├── src/
│   ├── (Phase A files)
│   ├── server.ts                   Modified: SPA fallback + /assets
│   └── staticFile.ts               NEW: Range-aware static file helper
├── web/                            NEW
│   ├── index.html
│   ├── vite.config.ts
│   ├── tsconfig.json               Extends root tsconfig with jsx
│   ├── public/favicon.svg
│   └── src/
│       ├── main.tsx
│       ├── App.tsx
│       ├── trpc.ts
│       ├── ws.ts
│       ├── theme.ts
│       ├── tokens.css
│       ├── wallpaper.css
│       ├── routes/
│       │   ├── root.tsx
│       │   ├── inbox/{voicemails,meetings,search}.tsx
│       │   ├── knowledge/{prompts,glossary}.tsx
│       │   ├── settings/{audio,transcription,llm,hotkey,integrations,storage}.tsx
│       │   └── health/{daemons,logs}.tsx
│       └── components/
│           ├── Sidebar.{tsx,css}
│           ├── TopBar.{tsx,css}
│           ├── Pill.{tsx,css}
│           ├── ThemeToggle.{tsx,css}
│           └── Placeholder.{tsx,css}
└── tests/
    ├── (Phase A tests)
    └── web/                        NEW
        ├── setup.ts
        ├── theme.test.tsx
        ├── ws.test.ts
        ├── Sidebar.test.tsx
        ├── TopBar.test.tsx
        ├── Pill.test.tsx
        ├── ThemeToggle.test.tsx
        └── routes.test.tsx
```

**Why these splits:** Each component owns its `.tsx` + sibling `.css` so style/markup ship together. Cross-cutting hooks (`trpc`, `ws`, `theme`) sit at `web/src/` root — they're the contracts every component uses. Routes live in `routes/` mirroring the sidebar's information architecture (inbox / knowledge / settings / health). Tests mirror `web/src/`'s structure but under `tests/web/`.

---

## Task B.1 — Workspace scaffolding (deps, vite, vitest projects)

**Files:**
- Modify: `yulu/scripts/yulu_ui/package.json`
- Modify: `yulu/scripts/yulu_ui/tsconfig.json`
- Modify: `yulu/scripts/yulu_ui/vitest.config.ts`
- Create: `yulu/scripts/yulu_ui/vitest.workspace.ts`
- Create: `yulu/scripts/yulu_ui/web/index.html`
- Create: `yulu/scripts/yulu_ui/web/vite.config.ts`
- Create: `yulu/scripts/yulu_ui/web/tsconfig.json`
- Create: `yulu/scripts/yulu_ui/web/public/favicon.svg`
- Create: `yulu/scripts/yulu_ui/web/src/main.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/App.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/tokens.css`
- Create: `yulu/scripts/yulu_ui/web/src/wallpaper.css`
- Create: `yulu/scripts/yulu_ui/tests/web/setup.ts`

This task is intentionally a single large commit — every piece is interdependent (vite needs index.html, tsconfig needs jsx, vitest projects need setup.ts, etc.) and only useful when they land together. Subsequent tasks add to this base one piece at a time.

- [ ] **Step 1: Extend `package.json`**

Replace the existing `package.json`:

```json
{
  "name": "yulu-ui",
  "version": "0.0.1",
  "private": true,
  "type": "module",
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
  },
  "dependencies": {
    "@trpc/client":         "^11.0.0",
    "@trpc/react-query":    "^11.0.0",
    "@trpc/server":         "^11.0.0",
    "@tanstack/react-query": "^5.59.0",
    "better-sqlite3":       "^11.5.0",
    "hono":                 "^4.6.0",
    "react":                "^18.3.0",
    "react-dom":            "^18.3.0",
    "react-router":         "^7.0.0",
    "wavesurfer.js":        "^7.8.0",
    "ws":                   "^8.18.0",
    "zod":                  "^3.23.0"
  },
  "devDependencies": {
    "@testing-library/dom":         "^10.4.0",
    "@testing-library/jest-dom":    "^6.6.0",
    "@testing-library/react":       "^16.0.0",
    "@testing-library/user-event":  "^14.5.0",
    "@types/better-sqlite3":        "^7.6.11",
    "@types/node":                  "^22.0.0",
    "@types/react":                 "^18.3.0",
    "@types/react-dom":             "^18.3.0",
    "@types/ws":                    "^8.5.13",
    "@vitejs/plugin-react":         "^4.3.0",
    "concurrently":                 "^9.0.0",
    "esbuild":                      "^0.24.0",
    "jsdom":                        "^25.0.0",
    "mock-socket":                  "^9.3.0",
    "tsx":                          "^4.19.0",
    "typescript":                   "^5.6.0",
    "vite":                         "^5.4.0",
    "vitest":                       "^2.1.0"
  },
  "engines": {
    "node": ">=20.0.0"
  }
}
```

- [ ] **Step 2: Update `tsconfig.json`** to include `web/`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "allowImportingTsExtensions": false,
    "rootDir": ".",
    "baseUrl": ".",
    "outDir": "dist",
    "types": ["vitest/globals"]
  },
  "include": ["src/**/*", "tests/**/*", "web/**/*", "esbuild.config.mjs"]
}
```

- [ ] **Step 3: Create `web/tsconfig.json`** (so IDEs see vite config + extra lib)

```json
{
  "extends": "../tsconfig.json",
  "include": ["src/**/*", "vite.config.ts"]
}
```

- [ ] **Step 4: Replace `vitest.config.ts`** (will be referenced by both project configs)

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 5_000,
  },
});
```

- [ ] **Step 5: Create `vitest.workspace.ts`** (two projects: server-node + web-jsdom)

```ts
import { defineWorkspace } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineWorkspace([
  {
    extends: "./vitest.config.ts",
    test: {
      name: "server",
      include: ["tests/**/*.test.ts"],
      exclude: ["tests/web/**", "node_modules/**"],
      environment: "node",
      pool: "forks",
    },
  },
  {
    extends: "./vitest.config.ts",
    plugins: [react()],
    test: {
      name: "web",
      include: ["tests/web/**/*.test.{ts,tsx}"],
      environment: "jsdom",
      setupFiles: ["tests/web/setup.ts"],
    },
  },
]);
```

- [ ] **Step 6: Create `web/index.html`** (Vite entry)

```html
<!doctype html>
<html lang="en" data-theme="dark">
  <head>
    <meta charset="UTF-8" />
    <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Yulu</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 7: Create `web/vite.config.ts`**

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    strictPort: true,
    host: "127.0.0.1",
    proxy: {
      "/trpc":    "http://127.0.0.1:7777",
      "/files":   "http://127.0.0.1:7777",
      "/healthz": "http://127.0.0.1:7777",
      "/ws":      { target: "ws://127.0.0.1:7777", ws: true, rewriteWsOrigin: true },
    },
  },
});
```

- [ ] **Step 8: Create `web/public/favicon.svg`** (one-character Yulu logo)

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none">
  <rect width="32" height="32" rx="6" fill="#161A23"/>
  <text x="16" y="22" text-anchor="middle" font-family="-apple-system, sans-serif" font-size="18" font-weight="500" fill="#FFCC66">语</text>
</svg>
```

- [ ] **Step 9: Create `web/src/tokens.css`** (Ayu palette + glass tokens, copied from spec §5.1 / §5.2)

```css
:root {
  --radius-panel: 12px;
  --radius-pill:  22px;
  --radius-inner: 8px;
  --blur-glass:   blur(28px) saturate(180%);
  --blur-pill:    blur(32px) saturate(200%);
  --edge-shadow:  0 1px 0 var(--edge-top) inset, 0 0 0 1px var(--edge);
}

[data-theme="dark"] {
  --wp-1: #161A23;  --wp-2: #1F2430;  --wp-3: #2B3343;
  --glass:   rgba(255, 255, 255, 0.045);
  --glass-2: rgba(255, 255, 255, 0.08);
  --glass-3: rgba(255, 255, 255, 0.12);
  --edge:    rgba(255, 255, 255, 0.08);
  --edge-top:rgba(255, 255, 255, 0.14);
  --fg: #E4E4DE;  --fg-2: #8B92A0;  --fg-3: #5A6172;
  --accent: #FFCC66;  --accent-soft: rgba(255, 204, 102, 0.18);
  --blue:   #5CCFE6;  --green: #BAE67E;
  --red:    #FF7B72;  --purple: #DFBFFF;
  --shadow: 0 12px 32px rgba(0, 0, 0, 0.35), 0 2px 6px rgba(0, 0, 0, 0.20);
  --row-hover: rgba(255, 255, 255, 0.04);
}
[data-theme="light"] {
  --wp-1: #F0F2F5;  --wp-2: #F8FAFC;  --wp-3: #E5EAF1;
  --glass:   rgba(255, 255, 255, 0.55);
  --glass-2: rgba(255, 255, 255, 0.72);
  --glass-3: rgba(255, 255, 255, 0.88);
  --edge:    rgba(255, 255, 255, 0.80);
  --edge-top:rgba(255, 255, 255, 1);
  --fg: #3B4252;  --fg-2: #7A8290;  --fg-3: #A8AEB8;
  --accent: #F2AE49;  --accent-soft: rgba(242, 174, 73, 0.18);
  --blue:   #399EE6;  --green: #6CBF00;
  --red:    #E55050;  --purple: #8E5BD8;
  --shadow: 0 10px 28px rgba(60, 80, 110, 0.10), 0 1px 4px rgba(60, 80, 110, 0.05);
  --row-hover: rgba(0, 0, 0, 0.025);
}
```

- [ ] **Step 10: Create `web/src/wallpaper.css`** (spec §5.4)

```css
html, body, #root {
  height: 100%;
  margin: 0;
  font-family: -apple-system, "SF Pro Text", "Helvetica Neue", sans-serif;
  font-size: 13px;
  color: var(--fg);
  background:
    radial-gradient(at 20% 0%,   var(--wp-3) 0%, transparent 50%),
    radial-gradient(at 100% 100%, var(--wp-3) 0%, transparent 60%),
    linear-gradient(135deg, var(--wp-1) 0%, var(--wp-2) 100%);
  background-attachment: fixed;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}
*, *::before, *::after { box-sizing: border-box; }
button {
  font: inherit;
  color: inherit;
  background: none;
  border: none;
  cursor: pointer;
  padding: 0;
}
a { color: inherit; text-decoration: none; }
```

- [ ] **Step 11: Create `web/src/main.tsx`** (minimal entry; App will be expanded in B.10)

```tsx
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./tokens.css";
import "./wallpaper.css";
import { App } from "./App.js";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");
createRoot(root).render(<StrictMode><App /></StrictMode>);
```

- [ ] **Step 12: Create `web/src/App.tsx`** (placeholder — replaced in B.10)

```tsx
export function App() {
  return <div style={{ padding: 24 }}>Yulu UI — scaffold ready. (Real shell wired in B.10.)</div>;
}
```

- [ ] **Step 13: Create `tests/web/setup.ts`** (jest-dom matchers + matchMedia mock)

```ts
import "@testing-library/jest-dom/vitest";

// jsdom lacks matchMedia; provide a minimal mock so ThemeProvider doesn't crash.
if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
```

- [ ] **Step 14: Install + verify**

```bash
cd yulu/scripts/yulu_ui
npm install
npm run typecheck
npm test
```

Expected:
- `npm install` completes without error.
- `npm run typecheck` passes (no files reference React yet beyond the bare App).
- `npm test` runs both projects and reports the existing 41 server tests passing + 0 web tests (vitest exits 0 even with zero tests in a project).

- [ ] **Step 15: Verify Vite dev server starts**

```bash
cd yulu/scripts/yulu_ui
npm run dev:web &
DEV_PID=$!
sleep 2
curl -s http://127.0.0.1:5173/ | head -c 200
kill $DEV_PID
```

Expected: `<!doctype html>...Yulu...` HTML returned. Vite logs `VITE ... ready in <X> ms`.

- [ ] **Step 16: Commit**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git add yulu/scripts/yulu_ui/package.json yulu/scripts/yulu_ui/package-lock.json \
        yulu/scripts/yulu_ui/tsconfig.json yulu/scripts/yulu_ui/vitest.config.ts \
        yulu/scripts/yulu_ui/vitest.workspace.ts \
        yulu/scripts/yulu_ui/web/ yulu/scripts/yulu_ui/tests/web/setup.ts
git commit -m "chore(yulu_ui): scaffold web/ (vite + react + vitest projects)"
```

---

## Task B.2 — tRPC client (`trpc.ts`)

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/trpc.ts`
- Create: `yulu/scripts/yulu_ui/tests/web/trpc.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/trpc.test.tsx
import { describe, it, expect } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc, makeTrpcClient } from "../../web/src/trpc.js";
import type { ReactNode } from "react";

describe("trpc client", () => {
  it("exports a typed trpc react proxy + makeTrpcClient factory", () => {
    expect(typeof trpc.system).toBe("object");
    expect(typeof trpc.system.version.useQuery).toBe("function");
    const client = makeTrpcClient("http://127.0.0.1:7777");
    expect(client).toBeDefined();
  });

  it("Provider mounts with TanStack Query without throwing", () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => "ok", { wrapper });
    expect(result.current).toBe("ok");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
cd yulu/scripts/yulu_ui
npm test -- tests/web/trpc.test.tsx
```

Expected: FAIL (`Cannot find module '../../web/src/trpc.js'`).

- [ ] **Step 3: Implement**

```ts
// web/src/trpc.ts
import { createTRPCReact, httpBatchLink } from "@trpc/react-query";
import type { AppRouter } from "../../src/routers/_app.js";

/**
 * Typed React hooks (`trpc.<router>.<procedure>.useQuery()` / `.useMutation()`).
 * Type imported directly from the server module — no codegen, no publish.
 */
export const trpc = createTRPCReact<AppRouter>();

/**
 * Build a tRPC client for a given base URL. Same-origin in prod (served by the
 * Node server), explicit URL in dev (Vite proxies to :7777).
 */
export function makeTrpcClient(baseUrl = "") {
  return trpc.createClient({
    links: [httpBatchLink({ url: `${baseUrl}/trpc` })],
  });
}
```

- [ ] **Step 4: Re-run, verify PASS**

```bash
npm test -- tests/web/trpc.test.tsx
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/trpc.ts yulu/scripts/yulu_ui/tests/web/trpc.test.tsx
git commit -m "feat(yulu_ui/web): tRPC client with shared AppRouter type"
```

---

## Task B.3 — WebSocket multiplexer client (`ws.ts`)

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/ws.ts`
- Create: `yulu/scripts/yulu_ui/tests/web/ws.test.ts`

- [ ] **Step 1: Write failing test (pure function + hook behavior)**

```ts
// tests/web/ws.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { Server as MockServer, WebSocket as MockWebSocket } from "mock-socket";
import type { ReactNode } from "react";
import { WsProvider, useWsChannel, nextBackoff } from "../../web/src/ws.js";

describe("nextBackoff", () => {
  it("doubles each attempt, caps at 30000ms", () => {
    expect(nextBackoff(0)).toBe(1_000);
    expect(nextBackoff(1)).toBe(2_000);
    expect(nextBackoff(2)).toBe(4_000);
    expect(nextBackoff(3)).toBe(8_000);
    expect(nextBackoff(4)).toBe(16_000);
    expect(nextBackoff(5)).toBe(30_000);
    expect(nextBackoff(10)).toBe(30_000);
  });
});

describe("useWsChannel", () => {
  const URL = "ws://127.0.0.1:17999/ws";
  let server: MockServer;
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    server = new MockServer(URL);
  });
  afterEach(() => {
    cleanup();
    server.stop();
    globalThis.WebSocket = originalWebSocket;
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <WsProvider url={URL}>{children}</WsProvider>;
  }

  it("subscribes on mount, receives published messages, unsubscribes on unmount", async () => {
    const received: unknown[] = [];
    const frames: unknown[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    });

    const { unmount } = renderHook(
      () => useWsChannel("recording", (msg) => received.push(msg)),
      { wrapper },
    );

    // wait for connection
    await vi.waitFor(() => expect(frames).toContainEqual({ type: "subscribe", channel: "recording" }));

    act(() => {
      server.emit("message", JSON.stringify({ channel: "recording", payload: { state: "recording" } }));
    });

    await vi.waitFor(() => expect(received).toEqual([{ state: "recording" }]));

    unmount();
    await vi.waitFor(() => expect(frames).toContainEqual({ type: "unsubscribe", channel: "recording" }));
  });

  it("two subscribers to the same channel dedupe the subscribe frame", async () => {
    const frames: unknown[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    });
    function TwoSubs() {
      useWsChannel("recording", () => {});
      useWsChannel("recording", () => {});
      return null;
    }
    renderHook(() => TwoSubs(), { wrapper });
    await vi.waitFor(() => expect(frames.filter((f) => (f as { type: string }).type === "subscribe")).toHaveLength(1));
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/ws.test.ts
```

Expected: FAIL (`Cannot find module '../../web/src/ws.js'`).

- [ ] **Step 3: Implement**

```ts
// web/src/ws.ts
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import type { AppChannels } from "../../src/pubsub.js";

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

export function nextBackoff(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

interface WsManager {
  subscribe<K extends keyof AppChannels & string>(channel: K, fn: (payload: AppChannels[K]) => void): () => void;
}

const WsContext = createContext<WsManager | null>(null);

interface WsProviderProps {
  url?: string;
  children: ReactNode;
}

/**
 * Owns the single WebSocket connection. Opens lazily on the first subscribe.
 * Reconnects with exponential backoff (1s → 30s). Listeners ref-count per
 * channel so the unsubscribe frame fires only when the last listener leaves.
 */
export function WsProvider({ url, children }: WsProviderProps) {
  const managerRef = useRef<WsManager | null>(null);

  if (!managerRef.current) managerRef.current = createManager(url ?? defaultUrl());

  useEffect(() => () => {
    // Provider unmount = full teardown (page unload)
    (managerRef.current as ReturnType<typeof createManager>).destroy();
    managerRef.current = null;
  }, []);

  return <WsContext.Provider value={managerRef.current}>{children}</WsContext.Provider>;
}

export function useWsChannel<K extends keyof AppChannels & string>(
  channel: K,
  onMessage: (payload: AppChannels[K]) => void,
): void {
  const mgr = useContext(WsContext);
  if (!mgr) throw new Error("useWsChannel must be used inside <WsProvider>");
  const cbRef = useRef(onMessage);
  cbRef.current = onMessage;

  useEffect(() => {
    return mgr.subscribe(channel, (p) => cbRef.current(p));
  }, [mgr, channel]);
}

function defaultUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

interface ManagerInternals extends WsManager {
  destroy(): void;
}

function createManager(url: string): ManagerInternals {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  let socket: WebSocket | null = null;
  let attempt = 0;
  let destroyed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function ensureOpen() {
    if (destroyed) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    const ws = new WebSocket(url);
    socket = ws;
    ws.addEventListener("open", () => {
      attempt = 0;
      // resubscribe everything
      for (const channel of listeners.keys()) ws.send(JSON.stringify({ type: "subscribe", channel }));
    });
    ws.addEventListener("message", (e) => {
      let msg: { channel?: string; payload?: unknown };
      try { msg = JSON.parse(typeof e.data === "string" ? e.data : ""); } catch { return; }
      if (!msg.channel) return;
      const set = listeners.get(msg.channel);
      if (!set) return;
      for (const fn of set) fn(msg.payload);
    });
    const onClose = () => {
      if (destroyed) return;
      socket = null;
      reconnectTimer = setTimeout(ensureOpen, nextBackoff(attempt));
      attempt += 1;
    };
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", () => ws.close());
  }

  function sendIfOpen(frame: object) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  return {
    subscribe(channel, fn) {
      let set = listeners.get(channel);
      const isFirst = !set || set.size === 0;
      if (!set) { set = new Set(); listeners.set(channel, set); }
      set.add(fn as (p: unknown) => void);
      ensureOpen();
      if (isFirst) sendIfOpen({ type: "subscribe", channel });

      return () => {
        const s = listeners.get(channel);
        if (!s) return;
        s.delete(fn as (p: unknown) => void);
        if (s.size === 0) {
          listeners.delete(channel);
          sendIfOpen({ type: "unsubscribe", channel });
        }
      };
    },
    destroy() {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.close();
      socket = null;
      listeners.clear();
    },
  };
}
```

- [ ] **Step 4: Re-run, verify PASS**

```bash
npm test -- tests/web/ws.test.ts
```

Expected: PASS (3 tests — `nextBackoff` + 2 `useWsChannel`).

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/ws.ts yulu/scripts/yulu_ui/tests/web/ws.test.ts
git commit -m "feat(yulu_ui/web): WsProvider + useWsChannel + nextBackoff"
```

---

## Task B.4 — Theme system (`theme.ts`)

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/theme.ts`
- Create: `yulu/scripts/yulu_ui/tests/web/theme.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/theme.test.tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render, renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { ThemeProvider, useTheme } from "../../web/src/theme.js";

function wrapper({ children }: { children: ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

describe("ThemeProvider + useTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("defaults to auto + resolves to dark when matchMedia matches dark", () => {
    (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (q: string) => ({
      matches: q.includes("dark"),
      media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    } as MediaQueryList);

    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.choice).toBe("auto");
    expect(result.current.resolved).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("set('light') persists to localStorage and flips data-theme", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.set("light"));
    expect(localStorage.getItem("yulu_theme")).toBe("light");
    expect(result.current.choice).toBe("light");
    expect(result.current.resolved).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("set('auto') clears localStorage", () => {
    localStorage.setItem("yulu_theme", "dark");
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.set("auto"));
    expect(localStorage.getItem("yulu_theme")).toBeNull();
    expect(result.current.choice).toBe("auto");
  });

  it("reads existing localStorage value on mount", () => {
    localStorage.setItem("yulu_theme", "light");
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.choice).toBe("light");
    expect(result.current.resolved).toBe("light");
  });

  it("renders children without crashing", () => {
    const { getByText } = render(<ThemeProvider><span>hi</span></ThemeProvider>);
    expect(getByText("hi")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/theme.test.tsx
```

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// web/src/theme.ts
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemeChoice = "auto" | "light" | "dark";
type Resolved = "light" | "dark";

interface ThemeContextValue {
  choice: ThemeChoice;
  resolved: Resolved;
  set: (c: ThemeChoice) => void;
}

const KEY = "yulu_theme";

function readStored(): ThemeChoice {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "auto";
}

function systemPrefersDark(): boolean {
  return typeof window.matchMedia === "function" &&
         window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(choice: ThemeChoice): Resolved {
  if (choice === "auto") return systemPrefersDark() ? "dark" : "light";
  return choice;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [choice, setChoice] = useState<ThemeChoice>(() => readStored());
  const [resolved, setResolved] = useState<Resolved>(() => resolve(readStored()));

  // Apply data-theme attribute whenever resolved changes
  useEffect(() => { document.documentElement.setAttribute("data-theme", resolved); }, [resolved]);

  // Track system changes when in auto mode
  useEffect(() => {
    if (choice !== "auto" || typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(mq.matches ? "dark" : "light");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice]);

  const set = useCallback((c: ThemeChoice) => {
    if (c === "auto") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, c);
    setChoice(c);
    setResolved(resolve(c));
  }, []);

  const value = useMemo<ThemeContextValue>(() => ({ choice, resolved, set }), [choice, resolved, set]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const v = useContext(ThemeContext);
  if (!v) throw new Error("useTheme must be used inside <ThemeProvider>");
  return v;
}
```

- [ ] **Step 4: Re-run, verify PASS**

```bash
npm test -- tests/web/theme.test.tsx
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/theme.ts yulu/scripts/yulu_ui/tests/web/theme.test.tsx
git commit -m "feat(yulu_ui/web): ThemeProvider + useTheme + localStorage persist"
```

---

## Task B.5 — Placeholder component

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/Placeholder.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/Placeholder.css`

(No dedicated test — covered by `routes.test.tsx` in B.15 and by Sidebar/TopBar tests that render it.)

- [ ] **Step 1: Implement**

```tsx
// web/src/components/Placeholder.tsx
import "./Placeholder.css";

export interface PlaceholderProps {
  phase: "C" | "D" | "E" | "F" | "G";
  backendNote?: string;
}

export function Placeholder({ phase, backendNote }: PlaceholderProps) {
  return (
    <div className="placeholder">
      <div className="placeholder-label">COMING IN PHASE {phase}</div>
      {backendNote && <div className="placeholder-backend">backend wired: {backendNote}</div>}
    </div>
  );
}
```

```css
/* web/src/components/Placeholder.css */
.placeholder {
  padding: 48px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 12px;
}
.placeholder-label {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.10em;
  color: var(--fg-3);
}
.placeholder-backend {
  font-family: "SF Mono", ui-monospace, "JetBrains Mono", monospace;
  font-size: 11px;
  color: var(--fg-2);
  padding: 6px 10px;
  background: var(--row-hover);
  border-radius: var(--radius-inner);
}
```

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/Placeholder.tsx \
        yulu/scripts/yulu_ui/web/src/components/Placeholder.css
git commit -m "feat(yulu_ui/web): Placeholder component for phase route stubs"
```

---

## Task B.6 — ThemeToggle component

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/ThemeToggle.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/ThemeToggle.css`
- Create: `yulu/scripts/yulu_ui/tests/web/ThemeToggle.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/ThemeToggle.test.tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "../../web/src/theme.js";
import { ThemeToggle } from "../../web/src/components/ThemeToggle.js";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

function mount() {
  return render(<ThemeProvider><ThemeToggle /></ThemeProvider>);
}

describe("ThemeToggle", () => {
  it("renders three segments: Auto, Light, Dark", () => {
    mount();
    expect(screen.getByRole("button", { name: /auto/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /light/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /dark/i })).toBeInTheDocument();
  });

  it("marks the active choice with aria-pressed", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /light/i }));
    expect(screen.getByRole("button", { name: /light/i })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /dark/i })).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.getItem("yulu_theme")).toBe("light");
  });

  it("Auto clears localStorage", async () => {
    localStorage.setItem("yulu_theme", "dark");
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /auto/i }));
    expect(localStorage.getItem("yulu_theme")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/ThemeToggle.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// web/src/components/ThemeToggle.tsx
import { useTheme, type ThemeChoice } from "../theme.js";
import "./ThemeToggle.css";

const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: "auto",  label: "Auto" },
  { value: "light", label: "Light" },
  { value: "dark",  label: "Dark" },
];

export function ThemeToggle() {
  const { choice, set } = useTheme();
  return (
    <div className="theme-toggle" role="group" aria-label="Theme">
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={choice === o.value}
          className={choice === o.value ? "active" : ""}
          onClick={() => set(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
```

```css
/* web/src/components/ThemeToggle.css */
.theme-toggle {
  display: inline-flex;
  background: var(--row-hover);
  border-radius: var(--radius-inner);
  padding: 2px;
  gap: 1px;
}
.theme-toggle button {
  padding: 4px 10px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--fg-2);
  transition: background 120ms, color 120ms;
}
.theme-toggle button:hover { color: var(--fg); }
.theme-toggle button.active {
  background: var(--glass-3);
  color: var(--fg);
}
```

- [ ] **Step 4: Re-run, verify PASS**

```bash
npm test -- tests/web/ThemeToggle.test.tsx
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/ThemeToggle.tsx \
        yulu/scripts/yulu_ui/web/src/components/ThemeToggle.css \
        yulu/scripts/yulu_ui/tests/web/ThemeToggle.test.tsx
git commit -m "feat(yulu_ui/web): ThemeToggle segmented control"
```

---

## Task B.7 — Sidebar component

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/Sidebar.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/Sidebar.css`
- Create: `yulu/scripts/yulu_ui/tests/web/Sidebar.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/Sidebar.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "../../web/src/theme.js";
import { Sidebar } from "../../web/src/components/Sidebar.js";

// Mock the trpc react proxy so Sidebar's useQuery returns deterministic data
vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    sidebar: { counts: { useQuery: () => ({ data: { voicemails: 3, meetings: 5, prompts: 7, glossary: 12 } }) } },
  },
}));

// Stub ws so Sidebar doesn't try to open a real WebSocket
vi.mock("../../web/src/ws.js", () => ({
  useWsChannel: () => {},
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  nextBackoff: (n: number) => n,
}));

function mount(initialPath = "/inbox/voicemails") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ThemeProvider>
        <MemoryRouter initialEntries={[initialPath]}>
          <Sidebar />
        </MemoryRouter>
      </ThemeProvider>
    </QueryClientProvider>,
  );
}

describe("Sidebar", () => {
  it("renders all 13 nav items grouped by section", () => {
    mount();
    expect(screen.getByText("Voicemails")).toBeInTheDocument();
    expect(screen.getByText("Meetings")).toBeInTheDocument();
    expect(screen.getByText("Search")).toBeInTheDocument();
    expect(screen.getByText("Prompts")).toBeInTheDocument();
    expect(screen.getByText("Glossary")).toBeInTheDocument();
    expect(screen.getByText("Audio")).toBeInTheDocument();
    expect(screen.getByText("Transcription")).toBeInTheDocument();
    expect(screen.getByText("LLM")).toBeInTheDocument();
    expect(screen.getByText("Hotkey & UI")).toBeInTheDocument();
    expect(screen.getByText("Integrations")).toBeInTheDocument();
    expect(screen.getByText("Storage")).toBeInTheDocument();
    expect(screen.getByText("Daemons")).toBeInTheDocument();
    expect(screen.getByText("Logs")).toBeInTheDocument();
  });

  it("renders the four count badges from sidebar.counts", () => {
    mount();
    expect(screen.getByTestId("count-voicemails")).toHaveTextContent("3");
    expect(screen.getByTestId("count-meetings")).toHaveTextContent("5");
    expect(screen.getByTestId("count-prompts")).toHaveTextContent("7");
    expect(screen.getByTestId("count-glossary")).toHaveTextContent("12");
  });

  it("renders a static 7 for the Daemons badge (known yulu daemons)", () => {
    mount();
    expect(screen.getByTestId("count-daemons")).toHaveTextContent("7");
  });

  it("marks the active route as aria-current=page", () => {
    mount("/settings/audio");
    expect(screen.getByRole("link", { name: /audio/i })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: /voicemails/i })).not.toHaveAttribute("aria-current");
  });

  it("includes the ThemeToggle in the sidebar", () => {
    mount();
    expect(screen.getByRole("group", { name: /theme/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/Sidebar.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// web/src/components/Sidebar.tsx
import { NavLink } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../trpc.js";
import { useWsChannel } from "../ws.js";
import { ThemeToggle } from "./ThemeToggle.js";
import "./Sidebar.css";

interface NavItem {
  to: string;
  label: string;
  countKey?: "voicemails" | "meetings" | "prompts" | "glossary";
  staticCount?: number;
}

const SECTIONS: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Inbox",
    items: [
      { to: "/inbox/voicemails", label: "Voicemails", countKey: "voicemails" },
      { to: "/inbox/meetings",   label: "Meetings",   countKey: "meetings" },
      { to: "/inbox/search",     label: "Search" },
    ],
  },
  {
    heading: "Knowledge",
    items: [
      { to: "/knowledge/prompts",  label: "Prompts",  countKey: "prompts" },
      { to: "/knowledge/glossary", label: "Glossary", countKey: "glossary" },
    ],
  },
  {
    heading: "Settings",
    items: [
      { to: "/settings/audio",         label: "Audio" },
      { to: "/settings/transcription", label: "Transcription" },
      { to: "/settings/llm",           label: "LLM" },
      { to: "/settings/hotkey",        label: "Hotkey & UI" },
      { to: "/settings/integrations",  label: "Integrations" },
      { to: "/settings/storage",       label: "Storage" },
    ],
  },
  {
    heading: "Health",
    items: [
      { to: "/health/daemons", label: "Daemons", staticCount: 7 },
      { to: "/health/logs",    label: "Logs" },
    ],
  },
];

export function Sidebar() {
  const { data: counts } = trpc.sidebar.counts.useQuery();
  const qc = useQueryClient();
  useWsChannel("sidebar-counts", () => {
    qc.invalidateQueries({ queryKey: [["sidebar", "counts"]] });
  });

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-logo">语</span>
        <span className="sidebar-brand-text">yulu</span>
        <div className="sidebar-brand-spacer" />
        <ThemeToggle />
      </div>

      {SECTIONS.map((section) => (
        <div key={section.heading} className="sidebar-section">
          <div className="sidebar-heading">{section.heading.toUpperCase()}</div>
          {section.items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              className={({ isActive }) => "sidebar-item" + (isActive ? " active" : "")}
            >
              <span className="sidebar-item-label">{it.label}</span>
              {it.countKey && (
                <span className="sidebar-count" data-testid={`count-${it.countKey}`}>
                  {counts?.[it.countKey] ?? "?"}
                </span>
              )}
              {it.staticCount !== undefined && (
                <span className="sidebar-count" data-testid="count-daemons">
                  {it.staticCount}
                </span>
              )}
            </NavLink>
          ))}
        </div>
      ))}
    </aside>
  );
}
```

```css
/* web/src/components/Sidebar.css */
.sidebar {
  width: 168px;
  flex: 0 0 168px;
  height: 100%;
  padding: 14px 10px;
  background: var(--glass);
  backdrop-filter: var(--blur-glass);
  -webkit-backdrop-filter: var(--blur-glass);
  border-radius: var(--radius-panel);
  box-shadow: var(--edge-shadow);
  display: flex;
  flex-direction: column;
  gap: 14px;
  overflow-y: auto;
}
.sidebar-brand {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 6px 8px;
  border-bottom: 1px solid var(--edge);
}
.sidebar-logo { font-size: 16px; color: var(--accent); }
.sidebar-brand-text { font-size: 13px; font-weight: 500; }
.sidebar-brand-spacer { flex: 1; }
.sidebar-section { display: flex; flex-direction: column; gap: 1px; }
.sidebar-heading {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.10em;
  color: var(--fg-3);
  padding: 0 6px 4px;
}
.sidebar-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 8px;
  border-radius: 7px;
  font-size: 13px;
  color: var(--fg-2);
  transition: background 100ms, color 100ms;
}
.sidebar-item:hover { background: var(--row-hover); color: var(--fg); }
.sidebar-item.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.sidebar-count {
  font-size: 11px;
  color: var(--fg-3);
  font-variant-numeric: tabular-nums;
}
.sidebar-item.active .sidebar-count { color: var(--accent); }
```

- [ ] **Step 4: Re-run, verify PASS**

```bash
npm test -- tests/web/Sidebar.test.tsx
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/Sidebar.tsx \
        yulu/scripts/yulu_ui/web/src/components/Sidebar.css \
        yulu/scripts/yulu_ui/tests/web/Sidebar.test.tsx
git commit -m "feat(yulu_ui/web): Sidebar with nav + count badges + ThemeToggle"
```

---

## Task B.8 — TopBar component

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/TopBar.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/TopBar.css`
- Create: `yulu/scripts/yulu_ui/tests/web/TopBar.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/TopBar.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider, Outlet } from "react-router";
import { TopBar } from "../../web/src/components/TopBar.js";

function Layout() { return (<><TopBar /><Outlet /></>); }
function Empty() { return null; }

function mount(opts: {
  path: string;
  routeHandle?: { breadcrumb?: string; filters?: React.ReactNode };
}) {
  const router = createMemoryRouter(
    [{
      path: "/",
      element: <Layout />,
      children: [{
        path: opts.path.replace(/^\//, ""),
        element: <Empty />,
        handle: opts.routeHandle,
      }],
    }],
    { initialEntries: [opts.path] },
  );
  return render(<RouterProvider router={router} />);
}

describe("TopBar", () => {
  it("renders the breadcrumb from the active route's handle", () => {
    mount({ path: "/inbox/voicemails", routeHandle: { breadcrumb: "Inbox / Voicemails" } });
    expect(screen.getByText("Inbox / Voicemails")).toBeInTheDocument();
  });

  it("renders the filters slot when handle.filters is provided", () => {
    mount({ path: "/x", routeHandle: { breadcrumb: "X", filters: <span data-testid="f">filter</span> } });
    expect(screen.getByTestId("f")).toBeInTheDocument();
  });

  it("renders no filters area when handle.filters is null/undefined", () => {
    mount({ path: "/x", routeHandle: { breadcrumb: "X" } });
    expect(screen.queryByTestId("topbar-filters")).not.toBeInTheDocument();
  });

  it("falls back to '—' when no breadcrumb is provided", () => {
    mount({ path: "/x" });
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/TopBar.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// web/src/components/TopBar.tsx
import { useMatches } from "react-router";
import type { ReactNode } from "react";
import "./TopBar.css";

interface RouteHandle {
  breadcrumb?: string;
  filters?: ReactNode;
}

export function TopBar() {
  const matches = useMatches();
  const deepest = matches[matches.length - 1];
  const handle = (deepest?.handle ?? {}) as RouteHandle;
  const breadcrumb = handle.breadcrumb ?? "—";

  return (
    <div className="topbar">
      <div className="topbar-breadcrumb">{breadcrumb}</div>
      {handle.filters && (
        <div className="topbar-filters" data-testid="topbar-filters">
          {handle.filters}
        </div>
      )}
    </div>
  );
}
```

```css
/* web/src/components/TopBar.css */
.topbar {
  display: flex;
  align-items: center;
  padding: 10px 14px;
  background: var(--glass);
  backdrop-filter: var(--blur-glass);
  -webkit-backdrop-filter: var(--blur-glass);
  border-radius: var(--radius-panel);
  box-shadow: var(--edge-shadow);
  gap: 14px;
  min-height: 38px;
}
.topbar-breadcrumb {
  font-size: 13px;
  font-weight: 500;
  color: var(--fg);
}
.topbar-filters {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
```

- [ ] **Step 4: Re-run, verify PASS**

```bash
npm test -- tests/web/TopBar.test.tsx
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/TopBar.tsx \
        yulu/scripts/yulu_ui/web/src/components/TopBar.css \
        yulu/scripts/yulu_ui/tests/web/TopBar.test.tsx
git commit -m "feat(yulu_ui/web): TopBar (breadcrumb + filters slot via route handle)"
```

---

## Task B.9 — Pill component (5-state machine, single file)

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/Pill.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/Pill.css`
- Create: `yulu/scripts/yulu_ui/tests/web/Pill.test.tsx`

- [ ] **Step 1: Write failing test (parameterized over 5 states)**

```tsx
// tests/web/Pill.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { Pill, type PillState } from "../../web/src/components/Pill.js";

const toggleMock = vi.fn();
const stateQueryMock = vi.fn(() => ({ data: { state: "idle", hotkey: "⌘⇧V" } }));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    recording: {
      state: { useQuery: () => stateQueryMock() },
      toggle: { useMutation: () => ({ mutate: toggleMock, isPending: false }) },
    },
  },
}));

const wsHandlers = new Map<string, (payload: unknown) => void>();
vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: (channel: string, fn: (p: unknown) => void) => { wsHandlers.set(channel, fn); },
  nextBackoff: (n: number) => n,
}));

beforeEach(() => {
  toggleMock.mockReset();
  wsHandlers.clear();
  stateQueryMock.mockReturnValue({ data: { state: "idle", hotkey: "⌘⇧V" } });
});

describe("Pill state machine", () => {
  const cases: { state: PillState; mustContain: RegExp }[] = [
    { state: "idle",        mustContain: /record/i },
    { state: "recording",   mustContain: /:[0-9]{2}/ },
    { state: "processing",  mustContain: /transcrib/i },
    { state: "meetingBusy", mustContain: /meeting/i },
    { state: "daemonDown",  mustContain: /audio daemon/i },
  ];

  it.each(cases)("renders the right markup for state: $state", ({ state, mustContain }) => {
    stateQueryMock.mockReturnValueOnce({ data: { state, hotkey: "⌘⇧V" } });
    render(<Pill />);
    expect(screen.getByText(mustContain)).toBeInTheDocument();
  });

  it("clicking the idle pill fires recording.toggle", async () => {
    render(<Pill />);
    const btn = screen.getByRole("button", { name: /record/i });
    btn.click();
    expect(toggleMock).toHaveBeenCalledTimes(1);
  });

  it("transitions to recording when WS publishes recording state", () => {
    render(<Pill />);
    act(() => wsHandlers.get("recording")?.({ state: "recording" }));
    expect(screen.getByText(/:[0-9]{2}/)).toBeInTheDocument();
  });

  it("flips to daemonDown when audiodaemon WS event reports non-running", () => {
    render(<Pill />);
    act(() => wsHandlers.get("daemons")?.({ name: "com.yulu.audiodaemon", status: "stopped", pid: 0 }));
    expect(screen.getByText(/audio daemon/i)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/Pill.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// web/src/components/Pill.tsx
import { useEffect, useState } from "react";
import { trpc } from "../trpc.js";
import { useWsChannel } from "../ws.js";
import "./Pill.css";

export type PillState = "idle" | "recording" | "processing" | "meetingBusy" | "daemonDown";

interface RecordingMsg {
  state: PillState;
  elapsedSec?: number;
  level?: number;
  file?: string;
}

export function Pill() {
  const initial = trpc.recording.state.useQuery();
  const [state, setState] = useState<PillState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const hotkey = (initial.data as { hotkey?: string } | undefined)?.hotkey ?? "⌘⇧V";
  const toggle = trpc.recording.toggle.useMutation();

  // Hydrate from initial fetch
  useEffect(() => {
    const initState = (initial.data as { state?: PillState } | undefined)?.state;
    if (initState) setState(initState);
  }, [initial.data]);

  useWsChannel("recording", (msg: RecordingMsg) => {
    setState(msg.state);
    if (typeof msg.elapsedSec === "number") setElapsed(msg.elapsedSec);
    if (typeof msg.level === "number")      setLevel(msg.level);
  });

  useWsChannel("daemons", (msg) => {
    if (msg.name === "com.yulu.audiodaemon" && msg.status !== "running") setState("daemonDown");
  });

  switch (state) {
    case "idle":
      return (
        <button className="pill pill-idle" onClick={() => toggle.mutate()} aria-label="Record">
          <span className="pill-mic">🎤</span>
          <span className="pill-label">Record</span>
          <span className="pill-hotkey">{hotkey}</span>
        </button>
      );

    case "recording":
      return (
        <div className="pill pill-recording" role="status" aria-label="Recording">
          <span className="pill-dot pulse" />
          <span className="pill-time">{formatElapsed(elapsed)}</span>
          <Meter level={level} />
          <button className="pill-stop" onClick={() => toggle.mutate()} aria-label="Stop recording">■</button>
        </div>
      );

    case "processing":
      return (
        <div className="pill pill-processing" role="status">
          <span className="pill-spinner" />
          <span>Transcribing... {formatElapsed(elapsed)}</span>
        </div>
      );

    case "meetingBusy":
      return (
        <div className="pill pill-meeting" role="status" title={`Meeting in progress`}>
          <span className="pill-dot" />
          <span>Meeting in progress</span>
        </div>
      );

    case "daemonDown":
      return (
        <a className="pill pill-down" href="/health/daemons" role="alert">
          <span className="pill-warn">⚠</span>
          <span>Audio daemon down</span>
        </a>
      );
  }
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function Meter({ level }: { level: number }) {
  const cells = 6;
  const filled = Math.round(Math.max(0, Math.min(1, level)) * cells);
  return (
    <div className="pill-meter" aria-hidden="true">
      {Array.from({ length: cells }).map((_, i) => (
        <span key={i} className={i < filled ? "cell on" : "cell"} />
      ))}
    </div>
  );
}
```

```css
/* web/src/components/Pill.css */
.pill {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 100;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  border-radius: var(--radius-pill);
  background: var(--glass);
  backdrop-filter: var(--blur-pill);
  -webkit-backdrop-filter: var(--blur-pill);
  box-shadow: var(--edge-shadow), var(--shadow);
  font-size: 13px;
  color: var(--fg);
  user-select: none;
}
.pill-idle:hover { background: var(--glass-2); cursor: pointer; }
.pill-mic { font-size: 14px; }
.pill-hotkey {
  font-family: "SF Mono", ui-monospace, monospace;
  font-size: 11px;
  color: var(--fg-3);
}
.pill-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--red);
}
.pill-dot.pulse { animation: pillPulse 1s ease-in-out infinite; }
@keyframes pillPulse { 0%,100% { opacity: 1; } 50% { opacity: 0.45; } }
.pill-time {
  font-family: "SF Mono", ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 13px;
}
.pill-meter { display: inline-flex; gap: 2px; }
.pill-meter .cell {
  width: 4px; height: 12px; border-radius: 1px;
  background: var(--row-hover);
}
.pill-meter .cell.on { background: var(--accent); }
.pill-stop {
  width: 22px; height: 22px;
  border-radius: 6px;
  background: var(--row-hover);
  color: var(--fg);
}
.pill-stop:hover { background: var(--glass-3); }
.pill-processing { color: var(--fg-2); }
.pill-spinner {
  width: 12px; height: 12px;
  border-radius: 50%;
  border: 2px solid var(--fg-3);
  border-top-color: var(--accent);
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.pill-meeting { color: var(--fg-2); }
.pill-meeting .pill-dot { background: var(--fg-3); animation: none; }
.pill-down {
  cursor: pointer;
  color: var(--red);
  box-shadow: var(--edge-shadow), 0 0 0 1px var(--red);
}
.pill-warn { font-size: 14px; }
```

- [ ] **Step 4: Re-run, verify PASS**

```bash
npm test -- tests/web/Pill.test.tsx
```

Expected: PASS (5 parameterized + 3 = 8 tests).

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/Pill.tsx \
        yulu/scripts/yulu_ui/web/src/components/Pill.css \
        yulu/scripts/yulu_ui/tests/web/Pill.test.tsx
git commit -m "feat(yulu_ui/web): Pill component (5-state machine, WS-driven)"
```

---

## Task B.10 — App root + root layout + RouterProvider + providers tree

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/App.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/routes/root.tsx`

This task wires everything together but defers the 13 child routes to B.11. After B.10, `/` should redirect to `/inbox/voicemails` and the root layout (Sidebar + TopBar + outlet + Pill) renders — with the outlet showing an empty fragment for now.

- [ ] **Step 1: Create the root layout**

```tsx
// web/src/routes/root.tsx
import { Outlet } from "react-router";
import { Sidebar } from "../components/Sidebar.js";
import { TopBar } from "../components/TopBar.js";
import { Pill } from "../components/Pill.js";

export function RootLayout() {
  return (
    <div className="root-shell">
      <Sidebar />
      <main className="root-main">
        <TopBar />
        <div className="root-body">
          <Outlet />
        </div>
      </main>
      <Pill />
    </div>
  );
}
```

- [ ] **Step 2: Add the layout styles inline in `wallpaper.css`** (small additions, keep tokens contained)

Append to `web/src/wallpaper.css`:

```css
.root-shell {
  display: flex;
  height: 100vh;
  padding: 12px;
  gap: 10px;
}
.root-main {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
}
.root-body {
  flex: 1;
  overflow-y: auto;
  border-radius: var(--radius-panel);
}
```

- [ ] **Step 3: Replace `App.tsx`** to mount providers + router

```tsx
// web/src/App.tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider } from "react-router";
import { useState } from "react";
import { trpc, makeTrpcClient } from "./trpc.js";
import { ThemeProvider } from "./theme.js";
import { WsProvider } from "./ws.js";
import { RootLayout } from "./routes/root.js";

const router = createBrowserRouter([
  {
    path: "/",
    Component: RootLayout,
    children: [
      // Child routes filled in by Task B.11.
    ],
  },
]);

export function App() {
  const [qc] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
  }));
  const [tc] = useState(() => makeTrpcClient());

  return (
    <ThemeProvider>
      <trpc.Provider client={tc} queryClient={qc}>
        <QueryClientProvider client={qc}>
          <WsProvider>
            <RouterProvider router={router} />
          </WsProvider>
        </QueryClientProvider>
      </trpc.Provider>
    </ThemeProvider>
  );
}
```

- [ ] **Step 4: Build check (no test yet — B.15 covers route smoke)**

```bash
cd yulu/scripts/yulu_ui
npm run typecheck
npm test     # both projects still pass
```

Expected: PASS.

- [ ] **Step 5: Verify Vite dev renders the shell**

```bash
npm run dev:web &
DEV_PID=$!
sleep 2
curl -s http://127.0.0.1:5173/ | head -c 200
kill $DEV_PID
```

Expected: HTML response contains `<div id="root"></div>` and `script type="module" src="/src/main.tsx"`. (The actual rendered shell needs a real browser — covered by B.16 smoke.)

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/App.tsx \
        yulu/scripts/yulu_ui/web/src/routes/root.tsx \
        yulu/scripts/yulu_ui/web/src/wallpaper.css
git commit -m "feat(yulu_ui/web): App + RootLayout + providers tree (router child routes deferred to B.11)"
```

---

## Task B.11 — 13 placeholder routes + router child registration

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/App.tsx` (add 13 child route entries)
- Create: 13 route files under `yulu/scripts/yulu_ui/web/src/routes/`:
  - `inbox/voicemails.tsx`, `inbox/meetings.tsx`, `inbox/search.tsx`
  - `knowledge/prompts.tsx`, `knowledge/glossary.tsx`
  - `settings/audio.tsx`, `settings/transcription.tsx`, `settings/llm.tsx`, `settings/hotkey.tsx`, `settings/integrations.tsx`, `settings/storage.tsx`
  - `health/daemons.tsx`, `health/logs.tsx`

All 13 routes follow the same pattern, so they ship in one commit. No per-route tests — B.15's `routes.test.tsx` smoke-tests all of them parameterized.

- [ ] **Step 1: Create the inbox routes**

```tsx
// web/src/routes/inbox/voicemails.tsx
import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";

export const handle = { breadcrumb: "Inbox / Voicemails", filters: null };

export function Voicemails() {
  const { data } = trpc.voicemails.list.useQuery({});
  return <Placeholder phase="C" backendNote={`voicemails.list returned ${data?.length ?? "…"} rows`} />;
}
```

```tsx
// web/src/routes/inbox/meetings.tsx
import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";

export const handle = { breadcrumb: "Inbox / Meetings", filters: null };

export function Meetings() {
  const { data } = trpc.meetings.list.useQuery({});
  return <Placeholder phase="C" backendNote={`meetings.list returned ${data?.length ?? "…"} rows`} />;
}
```

```tsx
// web/src/routes/inbox/search.tsx
import { Placeholder } from "../../components/Placeholder.js";

export const handle = { breadcrumb: "Inbox / Search", filters: null };

export function Search() {
  // search.run requires a query; we just render the placeholder without firing a real query.
  return <Placeholder phase="C" backendNote="search.run available; UI deferred to Phase C" />;
}
```

- [ ] **Step 2: Create the knowledge routes**

```tsx
// web/src/routes/knowledge/prompts.tsx
import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";

export const handle = { breadcrumb: "Knowledge / Prompts", filters: null };

export function Prompts() {
  const { data } = trpc.prompts.list.useQuery({});
  return <Placeholder phase="E" backendNote={`prompts.list returned ${data?.length ?? "…"} rows`} />;
}
```

```tsx
// web/src/routes/knowledge/glossary.tsx
import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";

export const handle = { breadcrumb: "Knowledge / Glossary", filters: null };

export function Glossary() {
  const { data } = trpc.glossary.list.useQuery();
  return <Placeholder phase="E" backendNote={`glossary.list returned ${data?.length ?? "…"} rows`} />;
}
```

- [ ] **Step 3: Create the settings routes (6 files)**

```tsx
// web/src/routes/settings/audio.tsx
import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";
export const handle = { breadcrumb: "Settings / Audio", filters: null };
export function SettingsAudio() {
  const { data } = trpc.config.get.useQuery();
  return <Placeholder phase="D" backendNote={`config.get loaded; audio backend = ${data?.audio.backend ?? "?"}`} />;
}
```

```tsx
// web/src/routes/settings/transcription.tsx
import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";
export const handle = { breadcrumb: "Settings / Transcription", filters: null };
export function SettingsTranscription() {
  const { data } = trpc.config.get.useQuery();
  return <Placeholder phase="D" backendNote={`config.get loaded; final_engine = ${data?.transcription.final_engine ?? "?"}`} />;
}
```

```tsx
// web/src/routes/settings/llm.tsx
import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";
export const handle = { breadcrumb: "Settings / LLM", filters: null };
export function SettingsLlm() {
  const { data } = trpc.config.get.useQuery();
  return <Placeholder phase="D" backendNote={`config.get loaded; llm.enabled = ${String(data?.llm?.enabled ?? "?")}`} />;
}
```

```tsx
// web/src/routes/settings/hotkey.tsx
import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";
export const handle = { breadcrumb: "Settings / Hotkey & UI", filters: null };
export function SettingsHotkey() {
  const { data } = trpc.config.get.useQuery();
  return <Placeholder phase="D" backendNote={`hotkey key = ${data?.status_agent?.hotkey.key ?? "?"}`} />;
}
```

```tsx
// web/src/routes/settings/integrations.tsx
import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";
export const handle = { breadcrumb: "Settings / Integrations", filters: null };
export function SettingsIntegrations() {
  const { data } = trpc.config.get.useQuery();
  return <Placeholder phase="D" backendNote={`calendars count = ${data?.calendars?.length ?? 0}`} />;
}
```

```tsx
// web/src/routes/settings/storage.tsx
import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";
export const handle = { breadcrumb: "Settings / Storage", filters: null };
export function SettingsStorage() {
  const { data } = trpc.config.get.useQuery();
  return <Placeholder phase="D" backendNote={`output_dir = ${data?.audio.output_dir ?? "?"}`} />;
}
```

- [ ] **Step 4: Create the health routes**

```tsx
// web/src/routes/health/daemons.tsx
import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";

export const handle = { breadcrumb: "Health / Daemons", filters: null };

export function HealthDaemons() {
  const { data } = trpc.daemons.health.useQuery(undefined, { refetchInterval: 5_000 });
  const running = data?.filter((d) => d.status === "running").length ?? 0;
  return <Placeholder phase="F" backendNote={`daemons.health returned ${data?.length ?? "…"} daemons; ${running} running`} />;
}
```

```tsx
// web/src/routes/health/logs.tsx
import { trpc } from "../../trpc.js";
import { Placeholder } from "../../components/Placeholder.js";

export const handle = { breadcrumb: "Health / Logs", filters: null };

export function HealthLogs() {
  const { data } = trpc.logs.tail.useQuery({ name: "com.yulu.audiodaemon", limit: 1 });
  return <Placeholder phase="F" backendNote={`logs.tail returned ${data?.lines.length ?? "…"} line(s)`} />;
}
```

- [ ] **Step 5: Wire all 13 routes into the router in `App.tsx`**

Replace the empty `children: []` array in `App.tsx` with the full set, plus an index redirect:

```tsx
// web/src/App.tsx — replace just the router definition

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider, Navigate } from "react-router";
import { useState } from "react";
import { trpc, makeTrpcClient } from "./trpc.js";
import { ThemeProvider } from "./theme.js";
import { WsProvider } from "./ws.js";
import { RootLayout } from "./routes/root.js";
import { Voicemails, handle as voicemailsHandle } from "./routes/inbox/voicemails.js";
import { Meetings,   handle as meetingsHandle   } from "./routes/inbox/meetings.js";
import { Search,     handle as searchHandle     } from "./routes/inbox/search.js";
import { Prompts,    handle as promptsHandle    } from "./routes/knowledge/prompts.js";
import { Glossary,   handle as glossaryHandle   } from "./routes/knowledge/glossary.js";
import { SettingsAudio,         handle as audioHandle         } from "./routes/settings/audio.js";
import { SettingsTranscription, handle as transcriptionHandle } from "./routes/settings/transcription.js";
import { SettingsLlm,           handle as llmHandle           } from "./routes/settings/llm.js";
import { SettingsHotkey,        handle as hotkeyHandle        } from "./routes/settings/hotkey.js";
import { SettingsIntegrations,  handle as integrationsHandle  } from "./routes/settings/integrations.js";
import { SettingsStorage,       handle as storageHandle       } from "./routes/settings/storage.js";
import { HealthDaemons, handle as daemonsHandle } from "./routes/health/daemons.js";
import { HealthLogs,    handle as logsHandle    } from "./routes/health/logs.js";

const router = createBrowserRouter([
  {
    path: "/",
    Component: RootLayout,
    children: [
      { index: true, element: <Navigate to="/inbox/voicemails" replace /> },
      { path: "inbox/voicemails",     Component: Voicemails,           handle: voicemailsHandle },
      { path: "inbox/meetings",       Component: Meetings,             handle: meetingsHandle },
      { path: "inbox/search",         Component: Search,               handle: searchHandle },
      { path: "knowledge/prompts",    Component: Prompts,              handle: promptsHandle },
      { path: "knowledge/glossary",   Component: Glossary,             handle: glossaryHandle },
      { path: "settings/audio",         Component: SettingsAudio,         handle: audioHandle },
      { path: "settings/transcription", Component: SettingsTranscription, handle: transcriptionHandle },
      { path: "settings/llm",           Component: SettingsLlm,           handle: llmHandle },
      { path: "settings/hotkey",        Component: SettingsHotkey,        handle: hotkeyHandle },
      { path: "settings/integrations",  Component: SettingsIntegrations,  handle: integrationsHandle },
      { path: "settings/storage",       Component: SettingsStorage,       handle: storageHandle },
      { path: "health/daemons",         Component: HealthDaemons,         handle: daemonsHandle },
      { path: "health/logs",            Component: HealthLogs,            handle: logsHandle },
    ],
  },
]);

export function App() {
  const [qc] = useState(() => new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: 1 } },
  }));
  const [tc] = useState(() => makeTrpcClient());

  return (
    <ThemeProvider>
      <trpc.Provider client={tc} queryClient={qc}>
        <QueryClientProvider client={qc}>
          <WsProvider>
            <RouterProvider router={router} />
          </WsProvider>
        </QueryClientProvider>
      </trpc.Provider>
    </ThemeProvider>
  );
}
```

- [ ] **Step 6: Typecheck + test**

```bash
cd yulu/scripts/yulu_ui
npm run typecheck
npm test
```

Expected: PASS (no new tests, all existing pass).

- [ ] **Step 7: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/App.tsx \
        yulu/scripts/yulu_ui/web/src/routes/inbox/ \
        yulu/scripts/yulu_ui/web/src/routes/knowledge/ \
        yulu/scripts/yulu_ui/web/src/routes/settings/ \
        yulu/scripts/yulu_ui/web/src/routes/health/
git commit -m "feat(yulu_ui/web): scaffold all 13 placeholder routes + child route registration"
```

---

## Task B.12 — Server SPA fallback + static asset serving (`staticFile.ts`)

**Files:**
- Create: `yulu/scripts/yulu_ui/src/staticFile.ts`
- Modify: `yulu/scripts/yulu_ui/src/server.ts`
- Modify: `yulu/scripts/yulu_ui/tests/server.test.ts`

- [ ] **Step 1: Write failing test — extend the existing server test**

Append to `tests/server.test.ts` (inside the existing `describe("server")` block):

```ts
import { mkdirSync as _mkdirSync, writeFileSync as _writeFileSync } from "node:fs";

// ... existing tests ...

it("serves /assets/* from dist/web/assets with the right Content-Type", async () => {
  // Bootstrap a fake built UI directory for this test
  const distWeb = join(env.root, "dist/web/assets");
  _mkdirSync(distWeb, { recursive: true });
  _writeFileSync(join(distWeb, "smoke.css"), ".x{color:red}");
  process.env.YULU_UI_DIST_WEB = join(env.root, "dist/web");  // server reads this for tests

  const r = await fetch(`${env.baseUrl}/assets/smoke.css`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toMatch(/text\/css/);
  expect(await r.text()).toContain("color:red");
});

it("falls back to index.html for unknown SPA paths", async () => {
  // Ensure index.html exists
  const distWeb = join(env.root, "dist/web");
  _mkdirSync(distWeb, { recursive: true });
  _writeFileSync(join(distWeb, "index.html"), "<!doctype html><html><body>SPA</body></html>");
  process.env.YULU_UI_DIST_WEB = distWeb;

  const r = await fetch(`${env.baseUrl}/inbox/voicemails`);
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toMatch(/text\/html/);
  expect(await r.text()).toContain("SPA");
});

it("503s when SPA index.html is missing (dev-without-build scenario)", async () => {
  delete process.env.YULU_UI_DIST_WEB;
  const r = await fetch(`${env.baseUrl}/some/unknown/path`);
  expect(r.status).toBe(503);
  expect(await r.text()).toMatch(/UI not built/);
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/server.test.ts
```

Expected: FAIL (no `/assets/*` route, no SPA fallback).

- [ ] **Step 3: Implement `src/staticFile.ts`**

```ts
// src/staticFile.ts
import { createReadStream, statSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { Readable } from "node:stream";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".woff2":"font/woff2",
  ".woff": "font/woff",
  ".ico":  "image/x-icon",
  ".map":  "application/json; charset=utf-8",
};

function mimeFor(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Serve a single file from disk, optionally under a fixed name (used for
 * SPA fallback where the request URL doesn't map to a file). Supports HTTP
 * Range so the audio file routes can keep using the same helper.
 */
export function serveStaticFile(req: Request, baseDir: string, fixedName?: string): Response {
  const url = new URL(req.url);
  const rel = fixedName ?? decodeURIComponent(url.pathname.replace(/^\/(?:assets\/)?/, ""));
  // Guard against ../ traversal
  if (rel.includes("..")) return new Response("forbidden", { status: 403 });
  const path = join(baseDir, rel);
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  const stat = statSync(path);
  if (!stat.isFile()) return new Response("not found", { status: 404 });

  const type = mimeFor(path);
  const range = req.headers.get("range");
  if (!range) {
    const body = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Length": String(stat.size),
        "Content-Type":   type,
        "Accept-Ranges":  "bytes",
        // hash-named asset chunks are immutable; index.html should not be cached this long
        "Cache-Control":  fixedName === "index.html" ? "no-cache" : "public, max-age=31536000, immutable",
      },
    });
  }
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  const start = m ? Number(m[1]) : 0;
  const end   = m && m[2] ? Number(m[2]) : stat.size - 1;
  const body = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream;
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Range":  `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges":  "bytes",
      "Content-Length": String(end - start + 1),
      "Content-Type":   type,
    },
  });
}
```

- [ ] **Step 4: Modify `src/server.ts` — add `/assets/*` route + SPA fallback**

Edit `src/server.ts`. After the existing `/files/meetings/*` route and **before** the `createServer` call, insert:

```ts
import { serveStaticFile } from "./staticFile.js";

// ... inside startServer(), AFTER the /files routes:

const distWebDir = () => process.env.YULU_UI_DIST_WEB ?? join(__dirname, "../dist/web");

app.get("/assets/*", (c) => serveStaticFile(c.req.raw, join(distWebDir(), "assets")));

// SPA fallback — must be the last GET route
app.get("*", (c) => {
  if (c.req.method !== "GET") return c.text("not found", 404);
  const indexPath = join(distWebDir(), "index.html");
  if (!existsSync(indexPath)) {
    return c.text("UI not built — run `npm run build` or use `npm run dev:web`", 503);
  }
  return serveStaticFile(c.req.raw, distWebDir(), "index.html");
});
```

Add the `__dirname` derivation near the top of `src/server.ts` if not already present:

```ts
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
```

(If your existing `src/server.ts` already derives `__dirname`, skip that import.)

- [ ] **Step 5: Re-run, verify PASS**

```bash
npm test -- tests/server.test.ts
```

Expected: PASS (all server tests + 3 new ones).

- [ ] **Step 6: Verify full suite still passes**

```bash
npm test
npm run typecheck
```

- [ ] **Step 7: Commit**

```bash
git add yulu/scripts/yulu_ui/src/staticFile.ts \
        yulu/scripts/yulu_ui/src/server.ts \
        yulu/scripts/yulu_ui/tests/server.test.ts
git commit -m "feat(yulu_ui): serveStaticFile + SPA fallback + /assets/* on Node server"
```

---

## Task B.13 — Unified build (esbuild server + vite build web)

**Files:**
- Verify: `yulu/scripts/yulu_ui/package.json` scripts (already added in B.1)
- No code changes — verification + commit only.

- [ ] **Step 1: Clean rebuild from a fresh state**

```bash
cd yulu/scripts/yulu_ui
rm -rf dist node_modules
npm install
npm run build
```

Expected: `dist/server.js` (~440 KB) + `dist/web/index.html` + `dist/web/assets/*.{js,css}` all produced.

- [ ] **Step 2: Verify the built bundle smoke-tests end-to-end**

```bash
YULU_UI_PORT=17777 node dist/server.js > /tmp/yulu_ui_b13.log 2>&1 &
SERVER_PID=$!
sleep 1
echo "--- /healthz ---"
curl -s http://127.0.0.1:17777/healthz
echo
echo "--- / (SPA index) ---"
curl -s http://127.0.0.1:17777/ | head -c 200
echo
echo "--- /trpc/system.version ---"
curl -s http://127.0.0.1:17777/trpc/system.version
echo
echo "--- /inbox/voicemails (SPA fallback) ---"
curl -s http://127.0.0.1:17777/inbox/voicemails | head -c 60
echo
echo "--- /assets first asset ---"
ASSET=$(ls dist/web/assets/ | head -1)
curl -sI http://127.0.0.1:17777/assets/$ASSET | head -3
kill $SERVER_PID
```

Expected:
- `/healthz` returns `{"status":"ok",...}`
- `/` returns the SPA `<!doctype html>` with `#root` div
- `/trpc/system.version` returns `{"result":{"data":{"name":"yulu-ui",...}}}`
- `/inbox/voicemails` returns the same SPA HTML (SPA fallback works)
- `/assets/<file>` returns 200 + appropriate Content-Type

- [ ] **Step 3: No commit — nothing changed**

This task is verification-only; if anything fails, fix it before moving on. The build script wiring already shipped in B.1.

---

## Task B.14 — Dev workflow smoke (`npm run dev`)

**Files:** none — verification of B.1's `dev` script.

- [ ] **Step 1: Start both processes via `npm run dev`**

```bash
cd yulu/scripts/yulu_ui
npm run dev > /tmp/yulu_ui_dev.log 2>&1 &
DEV_PID=$!
sleep 4

# Server (:7777) up
curl -s http://127.0.0.1:7777/healthz
echo
# Vite (:5173) up
curl -s http://127.0.0.1:5173/ | head -c 100
echo
# tRPC proxy through Vite
curl -s http://127.0.0.1:5173/trpc/system.version
echo

kill $DEV_PID
wait 2>/dev/null
```

Expected:
- `/healthz` from :7777 returns ok.
- :5173 returns the SPA index HTML.
- :5173 /trpc/system.version returns the same JSON as the direct :7777 call (proxy works).

- [ ] **Step 2: Verify Vite WebSocket proxy works**

A scripted assertion would require opening a real WS client; manual confirmation via browser devtools is the standard path. Document the expectation:

> Open `http://127.0.0.1:5173/` in a browser → DevTools → Network → WS tab shows a single `/ws` connection upgraded successfully (101 Switching Protocols). This is also verified end-to-end in B.16.

- [ ] **Step 3: No commit — verification only.**

---

## Task B.15 — Routes smoke test (parameterized)

**Files:**
- Create: `yulu/scripts/yulu_ui/tests/web/routes.test.tsx`

- [ ] **Step 1: Write the parameterized smoke test**

```tsx
// tests/web/routes.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ThemeProvider } from "../../web/src/theme.js";
import { WsProvider } from "../../web/src/ws.js";

// Stub trpc so every router call returns an empty/safe payload — the goal is mount-without-crash
vi.mock("../../web/src/trpc.js", () => {
  const noop = () => ({ data: undefined, isPending: false });
  const okMutation = () => ({ mutate: () => {}, isPending: false });
  return {
    trpc: new Proxy({}, {
      get() {
        return new Proxy({}, {
          get() {
            return { useQuery: noop, useMutation: okMutation };
          },
        });
      },
    }),
    makeTrpcClient: () => ({}),
  };
});

// Stub ws so no real WebSocket opens during tests
vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: () => {},
  nextBackoff: (n: number) => n,
}));

import { Voicemails } from "../../web/src/routes/inbox/voicemails.js";
import { Meetings }   from "../../web/src/routes/inbox/meetings.js";
import { Search }     from "../../web/src/routes/inbox/search.js";
import { Prompts }    from "../../web/src/routes/knowledge/prompts.js";
import { Glossary }   from "../../web/src/routes/knowledge/glossary.js";
import { SettingsAudio }         from "../../web/src/routes/settings/audio.js";
import { SettingsTranscription } from "../../web/src/routes/settings/transcription.js";
import { SettingsLlm }           from "../../web/src/routes/settings/llm.js";
import { SettingsHotkey }        from "../../web/src/routes/settings/hotkey.js";
import { SettingsIntegrations }  from "../../web/src/routes/settings/integrations.js";
import { SettingsStorage }       from "../../web/src/routes/settings/storage.js";
import { HealthDaemons } from "../../web/src/routes/health/daemons.js";
import { HealthLogs }    from "../../web/src/routes/health/logs.js";

const ROUTES: { name: string; Component: React.ComponentType }[] = [
  { name: "inbox/voicemails",       Component: Voicemails },
  { name: "inbox/meetings",         Component: Meetings },
  { name: "inbox/search",           Component: Search },
  { name: "knowledge/prompts",      Component: Prompts },
  { name: "knowledge/glossary",     Component: Glossary },
  { name: "settings/audio",         Component: SettingsAudio },
  { name: "settings/transcription", Component: SettingsTranscription },
  { name: "settings/llm",           Component: SettingsLlm },
  { name: "settings/hotkey",        Component: SettingsHotkey },
  { name: "settings/integrations",  Component: SettingsIntegrations },
  { name: "settings/storage",       Component: SettingsStorage },
  { name: "health/daemons",         Component: HealthDaemons },
  { name: "health/logs",            Component: HealthLogs },
];

describe("placeholder routes smoke", () => {
  it.each(ROUTES)("$name mounts without throwing", ({ Component }) => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([{ path: "/", element: <Component /> }], { initialEntries: ["/"] });
    expect(() =>
      render(
        <ThemeProvider>
          <QueryClientProvider client={qc}>
            <WsProvider>
              <RouterProvider router={router} />
            </WsProvider>
          </QueryClientProvider>
        </ThemeProvider>,
      ),
    ).not.toThrow();
  });

  it("has exactly 13 routes", () => {
    expect(ROUTES).toHaveLength(13);
  });
});
```

- [ ] **Step 2: Run, verify PASS**

```bash
npm test -- tests/web/routes.test.tsx
```

Expected: PASS (14 tests = 13 routes + count assertion).

- [ ] **Step 3: Full suite check**

```bash
npm test
npm run typecheck
```

Expected: server project 41+3 = 44 passing, web project 5+3+5+3+5+4+8+14 = 47 passing, total ~91. (Exact count depends on assertions per test; the important property is "all green".)

- [ ] **Step 4: Commit**

```bash
git add yulu/scripts/yulu_ui/tests/web/routes.test.tsx
git commit -m "test(yulu_ui/web): parameterized mount smoke for all 13 placeholder routes"
```

---

## Task B.16 — Real-machine smoke (dev + prod)

**Files:** none — manual + scripted verification on the developer's actual machine.

- [ ] **Step 1: Production-mode smoke**

```bash
cd yulu/scripts/yulu_ui
rm -rf dist
npm install
npm run build
YULU_UI_PORT=17778 node dist/server.js > /tmp/yulu_ui_prod_smoke.log 2>&1 &
PROD_PID=$!
sleep 1

echo "=== healthz ==="
curl -s http://127.0.0.1:17778/healthz
echo

echo "=== system.version ==="
curl -s http://127.0.0.1:17778/trpc/system.version
echo

echo "=== / (SPA) ==="
curl -s http://127.0.0.1:17778/ | grep -E 'root|main\.tsx|/assets' | head -3

echo "=== /inbox/voicemails (SPA fallback) ==="
curl -sI http://127.0.0.1:17778/inbox/voicemails | head -3

ASSET=$(ls dist/web/assets/ | head -1)
echo "=== /assets/$ASSET ==="
curl -sI "http://127.0.0.1:17778/assets/$ASSET" | head -3

kill $PROD_PID
```

Expected: every check returns a 200 with the appropriate content. SPA fallback returns text/html, asset returns its declared MIME with `Cache-Control: public, max-age=31536000, immutable`.

- [ ] **Step 2: Dev-mode smoke (two processes)**

```bash
cd yulu/scripts/yulu_ui
npm run dev > /tmp/yulu_ui_dev_smoke.log 2>&1 &
DEV_PID=$!
sleep 4

echo "=== :7777 healthz ==="
curl -s http://127.0.0.1:7777/healthz
echo

echo "=== :5173 / ==="
curl -s http://127.0.0.1:5173/ | grep -E 'root|main\.tsx' | head -1

echo "=== :5173 /trpc/system.version (proxy) ==="
curl -s http://127.0.0.1:5173/trpc/system.version
echo

kill $DEV_PID
wait 2>/dev/null
```

Expected: server up, vite up, vite proxy forwards `/trpc` to :7777 successfully.

- [ ] **Step 3: Browser smoke (manual)**

Open `http://127.0.0.1:5173/` in a real browser (run `npm run dev` first). Verify visually:

1. Sidebar renders with all 13 nav items grouped under Inbox / Knowledge / Settings / Health.
2. Count badges show numbers (or `?` if backend DBs are missing for prompts/vocab) — open DevTools Network and confirm `/trpc/sidebar.counts` returns 200.
3. TopBar shows breadcrumb `Inbox / Voicemails` after the index redirect.
4. Pill bottom-right shows `[🎤] Record ⌘⇧V` (idle).
5. Clicking each sidebar item navigates and shows the corresponding placeholder with the backend confirmation line.
6. Click ThemeToggle → "Light" — the whole shell flips to Ayu Light palette; reload — still light. Click "Auto" — clears localStorage; system preference takes over.
7. DevTools Network → WS tab → exactly one `/ws` connection in `101 Switching Protocols` state.

If anything visually wrong, fix and re-verify before declaring Phase B done. (Visual fidelity is acceptance criterion #3 + #4 + #5 from the spec.)

- [ ] **Step 4: Verify the existing `com.yulu.ui` LaunchAgent integration is not broken**

If you already loaded the LaunchAgent in Phase A (deferred via consent), confirm:

```bash
launchctl list | grep com.yulu.ui
curl -s http://127.0.0.1:7777/healthz
```

If you haven't loaded it (recommended path from Phase A), this step is informational only.

- [ ] **Step 5: Final commit (no code; reflects readiness)**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git log --oneline -25
git push
```

Push the branch (already has upstream from Phase A).

---

## Self-review (run before declaring Phase B done)

Skim each acceptance criterion in the spec (§10) and confirm:

- [ ] §10 #1 `npm install && npm test` — verified in B.15 step 3
- [ ] §10 #2 `npm run typecheck` clean — verified in every task
- [ ] §10 #3 `npm run dev` shell loads + sidebar/topbar/pill render — verified in B.14 + B.16 step 3
- [ ] §10 #4 Every sidebar item navigates + placeholder shows backend confirmation — verified in B.16 step 3
- [ ] §10 #5 Theme toggle persists Light/Dark, Auto clears storage + tracks system — verified in B.6 tests + B.16 step 3
- [ ] §10 #6 `npm run build` produces both bundles, sizes reasonable — verified in B.13
- [ ] §10 #7 Prod bundle serves SPA + tRPC + healthz — verified in B.13 + B.16 step 1
- [ ] §10 #8 Single WS connection per page, exp-backoff reconnect on server restart — partial (single connection verified, backoff covered by ws.test.ts pure-function tests; live reconnect visual in browser only)

Type consistency check:
- `AppRouter` imported in `web/src/trpc.ts` matches the export in `src/routers/_app.ts`
- `AppChannels` imported in `web/src/ws.ts` matches the export in `src/pubsub.ts`
- All 13 route files export `handle` with `{ breadcrumb: string; filters: ReactNode | null }` shape — TopBar's `RouteHandle` interface accepts this
- `Sidebar`'s `countKey` union (`"voicemails" | "meetings" | "prompts" | "glossary"`) matches the four keys in `sidebar.counts` return type — verified at runtime in B.7 tests, at typecheck via `trpc` return type
- `PillState` 5-variant union covers spec §8.1/§8.2/§8.3's state list

If any check fails, fix inline before pushing.

---

## What's NOT in Phase B (deferred to Phases C–G)

| Phase | Scope | Why deferred |
|---|---|---|
| C | Real Inbox bodies (Voicemails / Meetings / Search); first `wavesurfer.js` wiring; first TopBar filter group | Each page is non-trivial; spec gives them dedicated §7 entries |
| D | Real Settings bodies; inline-edit pattern; restart banner driven by `config.update`'s daemonsNeedingRestart result | Inline edit + restart banner is a cross-cutting interaction worth its own pass |
| E | Real Knowledge bodies (Prompts / Glossary); inline table edit pattern | Reuses inline-edit pattern from D |
| F | Real Health bodies (Daemons grid / Logs tail with WS-driven `useWsChannel("logs", ...)`) | Backend is already live; B's placeholder confirms it |
| G | `setup.sh` integration; `yulu doctor` entry; release packaging; LaunchAgent install consolidation | Cross-cutting deployment work |
