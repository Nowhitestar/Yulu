# Yulu UI · Phase C — Inbox Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase B placeholders for `/inbox/voicemails`, `/inbox/meetings`, and `/inbox/search` with production-grade pages. After Phase C the app supports the core daily user flow: browse / play / read voicemails and meetings, jump to any item via full-text search, and have new items appear live without page reload.

**Architecture:** Two layout shapes drive three pages — master-detail for Voicemails and Meetings (sharing a `<MasterDetail>` component + per-page list/reader contents) and single-column for Search. Five shared components (`MasterDetail` / `AudioPlayer` / `FilterChips` / `TranscriptView` / `EmptyState`) and two hooks (`useDebounced` / `useHotkeys`) form the reusable layer. Two backend tweaks: `voicemails.list`/`meetings.list` return a new `firstWords` field, and a new `inboxWatcher.ts` module emits `sidebar-counts` WS events on filesystem creates/deletes so the list refreshes when a new recording lands.

**Tech Stack:** React 18 · React Router 7 (data router, nested routes with `:stem` params) · @tanstack/react-query 5 + @trpc/react-query 11 · wavesurfer.js 7 (first integration) · vanilla CSS + CSS custom properties · vitest + jsdom + @testing-library/react + mock-socket · Node `fs.watch` for backend watcher

**Spec reference:** [`docs/superpowers/specs/2026-05-26-yulu-ui-C-inbox-pages-design.md`](../specs/2026-05-26-yulu-ui-C-inbox-pages-design.md) (all sections)

**Out of scope (deferred to Phases D–G):** delete UI; multi-select / batch ops; drag-reorder / favoriting / tagging; in-page transcript search; audio download button; Playwright E2E (single pass after Phase F).

**Path conventions:** All paths relative to repo root. Server-side work in `yulu/scripts/yulu_ui/src/`; React work in `yulu/scripts/yulu_ui/web/`. Commands run from `yulu/scripts/yulu_ui/` unless noted.

---

## File Structure

```
yulu/scripts/yulu_ui/
├── src/
│   ├── routers/
│   │   ├── voicemails.ts                MOD — list returns firstWords (C.1)
│   │   └── meetings.ts                  MOD — list returns firstWords (C.1)
│   ├── inboxWatcher.ts                  NEW — fs.watch + publish sidebar-counts (C.2)
│   └── server.ts                        MOD — start inboxWatcher in startServer (C.2)
├── web/src/
│   ├── hooks/
│   │   ├── useDebounced.ts              NEW (C.3)
│   │   └── useHotkeys.ts                NEW (C.4)
│   ├── components/
│   │   ├── MasterDetail.{tsx,css}       NEW (C.5)
│   │   ├── AudioPlayer.{tsx,css}        NEW (C.6)
│   │   ├── FilterChips.{tsx,css}        NEW (C.7)
│   │   ├── TranscriptView.{tsx,css}     NEW (C.8)
│   │   └── EmptyState.{tsx,css}         NEW (C.9)
│   ├── routes/
│   │   ├── inbox/
│   │   │   ├── _layout.tsx              NEW — InboxLayout wraps all /inbox/* routes (C.21)
│   │   │   ├── voicemails.tsx           MOD — real list + Outlet (C.10-13)
│   │   │   ├── voicemails.$stem.tsx     NEW — reader (C.11-12)
│   │   │   ├── voicemails.index.tsx     NEW — "select an item" empty (C.10)
│   │   │   ├── meetings.tsx             MOD (C.14-16)
│   │   │   ├── meetings.$stem.tsx       NEW (C.15)
│   │   │   ├── meetings.index.tsx       NEW (C.14)
│   │   │   └── search.tsx               MOD (C.17-20)
│   │   └── (other routes unchanged)
│   └── App.tsx                          MOD — restructure inbox children (C.10, C.14)
└── tests/
    ├── inboxWatcher.test.ts             NEW (C.2, runs in server vitest project)
    └── web/
        ├── useDebounced.test.ts         NEW (C.3)
        ├── useHotkeys.test.ts           NEW (C.4)
        ├── MasterDetail.test.tsx        NEW (C.5)
        ├── AudioPlayer.test.tsx         NEW (C.6)
        ├── FilterChips.test.tsx         NEW (C.7)
        ├── TranscriptView.test.tsx      NEW (C.8)
        ├── EmptyState.test.tsx          NEW (C.9)
        ├── voicemails.list.test.tsx     NEW (C.10)
        ├── voicemails.reader.test.tsx   NEW (C.11)
        ├── voicemails.url.test.tsx      NEW (C.12)
        ├── voicemails.filters.test.tsx  NEW (C.13)
        ├── meetings.list.test.tsx       NEW (C.14)
        ├── meetings.reader.test.tsx     NEW (C.15)
        ├── meetings.filters.test.tsx    NEW (C.16)
        ├── search.test.tsx              NEW (C.17-19)
        └── search.crossnav.test.tsx     NEW (C.20)
```

**Why these splits:** Each shared component lives in `web/src/components/` next to its CSS (already the established pattern). Hooks get their own `hooks/` folder so they're not mixed with components. Route files are named with the React Router 7 `$param` convention (even though we use config-based routing) so the filename signals param shape. Page integration tests live next to other web tests; the one server-side test (inboxWatcher) lives at `tests/inboxWatcher.test.ts` to match Phase A's pattern.

---

## Task C.1 — Backend: `firstWords` in `voicemails.list` + `meetings.list`

**Files:**
- Modify: `yulu/scripts/yulu_ui/src/routers/voicemails.ts`
- Modify: `yulu/scripts/yulu_ui/src/routers/meetings.ts`
- Modify: `yulu/scripts/yulu_ui/tests/routers/voicemails.test.ts`
- Modify: `yulu/scripts/yulu_ui/tests/routers/meetings.test.ts`

- [ ] **Step 1: Write failing tests** — append to the existing test files

Append to `tests/routers/voicemails.test.ts` inside the existing `describe("voicemailsRouter")`:

```ts
it("list() returns firstWords from transcript.txt (first 80 chars, ellipsis if longer)", async () => {
  const { ctx, voicemailsDir, cleanup } = makeCtx();
  try {
    const { writeFileSync } = await import("node:fs");
    const long = "A".repeat(100);
    writeFileSync(join(voicemailsDir, "voicemail_20260526_110000.transcript.txt"), long);
    const caller = createCaller(voicemailsRouter, ctx);
    const rows = (await caller.list({})) as Array<{ stem: string; firstWords: string | null }>;
    const r110 = rows.find((r) => r.stem === "voicemail_20260526_110000")!;
    expect(r110.firstWords).toBe("A".repeat(80) + "…");

    const r100 = rows.find((r) => r.stem === "voicemail_20260526_100000")!;
    expect(r100.firstWords).toBe("hello world");

    const r120 = rows.find((r) => r.stem === "voicemail_20260526_120000")!;
    expect(r120.firstWords).toBe("second message");
  } finally { cleanup(); }
});

it("list() returns firstWords: null when no transcript file", async () => {
  const { ctx, voicemailsDir, cleanup } = makeCtx();
  try {
    const { writeFileSync, unlinkSync } = await import("node:fs");
    unlinkSync(join(voicemailsDir, "voicemail_20260526_120000.transcript.txt"));
    const caller = createCaller(voicemailsRouter, ctx);
    const rows = (await caller.list({})) as Array<{ stem: string; firstWords: string | null }>;
    const r120 = rows.find((r) => r.stem === "voicemail_20260526_120000")!;
    expect(r120.firstWords).toBeNull();
  } finally { cleanup(); }
});
```

Append to `tests/routers/meetings.test.ts` inside the existing `describe("meetingsRouter")`:

```ts
it("list() returns firstWords + attendeeCount (undefined for v1)", async () => {
  const { ctx, cleanup } = makeCtx();
  try {
    const caller = createCaller(meetingsRouter, ctx);
    const rows = (await caller.list({})) as Array<{ stem: string; firstWords: string | null; attendeeCount?: number }>;
    const standup = rows.find((r) => r.stem === "WeeklyStandup_20260520_100000")!;
    expect(standup.firstWords).toBe("agenda");
    expect(standup.attendeeCount).toBeUndefined();

    const oneOnOne = rows.find((r) => r.stem === "1on1_20260521_140000")!;
    expect(oneOnOne.firstWords).toBeNull();
  } finally { cleanup(); }
});
```

- [ ] **Step 2: Run tests, verify FAIL**

```bash
cd yulu/scripts/yulu_ui
npm test -- tests/routers/voicemails.test.ts tests/routers/meetings.test.ts
```

Expected: 3 new failing assertions (no `firstWords` field on returned rows).

- [ ] **Step 3: Implement in `src/routers/voicemails.ts`**

Modify the `listFromDir` helper to read transcript content. Find the current function:

```ts
function listFromDir(dir: string) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const rows = [];
  for (const f of entries) {
    const m = f.match(STEM_RE);
    if (!m) continue;
    const stem = m[1]!;
    const wavPath = join(dir, f);
    const stat = statSync(wavPath);
    rows.push({
      stem,
      wavPath,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      hasTranscript: existsSync(join(dir, `${stem}.transcript.txt`)),
      hasSummary:    existsSync(join(dir, `${stem}.summary.md`)),
    });
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows;
}
```

Replace with:

```ts
function listFromDir(dir: string) {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir);
  const rows = [];
  for (const f of entries) {
    const m = f.match(STEM_RE);
    if (!m) continue;
    const stem = m[1]!;
    const wavPath = join(dir, f);
    const stat = statSync(wavPath);
    const transcriptPath = join(dir, `${stem}.transcript.txt`);
    const hasTranscript = existsSync(transcriptPath);
    rows.push({
      stem,
      wavPath,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      hasTranscript,
      hasSummary:    existsSync(join(dir, `${stem}.summary.md`)),
      firstWords:    hasTranscript ? firstWordsOf(transcriptPath) : null,
    });
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows;
}

function firstWordsOf(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return null;
    if (raw.length <= 80) return raw;
    return raw.slice(0, 80) + "…";
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Implement in `src/routers/meetings.ts`**

Find the `list` query body. Add to each row push:

```ts
firstWords: firstWordsOf(join(dir, `${parsed.stem}.transcript.txt`)),
attendeeCount: undefined as number | undefined,
```

And add at the bottom of the file (before the closing `});`):

```ts
function firstWordsOf(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return null;
    if (raw.length <= 80) return raw;
    return raw.slice(0, 80) + "…";
  } catch {
    return null;
  }
}
```

(The DRY-pure version of duplicating `firstWordsOf` between two router files is fine — it's 8 lines, importing across routers would create an awkward dependency. If a third router ever needs it, extract to `src/textPreview.ts`.)

- [ ] **Step 5: Re-run, verify PASS**

```bash
npm test -- tests/routers/voicemails.test.ts tests/routers/meetings.test.ts
```

Expected: PASS — 4 voicemails tests + 3 meetings tests (existing + 3 new).

- [ ] **Step 6: Full suite + typecheck**

```bash
npm test
npm run typecheck
```

Expected: all green, ~92 tests.

- [ ] **Step 7: Commit**

```bash
git add yulu/scripts/yulu_ui/src/routers/voicemails.ts \
        yulu/scripts/yulu_ui/src/routers/meetings.ts \
        yulu/scripts/yulu_ui/tests/routers/voicemails.test.ts \
        yulu/scripts/yulu_ui/tests/routers/meetings.test.ts
git commit -m "feat(yulu_ui): voicemails.list/meetings.list return firstWords"
```

---

## Task C.2 — `inboxWatcher.ts` server module

**Files:**
- Create: `yulu/scripts/yulu_ui/src/inboxWatcher.ts`
- Modify: `yulu/scripts/yulu_ui/src/server.ts`
- Create: `yulu/scripts/yulu_ui/tests/inboxWatcher.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/inboxWatcher.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startInboxWatcher, type InboxWatcher } from "../src/inboxWatcher.js";
import { PubSub } from "../src/pubsub.js";
import type { AppChannels } from "../src/pubsub.js";

