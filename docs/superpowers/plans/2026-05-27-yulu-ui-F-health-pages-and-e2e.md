# Yulu UI · Phase F — Health Pages + Playwright E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase B placeholders for `/health/daemons` and `/health/logs` with two interactive pages. Add a server-side log tailer that publishes new log lines via WS so the Logs page auto-scrolls. Install Playwright and ship one critical-flow E2E spec covering all real pages from Phases C–E.

**Architecture:** Backend adds one new module (`src/logTailer.ts`) that watches `~/.config/yulu/*.log` and publishes new lines to the existing `logs` AppChannel. Frontend adds two components (`<DaemonCard>`, `<LogTail>`) and rewires the two Health route files. E2E adds `@playwright/test`, `playwright.config.ts`, and one critical-flow spec.

**Tech Stack:** React 18 · React Router 7 · @tanstack/react-query 5 + @trpc/react-query 11 · Node `fs.watch` + `fs.openSync`/`readSync` for tail-from-position · vanilla CSS · vitest + jsdom + @testing-library/react · @playwright/test

**Spec reference:** [`docs/superpowers/specs/2026-05-27-yulu-ui-F-health-pages-and-e2e-design.md`](../specs/2026-05-27-yulu-ui-F-health-pages-and-e2e-design.md)

**Out of scope (deferred to G):** Log rotation detection; in-log search; setup.sh integration; yulu doctor; release packaging; E2E in CI.

**Path conventions:** All paths relative to repo root. Server work in `yulu/scripts/yulu_ui/src/`; React work in `yulu/scripts/yulu_ui/web/`; E2E at `yulu/scripts/yulu_ui/e2e/`. Commands run from `yulu/scripts/yulu_ui/` unless noted.

---

## File Structure

```
yulu/scripts/yulu_ui/
├── src/
│   ├── logTailer.ts                              NEW (F.1)
│   └── server.ts                                  MOD (start tailer in startServer)
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
├── package.json                                   MOD (F.6: add @playwright/test + e2e script)
├── .gitignore (web/yulu_ui local one)             MOD (F.6: exclude test-results/playwright-report)
└── tests/
    ├── logTailer.test.ts                          NEW (F.1, server vitest project)
    └── web/
        ├── DaemonCard.test.tsx                    NEW (F.2)
        ├── LogTail.test.tsx                       NEW (F.3)
        ├── health.daemons.test.tsx                NEW (F.4)
        └── health.logs.test.tsx                   NEW (F.5)
```

8 tasks: F.1 (backend) · F.2–F.3 (components) · F.4–F.5 (pages) · F.6–F.7 (E2E) · F.8 (smoke).

---

## Task F.1 — `logTailer.ts` server module

**Files:**
- Create: `yulu/scripts/yulu_ui/src/logTailer.ts`
- Modify: `yulu/scripts/yulu_ui/src/server.ts` (start tailer in startServer + stop in close)
- Create: `yulu/scripts/yulu_ui/tests/logTailer.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/logTailer.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startLogTailer, type LogTailer } from "../src/logTailer.js";
import { PubSub, type AppChannels } from "../src/pubsub.js";

describe("logTailer", () => {
  let root: string;
  let tailer: LogTailer | undefined;
  let pubsub: PubSub<AppChannels>;
  let events: AppChannels["logs"][];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "yulu_lt_"));
    pubsub = new PubSub<AppChannels>();
    events = [];
    pubsub.subscribe("logs", (m) => events.push(m));
  });
  afterEach(() => {
    tailer?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  function waitMs(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

  it("publishes new lines appended to a watched log file", async () => {
    writeFileSync(join(root, "audiodaemon.log"), "initial\n");
    tailer = startLogTailer({ configDir: root, pubsub });
    await waitMs(50);
    appendFileSync(join(root, "audiodaemon.log"), "new line 1\nnew line 2\n");
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(2), { timeout: 1000 });
    const lines = events.filter((e) => e.name === "audiodaemon").map((e) => e.line);
    expect(lines).toEqual(expect.arrayContaining(["new line 1", "new line 2"]));
  });

  it("uses the short daemon name (sans com.yulu. prefix) in published events", async () => {
    writeFileSync(join(root, "sttdaemon.log"), "");
    tailer = startLogTailer({ configDir: root, pubsub });
    await waitMs(50);
    appendFileSync(join(root, "sttdaemon.log"), "hello\n");
    await vi.waitFor(() => expect(events.some((e) => e.name === "sttdaemon")).toBe(true));
  });

  it("skips missing log files silently (no throw)", () => {
    expect(() => {
      tailer = startLogTailer({ configDir: root, pubsub });   // root has no .log files
    }).not.toThrow();
  });

  it("emits events with numeric ts (timestamp in ms)", async () => {
    writeFileSync(join(root, "agentqueue.log"), "");
    tailer = startLogTailer({ configDir: root, pubsub });
    await waitMs(50);
    appendFileSync(join(root, "agentqueue.log"), "x\n");
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0));
    expect(typeof events[0]!.ts).toBe("number");
    expect(events[0]!.ts).toBeGreaterThan(0);
  });

  it("ignores empty trailing lines (final \\n does not emit an empty-string event)", async () => {
    writeFileSync(join(root, "scheduler.log"), "");
    tailer = startLogTailer({ configDir: root, pubsub });
    await waitMs(50);
    appendFileSync(join(root, "scheduler.log"), "one\ntwo\n");
    await vi.waitFor(() => expect(events.length).toBeGreaterThanOrEqual(2));
    expect(events.every((e) => e.line !== "")).toBe(true);
  });

  it("stop() closes watchers (no further events after stop + append)", async () => {
    writeFileSync(join(root, "detector.log"), "");
    tailer = startLogTailer({ configDir: root, pubsub });
    await waitMs(50);
    tailer.stop();
    tailer = undefined;
    const before = events.length;
    appendFileSync(join(root, "detector.log"), "after stop\n");
    await waitMs(200);
    expect(events.length).toBe(before);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
cd yulu/scripts/yulu_ui
npm test -- tests/logTailer.test.ts
```