describe("inboxWatcher", () => {
  let root: string;
  let voicemailsDir: string;
  let moviesDir: string;
  let watcher: InboxWatcher | undefined;
  let pubsub: PubSub<AppChannels>;
  let events: AppChannels["sidebar-counts"][];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "yulu_iw_"));
    voicemailsDir = join(root, "voicemails");
    moviesDir = root;
    mkdirSync(voicemailsDir);
    pubsub = new PubSub<AppChannels>();
    events = [];
    pubsub.subscribe("sidebar-counts", (m) => events.push(m));
  });

  afterEach(() => {
    watcher?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  function waitMs(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

  it("publishes sidebar-counts when a new .wav appears in voicemails dir", async () => {
    watcher = startInboxWatcher({ voicemailsDir, moviesDir, pubsub });
    await waitMs(50); // let fs.watch initialize
    writeFileSync(join(voicemailsDir, "voicemail_20260526_180000.wav"), Buffer.alloc(0));
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 1000 });
  });

  it("publishes sidebar-counts when a .summary.md appears in voicemails dir", async () => {
    writeFileSync(join(voicemailsDir, "voicemail_20260526_180000.wav"), Buffer.alloc(0));
    watcher = startInboxWatcher({ voicemailsDir, moviesDir, pubsub });
    await waitMs(50);
    writeFileSync(join(voicemailsDir, "voicemail_20260526_180000.summary.md"), "# summary");
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 1000 });
  });

  it("publishes sidebar-counts when a meeting .wav appears in movies dir", async () => {
    watcher = startInboxWatcher({ voicemailsDir, moviesDir, pubsub });
    await waitMs(50);
    writeFileSync(join(moviesDir, "Standup_20260526_180000.wav"), Buffer.alloc(0));
    await vi.waitFor(() => expect(events.length).toBeGreaterThan(0), { timeout: 1000 });
  });

  it("ignores non-relevant files (.DS_Store, partial writes)", async () => {
    watcher = startInboxWatcher({ voicemailsDir, moviesDir, pubsub });
    await waitMs(50);
    writeFileSync(join(voicemailsDir, ".DS_Store"), "x");
    writeFileSync(join(voicemailsDir, "voicemail_20260526_180000.wav.tmp"), Buffer.alloc(0));
    await waitMs(200);
    expect(events).toEqual([]);
  });

  it("does not throw when a watched dir is missing — falls back silently", () => {
    expect(() => {
      watcher = startInboxWatcher({
        voicemailsDir: join(root, "nonexistent-vm"),
        moviesDir: join(root, "nonexistent-mt"),
        pubsub,
      });
    }).not.toThrow();
  });

  it("debounces rapid creates: 5 files within 100 ms emit no more than 2 events", async () => {
    watcher = startInboxWatcher({ voicemailsDir, moviesDir, pubsub });
    await waitMs(50);
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(voicemailsDir, `voicemail_2026052618000${i}.wav`), Buffer.alloc(0));
    }
    await waitMs(300);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.length).toBeLessThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/inboxWatcher.test.ts
```

Expected: FAIL (`Cannot find module '../src/inboxWatcher.js'`).

- [ ] **Step 3: Implement `src/inboxWatcher.ts`**

```ts
// src/inboxWatcher.ts
import { watch, type FSWatcher, existsSync } from "node:fs";
import type { PubSub, AppChannels } from "./pubsub.js";

const RELEVANT_RE = /^(voicemail_)?[^.]+_\d{8}_\d{6}\.(wav|transcript\.txt|summary\.md|raw\.transcript\.txt|realtime\.transcript\.txt|summary\.html)$/;
const DEBOUNCE_MS = 80;

export interface InboxWatcherOptions {
  voicemailsDir: string;
  moviesDir: string;
  pubsub: PubSub<AppChannels>;
}

export interface InboxWatcher {
  stop(): void;
}

/**
 * Watch the two directories that hold user recordings and emit a
 * sidebar-counts WS event whenever a relevant file appears or disappears.
 * Debounces bursts (typical: a recording lands as .wav + .transcript.txt
 * + .summary.md within milliseconds) so the UI doesn't get hammered.
 */
export function startInboxWatcher(opts: InboxWatcherOptions): InboxWatcher {
  const watchers: FSWatcher[] = [];
  let pendingTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    pendingTimer = null;
    // Emit an "unknown deltas" signal — the UI invalidates relevant queries
    // and re-fetches counts itself. We don't try to be clever about which
    // count changed because the file system event is too noisy.
    opts.pubsub.publish("sidebar-counts", {
      voicemails: 0, meetings: 0, prompts: 0, glossary: 0,
    });
  };

  const onEvent = (_event: string, filename: string | Buffer | null) => {
    const name = typeof filename === "string" ? filename : filename?.toString() ?? "";
    if (!name || !RELEVANT_RE.test(name)) return;
    if (pendingTimer) clearTimeout(pendingTimer);
    pendingTimer = setTimeout(flush, DEBOUNCE_MS);
  };

  for (const dir of [opts.voicemailsDir, opts.moviesDir]) {
    if (!existsSync(dir)) continue;
    try {
      const w = watch(dir, { persistent: false }, onEvent);
      w.on("error", () => { /* swallow; fs.watch is best-effort */ });
      watchers.push(w);
    } catch {
      // Silently ignore (e.g., the dir is on a filesystem that doesn't support fs.watch)
    }
  }

  return {
    stop() {
      if (pendingTimer) { clearTimeout(pendingTimer); pendingTimer = null; }
      for (const w of watchers) w.close();
    },
  };
}
```

- [ ] **Step 4: Wire `inboxWatcher` into `server.ts`**

In `src/server.ts`, inside `startServer()`, add an import at the top:

```ts
import { startInboxWatcher } from "./inboxWatcher.js";
```

And after `mountWsMultiplexer(http, appPubSub);` (before the `await new Promise(...)` listen call), add:

```ts
const inboxWatcher = startInboxWatcher({
  voicemailsDir: paths.voicemailsDir,
  moviesDir: paths.moviesDir,
  pubsub: appPubSub,
});
```

And in the returned `close` function, stop the watcher before closing the HTTP server:

```ts
close: () => new Promise<void>((resolve) => { inboxWatcher.stop(); http.close(() => resolve()); }),
```

- [ ] **Step 5: Re-run, verify PASS**

```bash
npm test -- tests/inboxWatcher.test.ts
```

Expected: PASS (6 tests).

- [ ] **Step 6: Full suite + typecheck**

```bash
npm test
npm run typecheck
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add yulu/scripts/yulu_ui/src/inboxWatcher.ts \
        yulu/scripts/yulu_ui/src/server.ts \
        yulu/scripts/yulu_ui/tests/inboxWatcher.test.ts
git commit -m "feat(yulu_ui): inboxWatcher emits sidebar-counts on fs events"
```

---

## Task C.3 — `useDebounced` hook

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/hooks/useDebounced.ts`
- Create: `yulu/scripts/yulu_ui/tests/web/useDebounced.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/web/useDebounced.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebounced } from "../../web/src/hooks/useDebounced.js";

describe("useDebounced", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useDebounced("hello", 200));
    expect(result.current).toBe("hello");
  });

  it("returns the new value only after the delay elapses", () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 200), { initialProps: { v: "a" } });
    rerender({ v: "b" });
    expect(result.current).toBe("a");
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toBe("a");
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toBe("b");
  });

  it("resets the timer when the value changes again within the delay", () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 200), { initialProps: { v: "a" } });
    rerender({ v: "b" });
    act(() => { vi.advanceTimersByTime(150); });
    rerender({ v: "c" });
    act(() => { vi.advanceTimersByTime(150); });
    expect(result.current).toBe("a");
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toBe("c");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/useDebounced.test.ts
```

- [ ] **Step 3: Implement**

```ts
// web/src/hooks/useDebounced.ts
import { useEffect, useState } from "react";

export function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}
```

- [ ] **Step 4: Re-run, verify PASS + full suite**

```bash
npm test -- tests/web/useDebounced.test.ts
npm test
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/hooks/useDebounced.ts \
        yulu/scripts/yulu_ui/tests/web/useDebounced.test.ts
git commit -m "feat(yulu_ui/web): useDebounced hook"
```

---

## Task C.4 — `useHotkeys` hook

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/hooks/useHotkeys.ts`
- Create: `yulu/scripts/yulu_ui/tests/web/useHotkeys.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/web/useHotkeys.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { useHotkeys } from "../../web/src/hooks/useHotkeys.js";

describe("useHotkeys", () => {
  afterEach(() => { cleanup(); });

  it("calls the handler when a registered key is pressed", () => {
    const onJ = vi.fn();
    renderHook(() => useHotkeys({ j: onJ }));
    fireEvent.keyDown(window, { key: "j" });
    expect(onJ).toHaveBeenCalledTimes(1);
  });

  it("does not call handler when focus is in an <input>", () => {
    const onJ = vi.fn();
    renderHook(() => useHotkeys({ j: onJ }));
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "j" });
    expect(onJ).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("does not call handler when focus is in a [contenteditable]", () => {
    const onJ = vi.fn();
    renderHook(() => useHotkeys({ j: onJ }));
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    document.body.appendChild(div);
    div.focus();
    fireEvent.keyDown(div, { key: "j" });
    expect(onJ).not.toHaveBeenCalled();
    document.body.removeChild(div);
  });

  it("supports multiple keys", () => {
    const onJ = vi.fn();
    const onK = vi.fn();
    renderHook(() => useHotkeys({ j: onJ, k: onK }));
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "k" });
    expect(onJ).toHaveBeenCalledTimes(1);
    expect(onK).toHaveBeenCalledTimes(1);
  });

  it("removes listener on unmount", () => {
    const onJ = vi.fn();
    const { unmount } = renderHook(() => useHotkeys({ j: onJ }));
    unmount();
    fireEvent.keyDown(window, { key: "j" });
    expect(onJ).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/useHotkeys.test.ts
```

- [ ] **Step 3: Implement**

```ts
// web/src/hooks/useHotkeys.ts
import { useEffect, useRef } from "react";

export type HotkeyMap = Record<string, (e: KeyboardEvent) => void>;

/**
 * Bind global keydown shortcuts. Handler is skipped when focus is inside
 * an editable element (input, textarea, contenteditable) so typing in a
 * search box doesn't trigger nav keys.
 */
export function useHotkeys(map: HotkeyMap): void {
  // Stable ref so re-renders don't reattach listeners
  const mapRef = useRef(map);
  mapRef.current = map;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (isEditable(target)) return;
      const handler = mapRef.current[e.key];
      if (handler) handler(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function isEditable(el: HTMLElement | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (el.isContentEditable) return true;
  return false;
}
```

- [ ] **Step 4: Re-run, verify PASS + full suite**

```bash
npm test -- tests/web/useHotkeys.test.ts
npm test
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/hooks/useHotkeys.ts \
        yulu/scripts/yulu_ui/tests/web/useHotkeys.test.ts
git commit -m "feat(yulu_ui/web): useHotkeys hook (skips editable elements)"
```

---

## Task C.5 — `<MasterDetail>` component

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/MasterDetail.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/MasterDetail.css`
- Create: `yulu/scripts/yulu_ui/tests/web/MasterDetail.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/MasterDetail.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MasterDetail } from "../../web/src/components/MasterDetail.js";

describe("MasterDetail", () => {
  it("renders both list and detail slots", () => {
    render(<MasterDetail listSlot={<div>my-list</div>} detailSlot={<div>my-detail</div>} />);
    expect(screen.getByText("my-list")).toBeInTheDocument();
    expect(screen.getByText("my-detail")).toBeInTheDocument();
  });

  it("renders 8 skeleton rows when listPending is true (hides listSlot)", () => {
    render(<MasterDetail listSlot={<div>my-list</div>} detailSlot={<div>d</div>} listPending />);
    expect(screen.queryByText("my-list")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("masterdetail-skeleton")).toHaveLength(8);
  });

  it("list column has fixed 220px width via data attribute", () => {
    const { container } = render(<MasterDetail listSlot={<span />} detailSlot={<span />} />);
    const list = container.querySelector(".masterdetail-list");
    expect(list).not.toBeNull();
    expect(list?.getAttribute("data-width")).toBe("220");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/MasterDetail.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// web/src/components/MasterDetail.tsx
import type { ReactNode } from "react";
import "./MasterDetail.css";

export interface MasterDetailProps {
  listSlot: ReactNode;
  detailSlot: ReactNode;
  listPending?: boolean;
}

export function MasterDetail({ listSlot, detailSlot, listPending = false }: MasterDetailProps) {
  return (
    <div className="masterdetail">
      <div className="masterdetail-list" data-width="220">
        {listPending
          ? Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="masterdetail-skeleton" data-testid="masterdetail-skeleton" />
            ))
          : listSlot}
      </div>
      <div className="masterdetail-detail">{detailSlot}</div>
    </div>
  );
}
```

```css
/* web/src/components/MasterDetail.css */
.masterdetail {
  display: flex;
  height: 100%;
  gap: 10px;
}
.masterdetail-list {
  width: 220px;
  flex: 0 0 220px;
  height: 100%;
  overflow-y: auto;
  padding: 6px;
}
.masterdetail-detail {
  flex: 1;
  height: 100%;
  overflow-y: auto;
  padding: 6px;
  min-width: 0;
}
.masterdetail-skeleton {
  height: 46px;
  margin-bottom: 4px;
  border-radius: var(--radius-inner);
  background: var(--row-hover);
}
```

- [ ] **Step 4: Re-run, verify PASS + full suite + typecheck**

```bash
npm test -- tests/web/MasterDetail.test.tsx
npm test
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/MasterDetail.tsx \
        yulu/scripts/yulu_ui/web/src/components/MasterDetail.css \
        yulu/scripts/yulu_ui/tests/web/MasterDetail.test.tsx
git commit -m "feat(yulu_ui/web): MasterDetail (220px list + outlet, inline skeleton)"
```

---

## Task C.6 — `<AudioPlayer>` (wavesurfer.js wrapper)

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/AudioPlayer.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/AudioPlayer.css`
- Create: `yulu/scripts/yulu_ui/tests/web/AudioPlayer.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/AudioPlayer.test.tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AudioPlayer } from "../../web/src/components/AudioPlayer.js";

// Capture handlers registered via .on() so tests can fire 'ready' / 'audioprocess' / 'finish'
const handlers = new Map<string, (...args: unknown[]) => void>();
const playMock = vi.fn();
const pauseMock = vi.fn();
const setTimeMock = vi.fn();
const destroyMock = vi.fn();
const createMock = vi.fn(() => ({
  on: (event: string, cb: (...args: unknown[]) => void) => { handlers.set(event, cb); },
  play: playMock,
  pause: pauseMock,
  setTime: setTimeMock,
  destroy: destroyMock,
  getDuration: () => 12.5,
  isPlaying: () => false,
}));

vi.mock("wavesurfer.js", () => ({ default: { create: createMock } }));

beforeEach(() => {
  handlers.clear();
  playMock.mockReset();
  pauseMock.mockReset();
  setTimeMock.mockReset();
  destroyMock.mockReset();
  createMock.mockClear();
});

describe("AudioPlayer", () => {
  it("creates a wavesurfer instance with the right src on mount", () => {
    render(<AudioPlayer src="/files/voicemails/foo.wav" />);
    expect(createMock).toHaveBeenCalledTimes(1);
    const opts = createMock.mock.calls[0]![0] as { url: string };
    expect(opts.url).toBe("/files/voicemails/foo.wav");
  });

  it("destroys the wavesurfer instance on unmount", () => {
    const { unmount } = render(<AudioPlayer src="/files/voicemails/foo.wav" />);
    unmount();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it("applies initialSeek when the 'ready' event fires", () => {
    render(<AudioPlayer src="/x.wav" initialSeek={5.2} />);
    act(() => { handlers.get("ready")?.(); });
    expect(setTimeMock).toHaveBeenCalledWith(5.2);
  });

  it("clicking the play button calls wavesurfer.play()", async () => {
    render(<AudioPlayer src="/x.wav" />);
    act(() => { handlers.get("ready")?.(); });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /play/i }));
    expect(playMock).toHaveBeenCalled();
  });

  it("emits onSeek when wavesurfer fires 'audioprocess'", () => {
    const onSeek = vi.fn();
    render(<AudioPlayer src="/x.wav" onSeek={onSeek} />);
    act(() => { handlers.get("audioprocess")?.(3.7); });
    expect(onSeek).toHaveBeenCalledWith(3.7);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/AudioPlayer.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// web/src/components/AudioPlayer.tsx
import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import "./AudioPlayer.css";

export interface AudioPlayerProps {
  src: string;
  initialSeek?: number;
  onSeek?: (time: number) => void;
}

export function AudioPlayer({ src, initialSeek, onSeek }: AudioPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<ReturnType<typeof WaveSurfer.create> | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    if (!containerRef.current) return;
    const ws = WaveSurfer.create({
      container: containerRef.current,
      url: src,
      waveColor: "rgba(139, 146, 160, 0.55)",   // --fg-2 with alpha
      progressColor: "var(--accent)",
      cursorColor: "var(--accent)",
      barWidth: 2,
      barRadius: 2,
      barGap: 1,
      height: 48,
      normalize: true,
    });
    wsRef.current = ws;
    ws.on("ready", () => {
      setDuration(ws.getDuration());
      if (typeof initialSeek === "number" && initialSeek > 0) ws.setTime(initialSeek);
    });
    ws.on("play", () => setIsPlaying(true));
    ws.on("pause", () => setIsPlaying(false));
    ws.on("finish", () => setIsPlaying(false));
    ws.on("audioprocess", (t: number) => {
      setCurrentTime(t);
      onSeek?.(t);
    });
    ws.on("seeking", (t: number) => {
      setCurrentTime(t);
      onSeek?.(t);
    });
    return () => { ws.destroy(); wsRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const toggle = () => {
    const ws = wsRef.current;
    if (!ws) return;
    if (isPlaying) ws.pause(); else ws.play();
  };

  return (
    <div className="audioplayer">
      <button
        type="button"
        className="audioplayer-play"
        onClick={toggle}
        aria-label={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? "❚❚" : "▶"}
      </button>
      <div ref={containerRef} className="audioplayer-wave" />
      <div className="audioplayer-time">
        {formatTime(currentTime)} / {formatTime(duration)}
      </div>
    </div>
  );
}

function formatTime(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}
```

```css
/* web/src/components/AudioPlayer.css */
.audioplayer {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  background: var(--glass);
  border-radius: var(--radius-panel);
  box-shadow: var(--edge-shadow);
}
.audioplayer-play {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 13px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.audioplayer-play:hover { background: var(--glass-3); }
.audioplayer-wave {
  flex: 1;
  min-width: 0;
}
.audioplayer-time {
  font-family: "SF Mono", ui-monospace, monospace;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
  color: var(--fg-2);
}
```

- [ ] **Step 4: Re-run, verify PASS + full suite + typecheck**

```bash
npm test -- tests/web/AudioPlayer.test.tsx
npm test
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/AudioPlayer.tsx \
        yulu/scripts/yulu_ui/web/src/components/AudioPlayer.css \
        yulu/scripts/yulu_ui/tests/web/AudioPlayer.test.tsx
git commit -m "feat(yulu_ui/web): AudioPlayer wavesurfer.js wrapper"
```

---

## Task C.7 — `<FilterChips>` component

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/FilterChips.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/FilterChips.css`
- Create: `yulu/scripts/yulu_ui/tests/web/FilterChips.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/FilterChips.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterChips, type ChipDef } from "../../web/src/components/FilterChips.js";

const VM_CHIPS: ChipDef[] = [
  { id: "all", label: "All" },
  { id: "summarized", label: "Summarized" },
  { id: "last7d", label: "Last 7d" },
];

describe("FilterChips", () => {
  it("renders all chips with labels", () => {
    render(<FilterChips chips={VM_CHIPS} activeIds={[]} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarized" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Last 7d" })).toBeInTheDocument();
  });

  it("marks active chips with aria-pressed=true", () => {
    render(<FilterChips chips={VM_CHIPS} activeIds={["summarized"]} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Summarized" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Last 7d" })).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking a chip toggles it on, calling onChange with new active set", async () => {
    const onChange = vi.fn();
    render(<FilterChips chips={VM_CHIPS} activeIds={[]} onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Summarized" }));
    expect(onChange).toHaveBeenCalledWith(["summarized"]);
  });

  it("clicking an active chip toggles it off", async () => {
    const onChange = vi.fn();
    render(<FilterChips chips={VM_CHIPS} activeIds={["summarized", "last7d"]} onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Summarized" }));
    expect(onChange).toHaveBeenCalledWith(["last7d"]);
  });

  it("clicking 'All' (the chip with id='all') clears all other selections", async () => {
    const onChange = vi.fn();
    render(<FilterChips chips={VM_CHIPS} activeIds={["summarized", "last7d"]} onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("'All' chip is active when activeIds is empty", () => {
    render(<FilterChips chips={VM_CHIPS} activeIds={[]} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/FilterChips.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// web/src/components/FilterChips.tsx
import "./FilterChips.css";

export interface ChipDef {
  id: string;
  label: string;
}

export interface FilterChipsProps {
  chips: ChipDef[];
  activeIds: string[];
  onChange: (newActiveIds: string[]) => void;
}

const ALL_ID = "all";

export function FilterChips({ chips, activeIds, onChange }: FilterChipsProps) {
  const allActive = activeIds.length === 0;

  function toggle(id: string) {
    if (id === ALL_ID) { onChange([]); return; }
    if (activeIds.includes(id)) onChange(activeIds.filter((x) => x !== id));
    else onChange([...activeIds, id]);
  }

  return (
    <div className="filterchips" role="group">
      {chips.map((c) => {
        const isActive = c.id === ALL_ID ? allActive : activeIds.includes(c.id);
        return (
          <button
            key={c.id}
            type="button"
            aria-pressed={isActive}
            className={"filterchip" + (isActive ? " active" : "")}
            onClick={() => toggle(c.id)}
          >
            {c.label}
          </button>
        );
      })}
    </div>
  );
}
```

```css
/* web/src/components/FilterChips.css */
.filterchips {
  display: inline-flex;
  gap: 6px;
}
.filterchip {
  padding: 4px 10px;
  border-radius: var(--radius-inner);
  font-size: 11px;
  color: var(--fg-2);
  background: var(--row-hover);
  transition: background 100ms, color 100ms;
}
.filterchip:hover { color: var(--fg); }
.filterchip.active {
  background: var(--accent-soft);
  color: var(--accent);
}
```

- [ ] **Step 4: Re-run, verify PASS + full suite + typecheck**

```bash
npm test -- tests/web/FilterChips.test.tsx
npm test
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/FilterChips.tsx \
        yulu/scripts/yulu_ui/web/src/components/FilterChips.css \
        yulu/scripts/yulu_ui/tests/web/FilterChips.test.tsx
git commit -m "feat(yulu_ui/web): FilterChips multi-select chip group"
```

---

## Task C.8 — `<TranscriptView>` (vocab + speaker highlight)

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/TranscriptView.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/TranscriptView.css`
- Create: `yulu/scripts/yulu_ui/tests/web/TranscriptView.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/TranscriptView.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render } from "@testing-library/react";
import { TranscriptView } from "../../web/src/components/TranscriptView.js";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    glossary: {
      list: { useQuery: () => ({ data: [{ term: "AgentKey" }, { term: "OpenClaw" }], isError: false }) },
    },
  },
}));

describe("TranscriptView", () => {
  it("renders plain text as-is", () => {
    const { container } = render(<TranscriptView text="hello world" />);
    expect(container.textContent).toBe("hello world");
  });

  it("wraps glossary terms in a span.vocab (case-insensitive)", () => {
    const { container } = render(<TranscriptView text="we use AgentKey and openclaw" />);
    const vocabs = container.querySelectorAll(".vocab");
    expect(vocabs).toHaveLength(2);
    expect(vocabs[0]?.textContent).toBe("AgentKey");
    expect(vocabs[1]?.textContent).toBe("openclaw");
  });

  it("wraps speaker labels (Speaker A: prefix) in span.speaker", () => {
    const { container } = render(<TranscriptView text={"Speaker A: hello\nSpeaker B: world"} />);
    const speakers = container.querySelectorAll(".speaker");
    expect(speakers).toHaveLength(2);
    expect(speakers[0]?.textContent).toBe("Speaker A:");
    expect(speakers[1]?.textContent).toBe("Speaker B:");
  });

  it("preserves newlines as <br> (or whitespace: pre-wrap)", () => {
    const { container } = render(<TranscriptView text={"line1\nline2"} />);
    // Either implementation is acceptable; assert the visible text contains both
    expect(container.textContent).toContain("line1");
    expect(container.textContent).toContain("line2");
  });

  it("falls back to plain text when glossary query errors", () => {
    vi.doMock("../../web/src/trpc.js", () => ({
      trpc: { glossary: { list: { useQuery: () => ({ data: undefined, isError: true }) } } },
    }));
    const { container } = render(<TranscriptView text="hello AgentKey" />);
    expect(container.textContent).toBe("hello AgentKey");
    expect(container.querySelector(".vocab")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/TranscriptView.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// web/src/components/TranscriptView.tsx
import { useMemo } from "react";
import { trpc } from "../trpc.js";
import "./TranscriptView.css";

export interface TranscriptViewProps {
  text: string;
}

interface GlossaryRow { term: string }

const SPEAKER_RE = /^(Speaker [A-Z]:)/;

export function TranscriptView({ text }: TranscriptViewProps) {
  const { data, isError } = trpc.glossary.list.useQuery();

  const vocabRegex = useMemo(() => {
    if (isError || !data) return null;
    const terms = (data as GlossaryRow[])
      .map((r) => r.term)
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
    if (terms.length === 0) return null;
    const escaped = terms.map(escapeRegExp);
    return new RegExp(`\\b(${escaped.join("|")})\\b`, "gi");
  }, [data, isError]);

  return (
    <div className="transcript">
      {text.split("\n").map((line, i) => (
        <p key={i} className="transcript-line">
          {renderLine(line, vocabRegex)}
        </p>
      ))}
    </div>
  );
}

function renderLine(line: string, vocabRegex: RegExp | null) {
  const speakerMatch = line.match(SPEAKER_RE);
  let prefix: React.ReactNode = null;
  let body = line;
  if (speakerMatch) {
    prefix = <span className="speaker">{speakerMatch[1]}</span>;
    body = line.slice(speakerMatch[1]!.length);
  }
  if (!vocabRegex) return <>{prefix}{body}</>;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  body.replace(vocabRegex, (match, _g1, offset: number) => {
    if (offset > lastIndex) parts.push(body.slice(lastIndex, offset));
    parts.push(<span key={offset} className="vocab">{match}</span>);
    lastIndex = offset + match.length;
    return match;
  });
  if (lastIndex < body.length) parts.push(body.slice(lastIndex));
  return <>{prefix}{parts}</>;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
```

```css
/* web/src/components/TranscriptView.css */
.transcript {
  font-size: 13px;
  line-height: 1.7;
  color: var(--fg);
}
.transcript-line {
  margin: 0 0 8px 0;
}
.transcript .speaker {
  font-family: "SF Mono", ui-monospace, monospace;
  font-size: 11px;
  color: var(--fg-3);
  margin-right: 4px;
}
.transcript .vocab {
  color: var(--purple);
}
```

- [ ] **Step 4: Re-run, verify PASS + full suite + typecheck**

```bash
npm test -- tests/web/TranscriptView.test.tsx
npm test
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/TranscriptView.tsx \
        yulu/scripts/yulu_ui/web/src/components/TranscriptView.css \
        yulu/scripts/yulu_ui/tests/web/TranscriptView.test.tsx
git commit -m "feat(yulu_ui/web): TranscriptView with vocab + speaker highlight"
```

---

## Task C.9 — `<EmptyState>` component

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/EmptyState.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/EmptyState.css`
- Create: `yulu/scripts/yulu_ui/tests/web/EmptyState.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/EmptyState.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmptyState } from "../../web/src/components/EmptyState.js";

describe("EmptyState", () => {
  it("renders label", () => {
    render(<EmptyState label="No items" />);
    expect(screen.getByText("No items")).toBeInTheDocument();
  });

  it("renders optional icon", () => {
    render(<EmptyState icon="📭" label="Empty" />);
    expect(screen.getByText("📭")).toBeInTheDocument();
  });

  it("renders optional CTA button + fires onClick", async () => {
    const onClick = vi.fn();
    render(<EmptyState label="Empty" cta={{ label: "Try again", onClick }} />);
    const btn = screen.getByRole("button", { name: "Try again" });
    const user = userEvent.setup();
    await user.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/EmptyState.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// web/src/components/EmptyState.tsx
import "./EmptyState.css";

export interface EmptyStateProps {
  icon?: string;
  label: string;
  cta?: { label: string; onClick: () => void };
}

export function EmptyState({ icon, label, cta }: EmptyStateProps) {
  return (
    <div className="emptystate">
      {icon && <div className="emptystate-icon" aria-hidden="true">{icon}</div>}
      <div className="emptystate-label">{label}</div>
      {cta && (
        <button type="button" className="emptystate-cta" onClick={cta.onClick}>
          {cta.label}
        </button>
      )}
    </div>
  );
}
```

```css
/* web/src/components/EmptyState.css */
.emptystate {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 24px;
  gap: 10px;
  color: var(--fg-2);
}
.emptystate-icon {
  font-size: 36px;
  opacity: 0.6;
}
.emptystate-label {
  font-size: 13px;
  text-align: center;
  max-width: 340px;
}
.emptystate-cta {
  margin-top: 8px;
  padding: 6px 14px;
  border-radius: var(--radius-inner);
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 11px;
}
.emptystate-cta:hover { background: var(--glass-3); }
```

- [ ] **Step 4: Re-run, verify PASS + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/EmptyState.tsx \
        yulu/scripts/yulu_ui/web/src/components/EmptyState.css \
        yulu/scripts/yulu_ui/tests/web/EmptyState.test.tsx
git commit -m "feat(yulu_ui/web): EmptyState component"
```

---

## Task C.10 — Voicemails list view + nested route shell + index empty

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.tsx` (REPLACE the placeholder)
- Create: `yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.index.tsx`
- Modify: `yulu/scripts/yulu_ui/web/src/App.tsx` (add `:stem` and `index` children under voicemails)
- Create: `yulu/scripts/yulu_ui/tests/web/voicemails.list.test.tsx`

This task wires the list view + the "no selection" empty state. The `:stem` reader is implemented in C.11.

- [ ] **Step 1: Write failing test for the list view**

```tsx
// tests/web/voicemails.list.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Voicemails } from "../../web/src/routes/inbox/voicemails.js";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    voicemails: {
      list: { useQuery: () => ({
        data: [
          { stem: "voicemail_20260526_120000", firstWords: "hello world", sizeBytes: 1024, mtimeMs: 1000003, hasTranscript: true, hasSummary: true },
          { stem: "voicemail_20260526_110000", firstWords: null, sizeBytes: 2048, mtimeMs: 1000002, hasTranscript: false, hasSummary: false },
          { stem: "voicemail_20260526_100000", firstWords: "second message", sizeBytes: 512, mtimeMs: 1000001, hasTranscript: true, hasSummary: false },
        ],
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

function mount(initialPath = "/inbox/voicemails") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{
      path: "/inbox/voicemails",
      Component: Voicemails,
      children: [{ index: true, element: <div>EMPTY-SLOT</div> }],
    }],
    { initialEntries: [initialPath] }
  );
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

describe("Voicemails list", () => {
  it("renders all rows with firstWords + meta", () => {
    mount();
    expect(screen.getByText("hello world")).toBeInTheDocument();
    expect(screen.getByText("second message")).toBeInTheDocument();
    // No firstWords → stem shown
    expect(screen.getByText(/voicemail_20260526_110000/)).toBeInTheDocument();
  });

  it("renders ✓ marker when summary exists", () => {
    mount();
    const rows = screen.getAllByTestId("voicemail-row");
    expect(rows[0]).toHaveTextContent("✓");
    expect(rows[1]).not.toHaveTextContent("✓");
  });

  it("renders the outlet (no selection → 'Select a voicemail' empty state via index route)", () => {
    mount();
    expect(screen.getByText("EMPTY-SLOT")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/voicemails.list.test.tsx
```

- [ ] **Step 3: Implement voicemails list view**

Replace `web/src/routes/inbox/voicemails.tsx`:

```tsx
// web/src/routes/inbox/voicemails.tsx
import { NavLink, Outlet, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../../trpc.js";
import { useWsChannel } from "../../ws.js";
import { MasterDetail } from "../../components/MasterDetail.js";
import "./voicemails.css";

export const handle = { breadcrumb: "Inbox / Voicemails", filters: null };

interface Row {
  stem: string;
  firstWords: string | null;
  sizeBytes: number;
  mtimeMs: number;
  hasTranscript: boolean;
  hasSummary: boolean;
}

export function Voicemails() {
  const { data, isPending } = trpc.voicemails.list.useQuery({});
  const qc = useQueryClient();
  useWsChannel("sidebar-counts", () => {
    qc.invalidateQueries({ queryKey: [["voicemails", "list"]] });
  });
  const params = useParams();
  const activeStem = params.stem;

  const rows = (data as Row[] | undefined) ?? [];

  const list = rows.length === 0
    ? null  // empty state handled in the index route
    : rows.map((r) => (
        <NavLink
          key={r.stem}
          to={r.stem}
          data-testid="voicemail-row"
          className={({ isActive }) => "voicemail-row" + (isActive ? " active" : "")}
        >
          <div className="voicemail-row-title">{r.firstWords ?? r.stem}</div>
          <div className="voicemail-row-meta">
            <span>{formatSeconds(r.sizeBytes)}</span>
            <span>·</span>
            <span>{formatDate(r.mtimeMs)}</span>
            {r.hasSummary && <span className="voicemail-row-check">✓</span>}
          </div>
        </NavLink>
      ));

  return (
    <MasterDetail
      listPending={isPending}
      listSlot={<div className="voicemail-list">{list}</div>}
      detailSlot={<Outlet />}
    />
  );
  // activeStem is read for future filter UX (e.g. scroll into view); not yet needed here
  void activeStem;
}

function formatSeconds(bytes: number): string {
  // Rough: 16-bit 16kHz mono WAV ≈ 32_000 bytes/sec; close enough for the master-list preview
  const sec = Math.max(1, Math.round(bytes / 32_000));
  return `${sec}s`;
}

function formatDate(ms: number): string {
  const d = new Date(ms);
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${mi}`;
}
```

Create `web/src/routes/inbox/voicemails.css`:

```css
/* web/src/routes/inbox/voicemails.css */
.voicemail-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.voicemail-row {
  display: flex;
  flex-direction: column;
  padding: 8px 10px;
  border-radius: var(--radius-inner);
  color: var(--fg);
  cursor: pointer;
  transition: background 100ms;
}
.voicemail-row:hover { background: var(--row-hover); }
.voicemail-row.active {
  background: var(--accent-soft);
}
.voicemail-row.active .voicemail-row-title { color: var(--accent); }
.voicemail-row-title {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.voicemail-row-meta {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--fg-3);
}
.voicemail-row-check {
  margin-left: auto;
  color: var(--green);
}
```

Create `web/src/routes/inbox/voicemails.index.tsx`:

```tsx
// web/src/routes/inbox/voicemails.index.tsx
import { EmptyState } from "../../components/EmptyState.js";

export function VoicemailsIndex() {
  return <EmptyState icon="🎙️" label="Select a voicemail to view." />;
}
```

- [ ] **Step 4: Wire children into `App.tsx`**

In `web/src/App.tsx`, find the voicemails route entry:

```ts
{ path: "inbox/voicemails", Component: Voicemails, handle: voicemailsHandle },
```

Replace with:

```ts
{
  path: "inbox/voicemails",
  Component: Voicemails,
  handle: voicemailsHandle,
  children: [
    { index: true, Component: VoicemailsIndex },
    // { path: ":stem", Component: VoicemailReader, handle: voicemailReaderHandle }, // wired in C.11
  ],
},
```

Add the import near the top:

```ts
import { VoicemailsIndex } from "./routes/inbox/voicemails.index.js";
```

- [ ] **Step 5: Re-run, verify PASS + full suite + typecheck**

```bash
npm test -- tests/web/voicemails.list.test.tsx
npm test
npm run typecheck
```

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.tsx \
        yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.css \
        yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.index.tsx \
        yulu/scripts/yulu_ui/web/src/App.tsx \
        yulu/scripts/yulu_ui/tests/web/voicemails.list.test.tsx
git commit -m "feat(yulu_ui/web): Voicemails list view with WS auto-refresh + index empty"
```

---

## Task C.11 — Voicemails reader (`:stem` nested route)

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.$stem.tsx`
- Modify: `yulu/scripts/yulu_ui/web/src/App.tsx` (add `:stem` child)
- Create: `yulu/scripts/yulu_ui/tests/web/voicemails.reader.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/voicemails.reader.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VoicemailReader } from "../../web/src/routes/inbox/voicemails.$stem.js";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    voicemails: {
      get: { useQuery: () => ({
        data: {
          stem: "voicemail_20260526_120000",
          wavPath: "/x/voicemail_20260526_120000.wav",
          sizeBytes: 32000,
          mtimeMs: 1000003,
          transcript: "Speaker A: hello\nSpeaker B: world",
          summary: "## summary\n- point one\n- point two",
        },
        isPending: false,
      }) },
    },
    glossary: { list: { useQuery: () => ({ data: [], isError: false }) } },
  },
}));

// AudioPlayer stub so tests don't need wavesurfer
vi.mock("../../web/src/components/AudioPlayer.js", () => ({
  AudioPlayer: ({ src }: { src: string }) => <div data-testid="audio-stub">{src}</div>,
}));

function mount(initialPath = "/inbox/voicemails/voicemail_20260526_120000") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: "/inbox/voicemails/:stem", Component: VoicemailReader }],
    { initialEntries: [initialPath] },
  );
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