Expected: FAIL (`Cannot find module '../src/logTailer.js'`).

- [ ] **Step 3: Implement `src/logTailer.ts`**

```ts
// src/logTailer.ts
import { watch, type FSWatcher, existsSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import type { PubSub, AppChannels } from "./pubsub.js";

const DAEMON_SHORT_NAMES = [
  "audiodaemon", "sttdaemon", "agentqueue", "statusagent",
  "scheduler", "detector", "calendar", "ui",
] as const;

const READ_CHUNK_SIZE = 64 * 1024;

export interface LogTailerOptions {
  configDir: string;
  pubsub: PubSub<AppChannels>;
}

export interface LogTailer {
  stop(): void;
}

/**
 * Tails all known yulu daemon log files in `configDir`. On change, reads the
 * bytes appended since last poll, splits on newline, and publishes one event
 * per line via the `logs` channel.
 *
 * Strategy: open each existing file read-only, record current size, watch
 * via fs.watch. On change events, read from last position to current size
 * and emit. Empty trailing lines are skipped.
 */
export function startLogTailer(opts: LogTailerOptions): LogTailer {
  const watchers: FSWatcher[] = [];
  const fds: number[] = [];
  const positions = new Map<string, number>();   // daemon short name → last read offset
  const pending = new Set<string>();              // debounce: in-flight reads per daemon

  function pollFile(shortName: string, path: string, fd: number) {
    if (pending.has(shortName)) return;
    pending.add(shortName);
    queueMicrotask(() => {
      try {
        const stat = statSync(path);
        const lastPos = positions.get(shortName) ?? stat.size;
        if (stat.size <= lastPos) {
          // File truncated (rotation) — reset to current end and skip
          positions.set(shortName, stat.size);
          return;
        }
        let pos = lastPos;
        const buf = Buffer.alloc(READ_CHUNK_SIZE);
        let leftover = "";
        while (pos < stat.size) {
          const toRead = Math.min(READ_CHUNK_SIZE, stat.size - pos);
          const n = readSync(fd, buf, 0, toRead, pos);
          if (n <= 0) break;
          const text = leftover + buf.subarray(0, n).toString("utf8");
          const lines = text.split("\n");
          leftover = lines.pop() ?? "";
          for (const line of lines) {
            if (line.length === 0) continue;
            opts.pubsub.publish("logs", { name: shortName, line, ts: Date.now() });
          }
          pos += n;
        }
        positions.set(shortName, pos);
      } catch {
        // best-effort; on error, skip this poll cycle
      } finally {
        pending.delete(shortName);
      }
    });
  }

  for (const shortName of DAEMON_SHORT_NAMES) {
    const path = join(opts.configDir, `${shortName}.log`);
    if (!existsSync(path)) continue;
    try {
      const fd = openSync(path, "r");
      positions.set(shortName, statSync(path).size);   // start tailing from end
      fds.push(fd);
      const w = watch(path, { persistent: false }, () => pollFile(shortName, path, fd));
      w.on("error", () => { /* swallow */ });
      watchers.push(w);
    } catch {
      // Skip files we can't open
    }
  }

  return {
    stop() {
      for (const w of watchers) w.close();
      for (const fd of fds) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    },
  };
}
```

- [ ] **Step 4: Wire into `server.ts`**

In `yulu/scripts/yulu_ui/src/server.ts`, add an import at the top:

```ts
import { startLogTailer } from "./logTailer.js";
```

Inside `startServer()`, **after** the existing `startInboxWatcher` call, add:

```ts
const logTailer = startLogTailer({
  configDir: paths.configDir,
  pubsub: appPubSub,
});
```

Modify the returned `close` function to also call `logTailer.stop()` before existing teardown:

```ts
close: () => new Promise<void>((resolve) => {
  inboxWatcher.stop();
  logTailer.stop();
  http.close(() => resolve());
}),
```

(If your existing `close` has a different shape, integrate the `logTailer.stop()` call next to `inboxWatcher.stop()`.)

- [ ] **Step 5: Re-run + full suite + typecheck**

```bash
npm test -- tests/logTailer.test.ts
npm test
npm run typecheck
```

Expected: 6 tailer tests PASS + full suite ~278 passing.

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/yulu_ui/src/logTailer.ts \
        yulu/scripts/yulu_ui/src/server.ts \
        yulu/scripts/yulu_ui/tests/logTailer.test.ts