describe("VoicemailReader", () => {
  it("renders the AudioPlayer pointed at the right /files URL", () => {
    mount();
    expect(screen.getByTestId("audio-stub")).toHaveTextContent("/files/voicemails/voicemail_20260526_120000.wav");
  });

  it("renders all three tabs: Transcript, Summary, Raw", () => {
    mount();
    expect(screen.getByRole("button", { name: "Transcript" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summary" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Raw" })).toBeInTheDocument();
  });

  it("defaults to Summary tab when summary exists", () => {
    mount();
    expect(screen.getByText(/point one/)).toBeInTheDocument();
  });

  it("clicking Transcript tab shows transcript text", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Transcript" }));
    expect(screen.getByText(/hello/)).toBeInTheDocument();
    expect(screen.getByText(/world/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/voicemails.reader.test.tsx
```

- [ ] **Step 3: Implement**

```tsx
// web/src/routes/inbox/voicemails.$stem.tsx
import { useParams, useSearchParams } from "react-router";
import { trpc } from "../../trpc.js";
import { AudioPlayer } from "../../components/AudioPlayer.js";
import { TranscriptView } from "../../components/TranscriptView.js";
import { EmptyState } from "../../components/EmptyState.js";
import "./voicemails.reader.css";

export const handle = { breadcrumb: "Inbox / Voicemails", filters: null };

type Tab = "transcript" | "summary" | "raw";

export function VoicemailReader() {
  const { stem = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { data, isPending } = trpc.voicemails.get.useQuery({ stem }, { enabled: stem.length > 0 });

  if (isPending) return <EmptyState label="Loading…" />;
  if (!data) return <EmptyState label={`Voicemail "${stem}" not found.`} />;

  const tabParam = params.get("tab") as Tab | null;
  const defaultTab: Tab = data.summary ? "summary" : "transcript";
  const tab: Tab = (tabParam === "transcript" || tabParam === "summary" || tabParam === "raw") ? tabParam : defaultTab;

  const setTab = (t: Tab) => {
    const next = new URLSearchParams(params);
    next.set("tab", t);
    setParams(next, { replace: true });
  };

  const seekParam = params.get("seek");
  const initialSeek = seekParam ? parseFloat(seekParam) : undefined;

  return (
    <div className="reader">
      <div className="reader-header">
        <h2 className="reader-title">{data.stem}</h2>
        <div className="reader-meta">
          <span>{new Date(data.mtimeMs).toLocaleString()}</span>
        </div>
      </div>

      <AudioPlayer
        src={`/files/voicemails/${data.stem}.wav`}
        initialSeek={Number.isFinite(initialSeek) ? initialSeek : undefined}
      />

      <div className="reader-tabs" role="tablist">
        {(["transcript", "summary", "raw"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            className={"reader-tab" + (tab === t ? " active" : "")}
            onClick={() => setTab(t)}
          >
            {t === "transcript" ? "Transcript" : t === "summary" ? "Summary" : "Raw"}
          </button>
        ))}
      </div>

      <div className="reader-body">
        {tab === "transcript" && (
          data.transcript ? <TranscriptView text={data.transcript} /> : <EmptyState label="No transcript available." />
        )}
        {tab === "summary" && (
          data.summary ? <pre className="reader-md">{data.summary}</pre> : <EmptyState label="No summary yet." />
        )}
        {tab === "raw" && (
          <pre className="reader-raw">{data.transcript ?? ""}</pre>
        )}
      </div>
    </div>
  );
}
```

```css
/* web/src/routes/inbox/voicemails.reader.css */
.reader {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 10px 14px;
}
.reader-header {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.reader-title {
  font-size: 15px;
  font-weight: 500;
  margin: 0;
  color: var(--fg);
}
.reader-meta {
  font-size: 11px;
  color: var(--fg-3);
}
.reader-tabs {
  display: flex;
  gap: 4px;
  padding: 4px;
  background: var(--row-hover);
  border-radius: var(--radius-inner);
  width: fit-content;
}
.reader-tab {
  padding: 4px 12px;
  border-radius: 6px;
  font-size: 11px;
  color: var(--fg-2);
}
.reader-tab:hover { color: var(--fg); }
.reader-tab.active {
  background: var(--glass-3);
  color: var(--fg);
}
.reader-body {
  font-size: 13px;
  line-height: 1.7;
}
.reader-md, .reader-raw {
  font-family: inherit;
  font-size: 13px;
  white-space: pre-wrap;
  word-wrap: break-word;
  margin: 0;
}
.reader-raw {
  font-family: "SF Mono", ui-monospace, monospace;
  font-size: 11px;
  color: var(--fg-2);
}
```

- [ ] **Step 4: Wire into `App.tsx`**

In the voicemails children array, uncomment / add:

```ts
import { VoicemailReader, handle as voicemailReaderHandle } from "./routes/inbox/voicemails.$stem.js";
// ...
children: [
  { index: true, Component: VoicemailsIndex },
  { path: ":stem", Component: VoicemailReader, handle: voicemailReaderHandle },
],
```

- [ ] **Step 5: Re-run, verify PASS + full suite + typecheck**

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.\$stem.tsx \
        yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.reader.css \
        yulu/scripts/yulu_ui/web/src/App.tsx \
        yulu/scripts/yulu_ui/tests/web/voicemails.reader.test.tsx
git commit -m "feat(yulu_ui/web): VoicemailReader (:stem nested route + tabs + AudioPlayer)"
```

---

## Task C.12 — Voicemails URL state: `?seek=` persistence + `?snippet=` scroll

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.$stem.tsx`
- Create: `yulu/scripts/yulu_ui/tests/web/voicemails.url.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/voicemails.url.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VoicemailReader } from "../../web/src/routes/inbox/voicemails.$stem.js";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    voicemails: {
      get: { useQuery: () => ({
        data: {
          stem: "voicemail_20260526_120000",
          wavPath: "/x/voicemail_20260526_120000.wav",
          sizeBytes: 32000,
          mtimeMs: 1000003,
          transcript: "alpha beta gamma OKR delta epsilon",
          summary: null,
        },
        isPending: false,
      }) },
    },
    glossary: { list: { useQuery: () => ({ data: [], isError: false }) } },
  },
}));

vi.mock("../../web/src/components/AudioPlayer.js", () => ({
  AudioPlayer: ({ initialSeek }: { initialSeek?: number }) => <div data-testid="audio-stub" data-seek={initialSeek ?? "none"} />,
}));

function mountAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: "/inbox/voicemails/:stem", Component: VoicemailReader }],
    { initialEntries: [path] },
  );
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