git commit -m "feat(yulu_ui): logTailer publishes new log lines on logs WS channel"
```

---

## Task F.2 — `<DaemonCard>` component

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/DaemonCard.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/DaemonCard.css`
- Create: `yulu/scripts/yulu_ui/tests/web/DaemonCard.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/DaemonCard.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { DaemonCard, type DaemonHealth } from "../../web/src/components/DaemonCard.js";

const RUNNING: DaemonHealth = {
  name: "com.yulu.audiodaemon",
  status: "running",
  pid: 1234,
  exitStatus: 0,
  lastLog: "Listening on /Users/x/.config/yulu/audio_daemon.sock",
};

function mount(daemon: DaemonHealth, opts: Partial<{ onRestart: (n: string) => void; onStop: (n: string) => void }> = {}) {
  return render(
    <MemoryRouter>
      <DaemonCard
        daemon={daemon}
        onRestart={opts.onRestart ?? (() => {})}
        onStop={opts.onStop ?? (() => {})}
      />
    </MemoryRouter>
  );
}

describe("DaemonCard", () => {
  it("renders short daemon name (strips com.yulu. prefix)", () => {
    mount(RUNNING);
    expect(screen.getByText("audiodaemon")).toBeInTheDocument();
  });

  it("renders status pill with correct data-status", () => {
    const { container } = mount(RUNNING);
    const pill = container.querySelector(".status-pill");
    expect(pill).not.toBeNull();
    expect(pill).toHaveAttribute("data-status", "running");
    expect(pill?.textContent).toMatch(/running/);
  });

  it("shows ⚠ glyph for crashed status", () => {
    mount({ ...RUNNING, status: "crashed", exitStatus: 137 });
    expect(screen.getByText(/⚠/)).toBeInTheDocument();
  });

  it("shows ⏸ glyph for stopped status", () => {
    mount({ ...RUNNING, status: "stopped", pid: 0 });
    expect(screen.getByText(/⏸/)).toBeInTheDocument();
  });

  it("renders PID + last log line", () => {
    mount(RUNNING);
    expect(screen.getByText(/PID 1234/)).toBeInTheDocument();
    expect(screen.getByText(/Listening on/)).toBeInTheDocument();
  });

  it("Restart button click fires onRestart with the full daemon name", async () => {
    const onRestart = vi.fn();
    mount(RUNNING, { onRestart });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^restart$/i }));
    expect(onRestart).toHaveBeenCalledWith("com.yulu.audiodaemon");
  });

  it("Stop button click fires onStop with the full daemon name", async () => {
    const onStop = vi.fn();
    mount(RUNNING, { onStop });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^stop$/i }));
    expect(onStop).toHaveBeenCalledWith("com.yulu.audiodaemon");
  });

  it("View logs → links to /health/logs?name=<full-name>", () => {
    mount(RUNNING);
    const link = screen.getByRole("link", { name: /view logs/i });
    expect(link).toHaveAttribute("href", "/health/logs?name=com.yulu.audiodaemon");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/DaemonCard.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// web/src/components/DaemonCard.tsx
import { Link } from "react-router";
import "./DaemonCard.css";

export interface DaemonHealth {
  name: string;
  status: "running" | "stopped" | "crashed";
  pid: number;
  exitStatus: number;
  lastLog: string;
}

export interface DaemonCardProps {
  daemon: DaemonHealth;
  onRestart: (name: string) => void;
  onStop: (name: string) => void;
  restartPending?: boolean;
  stopPending?: boolean;
}

const STATUS_GLYPH: Record<DaemonHealth["status"], string> = {
  running: "●",
  stopped: "⏸",
  crashed: "⚠",
};

const STATUS_LABEL: Record<DaemonHealth["status"], string> = {
  running: "running",
  stopped: "stopped",
  crashed: "crashed",
};

export function DaemonCard({ daemon, onRestart, onStop, restartPending, stopPending }: DaemonCardProps) {
  const shortName = daemon.name.replace(/^com\.yulu\./, "");
  return (
    <div className="daemon-card" data-status={daemon.status}>
      <div className="daemon-card-header">
        <div className="daemon-card-name">{shortName}</div>
        <span className="status-pill" data-status={daemon.status}>
          <span className="status-pill-glyph">{STATUS_GLYPH[daemon.status]}</span>
          <span className="status-pill-label">{STATUS_LABEL[daemon.status]}</span>
        </span>
      </div>
      <div className="daemon-card-meta">
        <div className="daemon-card-pid">PID {daemon.pid || "—"}</div>
        <div className="daemon-card-lastlog" title={daemon.lastLog}>{daemon.lastLog || "(no log entries yet)"}</div>
      </div>
      <div className="daemon-card-actions">
        <button
          type="button"
          className="daemon-card-btn restart"
          onClick={() => onRestart(daemon.name)}
          disabled={restartPending}
        >
          Restart
        </button>
        <button
          type="button"
          className="daemon-card-btn stop"
          onClick={() => onStop(daemon.name)}
          disabled={stopPending || daemon.status === "stopped"}
        >
          Stop
        </button>
        <Link to={`/health/logs?name=${encodeURIComponent(daemon.name)}`} className="daemon-card-btn link">
          View logs →
        </Link>
      </div>
    </div>
  );
}
```

```css
/* web/src/components/DaemonCard.css */
.daemon-card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 14px;
  background: var(--glass);
  border-radius: var(--radius-panel);
  box-shadow: var(--edge-shadow);
  min-width: 0;
}
.daemon-card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.daemon-card-name {
  font-size: 13px;
  font-weight: 500;
  color: var(--fg);
  font-family: "SF Mono", ui-monospace, monospace;
}
.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 500;
}
.status-pill[data-status="running"] {
  background: rgba(186, 230, 126, 0.18);
  color: var(--green);
}
.status-pill[data-status="stopped"] {
  background: var(--row-hover);
  color: var(--fg-3);
}
.status-pill[data-status="crashed"] {
  background: rgba(255, 123, 114, 0.18);
  color: var(--red);
}
.status-pill-glyph { font-size: 9px; }
.daemon-card-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.daemon-card-pid {
  font-size: 10px;
  color: var(--fg-3);
  font-family: "SF Mono", ui-monospace, monospace;
}
.daemon-card-lastlog {
  font-size: 11px;
  color: var(--fg-2);
  font-family: "SF Mono", ui-monospace, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.daemon-card-actions {
  display: flex;
  gap: 6px;
  padding-top: 4px;
  border-top: 1px solid var(--edge);
}
.daemon-card-btn {
  padding: 3px 10px;
  font-size: 11px;
  border-radius: var(--radius-inner);
  text-decoration: none;
  background: var(--row-hover);
  color: var(--fg-2);
  border: none;
  cursor: pointer;
}
.daemon-card-btn:hover { color: var(--fg); background: var(--glass-3); }
.daemon-card-btn.restart { color: var(--accent); }
.daemon-card-btn.restart:hover { background: var(--accent-soft); }
.daemon-card-btn.stop { color: var(--red); }
.daemon-card-btn.stop:hover { background: rgba(255, 123, 114, 0.18); }
.daemon-card-btn.link { color: var(--fg-3); margin-left: auto; }
.daemon-card-btn:disabled { opacity: 0.4; cursor: not-allowed; }
```