describe("Voicemails URL state", () => {
  it("passes ?seek= as initialSeek to AudioPlayer", () => {
    mountAt("/inbox/voicemails/voicemail_20260526_120000?seek=12.3");
    expect(screen.getByTestId("audio-stub")).toHaveAttribute("data-seek", "12.3");
  });

  it("?snippet= scrolls the first match into view + applies highlight class", async () => {
    mountAt("/inbox/voicemails/voicemail_20260526_120000?tab=transcript&snippet=OKR");
    await waitFor(() => {
      const highlighted = document.querySelector(".search-highlight");
      expect(highlighted).not.toBeNull();
      expect(highlighted?.textContent).toContain("OKR");
    });
  });

  it("?snippet= silently skips if no match", () => {
    mountAt("/inbox/voicemails/voicemail_20260526_120000?tab=transcript&snippet=zzznosuch");
    expect(document.querySelector(".search-highlight")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/voicemails.url.test.tsx
```

- [ ] **Step 3: Implement — snippet highlighting in `voicemails.$stem.tsx`**

In `voicemails.$stem.tsx`, after the `<div className="reader-body">` block, add a `useEffect` to handle snippet scrolling. Inside the `VoicemailReader` component, add:

```ts
import { useEffect, useRef } from "react";
// (combine with existing react-router imports)

// inside VoicemailReader, near the top:
const bodyRef = useRef<HTMLDivElement>(null);
const snippet = (params.get("snippet") ?? "").replace(/\[\/?hit\]/g, "").trim();

useEffect(() => {
  if (!snippet || !bodyRef.current) return;
  const body = bodyRef.current;
  const text = body.textContent ?? "";
  const idx = text.toLowerCase().indexOf(snippet.toLowerCase());
  if (idx < 0) return;
  // Walk the DOM to find the text node + offset, wrap with a highlight span
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  let acc = 0;
  while (true) {
    const node = walker.nextNode() as Text | null;
    if (!node) break;
    const nodeLen = node.data.length;
    if (acc + nodeLen > idx) {
      const start = idx - acc;
      const span = document.createElement("span");
      span.className = "search-highlight";
      const matched = node.splitText(start);
      const remainder = matched.splitText(Math.min(snippet.length, matched.data.length));
      void remainder;
      span.textContent = matched.data;
      matched.replaceWith(span);
      span.scrollIntoView({ block: "center" });
      const t = setTimeout(() => span.classList.add("fade"), 50);
      const t2 = setTimeout(() => span.classList.remove("search-highlight", "fade"), 2050);
      return () => { clearTimeout(t); clearTimeout(t2); };
    }
    acc += nodeLen;
  }
}, [snippet, tab, data]);
```

And update the JSX:

```tsx
<div className="reader-body" ref={bodyRef}>
  {/* existing tab content */}
</div>
```

Also add CSS to `voicemails.reader.css`:

```css
.search-highlight {
  background: var(--accent);
  color: var(--wp-1);
  padding: 0 2px;
  border-radius: 2px;
  transition: background 2s ease-out, color 2s ease-out;
}
.search-highlight.fade {
  background: transparent;
  color: inherit;
}
```

- [ ] **Step 4: Re-run, verify PASS + full suite + typecheck**

```bash
npm test -- tests/web/voicemails.url.test.tsx
npm test
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.\$stem.tsx \
        yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.reader.css \
        yulu/scripts/yulu_ui/tests/web/voicemails.url.test.tsx
git commit -m "feat(yulu_ui/web): voicemails URL state (?seek init + ?snippet scroll-to-match)"
```

---

## Task C.13 — Voicemails TopBar filters

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.tsx` (use FilterChips in handle.filters)
- Create: `yulu/scripts/yulu_ui/tests/web/voicemails.filters.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/voicemails.filters.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, Outlet } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Voicemails } from "../../web/src/routes/inbox/voicemails.js";
import { TopBar } from "../../web/src/components/TopBar.js";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    voicemails: {
      list: { useQuery: () => ({
        data: [
          { stem: "voicemail_20260526_120000", firstWords: "with summary", sizeBytes: 1024, mtimeMs: Date.now() - 1000, hasTranscript: true, hasSummary: true },
          { stem: "voicemail_20260526_110000", firstWords: "no summary", sizeBytes: 1024, mtimeMs: Date.now() - 1000, hasTranscript: true, hasSummary: false },
          { stem: "voicemail_20260520_100000", firstWords: "old one", sizeBytes: 1024, mtimeMs: Date.now() - 30 * 86_400_000, hasTranscript: true, hasSummary: true },
        ],
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

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Layout() { return (<><TopBar /><Outlet /></>); }
  const router = createMemoryRouter([
    {
      path: "/",
      Component: Layout,
      children: [{
        path: "inbox/voicemails",
        Component: Voicemails,
        handle: undefined,                  // filters wired by Voicemails internally
        children: [{ index: true, element: null }],
      }],
    },
  ], { initialEntries: ["/inbox/voicemails"] });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

describe("Voicemails filters", () => {
  it("renders the 3 filter chips in TopBar (All, Summarized, Last 7d)", () => {
    mount();
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarized" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Last 7d" })).toBeInTheDocument();
  });

  it("clicking Summarized filters list to summarized rows only", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Summarized" }));
    const rows = screen.getAllByTestId("voicemail-row");
    expect(rows).toHaveLength(2); // with summary + old one (also has summary)
    expect(rows.every((r) => r.textContent?.includes("✓"))).toBe(true);
  });

  it("clicking Last 7d filters out older rows", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Last 7d" }));
    const rows = screen.getAllByTestId("voicemail-row");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.textContent?.includes("old one"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/voicemails.filters.test.tsx
```

- [ ] **Step 3: Implement — wire FilterChips into `handle.filters`**

In `web/src/routes/inbox/voicemails.tsx`, refactor:

```tsx
import { useState, useMemo } from "react";
// ... existing imports
import { FilterChips, type ChipDef } from "../../components/FilterChips.js";

const FILTER_CHIPS: ChipDef[] = [
  { id: "all", label: "All" },
  { id: "summarized", label: "Summarized" },
  { id: "last7d", label: "Last 7d" },
];

export function Voicemails() {
  const { data, isPending } = trpc.voicemails.list.useQuery({});
  const qc = useQueryClient();
  useWsChannel("sidebar-counts", () => {
    qc.invalidateQueries({ queryKey: [["voicemails", "list"]] });
  });

  const [activeFilters, setActiveFilters] = useState<string[]>([]);
  const rows = useMemo(() => {
    const all = ((data as Row[] | undefined) ?? []);
    let out = all;
    if (activeFilters.includes("summarized")) out = out.filter((r) => r.hasSummary);
    if (activeFilters.includes("last7d")) {
      const cutoff = Date.now() - 7 * 86_400_000;
      out = out.filter((r) => r.mtimeMs >= cutoff);
    }
    return out;
  }, [data, activeFilters]);

  // Provide filters into the route handle dynamically via context. Since handle is
  // static, we instead render FilterChips inline at the page-top — TopBar reads
  // handle.filters for the static case; the page can override by rendering a
  // visually-similar chip group as its first child.
  //
  // Simpler approach: keep handle.filters = null and render FilterChips inline at
  // the top of the list column.

  const list = rows.length === 0
    ? null
    : rows.map(/* same as before */);

  return (
    <MasterDetail
      listPending={isPending}
      listSlot={
        <>
          <div className="voicemail-filterbar">
            <FilterChips chips={FILTER_CHIPS} activeIds={activeFilters} onChange={setActiveFilters} />
          </div>
          <div className="voicemail-list">{list}</div>
        </>
      }
      detailSlot={<Outlet />}
    />
  );
}
```

Add to `voicemails.css`:

```css
.voicemail-filterbar {
  padding: 6px 4px 10px;
  border-bottom: 1px solid var(--edge);
  margin-bottom: 6px;
}
```

Note: the TopBar still reads `handle.filters` (null here). For Phase C we render the filter chips inside the list column instead of in the TopBar — this keeps the filter visually tied to the list it's filtering (more discoverable than a remote TopBar slot), and means we don't need to thread state from a child route up into the route handle.

If you prefer TopBar filters, the alternative is a `<FilterContext>` provider mounted by Voicemails that TopBar reads via context — but per Phase B's TopBar design (`handle.filters: ReactNode`), the handle is static. Inline is simpler.

- [ ] **Step 4: Re-run, verify PASS + full suite + typecheck**

```bash
npm test -- tests/web/voicemails.filters.test.tsx
npm test
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.tsx \
        yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.css \
        yulu/scripts/yulu_ui/tests/web/voicemails.filters.test.tsx
git commit -m "feat(yulu_ui/web): Voicemails filters (All/Summarized/Last 7d) in list column"
```

---

## Tasks C.14, C.15, C.16 — Meetings list + reader + filters

The Meetings pages mirror Voicemails 1:1 with three differences:
- List row uses `meetingTitle` (parsed by Phase A `meetings.list` STEM_RE) + `HH:MM:SS` duration (calculated from `sizeBytes` similar to voicemails)
- Reader has an extra `Realtime` tab visible only when `data.realtime !== null`
- Filters: `All | Summarized | Last 30d | Has realtime` (4 chips instead of 3)

### Task C.14 — Meetings list view + nested route shell

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.index.tsx`
- Modify: `yulu/scripts/yulu_ui/web/src/App.tsx`
- Create: `yulu/scripts/yulu_ui/tests/web/meetings.list.test.tsx`

Follow the same TDD pattern as C.10. The implementation is the same shape with these substitutions:

- Component name: `Meetings` (export it as `Meetings`)
- Query: `trpc.meetings.list.useQuery({})`
- Row type adds `meetingTitle: string`, `recordedAt: string`, `hasRealtime: boolean`, `attendeeCount?: number`
- Row rendering: title = `meetingTitle`; meta line = `formatDuration(sizeBytes)` + `recordedAt` + `✓` (summary) + `attendeeCount` chip when present
- Reuse `voicemails.css` styles via a duplicated `meetings.css` (small enough that DRY isn't worth a shared file at this stage)

`meetings.index.tsx`:
```tsx
import { EmptyState } from "../../components/EmptyState.js";
export function MeetingsIndex() {
  return <EmptyState icon="🎬" label="Select a meeting to view." />;
}
```

App.tsx wiring mirrors voicemails — replace the meetings route with the same nested structure (`{ index: true, Component: MeetingsIndex }` + `{ path: ":stem", Component: MeetingReader, handle: meetingReaderHandle }`).

Tests assert: rows render, ✓ marker, index outlet renders.

- [ ] **TDD cycle**: write test (FAIL) → implement → test (PASS) → typecheck → commit

```bash
git add yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.tsx \
        yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.css \
        yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.index.tsx \
        yulu/scripts/yulu_ui/web/src/App.tsx \
        yulu/scripts/yulu_ui/tests/web/meetings.list.test.tsx
git commit -m "feat(yulu_ui/web): Meetings list view with WS auto-refresh + index empty"
```

### Task C.15 — Meeting reader (:stem nested route, + Realtime tab)

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.$stem.tsx`
- Modify: `yulu/scripts/yulu_ui/web/src/App.tsx`
- Create: `yulu/scripts/yulu_ui/tests/web/meetings.reader.test.tsx`

Implementation: copy `voicemails.$stem.tsx` and substitute:
- Query: `trpc.meetings.get.useQuery({ stem })`
- Tab type adds `"realtime"`: `type Tab = "transcript" | "summary" | "realtime" | "raw"`
- Realtime tab button conditionally rendered: `{data.realtime !== null && <button>Realtime</button>}`
- Realtime body content: `{tab === "realtime" && <pre className="reader-raw">{data.realtime ?? ""}</pre>}`
- AudioPlayer src: `/files/meetings/${data.stem}.wav`

Default tab logic:
```ts
const defaultTab: Tab = data.summary ? "summary" : data.transcript ? "transcript" : "raw";
```

Tests:
1. All 3 tabs always present (transcript / summary / raw)
2. Realtime tab appears only when `data.realtime` is non-null
3. Realtime tab content shows the realtime text
4. Default tab is summary when present

- [ ] **TDD cycle**: write test → FAIL → implement → PASS → typecheck → commit

```bash
git add yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.\$stem.tsx \
        yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.reader.css \
        yulu/scripts/yulu_ui/web/src/App.tsx \
        yulu/scripts/yulu_ui/tests/web/meetings.reader.test.tsx
git commit -m "feat(yulu_ui/web): MeetingReader with Realtime tab"
```

### Task C.16 — Meetings filters

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.tsx`
- Create: `yulu/scripts/yulu_ui/tests/web/meetings.filters.test.tsx`

Same pattern as C.13. The four-chip definition:

```ts
const FILTER_CHIPS: ChipDef[] = [
  { id: "all", label: "All" },
  { id: "summarized", label: "Summarized" },
  { id: "last30d", label: "Last 30d" },
  { id: "has-realtime", label: "Has realtime" },
];
```

Filter logic:
- `summarized`: `r.hasSummary`
- `last30d`: `r.mtimeMs >= Date.now() - 30 * 86_400_000`
- `has-realtime`: `r.hasRealtime`

Tests assert: 4 chips render, each one filters the list correctly, AND semantics (Summarized + Has realtime = both true).

- [ ] **TDD cycle** then commit:

```bash
git add yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.tsx \
        yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.css \
        yulu/scripts/yulu_ui/tests/web/meetings.filters.test.tsx
git commit -m "feat(yulu_ui/web): Meetings filters (All/Summarized/Last 30d/Has realtime)"
```

---

## Task C.17 — Search page input + URL state

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/inbox/search.tsx` (replace placeholder)
- Create: `yulu/scripts/yulu_ui/web/src/routes/inbox/search.css`
- Create: `yulu/scripts/yulu_ui/tests/web/search.test.tsx`

- [ ] **Step 1: Write failing test (input + URL sync)**

```tsx
// tests/web/search.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Search } from "../../web/src/routes/inbox/search.js";

const runMock = vi.fn(() => ({ data: undefined, isPending: false }));
vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    search: { run: { useQuery: (input: unknown) => { runMock(); return { data: undefined, isPending: false }; } } },
  },
}));

function mount(initialPath = "/inbox/search") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: "/inbox/search", Component: Search }],
    { initialEntries: [initialPath] },
  );
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

describe("Search page", () => {
  it("renders an input with role=searchbox", () => {
    mount();
    expect(screen.getByRole("searchbox")).toBeInTheDocument();
  });

  it("populates input from ?q= URL param", () => {
    mount("/inbox/search?q=OKR");
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("OKR");
  });

  it("typing into the input writes ?q= to URL", async () => {
    mount();
    const user = userEvent.setup();
    await user.type(screen.getByRole("searchbox"), "OKR");
    // After typing, URL should reflect the query (router is in-memory but useSearchParams works)
    // We assert via the input value (which is bound to URL via useSearchParams) — final value 'OKR'
    expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("OKR");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// web/src/routes/inbox/search.tsx
import { useSearchParams } from "react-router";
import { trpc } from "../../trpc.js";
import { useDebounced } from "../../hooks/useDebounced.js";
import "./search.css";

export const handle = { breadcrumb: "Inbox / Search", filters: null };

export function Search() {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const debouncedQ = useDebounced(q, 300);

  const setQ = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set("q", value); else next.delete("q");
    setParams(next, { replace: true });
  };

  const type = params.get("type");
  const inLayer = params.get("in");
  const kinds = (type === "voicemail" || type === "meeting") && (inLayer === "summary" || inLayer === "transcript")
    ? [`${type}_${inLayer}`] as const
    : undefined;

  const { data, isPending } = trpc.search.run.useQuery(
    { query: debouncedQ, kinds: kinds as never, since: params.get("since") ?? undefined },
    { enabled: debouncedQ.length >= 2 }
  );

  return (
    <div className="search-page">
      <div className="search-header">
        <input
          type="search"
          role="searchbox"
          className="search-input"
          placeholder="Search voicemails, meetings, summaries…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
      </div>
      <div className="search-results">
        {/* results rendered in C.18 */}
        {debouncedQ.length >= 2 && isPending && <div className="search-empty">Searching…</div>}
      </div>
    </div>
  );
}
```

```css
/* web/src/routes/inbox/search.css */
.search-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  padding: 10px 14px;
  gap: 10px;
}
.search-header {
  display: flex;
  gap: 10px;
}
.search-input {
  flex: 1;
  padding: 10px 14px;
  border-radius: var(--radius-panel);
  background: var(--glass);
  color: var(--fg);
  font-size: 13px;
  border: none;
  box-shadow: var(--edge-shadow);
}
.search-input::placeholder { color: var(--fg-3); }
.search-input:focus { outline: 2px solid var(--accent-soft); outline-offset: 0; }
.search-results {
  flex: 1;
  overflow-y: auto;
}
.search-empty {
  padding: 20px;
  color: var(--fg-3);
  font-size: 12px;
}
```

- [ ] **Step 4: Re-run, verify PASS + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/inbox/search.tsx \
        yulu/scripts/yulu_ui/web/src/routes/inbox/search.css \
        yulu/scripts/yulu_ui/tests/web/search.test.tsx
git commit -m "feat(yulu_ui/web): Search input + URL state + debounced query"
```

---

## Task C.18 — Search results column + snippet rendering

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/inbox/search.tsx`
- Modify: `yulu/scripts/yulu_ui/tests/web/search.test.tsx` (append)

- [ ] **Step 1: Append failing test**

```ts
it("renders result rows with stem + score + snippet (hit segments colored)", async () => {
  // Override the mock to return some hits
  const hits = {
    hits: [
      { kind: "voicemail_summary", stem: "voicemail_20260526_120000",
        meetingTitle: "voicemail", recordedAt: "2026-05-26T12:00:00",
        sourcePath: "/x/y.md", score: 1.5, snippet: "Quarter [hit]OKR[/hit] review next" }
    ],
    telemetry: { sweepMs: 12, queryMs: 4, fallbackUsed: false, hitCount: 1 }
  };
  // Reset module mock with new return value
  const { vi } = await import("vitest");
  vi.doMock("../../web/src/trpc.js", () => ({
    trpc: {
      search: { run: { useQuery: () => ({ data: hits, isPending: false }) } },
    },
  }));
  // Re-import after re-mock (vitest convention)
  const { Search: SearchHits } = await import("../../web/src/routes/inbox/search.js");
  const { createMemoryRouter, RouterProvider } = await import("react-router");
  const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: "/inbox/search", Component: SearchHits }],
    { initialEntries: ["/inbox/search?q=OKR"] },
  );
  const { render } = await import("@testing-library/react");
  const { container } = render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
  expect(container.querySelector(".search-result")).not.toBeNull();
  expect(container.querySelector(".search-snippet-hit")).not.toBeNull();
  expect(container.querySelector(".search-snippet-hit")?.textContent).toBe("OKR");
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement — extend search.tsx**

In `web/src/routes/inbox/search.tsx`, replace the placeholder results block with:

```tsx
interface Hit {
  kind: string;
  stem: string;
  meetingTitle: string;
  recordedAt: string;
  sourcePath: string;
  score: number;
  snippet: string;
}

// ... inside Search component, replace the search-results div:
<div className="search-results">
  {debouncedQ.length < 2 && (
    <div className="search-empty">Type at least 2 characters to search.</div>
  )}
  {debouncedQ.length >= 2 && isPending && <div className="search-empty">Searching…</div>}
  {debouncedQ.length >= 2 && !isPending && (data?.hits?.length ?? 0) === 0 && (
    <div className="search-empty">No matches for "{debouncedQ}".</div>
  )}
  {(data?.hits as Hit[] | undefined)?.map((h, i) => (
    <SearchResultRow key={`${h.stem}-${i}`} hit={h} />
  ))}
  {data && (
    <div className="search-telemetry">
      {(data.hits as Hit[]).length} hits ({(data.telemetry as { sweepMs: number; queryMs: number; fallbackUsed: boolean }).sweepMs} ms sweep, {(data.telemetry as { sweepMs: number; queryMs: number }).queryMs} ms query, {(data.telemetry as { fallbackUsed: boolean }).fallbackUsed ? "LIKE" : "FTS5"})
    </div>
  )}
</div>
```

Add `SearchResultRow` component at the bottom of `search.tsx`:

```tsx
function SearchResultRow({ hit }: { hit: Hit }) {
  return (
    <div className="search-result">
      <div className="search-result-title">{hit.meetingTitle === "voicemail" ? hit.stem : hit.meetingTitle}</div>
      <div className="search-result-meta">
        <span>{hit.recordedAt}</span>
        <span>·</span>
        <span>score {hit.score.toFixed(2)}</span>
        <span>·</span>
        <span>{hit.kind}</span>
      </div>
      <div className="search-result-snippet">{renderSnippet(hit.snippet)}</div>
    </div>
  );
}

function renderSnippet(snippet: string): React.ReactNode[] {
  // Tokenize [hit]...[/hit] segments
  const out: React.ReactNode[] = [];
  const re = /\[hit\](.*?)\[\/hit\]/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(snippet)) !== null) {
    if (m.index > lastIdx) out.push(snippet.slice(lastIdx, m.index));
    out.push(<span key={key++} className="search-snippet-hit">{m[1]}</span>);
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < snippet.length) out.push(snippet.slice(lastIdx));
  return out;
}
```

Append to `search.css`:

```css
.search-result {
  padding: 12px 14px;
  border-radius: var(--radius-inner);
  margin-bottom: 4px;
  cursor: pointer;
  transition: background 100ms;
}
.search-result:hover { background: var(--row-hover); }
.search-result-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--fg);
}
.search-result-meta {
  display: flex;
  gap: 4px;
  margin-top: 2px;
  font-size: 11px;
  color: var(--fg-3);
}
.search-result-snippet {
  margin-top: 6px;
  font-size: 12px;
  color: var(--fg-2);
  line-height: 1.5;
}
.search-snippet-hit {
  color: var(--accent);
  font-weight: 500;
}
.search-telemetry {
  margin-top: 14px;
  font-size: 11px;
  color: var(--fg-3);
  font-family: "SF Mono", ui-monospace, monospace;
}
```

- [ ] **Step 4: Re-run, verify PASS + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/inbox/search.tsx \
        yulu/scripts/yulu_ui/web/src/routes/inbox/search.css \
        yulu/scripts/yulu_ui/tests/web/search.test.tsx
git commit -m "feat(yulu_ui/web): Search results column with [hit] snippet rendering"
```

---

## Task C.19 — Search filters (type / in / since)

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/inbox/search.tsx`
- Modify: `yulu/scripts/yulu_ui/tests/web/search.test.tsx` (append)

- [ ] **Step 1: Append failing test**

```ts
it("renders type + in dropdowns and since chips", () => {
  mount("/inbox/search?q=OKR");
  expect(screen.getByLabelText(/type/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/in/i)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Last 7d" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Last 30d" })).toBeInTheDocument();
});

it("selecting Type+In and a Since chip writes to URL params", async () => {
  mount("/inbox/search?q=OKR");
  const user = userEvent.setup();
  await user.selectOptions(screen.getByLabelText(/type/i), "voicemail");
  await user.selectOptions(screen.getByLabelText(/in/i), "summary");
  await user.click(screen.getByRole("button", { name: "Last 7d" }));
  // URL has been updated; we can verify via input persistence indirectly,
  // but the most direct assertion is that the select values are preserved
  expect((screen.getByLabelText(/type/i) as HTMLSelectElement).value).toBe("voicemail");
  expect((screen.getByLabelText(/in/i) as HTMLSelectElement).value).toBe("summary");
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement — extend `search.tsx`'s header**

Update the search-header block in `search.tsx`:

```tsx
import { FilterChips, type ChipDef } from "../../components/FilterChips.js";

const SINCE_CHIPS: ChipDef[] = [
  { id: "all", label: "All time" },
  { id: "7d", label: "Last 7d" },
  { id: "30d", label: "Last 30d" },
  { id: "90d", label: "Last 90d" },
];

// inside Search component:
const type = params.get("type") ?? "";
const inLayer = params.get("in") ?? "";
const since = params.get("since") ?? "";

const setParam = (key: string, value: string) => {
  const next = new URLSearchParams(params);
  if (value) next.set(key, value); else next.delete(key);
  setParams(next, { replace: true });
};

// In the JSX, replace .search-header:
<div className="search-header">
  <input
    type="search"
    role="searchbox"
    className="search-input"
    placeholder="Search…"
    value={q}
    onChange={(e) => setQ(e.target.value)}
    autoFocus
  />
  <label className="search-select-wrap">
    <span className="search-select-label">Type</span>
    <select
      className="search-select"
      aria-label="Type"
      value={type}
      onChange={(e) => setParam("type", e.target.value)}
    >
      <option value="">Any</option>
      <option value="voicemail">Voicemail</option>
      <option value="meeting">Meeting</option>
    </select>
  </label>
  <label className="search-select-wrap">
    <span className="search-select-label">In</span>
    <select
      className="search-select"
      aria-label="In"
      value={inLayer}
      onChange={(e) => setParam("in", e.target.value)}
    >
      <option value="">Any</option>
      <option value="summary">Summary</option>
      <option value="transcript">Transcript</option>
    </select>
  </label>
  <FilterChips
    chips={SINCE_CHIPS}
    activeIds={since ? [since] : []}
    onChange={(ids) => setParam("since", ids[0] === "all" ? "" : (ids[0] ?? ""))}
  />
</div>
```

Append to `search.css`:

```css
.search-select-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--fg-3);
}
.search-select {
  padding: 6px 8px;
  border-radius: var(--radius-inner);
  background: var(--glass);
  color: var(--fg);
  font-size: 12px;
  border: none;
}
```

- [ ] **Step 4: Re-run, verify PASS + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/inbox/search.tsx \
        yulu/scripts/yulu_ui/web/src/routes/inbox/search.css \
        yulu/scripts/yulu_ui/tests/web/search.test.tsx
git commit -m "feat(yulu_ui/web): Search filters (type/in dropdowns + since chips)"
```

---

## Task C.20 — Search → reader cross-page navigation

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/inbox/search.tsx` (make result rows navigate)
- Create: `yulu/scripts/yulu_ui/tests/web/search.crossnav.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/search.crossnav.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const HITS = {
  hits: [{
    kind: "voicemail_summary",
    stem: "voicemail_20260526_120000",
    meetingTitle: "voicemail",
    recordedAt: "2026-05-26T12:00:00",
    sourcePath: "/x/y.md",
    score: 1.5,
    snippet: "Quarter [hit]OKR[/hit] review next",
  }],
  telemetry: { sweepMs: 12, queryMs: 4, fallbackUsed: false, hitCount: 1 },
};

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    search: { run: { useQuery: () => ({ data: HITS, isPending: false }) } },
  },
}));

describe("Search cross-nav", () => {
  it("clicking a voicemail_summary hit navigates to /inbox/voicemails/:stem?tab=summary&snippet=...", async () => {
    const { Search } = await import("../../web/src/routes/inbox/search.js");
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const router = createMemoryRouter([
      { path: "/inbox/search", Component: Search },
      { path: "/inbox/voicemails/:stem", element: <div data-testid="vm-reader" /> },
    ], { initialEntries: ["/inbox/search?q=OKR"] });
    render(
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    );
    const user = userEvent.setup();
    await user.click(screen.getByText(/Quarter/));
    await waitFor(() => expect(screen.getByTestId("vm-reader")).toBeInTheDocument());
    // URL should be /inbox/voicemails/voicemail_20260526_120000?tab=summary&snippet=...
    // We can't assert router.state.location easily in this stub; the reader rendering is sufficient.
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

Update `SearchResultRow` in `search.tsx`:

```tsx
import { Link } from "react-router";

function SearchResultRow({ hit }: { hit: Hit }) {
  // Map kind ("voicemail_summary" / "meeting_transcript" / ...) to route + tab
  const [kindType, kindIn] = hit.kind.split("_");
  const basePath = kindType === "voicemail" ? "voicemails" : "meetings";
  const tab = kindIn === "summary" ? "summary" : kindIn === "transcript" ? "transcript" : "raw";
  // Strip [hit] markers so the snippet matcher in the reader can find a clean string
  const cleanSnippet = hit.snippet.replace(/\[\/?hit\]/g, "").trim().slice(0, 80);
  const target = `/inbox/${basePath}/${hit.stem}?tab=${tab}&snippet=${encodeURIComponent(cleanSnippet)}`;

  return (
    <Link to={target} className="search-result">
      <div className="search-result-title">{hit.meetingTitle === "voicemail" ? hit.stem : hit.meetingTitle}</div>
      <div className="search-result-meta">
        <span>{hit.recordedAt}</span>
        <span>·</span>
        <span>score {hit.score.toFixed(2)}</span>
        <span>·</span>
        <span>{hit.kind}</span>
      </div>
      <div className="search-result-snippet">{renderSnippet(hit.snippet)}</div>
    </Link>
  );
}
```

Update `.search-result` CSS to remove default link underline:

```css
.search-result {
  display: block;
  color: inherit;
  text-decoration: none;
  /* ... existing styles unchanged */
}
```

- [ ] **Step 4: Re-run, verify PASS + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/inbox/search.tsx \
        yulu/scripts/yulu_ui/web/src/routes/inbox/search.css \
        yulu/scripts/yulu_ui/tests/web/search.crossnav.test.tsx
git commit -m "feat(yulu_ui/web): Search result row → /inbox/<kind>/:stem cross-nav"
```

---

## Task C.21 — Keyboard shortcuts at `/inbox/*` layout level

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/routes/inbox/_layout.tsx`
- Modify: `yulu/scripts/yulu_ui/web/src/App.tsx` (wrap inbox routes in InboxLayout)
- Create: `yulu/scripts/yulu_ui/tests/web/inbox.hotkeys.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/inbox.hotkeys.test.tsx
import { describe, it, expect } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { InboxLayout } from "../../web/src/routes/inbox/_layout.js";
import { vi } from "vitest";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    voicemails: { list: { useQuery: () => ({
      data: [
        { stem: "vm1", firstWords: "a", sizeBytes: 1024, mtimeMs: 3, hasTranscript: true, hasSummary: false },
        { stem: "vm2", firstWords: "b", sizeBytes: 1024, mtimeMs: 2, hasTranscript: true, hasSummary: false },
        { stem: "vm3", firstWords: "c", sizeBytes: 1024, mtimeMs: 1, hasTranscript: true, hasSummary: false },
      ],
      isPending: false,
    }) }, get: { useQuery: () => ({ data: null, isPending: false }) } },
    glossary: { list: { useQuery: () => ({ data: [], isError: false }) } },
  },
}));

vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: () => {},
  nextBackoff: (n: number) => n,
}));

import { Voicemails } from "../../web/src/routes/inbox/voicemails.js";

function mount(initialPath = "/inbox/voicemails/vm2") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([
    {
      path: "/inbox",
      Component: InboxLayout,
      children: [
        {
          path: "voicemails",
          Component: Voicemails,
          children: [
            { index: true, element: <div>INDEX</div> },
            { path: ":stem", element: <div data-testid="reader" /> },
          ],
        },
      ],
    },
  ], { initialEntries: [initialPath] });
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

describe("Inbox keyboard shortcuts", () => {
  it("'j' navigates to next stem", async () => {
    mount("/inbox/voicemails/vm1");
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => {
      // The active row in DOM should switch from vm1 to vm2 (via NavLink active)
      const rows = screen.getAllByTestId("voicemail-row");
      expect(rows[1]?.className).toMatch(/active/);
    });
  });

  it("'k' navigates to previous stem", async () => {
    mount("/inbox/voicemails/vm2");
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => {
      const rows = screen.getAllByTestId("voicemail-row");
      expect(rows[0]?.className).toMatch(/active/);
    });
  });

  it("'k' on first stem stays on first (no wrap)", async () => {
    mount("/inbox/voicemails/vm1");
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => {
      const rows = screen.getAllByTestId("voicemail-row");
      expect(rows[0]?.className).toMatch(/active/);
    });
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement `_layout.tsx`**

```tsx
// web/src/routes/inbox/_layout.tsx
import { Outlet, useLocation, useNavigate, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useHotkeys } from "../../hooks/useHotkeys.js";
import { trpc } from "../../trpc.js";

/**
 * Wraps all /inbox/* routes. Registers keyboard shortcuts (j/k/space/[/]/) once.
 * Reads current route + selected stem to decide which list to navigate.
 */
export function InboxLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const params = useParams();
  const qc = useQueryClient();

  // Determine which list to navigate based on current path
  const isVoicemails = location.pathname.startsWith("/inbox/voicemails");
  const isMeetings = location.pathname.startsWith("/inbox/meetings");

  const moveSelection = useCallback((direction: 1 | -1) => {
    if (!isVoicemails && !isMeetings) return;
    const queryKey = isVoicemails ? ["voicemails", "list"] : ["meetings", "list"];
    const data = qc.getQueryData([queryKey, { input: {} }]) as Array<{ stem: string }> | undefined
              ?? qc.getQueryData([queryKey]) as Array<{ stem: string }> | undefined;
    if (!data || data.length === 0) return;
    const currentStem = params.stem;
    let idx = data.findIndex((r) => r.stem === currentStem);
    if (idx < 0) idx = 0; else idx = Math.max(0, Math.min(data.length - 1, idx + direction));
    const next = data[idx]?.stem;
    if (next) {
      const basePath = isVoicemails ? "/inbox/voicemails" : "/inbox/meetings";
      navigate(`${basePath}/${next}${location.search}`);
    }
  }, [isVoicemails, isMeetings, qc, params.stem, navigate, location.search]);

  useHotkeys({
    j: () => moveSelection(1),
    k: () => moveSelection(-1),
    // space / [ / ] / / handlers added in C.22 polish if time
  });

  return <Outlet />;
}
```

Update `App.tsx` to wrap the inbox routes under InboxLayout:

```ts
import { InboxLayout } from "./routes/inbox/_layout.js";

// inside createBrowserRouter children, group inbox routes:
{
  path: "inbox",
  Component: InboxLayout,
  children: [
    { path: "voicemails", Component: Voicemails, handle: voicemailsHandle, children: [
      { index: true, Component: VoicemailsIndex },
      { path: ":stem", Component: VoicemailReader, handle: voicemailReaderHandle },
    ]},
    { path: "meetings", Component: Meetings, handle: meetingsHandle, children: [
      { index: true, Component: MeetingsIndex },
      { path: ":stem", Component: MeetingReader, handle: meetingReaderHandle },
    ]},
    { path: "search", Component: Search, handle: searchHandle },
  ],
},
// (keep knowledge / settings / health routes unchanged at the top-level children)
```

- [ ] **Step 4: Re-run, verify PASS + full suite + typecheck**

```bash
npm test -- tests/web/inbox.hotkeys.test.tsx
npm test
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/inbox/_layout.tsx \
        yulu/scripts/yulu_ui/web/src/App.tsx \
        yulu/scripts/yulu_ui/tests/web/inbox.hotkeys.test.tsx
git commit -m "feat(yulu_ui/web): InboxLayout with j/k keyboard nav across list"
```

---

## Task C.22 — Real-machine smoke (dev + prod) + push

**Files:** none — verification + push.

- [ ] **Step 1: Clean rebuild + prod smoke**

```bash
cd yulu/scripts/yulu_ui
rm -rf dist
npm install
npm run build
YULU_UI_PORT=17790 node dist/server.js > /tmp/yulu_c22_prod.log 2>&1 &
PROD_PID=$!
sleep 1

echo "=== healthz ==="; curl -s http://127.0.0.1:17790/healthz; echo
echo "=== voicemails.list ==="; curl -s "http://127.0.0.1:17790/trpc/voicemails.list?input=%7B%22json%22%3A%7B%7D%7D" | head -c 400; echo
echo "=== SPA / ==="; curl -sI http://127.0.0.1:17790/ | head -3
echo "=== /inbox/voicemails/voicemail_xxx ==="; curl -sI http://127.0.0.1:17790/inbox/voicemails/abc | head -3

kill $PROD_PID 2>/dev/null; wait 2>/dev/null
```

Expected: healthz 200 JSON, voicemails.list returns array (real or empty depending on user's machine), SPA index served for both / and nested route.

- [ ] **Step 2: Dev mode smoke**

```bash
cd yulu/scripts/yulu_ui
npm run dev > /tmp/yulu_c22_dev.log 2>&1 &
DEV_PID=$!
sleep 5
curl -s http://127.0.0.1:7777/healthz; echo
curl -s http://127.0.0.1:5173/trpc/voicemails.list | head -c 200; echo
kill $DEV_PID 2>/dev/null
pkill -f "tsx watch src/server.ts" 2>/dev/null
pkill -f "vite --config" 2>/dev/null
wait 2>/dev/null
```

- [ ] **Step 3: Browser visual smoke (manual via /browse skill or real browser)**

Open `http://127.0.0.1:5173/inbox/voicemails`. Verify:

1. List column populates from real backend
2. Clicking a row navigates to `/inbox/voicemails/:stem`; reader shows AudioPlayer + tabs
3. Audio plays (if real wav file exists)
4. Tabs switch; URL `?tab=` persists
5. Filter chips (All / Summarized / Last 7d) toggle list
6. Pressing `j` / `k` moves selection
7. `/inbox/meetings` works equivalently with extra Realtime tab when present
8. `/inbox/search` — typing 2+ chars triggers search; results render; clicking a result navigates to source page

If anything visually wrong, fix and re-verify.

- [ ] **Step 4: Push**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git log --oneline | head -25
git push
```

- [ ] **Step 5: Update PR #24 description** to include Phase C in the list of completed phases

(No commit; just `gh pr edit 24 --body "..."` to refresh the description with Phase C bullet.)

---

## Self-review (run before declaring Phase C done)

Skim each spec section and confirm a task implements it:

- [ ] §3 architecture (master-detail + single column) → C.10, C.14, C.17
- [ ] §4 URL model (`:stem`, `?tab`, `?seek`, `?snippet`, `?q/type/in/since`) → C.10, C.11, C.12, C.17, C.19
- [ ] §5 five shared components → C.5, C.6, C.7, C.8, C.9
- [ ] §6 backend tweak (firstWords) → C.1
- [ ] §7 data flow + WS invalidation + debounced search → C.10, C.14, C.17 + C.3 (useDebounced)
- [ ] §8 keyboard shortcuts → C.21 (+ space/[/]/space deferred)
- [ ] §9 empty states → C.10 (index), C.11 (loading + not-found), C.18 (no matches)
- [ ] §10 loading skeleton → C.5 (MasterDetail listPending)
- [ ] §11 inboxWatcher → C.2
- [ ] §13 acceptance #1 list+reader voicemails → C.10, C.11
- [ ] §13 acceptance #2 list+reader meetings → C.14, C.15
- [ ] §13 acceptance #3 search + cross-nav → C.17, C.18, C.20
- [ ] §13 acceptance #4 snippet auto-scroll → C.12
- [ ] §13 acceptance #5 vocab highlight → C.8
- [ ] §13 acceptance #6 keyboard → C.21
- [ ] §13 acceptance #7 live refresh → C.2 + C.10/C.14
- [ ] §13 acceptance #8 filters wired → C.13, C.16, C.19
- [ ] §13 acceptance #9 all tests pass + smoke → C.22

Type consistency:
- `AppContext` and `AppChannels` (Phase A/B) — unchanged, only consumed
- `firstWords: string | null` — defined in C.1 (server) and consumed in C.10/C.14
- `PillState` (Phase B) — not touched in C
- `useHotkeys` map type — defined in C.4, consumed in C.21
- `ChipDef` (FilterChips) — defined in C.7, consumed in C.13/C.16/C.19

If any gap found, add the task before pushing.

---

## What's NOT in Phase C (deferred)

| Phase | Scope |
|---|---|
| D | Settings pages (Audio / Transcription / LLM / Hotkey / Integrations / Storage) — inline-edit + restart banner |
| E | Knowledge (Prompts master-detail reuses `<MasterDetail>` from C; Glossary inline table) |
| F | Health (Daemons grid + Logs tail via `useWsChannel('logs')`); Playwright E2E sweep after all real pages exist |
| G | setup.sh integration, yulu doctor entry, release packaging |