- [ ] **Step 4: Re-run + full suite + typecheck**

```bash
npm test -- tests/web/DaemonCard.test.tsx
npm test
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/DaemonCard.tsx \
        yulu/scripts/yulu_ui/web/src/components/DaemonCard.css \
        yulu/scripts/yulu_ui/tests/web/DaemonCard.test.tsx
git commit -m "feat(yulu_ui/web): DaemonCard (status pill + meta + actions)"
```

---

## Task F.3 — `<LogTail>` component

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/LogTail.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/LogTail.css`
- Create: `yulu/scripts/yulu_ui/tests/web/LogTail.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/LogTail.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { LogTail } from "../../web/src/components/LogTail.js";

const wsHandlers = new Map<string, (payload: { name: string; line: string; ts: number }) => void>();

vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: (channel: string, fn: (msg: { name: string; line: string; ts: number }) => void) => {
    wsHandlers.set(channel, fn);
  },
  nextBackoff: (n: number) => n,
}));

beforeEach(() => { wsHandlers.clear(); });

describe("LogTail", () => {
  it("renders initial lines in order", () => {
    render(<LogTail daemonShortName="audiodaemon" daemonLabel="com.yulu.audiodaemon" initialLines={["line 1", "line 2", "line 3"]} paused={false} onClear={() => {}} />);
    const pre = screen.getByTestId("logtail-pre");
    expect(pre.textContent).toContain("line 1");
    expect(pre.textContent).toContain("line 2");
    expect(pre.textContent).toContain("line 3");
  });

  it("WS event with matching name appends a new line", () => {
    render(<LogTail daemonShortName="audiodaemon" daemonLabel="com.yulu.audiodaemon" initialLines={["one"]} paused={false} onClear={() => {}} />);
    act(() => wsHandlers.get("logs")?.({ name: "audiodaemon", line: "two", ts: 123 }));
    expect(screen.getByTestId("logtail-pre").textContent).toContain("two");
  });

  it("WS event with NON-matching name is ignored", () => {
    render(<LogTail daemonShortName="audiodaemon" daemonLabel="com.yulu.audiodaemon" initialLines={["one"]} paused={false} onClear={() => {}} />);
    act(() => wsHandlers.get("logs")?.({ name: "sttdaemon", line: "noise", ts: 123 }));
    expect(screen.getByTestId("logtail-pre").textContent).not.toContain("noise");
  });

  it("paused=true: WS events are NOT appended", () => {
    render(<LogTail daemonShortName="audiodaemon" daemonLabel="com.yulu.audiodaemon" initialLines={["one"]} paused onClear={() => {}} />);
    act(() => wsHandlers.get("logs")?.({ name: "audiodaemon", line: "two", ts: 123 }));
    expect(screen.getByTestId("logtail-pre").textContent).not.toContain("two");
  });

  it("renders empty state when no initial lines and no WS events", () => {
    render(<LogTail daemonShortName="agentqueue" daemonLabel="com.yulu.agentqueue" initialLines={[]} paused={false} onClear={() => {}} />);
    expect(screen.getByText(/no log entries yet/i)).toBeInTheDocument();
  });

  it("caps line buffer at 2000 (drops oldest)", () => {
    render(<LogTail daemonShortName="ui" daemonLabel="com.yulu.ui" initialLines={[]} paused={false} onClear={() => {}} />);
    act(() => {
      for (let i = 0; i < 2100; i++) {
        wsHandlers.get("logs")?.({ name: "ui", line: `line ${i}`, ts: i });
      }
    });
    const pre = screen.getByTestId("logtail-pre");
    expect(pre.textContent).not.toContain("line 0");
    expect(pre.textContent).toContain("line 2099");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/LogTail.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// web/src/components/LogTail.tsx
import { useEffect, useRef, useState } from "react";
import { useWsChannel } from "../ws.js";
import "./LogTail.css";

export interface LogTailProps {
  daemonShortName: string;
  daemonLabel: string;
  initialLines: string[];
  paused: boolean;
  onClear: () => void;
}

const MAX_LINES = 2000;
const AUTOSCROLL_THRESHOLD_PX = 50;

export function LogTail({ daemonShortName, daemonLabel, initialLines, paused }: LogTailProps) {
  const [lines, setLines] = useState<string[]>(initialLines);
  const preRef = useRef<HTMLPreElement>(null);
  const pausedRef = useRef(paused);

  useEffect(() => { pausedRef.current = paused; }, [paused]);
  useEffect(() => { setLines(initialLines); }, [initialLines]);

  useWsChannel("logs", (msg) => {
    if (msg.name !== daemonShortName) return;
    if (pausedRef.current) return;
    setLines((prev) => {
      const next = prev.concat(msg.line);
      if (next.length > MAX_LINES) return next.slice(next.length - MAX_LINES);
      return next;
    });
  });

  // Auto-scroll to bottom unless user scrolled up
  useEffect(() => {
    const pre = preRef.current;
    if (!pre) return;
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < AUTOSCROLL_THRESHOLD_PX;
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }, [lines]);

  if (lines.length === 0) {
    return (
      <div className="logtail" data-daemon={daemonLabel}>
        <div className="logtail-empty">No log entries yet for {daemonShortName}.</div>
      </div>
    );
  }

  return (
    <div className="logtail" data-daemon={daemonLabel}>
      <pre ref={preRef} className="logtail-pre" data-testid="logtail-pre">
        {lines.map((line, i) => (
          <div key={i} className="logtail-line">{line}</div>
        ))}
      </pre>
    </div>
  );
}
```

```css
/* web/src/components/LogTail.css */
.logtail {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--wp-1);
  border-radius: var(--radius-panel);
  overflow: hidden;
}
.logtail-pre {
  flex: 1;
  overflow-y: auto;
  margin: 0;
  padding: 8px 12px;
  font-family: "SF Mono", ui-monospace, monospace;
  font-size: 11px;
  line-height: 1.5;
  color: var(--fg-2);
  white-space: pre-wrap;
  word-break: break-all;
}
.logtail-line { padding: 0; }
.logtail-empty {
  padding: 40px;
  text-align: center;
  color: var(--fg-3);
  font-size: 12px;
}
```

- [ ] **Step 4: Re-run + full suite + typecheck**

```bash
npm test -- tests/web/LogTail.test.tsx
npm test
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/LogTail.tsx \
        yulu/scripts/yulu_ui/web/src/components/LogTail.css \
        yulu/scripts/yulu_ui/tests/web/LogTail.test.tsx
git commit -m "feat(yulu_ui/web): LogTail (auto-scroll + WS-driven append + 2000-line cap)"
```

---

## Task F.4 — Health/Daemons page

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/health/daemons.tsx` (REPLACE placeholder)
- Create: `yulu/scripts/yulu_ui/web/src/routes/health/daemons.css`
- Create: `yulu/scripts/yulu_ui/tests/web/health.daemons.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/health.daemons.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HealthDaemons } from "../../web/src/routes/health/daemons.js";

const HEALTH = [
  { name: "com.yulu.audiodaemon", status: "running",  pid: 1234, exitStatus: 0, lastLog: "Listening" },
  { name: "com.yulu.sttdaemon",    status: "running",  pid: 1235, exitStatus: 0, lastLog: "Ready" },
  { name: "com.yulu.agentqueue",   status: "stopped",  pid: 0,    exitStatus: 0, lastLog: "" },
  { name: "com.yulu.statusagent",  status: "running",  pid: 1236, exitStatus: 0, lastLog: "" },
  { name: "com.yulu.scheduler",    status: "running",  pid: 1237, exitStatus: 0, lastLog: "" },
  { name: "com.yulu.detector",     status: "crashed",  pid: 0,    exitStatus: 137, lastLog: "OOM" },
  { name: "com.yulu.calendar",     status: "stopped",  pid: 0,    exitStatus: 0, lastLog: "" },
  { name: "com.yulu.ui",           status: "running",  pid: 1238, exitStatus: 0, lastLog: "" },
];

const restartMutate = vi.fn(async () => ({ ok: true }));
const stopMutate    = vi.fn(async () => ({ ok: true }));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    daemons: {
      health:  { useQuery: () => ({ data: HEALTH, isPending: false }) },
      restart: { useMutation: () => ({ mutateAsync: restartMutate, isPending: false }) },
      stop:    { useMutation: () => ({ mutateAsync: stopMutate, isPending: false }) },
    },
  },
}));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <HealthDaemons />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("HealthDaemons page", () => {
  it("renders 8 daemon cards", () => {
    mount();
    const cards = screen.getAllByText(/^(audiodaemon|sttdaemon|agentqueue|statusagent|scheduler|detector|calendar|ui)$/);
    expect(cards).toHaveLength(8);
  });

  it("shows status pills with right counts (5 running, 2 stopped, 1 crashed)", () => {
    const { container } = mount();
    expect(container.querySelectorAll('[data-status="running"].status-pill')).toHaveLength(5);
    expect(container.querySelectorAll('[data-status="stopped"].status-pill')).toHaveLength(2);
    expect(container.querySelectorAll('[data-status="crashed"].status-pill')).toHaveLength(1);
  });

  it("clicking Restart on audiodaemon card calls daemons.restart with full name", async () => {
    mount();
    const user = userEvent.setup();
    const restartButtons = screen.getAllByRole("button", { name: /^restart$/i });
    await user.click(restartButtons[0]!);   // first card = audiodaemon (HEALTH[0])
    expect(restartMutate).toHaveBeenCalledWith({ name: "com.yulu.audiodaemon" });
  });

  it("View logs → links point to /health/logs?name=<full-name>", () => {
    mount();
    const links = screen.getAllByRole("link", { name: /view logs/i });
    expect(links[0]).toHaveAttribute("href", "/health/logs?name=com.yulu.audiodaemon");
    expect(links[5]).toHaveAttribute("href", "/health/logs?name=com.yulu.detector");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/health.daemons.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// web/src/routes/health/daemons.tsx
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../../trpc.js";
import { DaemonCard, type DaemonHealth } from "../../components/DaemonCard.js";
import "./daemons.css";

export const handle = { breadcrumb: "Health / Daemons", filters: null };

export function HealthDaemons() {
  const { data } = trpc.daemons.health.useQuery(undefined, { refetchInterval: 5_000 });
  const qc = useQueryClient();
  const invalidate = () => qc.invalidateQueries({ queryKey: [["daemons", "health"]] });

  const restartMut = trpc.daemons.restart.useMutation({ onSuccess: invalidate });
  const stopMut    = trpc.daemons.stop.useMutation({ onSuccess: invalidate });

  const daemons = (data as DaemonHealth[] | undefined) ?? [];

  return (
    <div className="daemons-page">
      <div className="daemons-grid">
        {daemons.map((d) => (
          <DaemonCard
            key={d.name}
            daemon={d}
            onRestart={(n) => restartMut.mutateAsync({ name: n as never })}
            onStop={(n) => stopMut.mutateAsync({ name: n as never })}
            restartPending={restartMut.isPending}
            stopPending={stopMut.isPending}
          />
        ))}
      </div>
    </div>
  );
}
```

```css
/* web/src/routes/health/daemons.css */
.daemons-page {
  padding: 12px 14px;
}
.daemons-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 12px;
}
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/health/daemons.tsx \
        yulu/scripts/yulu_ui/web/src/routes/health/daemons.css \
        yulu/scripts/yulu_ui/tests/web/health.daemons.test.tsx
git commit -m "feat(yulu_ui/web): Health/Daemons page (grid of 8 cards + 5s polling)"
```

---

## Task F.5 — Health/Logs page

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/health/logs.tsx` (REPLACE placeholder)
- Create: `yulu/scripts/yulu_ui/web/src/routes/health/logs.css`
- Create: `yulu/scripts/yulu_ui/tests/web/health.logs.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/health.logs.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HealthLogs } from "../../web/src/routes/health/logs.js";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    logs: {
      tail: { useQuery: ({ name }: { name: string }) => ({
        data: { lines: [`first line for ${name}`, "second line"], path: `/x/${name}.log` },
        isPending: false,
      }) },
    },
  },
}));

vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: () => {},
  nextBackoff: (n: number) => n,
}));

function mount(initialPath = "/health/logs") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/health/logs", Component: HealthLogs }], { initialEntries: [initialPath] });
  return render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
}

describe("HealthLogs page", () => {
  it("default daemon is com.yulu.audiodaemon when no ?name= param", () => {
    mount();
    expect(screen.getByText(/first line for com\.yulu\.audiodaemon/)).toBeInTheDocument();
  });

  it("?name= param sets initial selection", () => {
    mount("/health/logs?name=com.yulu.sttdaemon");
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("com.yulu.sttdaemon");
    expect(screen.getByText(/first line for com\.yulu\.sttdaemon/)).toBeInTheDocument();
  });

  it("dropdown has 8 options (one per yulu daemon)", () => {
    mount();
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.options.length).toBe(8);
  });

  it("changing dropdown updates URL + content", async () => {
    mount();
    const user = userEvent.setup();
    const select = screen.getByRole("combobox");
    await user.selectOptions(select, "com.yulu.scheduler");
    expect(screen.getByText(/first line for com\.yulu\.scheduler/)).toBeInTheDocument();
  });

  it("renders Pause + Clear buttons", () => {
    mount();
    expect(screen.getByRole("button", { name: /pause auto-scroll/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /clear scrollback/i })).toBeInTheDocument();
  });

  it("clicking Pause toggles label to Resume", async () => {
    mount();
    const user = userEvent.setup();
    const btn = screen.getByRole("button", { name: /pause auto-scroll/i });
    await user.click(btn);
    expect(screen.getByRole("button", { name: /^resume$/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/health.logs.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// web/src/routes/health/logs.tsx
import { useState } from "react";
import { useSearchParams } from "react-router";
import { trpc } from "../../trpc.js";
import { LogTail } from "../../components/LogTail.js";
import "./logs.css";

export const handle = { breadcrumb: "Health / Logs", filters: null };

const YULU_DAEMONS = [
  "com.yulu.audiodaemon",
  "com.yulu.sttdaemon",
  "com.yulu.agentqueue",
  "com.yulu.statusagent",
  "com.yulu.scheduler",
  "com.yulu.detector",
  "com.yulu.calendar",
  "com.yulu.ui",
] as const;

type DaemonName = typeof YULU_DAEMONS[number];

export function HealthLogs() {
  const [params, setParams] = useSearchParams();
  const fullName = (params.get("name") ?? "com.yulu.audiodaemon") as DaemonName;
  const shortName = fullName.replace(/^com\.yulu\./, "");
  const [paused, setPaused] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const { data } = trpc.logs.tail.useQuery({ name: fullName, limit: 500 });
  const initial = (data?.lines as string[] | undefined) ?? [];

  const setName = (v: string) => {
    const next = new URLSearchParams(params);
    next.set("name", v);
    setParams(next, { replace: true });
  };

  return (
    <div className="logs-page">
      <div className="logs-header">
        <select
          aria-label="Daemon"
          className="logs-select"
          value={fullName}
          onChange={(e) => setName(e.target.value)}
        >
          {YULU_DAEMONS.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <button type="button" className="logs-btn" onClick={() => setPaused((p) => !p)}>
          {paused ? "Resume" : "Pause auto-scroll"}
        </button>
        <button type="button" className="logs-btn" onClick={() => setResetKey((k) => k + 1)}>
          Clear scrollback
        </button>
      </div>
      <LogTail
        key={`${shortName}-${resetKey}`}
        daemonShortName={shortName}
        daemonLabel={fullName}
        initialLines={initial}
        paused={paused}
        onClear={() => setResetKey((k) => k + 1)}
      />
    </div>
  );
}
```

```css
/* web/src/routes/health/logs.css */
.logs-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 10px 14px;
  gap: 10px;
}
.logs-header {
  display: flex;
  gap: 8px;
  align-items: center;
}
.logs-select {
  padding: 6px 10px;
  border-radius: var(--radius-inner);
  background: var(--glass);
  color: var(--fg);
  font-size: 12px;
  font-family: "SF Mono", ui-monospace, monospace;
  border: none;
}
.logs-btn {
  padding: 5px 12px;
  border-radius: var(--radius-inner);
  background: var(--row-hover);
  color: var(--fg-2);
  font-size: 11px;
  border: none;
  cursor: pointer;
}
.logs-btn:hover { color: var(--fg); background: var(--glass-3); }
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/health/logs.tsx \
        yulu/scripts/yulu_ui/web/src/routes/health/logs.css \
        yulu/scripts/yulu_ui/tests/web/health.logs.test.tsx
git commit -m "feat(yulu_ui/web): Health/Logs page (dropdown + LogTail + pause/clear)"
```

---

## Task F.6 — Playwright setup

**Files:**
- Modify: `yulu/scripts/yulu_ui/package.json` (add `@playwright/test` dep + `e2e` script)
- Create: `yulu/scripts/yulu_ui/playwright.config.ts`
- Modify: `yulu/scripts/yulu_ui/.gitignore` (add test-results + playwright-report)

- [ ] **Step 1: Install Playwright**

```bash
cd yulu/scripts/yulu_ui
npm install --save-dev @playwright/test@^1.48.0
npx playwright install chromium
```

- [ ] **Step 2: Create `playwright.config.ts`**

```ts
// playwright.config.ts
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: "http://127.0.0.1:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 30_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
```

- [ ] **Step 3: Add `e2e` script to `package.json`**

Find the existing `scripts` block in `yulu/scripts/yulu_ui/package.json` and add:

```json
"e2e": "playwright test",
"e2e:ui": "playwright test --ui"
```

- [ ] **Step 4: Update `.gitignore`**

In `yulu/scripts/yulu_ui/.gitignore`, append:

```
test-results/
playwright-report/
```

- [ ] **Step 5: Verify install**

```bash
npx playwright --version
```

Expected: `Version 1.48.x` (or similar).

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/yulu_ui/package.json yulu/scripts/yulu_ui/package-lock.json \
        yulu/scripts/yulu_ui/playwright.config.ts \
        yulu/scripts/yulu_ui/.gitignore
git commit -m "chore(yulu_ui): install @playwright/test + config (e2e script)"
```

---

## Task F.7 — Critical-flow E2E spec

**Files:**
- Create: `yulu/scripts/yulu_ui/e2e/critical.spec.ts`

- [ ] **Step 1: Write the spec**

```ts
// e2e/critical.spec.ts
import { test, expect } from "@playwright/test";

test.describe.configure({ mode: "serial" });

test("shell loads + redirects /  to /inbox/voicemails", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/inbox\/voicemails/);
  // Sidebar present
  await expect(page.getByText("yulu").first()).toBeVisible();
  await expect(page.getByText("Voicemails").first()).toBeVisible();
});

test("Inbox/Voicemails — list renders + clicking a row opens reader", async ({ page }) => {
  await page.goto("/inbox/voicemails");
  // Filter chips present
  await expect(page.getByRole("button", { name: "All", exact: true })).toBeVisible();
  // At least one row OR empty state — both acceptable
  const rows = page.getByTestId("voicemail-row");
  const count = await rows.count();
  if (count === 0) {
    test.info().annotations.push({ type: "skip", description: "no voicemails on this machine" });
    return;
  }
  await rows.first().click();
  // Reader is visible (Audio play button + tab bar)
  await expect(page.getByRole("button", { name: /play|pause/i })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Transcript" })).toBeVisible();
});

test("Inbox/Search — input writes to URL", async ({ page }) => {
  await page.goto("/inbox/search");
  const input = page.getByRole("searchbox");
  await input.fill("OKR");
  await expect(page).toHaveURL(/q=OKR/, { timeout: 2_000 });
});

test("Settings/Audio — editing silence_threshold flashes restart banner", async ({ page }) => {
  await page.goto("/settings/audio");
  await expect(page.getByText("Silence threshold")).toBeVisible();
  // Click the displayed value to enter edit
  const valueDisplay = page.locator(".value-display").filter({ hasText: /^\d+(\.\d+)?$/ }).first();
  await valueDisplay.click();
  const input = page.getByRole("spinbutton").first();
  const currentValue = await input.inputValue();
  await input.fill(String(parseFloat(currentValue || "0.01") + 0.001));
  await input.press("Enter");
  await expect(page.getByText(/restart required/i)).toBeVisible({ timeout: 5_000 });
});

test("Knowledge/Prompts — new prompt mode hides Delete, Save disabled until valid", async ({ page }) => {
  await page.goto("/knowledge/prompts");
  await page.getByRole("link", { name: /\+ new prompt/i }).click();
  await expect(page).toHaveURL(/\/knowledge\/prompts\/new/);
  // Delete button should NOT exist in create mode
  await expect(page.getByRole("button", { name: /^delete$/i })).toHaveCount(0);
  // Save disabled
  await expect(page.getByRole("button", { name: /^save$/i })).toBeDisabled();
  // Fill required + Save enables
  await page.getByLabel(/^name$/i).fill("E2E Test Prompt");
  await page.getByLabel(/^slug$/i).fill("e2e-test-prompt");
  await page.getByLabel(/^content$/i).fill("Body");
  await expect(page.getByRole("button", { name: /^save$/i })).toBeEnabled();
});

test("Knowledge/Glossary — table renders + Add term button is visible", async ({ page }) => {
  await page.goto("/knowledge/glossary");
  await expect(page.getByRole("button", { name: /\+ add term/i })).toBeVisible();
  await expect(page.getByText("Term")).toBeVisible();
  await expect(page.getByText("Last edited")).toBeVisible();
});

test("Health/Daemons — 8 cards render", async ({ page }) => {
  await page.goto("/health/daemons");
  // We expect 8 daemon names rendered (status-pill spans are also present)
  const knownDaemons = ["audiodaemon", "sttdaemon", "agentqueue", "statusagent", "scheduler", "detector", "calendar", "ui"];
  for (const d of knownDaemons) {
    await expect(page.locator(".daemon-card-name", { hasText: d })).toBeVisible({ timeout: 10_000 });
  }
});

test("Health/Logs — dropdown defaults to audiodaemon", async ({ page }) => {
  await page.goto("/health/logs");
  const select = page.getByRole("combobox");
  await expect(select).toHaveValue("com.yulu.audiodaemon");
  await expect(page.getByRole("button", { name: /pause auto-scroll/i })).toBeVisible();
});
```

- [ ] **Step 2: Run the spec locally**

In one terminal:

```bash
cd yulu/scripts/yulu_ui
npm run dev      # leave running
```

In another terminal:

```bash
cd yulu/scripts/yulu_ui
npm run e2e
```

Expected: all 8 tests pass (the voicemail row test may skip if user's machine has no voicemails — that's OK).

- [ ] **Step 3: Stop the dev server + verify final state**

```bash
# In the dev terminal: Ctrl-C
# Then:
git status   # only the new file changed
```

- [ ] **Step 4: Commit**

```bash
git add yulu/scripts/yulu_ui/e2e/critical.spec.ts
git commit -m "test(yulu_ui/e2e): critical-flow spec across all real pages"
```

---

## Task F.8 — Real-machine smoke + push

**Files:** none — verification + push.

- [ ] **Step 1: Clean rebuild + prod smoke**

```bash
cd yulu/scripts/yulu_ui
rm -rf dist
npm install
npm run build
YULU_UI_PORT=17830 node dist/server.js > /tmp/yulu_f8_prod.log 2>&1 &
PID=$!
sleep 1
for p in /healthz /trpc/daemons.health /health/daemons /health/logs; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:17830$p")
  echo "$p → $CODE"
done
kill $PID 2>/dev/null; wait 2>/dev/null
```

Expected: all 200 (or `/trpc/daemons.health` may return 200 with the array).

- [ ] **Step 2: Dev mode + browser visual smoke** via `npm run dev` + the gstack `/browse` skill:

1. `/health/daemons` renders 8 cards with status pills + PIDs + last-log lines + Restart/Stop/View logs buttons
2. Status colors look right: running=green, stopped=grey, crashed=red
3. Click Restart on a stopped/non-critical daemon (or just verify the click registers — actual restart is system-mutating)
4. Click "View logs →" on audiodaemon → navigates to `/health/logs?name=com.yulu.audiodaemon`
5. `/health/logs` shows the audiodaemon log; dropdown lists 8 daemons; switching daemon updates content
6. Pause / Resume toggle works
7. New log line in `~/.config/yulu/audiodaemon.log` (e.g., `echo "smoke test $(date)" >> ~/.config/yulu/audiodaemon.log`) appears in the LogTail within ~1s

If anything visually wrong, fix and re-verify.

- [ ] **Step 3: Final E2E sweep (one more for confidence)**

```bash
cd yulu/scripts/yulu_ui
npm run e2e
```

Expected: all 8 e2e tests pass.

- [ ] **Step 4: Push**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git log --oneline | head -15
git push
```

- [ ] **Step 5: Update PR #24 description** to include Phase F summary (final phase before G).

---

## Self-review (run before declaring Phase F done)

- [ ] Spec §4 logTailer → F.1
- [ ] Spec §5.1 DaemonCard → F.2
- [ ] Spec §5.2 LogTail → F.3
- [ ] Spec §6.1 Daemons page → F.4
- [ ] Spec §6.2 Logs page → F.5
- [ ] Spec §7 Playwright setup → F.6
- [ ] Spec §7.2 critical-flow spec → F.7
- [ ] Spec §10 acceptance #1 grid renders 8 → F.4
- [ ] Spec §10 acceptance #2 Restart action → F.4
- [ ] Spec §10 acceptance #3 View logs → link → F.2 + F.5
- [ ] Spec §10 acceptance #4 initial 500 lines → F.5
- [ ] Spec §10 acceptance #5 WS live appends → F.3
- [ ] Spec §10 acceptance #6 Pause toggle → F.3 + F.5
- [ ] Spec §10 acceptance #7 Clear scrollback → F.5
- [ ] Spec §10 acceptance #8 npm run e2e passes → F.7 + F.8
- [ ] Spec §10 acceptance #9 vitest + typecheck → every task

Type consistency:
- `DaemonHealth` defined in `DaemonCard.tsx` (F.2), consumed in `daemons.tsx` (F.4)
- `LogTailProps` defined in `LogTail.tsx` (F.3), consumed in `logs.tsx` (F.5)
- `YULU_DAEMONS` array hard-coded in `logs.tsx` (F.5) — matches the 8 daemons in `src/routers/daemons.ts` (Phase A). Note: NOT imported from server router to keep the type-only import surface minimal — if drift becomes a problem in Phase G, add `import type { YuluDaemon } from "../../../src/routers/daemons.js"` instead.
- WS `logs` channel payload `{name, line, ts}` — defined in `src/pubsub.ts` (Phase A), consumed in F.1 (publisher) and F.3 (subscriber)

---

## What's NOT in Phase F (deferred to Phase G)

| Phase | Scope |
|---|---|
| G | `setup.sh` integration (build + install LaunchAgent in one shot); `yulu doctor` UI entry; release packaging; E2E in CI (GitHub Actions); log rotation detection in tailer |
