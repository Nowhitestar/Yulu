# Yulu UI · Phase D — Settings Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Phase B placeholders for all 6 Settings pages (`/settings/{audio,transcription,llm,hotkey,integrations,storage}`) with real, interactive pages built on a shared inline-edit row + restart banner pattern. After Phase D the user can tune every knob in `~/.config/yulu/config.json` from the browser and trigger required daemon restarts with one click.

**Architecture:** Backend extends the existing `system` router with 5 new procedures (`pickFile`, `openInFinder`, `audioDevices`, `dbStats`, `logPaths`) and adds two new routers (`integrations.test`, `llm.test`). Frontend ships one `<InlineEditRow>` covering 6 variants (text/number/select/toggle/path/readonly), one `<RestartBanner>` that aggregates `daemonsNeedingRestart` from `config.update` responses, plus four special editors (`<HotkeyCapture>`, `<CommandEditor>`, `<TestPopover>`, `<DbStatsRow>`). Page state is per-page via `useSettingsRestartTracker` (useReducer hook).

**Tech Stack:** React 18 · React Router 7 · @tanstack/react-query 5 + @trpc/react-query 11 · `osascript` for native file dialogs · `system_profiler -json` for audio device discovery · `better-sqlite3` for DB stats · vanilla CSS · vitest + jsdom + @testing-library/react

**Spec reference:** [`docs/superpowers/specs/2026-05-27-yulu-ui-D-settings-pages-design.md`](../specs/2026-05-27-yulu-ui-D-settings-pages-design.md) (all sections)

**Out of scope (deferred to E–G + future polish):** Knowledge / Health / setup pages; add/remove calendar provider UI; MLX model picker; per-row revert button; Playwright E2E; SIGHUP visualization (SIGHUP fires automatically server-side in Phase A — no UI surface needed).

**Path conventions:** All paths relative to repo root. Server work in `yulu/scripts/yulu_ui/src/`; React work in `yulu/scripts/yulu_ui/web/`. Commands run from `yulu/scripts/yulu_ui/` unless noted.

---

## File Structure

```
yulu/scripts/yulu_ui/
├── src/
│   ├── routers/
│   │   ├── system.ts                MOD — add pickFile/openInFinder/audioDevices/dbStats/logPaths
│   │   ├── integrations.ts          NEW — test mutation
│   │   ├── llm.ts                   NEW — test mutation
│   │   └── _app.ts                  MOD — register integrations + llm routers
├── web/src/
│   ├── hooks/
│   │   └── useSettingsRestartTracker.ts          NEW
│   ├── components/
│   │   ├── SettingsPage.{tsx,css}                NEW
│   │   ├── InlineEditRow.{tsx,css}               NEW
│   │   ├── RestartBanner.{tsx,css}               NEW
│   │   ├── HotkeyCapture.{tsx,css}               NEW
│   │   ├── CommandEditor.{tsx,css}               NEW
│   │   ├── TestPopover.{tsx,css}                 NEW
│   │   └── DbStatsRow.{tsx,css}                  NEW
│   └── routes/settings/
│       ├── audio.tsx                MOD — replace placeholder
│       ├── transcription.tsx        MOD
│       ├── llm.tsx                  MOD
│       ├── hotkey.tsx               MOD
│       ├── integrations.tsx         MOD
│       └── storage.tsx              MOD
└── tests/
    ├── routers/
    │   ├── system.test.ts                    MOD — append tests for 5 new procedures
    │   ├── integrations.test.ts              NEW
    │   └── llm.test.ts                       NEW
    └── web/
        ├── useSettingsRestartTracker.test.ts NEW
        ├── SettingsPage.test.tsx             NEW
        ├── InlineEditRow.test.tsx            NEW
        ├── RestartBanner.test.tsx            NEW
        ├── HotkeyCapture.test.tsx            NEW
        ├── CommandEditor.test.tsx            NEW
        ├── TestPopover.test.tsx              NEW
        ├── DbStatsRow.test.tsx               NEW
        ├── settings.audio.test.tsx           NEW
        ├── settings.transcription.test.tsx   NEW
        ├── settings.llm.test.tsx             NEW
        ├── settings.hotkey.test.tsx          NEW
        ├── settings.integrations.test.tsx    NEW
        └── settings.storage.test.tsx         NEW
```

**Why these splits:** Backend procedures group by router. The hooks/components split mirrors Phase C's pattern (`hooks/` for utilities, `components/` for UI). Each Settings page gets its own test file (page-level integration test). Component tests cover variants in isolation.

---

## Task D.1 — Backend: `system.pickFile` + `system.openInFinder`

**Files:**
- Modify: `yulu/scripts/yulu_ui/src/routers/system.ts`
- Modify: `yulu/scripts/yulu_ui/tests/routers/system.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
// tests/routers/system.test.ts — append inside existing describe
import { vi as _vi } from "vitest";

const spawnMock = _vi.hoisted(() => _vi.fn());
_vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

beforeEach(() => spawnMock.mockReset());

function mockSpawn(stdout: string, exitCode = 0, stderr = "") {
  spawnMock.mockImplementation(() => {
    const handlers = new Map<string, (arg: unknown) => void>();
    const proc = {
      stdout: { on: (e: string, cb: (b: Buffer) => void) => { if (e === "data") cb(Buffer.from(stdout)); } },
      stderr: { on: (e: string, cb: (b: Buffer) => void) => { if (e === "data" && stderr) cb(Buffer.from(stderr)); } },
      on: (e: string, cb: (arg: unknown) => void) => { handlers.set(e, cb); },
      kill: () => {},
    };
    setImmediate(() => handlers.get("close")?.(exitCode));
    return proc;
  });
}

describe("system.pickFile", () => {
  it("returns the chosen path for mode=folder", async () => {
    mockSpawn("/Users/me/Movies/Yulu\n");
    const caller = createCaller(systemRouter, {} as AppContext);
    const r = await caller.pickFile({ mode: "folder" });
    expect(r.path).toBe("/Users/me/Movies/Yulu");
    expect(spawnMock.mock.calls[0]![0]).toBe("osascript");
  });

  it("returns the chosen path for mode=file with filter", async () => {
    mockSpawn("/x/y.bin\n");
    const caller = createCaller(systemRouter, {} as AppContext);
    const r = await caller.pickFile({ mode: "file", filter: "bin" });
    expect(r.path).toBe("/x/y.bin");
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args.join(" ")).toContain('"bin"');
  });

  it("returns null on user-cancel (non-zero exit)", async () => {
    mockSpawn("", 1, "User canceled.");
    const caller = createCaller(systemRouter, {} as AppContext);
    const r = await caller.pickFile({ mode: "folder" });
    expect(r.path).toBeNull();
  });
});

describe("system.openInFinder", () => {
  it("spawns `open <path>` when reveal=false", async () => {
    mockSpawn("");
    const caller = createCaller(systemRouter, {} as AppContext);
    const r = await caller.openInFinder({ path: "/x/y" });
    expect(r.ok).toBe(true);
    expect(spawnMock.mock.calls[0]![0]).toBe("open");
    expect(spawnMock.mock.calls[0]![1]).toEqual(["/x/y"]);
  });

  it("spawns `open -R <path>` when reveal=true", async () => {
    mockSpawn("");
    const caller = createCaller(systemRouter, {} as AppContext);
    await caller.openInFinder({ path: "/x/y.txt", reveal: true });
    expect(spawnMock.mock.calls[0]![1]).toEqual(["-R", "/x/y.txt"]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
cd yulu/scripts/yulu_ui
npm test -- tests/routers/system.test.ts
```

Expected: FAIL (`caller.pickFile is not a function`).

- [ ] **Step 3: Implement in `src/routers/system.ts`**

Add imports at the top:

```ts
import { spawn } from "node:child_process";
import { z } from "zod";
```

Add helpers + procedures (inside the existing `systemRouter = router({...})`):

```ts
function runSpawn(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let stdout = "", stderr = "";
    proc.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    proc.on("close", (code: number | null) => resolve({ stdout, stderr, code: code ?? 1 }));
  });
}

export const systemRouter = router({
  // existing system.version stays...

  pickFile: publicProcedure
    .input(z.object({
      mode: z.enum(["file", "folder"]),
      filter: z.enum(["wav", "bin", "json", "pem"]).optional(),
    }))
    .mutation(async ({ input }) => {
      let script: string;
      if (input.mode === "folder") {
        script = 'POSIX path of (choose folder with prompt "Choose a folder")';
      } else {
        const ofType = input.filter ? ` of type {"${input.filter}"}` : "";
        script = `POSIX path of (choose file with prompt "Choose a file"${ofType})`;
      }
      const { stdout, code } = await runSpawn("osascript", ["-e", script]);
      if (code !== 0) return { path: null };
      const path = stdout.trim();
      return { path: path || null };
    }),

  openInFinder: publicProcedure
    .input(z.object({ path: z.string(), reveal: z.boolean().optional() }))
    .mutation(async ({ input }) => {
      const args = input.reveal ? ["-R", input.path] : [input.path];
      await runSpawn("open", args);
      return { ok: true as const };
    }),
});
```

(Keep the existing `version` procedure — don't replace the whole router. The block above shows the additions; integrate them into the existing `router({...})` call.)

- [ ] **Step 4: Re-run, verify PASS**

```bash
npm test -- tests/routers/system.test.ts
```

Expected: PASS (existing system tests + 5 new ones).

- [ ] **Step 5: Full suite + typecheck**

```bash
npm test
npm run typecheck
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/yulu_ui/src/routers/system.ts \
        yulu/scripts/yulu_ui/tests/routers/system.test.ts
git commit -m "feat(yulu_ui): system.pickFile + system.openInFinder via osascript/open"
```

---

## Task D.2 — Backend: `system.audioDevices`

**Files:**
- Modify: `yulu/scripts/yulu_ui/src/routers/system.ts`
- Modify: `yulu/scripts/yulu_ui/tests/routers/system.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
// tests/routers/system.test.ts — append (spawnMock already mocked from D.1)

describe("system.audioDevices", () => {
  it("returns input + output devices parsed from system_profiler JSON", async () => {
    const fixture = JSON.stringify({
      SPAudioDataType: [{
        _items: [
          { _name: "MacBook Pro Microphone", coreaudio_device_input: 1, coreaudio_device_uid: "BuiltInMic" },
          { _name: "BlackHole 2ch", coreaudio_device_input: 2, coreaudio_device_uid: "BlackHole2ch" },
          { _name: "MacBook Pro Speakers", coreaudio_device_output: 2, coreaudio_device_uid: "BuiltInSpeaker" },
        ],
      }],
    });
    mockSpawn(fixture);
    const caller = createCaller(systemRouter, {} as AppContext);
    const r = await caller.audioDevices();
    expect(r.input.map((d) => d.name)).toEqual(["MacBook Pro Microphone", "BlackHole 2ch"]);
    expect(r.output.map((d) => d.name)).toEqual(["MacBook Pro Speakers"]);
    expect(r.input[0]!.uid).toBe("BuiltInMic");
  });

  it("returns empty arrays on parse failure", async () => {
    mockSpawn("not json", 0);
    const caller = createCaller(systemRouter, {} as AppContext);
    const r = await caller.audioDevices();
    expect(r.input).toEqual([]);
    expect(r.output).toEqual([]);
  });

  it("returns empty arrays on non-zero exit", async () => {
    mockSpawn("", 1, "failed");
    const caller = createCaller(systemRouter, {} as AppContext);
    const r = await caller.audioDevices();
    expect(r.input).toEqual([]);
    expect(r.output).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/routers/system.test.ts
```

- [ ] **Step 3: Implement — add to `systemRouter` in `src/routers/system.ts`**

```ts
  audioDevices: publicProcedure.query(async () => {
    const { stdout, code } = await runSpawn("system_profiler", ["SPAudioDataType", "-json"]);
    if (code !== 0) return { input: [], output: [] };
    try {
      const parsed = JSON.parse(stdout) as { SPAudioDataType?: Array<{ _items?: Array<Record<string, unknown>> }> };
      const items = parsed.SPAudioDataType?.[0]?._items ?? [];
      const input: Array<{ uid: string; name: string }> = [];
      const output: Array<{ uid: string; name: string }> = [];
      for (const item of items) {
        const name = String(item._name ?? "");
        const uid = String(item.coreaudio_device_uid ?? "");
        if (!name || !uid) continue;
        if (item.coreaudio_device_input !== undefined) input.push({ uid, name });
        if (item.coreaudio_device_output !== undefined) output.push({ uid, name });
      }
      return { input, output };
    } catch {
      return { input: [], output: [] };
    }
  }),
```

- [ ] **Step 4: Re-run + full suite + typecheck**

```bash
npm test -- tests/routers/system.test.ts
npm test
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/routers/system.ts \
        yulu/scripts/yulu_ui/tests/routers/system.test.ts
git commit -m "feat(yulu_ui): system.audioDevices via system_profiler JSON"
```

---

## Task D.3 — Backend: `system.dbStats` + `system.logPaths`

**Files:**
- Modify: `yulu/scripts/yulu_ui/src/routers/system.ts`
- Modify: `yulu/scripts/yulu_ui/tests/routers/system.test.ts`

- [ ] **Step 1: Append failing tests**

```ts
// tests/routers/system.test.ts — append

import { mkdtempSync, mkdirSync, writeFileSync as _writeFileSync } from "node:fs";
import { tmpdir as _tmpdir } from "node:os";
import { join as _join } from "node:path";
import Database from "better-sqlite3";

describe("system.dbStats", () => {
  it("returns size + row count for prompts/vocab/search SQLite files", async () => {
    const dir = mkdtempSync(_join(_tmpdir(), "yulu_dbst_"));
    const promptsPath = _join(dir, "prompts.sqlite");
    const vocabPath = _join(dir, "vocab.sqlite");
    const searchPath = _join(dir, "search.sqlite");
    const p = new Database(promptsPath); p.exec("CREATE TABLE prompts (id TEXT); INSERT INTO prompts VALUES ('a');"); p.close();
    const v = new Database(vocabPath); v.exec("CREATE TABLE vocab (id INTEGER PRIMARY KEY); INSERT INTO vocab VALUES (1),(2);"); v.close();
    const s = new Database(searchPath); s.exec("CREATE VIRTUAL TABLE docs USING fts5(body);"); s.close();
    const ctx = { paths: { promptsDb: promptsPath, vocabDb: vocabPath, searchDb: searchPath } } as unknown as AppContext;
    const caller = createCaller(systemRouter, ctx);
    const r = await caller.dbStats();
    expect(r.find((d) => d.name === "prompts")!.rows).toBe(1);
    expect(r.find((d) => d.name === "vocab")!.rows).toBe(2);
    expect(r.find((d) => d.name === "search")!.rows).toBe(0);
    expect(r.every((d) => d.size > 0)).toBe(true);
  });

  it("returns rows=null + size=0 when DB file missing", async () => {
    const ctx = { paths: { promptsDb: "/no/such/p.sqlite", vocabDb: "/no/such/v.sqlite", searchDb: "/no/such/s.sqlite" } } as unknown as AppContext;
    const caller = createCaller(systemRouter, ctx);
    const r = await caller.dbStats();
    expect(r.every((d) => d.rows === null && d.size === 0)).toBe(true);
  });
});

describe("system.logPaths", () => {
  it("returns the 8 known yulu daemon log paths under configDir", async () => {
    const ctx = { paths: { configDir: "/x/.config/yulu" } } as unknown as AppContext;
    const caller = createCaller(systemRouter, ctx);
    const r = await caller.logPaths();
    expect(r).toHaveLength(8);
    expect(r.map((p) => p.name).sort()).toEqual(
      ["agentqueue","audiodaemon","calendar","detector","scheduler","statusagent","sttdaemon","ui"]
    );
    expect(r.every((p) => p.path.startsWith("/x/.config/yulu/"))).toBe(true);
    expect(r.every((p) => p.path.endsWith(".log"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement in `src/routers/system.ts`**

Add imports if not present:

```ts
import { existsSync, statSync } from "node:fs";
import { openDb } from "../db.js";
```

Add procedures inside `systemRouter`:

```ts
  dbStats: publicProcedure.query(({ ctx }) => {
    const entries: Array<{ name: "prompts" | "vocab" | "search"; mainTable: string; path: string }> = [
      { name: "prompts", mainTable: "prompts", path: ctx.paths.promptsDb },
      { name: "vocab",   mainTable: "vocab",   path: ctx.paths.vocabDb },
      { name: "search",  mainTable: "docs",    path: ctx.paths.searchDb },
    ];
    return entries.map(({ name, mainTable, path }) => {
      if (!existsSync(path)) return { name, path, size: 0, rows: null as number | null };
      let size = 0; try { size = statSync(path).size; } catch { /* ignore */ }
      let rows: number | null = null;
      try {
        const db = openDb(path);
        try {
          const row = db.prepare(`SELECT COUNT(*) AS n FROM ${mainTable}`).get() as { n: number };
          rows = row?.n ?? 0;
        } finally { db.close(); }
      } catch { rows = null; }
      return { name, path, size, rows };
    });
  }),

  logPaths: publicProcedure.query(({ ctx }) => {
    const names = ["audiodaemon", "sttdaemon", "agentqueue", "statusagent", "scheduler", "detector", "calendar", "ui"];
    return names.map((name) => ({ name, path: `${ctx.paths.configDir}/${name}.log` }));
  }),
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/src/routers/system.ts \
        yulu/scripts/yulu_ui/tests/routers/system.test.ts
git commit -m "feat(yulu_ui): system.dbStats + system.logPaths"
```

---

## Task D.4 — Backend: `integrations.test` router

**Files:**
- Create: `yulu/scripts/yulu_ui/src/routers/integrations.ts`
- Modify: `yulu/scripts/yulu_ui/src/routers/_app.ts`
- Create: `yulu/scripts/yulu_ui/tests/routers/integrations.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/routers/integrations.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { integrationsRouter } from "../../src/routers/integrations.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

beforeEach(() => spawnMock.mockReset());

function mockSpawn(stdout: string, exitCode = 0, stderr = "") {
  spawnMock.mockImplementation(() => {
    const handlers = new Map<string, (arg: unknown) => void>();
    const proc = {
      stdout: { on: (e: string, cb: (b: Buffer) => void) => { if (e === "data") cb(Buffer.from(stdout)); } },
      stderr: { on: (e: string, cb: (b: Buffer) => void) => { if (e === "data" && stderr) cb(Buffer.from(stderr)); } },
      on: (e: string, cb: (arg: unknown) => void) => { handlers.set(e, cb); },
      kill: () => {},
    };
    setImmediate(() => handlers.get("close")?.(exitCode));
    return proc;
  });
}

describe("integrationsRouter.test", () => {
  it("spawns python3 -m yulu.calendar.detect --provider <p> --json", async () => {
    mockSpawn(JSON.stringify({ ok: true }));
    const caller = createCaller(integrationsRouter, {} as AppContext);
    const r = await caller.test({ provider: "feishu" });
    expect(r.ok).toBe(true);
    const args = spawnMock.mock.calls[0]![1] as string[];
    expect(args).toContain("--provider");
    expect(args).toContain("feishu");
    expect(args).toContain("--json");
  });

  it("returns ok=false when python exits non-zero", async () => {
    mockSpawn("", 1, "ModuleNotFoundError: yulu.calendar");
    const caller = createCaller(integrationsRouter, {} as AppContext);
    const r = await caller.test({ provider: "google" });
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("ModuleNotFoundError");
  });

  it("includes stdout + stderr in the response", async () => {
    mockSpawn("hello\n", 0, "warning: x\n");
    const caller = createCaller(integrationsRouter, {} as AppContext);
    const r = await caller.test({ provider: "feishu" });
    expect(r.stdout).toBe("hello\n");
    expect(r.stderr).toBe("warning: x\n");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/routers/integrations.test.ts
```

- [ ] **Step 3: Implement `src/routers/integrations.ts`**

```ts
// src/routers/integrations.ts
import { spawn } from "node:child_process";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

function runSpawn(cmd: string, args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { env: { ...process.env, PYTHONPATH: process.env.YULU_SCRIPT_DIR ?? "/Users/liaoyuxing/.yulu/yulu/scripts" } });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { proc.kill("SIGKILL"); }, timeoutMs);
    proc.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    proc.on("close", (code: number | null) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? 1 }); });
  });
}

export const integrationsRouter = router({
  test: publicProcedure
    .input(z.object({ provider: z.enum(["feishu", "google"]) }))
    .mutation(async ({ input }) => {
      const { stdout, stderr, code } = await runSpawn(
        "python3",
        ["-m", "yulu.calendar.detect", "--provider", input.provider, "--json"],
        10_000,
      );
      return { ok: code === 0, stdout, stderr };
    }),
});
```

- [ ] **Step 4: Register in `_app.ts`**

In `src/routers/_app.ts`, add the import and entry:

```ts
import { integrationsRouter } from "./integrations.js";
// ...
export const appRouter = router({
  // ...existing
  integrations: integrationsRouter,
});
```

- [ ] **Step 5: Re-run + full suite + typecheck**

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/yulu_ui/src/routers/integrations.ts \
        yulu/scripts/yulu_ui/src/routers/_app.ts \
        yulu/scripts/yulu_ui/tests/routers/integrations.test.ts
git commit -m "feat(yulu_ui): integrations.test router (Python detector probe)"
```

---

## Task D.5 — Backend: `llm.test` router

**Files:**
- Create: `yulu/scripts/yulu_ui/src/routers/llm.ts`
- Modify: `yulu/scripts/yulu_ui/src/routers/_app.ts`
- Create: `yulu/scripts/yulu_ui/tests/routers/llm.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/routers/llm.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { llmRouter } from "../../src/routers/llm.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { ConfigManager } from "../../src/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

beforeEach(() => spawnMock.mockReset());

function mockSpawn(stdout: string, exitCode = 0, stderr = "") {
  spawnMock.mockImplementation(() => {
    const handlers = new Map<string, (arg: unknown) => void>();
    const stdinWrites: string[] = [];
    const proc = {
      stdin: { write: (s: string) => stdinWrites.push(s), end: () => {} },
      stdout: { on: (e: string, cb: (b: Buffer) => void) => { if (e === "data") cb(Buffer.from(stdout)); } },
      stderr: { on: (e: string, cb: (b: Buffer) => void) => { if (e === "data" && stderr) cb(Buffer.from(stderr)); } },
      on: (e: string, cb: (arg: unknown) => void) => { handlers.set(e, cb); },
      kill: () => {},
      __stdinWrites: stdinWrites,
    };
    setImmediate(() => handlers.get("close")?.(exitCode));
    return proc;
  });
}

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), "yulu_llm_"));
  const path = join(dir, "config.json");
  cpSync(join(HERE, "../fixtures/config.json"), path);
  return { config: new ConfigManager(path) } as unknown as AppContext;
}

describe("llmRouter.test", () => {
  it("spawns config.llm.command + writes 'hello, world' on stdin", async () => {
    mockSpawn("Hi there\n");
    const caller = createCaller(llmRouter, makeCtx());
    const r = await caller.test();
    expect(r.ok).toBe(true);
    expect(r.stdout).toBe("Hi there\n");
    expect(spawnMock.mock.calls[0]![0]).toBe("claude");
    expect(spawnMock.mock.calls[0]![1]).toEqual(["--print"]);
    // Verify stdin write happened (read from mock instance)
    const procInstance = spawnMock.mock.results[0]!.value as { __stdinWrites: string[] };
    expect(procInstance.__stdinWrites.join("")).toBe("hello, world\n");
  });

  it("returns ok=false without spawning when llm.enabled=false", async () => {
    const ctx = makeCtx();
    ctx.config.update("llm.enabled", false);
    const caller = createCaller(llmRouter, ctx);
    const r = await caller.test();
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("llm.enabled is false");
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("returns ok=false when llm.command is empty", async () => {
    const ctx = makeCtx();
    ctx.config.update("llm.command", []);
    const caller = createCaller(llmRouter, ctx);
    const r = await caller.test();
    expect(r.ok).toBe(false);
    expect(r.stderr).toContain("llm.command is empty");
    expect(spawnMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/routers/llm.test.ts
```

- [ ] **Step 3: Implement `src/routers/llm.ts`**

```ts
// src/routers/llm.ts
import { spawn } from "node:child_process";
import { router, publicProcedure } from "../trpc.js";

function runSpawnWithStdin(cmd: string, args: string[], stdin: string, timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args);
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { proc.kill("SIGKILL"); }, timeoutMs);
    proc.stdin.write(stdin);
    proc.stdin.end();
    proc.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    proc.on("close", (code: number | null) => { clearTimeout(timer); resolve({ stdout, stderr, code: code ?? 1 }); });
  });
}

export const llmRouter = router({
  test: publicProcedure.mutation(async ({ ctx }) => {
    const cfg = ctx.config.read();
    if (!cfg.llm?.enabled) {
      return { ok: false, stdout: "", stderr: "llm.enabled is false in config" };
    }
    const command = cfg.llm?.command ?? [];
    if (command.length === 0) {
      return { ok: false, stdout: "", stderr: "llm.command is empty" };
    }
    const [cmd, ...args] = command;
    const { stdout, stderr, code } = await runSpawnWithStdin(cmd!, args, "hello, world\n", 30_000);
    return { ok: code === 0, stdout, stderr };
  }),
});
```

- [ ] **Step 4: Register in `_app.ts`**

```ts
import { llmRouter } from "./llm.js";
// ...
  llm: llmRouter,
```

- [ ] **Step 5: Re-run + full suite + typecheck**

- [ ] **Step 6: Commit**

```bash
git add yulu/scripts/yulu_ui/src/routers/llm.ts \
        yulu/scripts/yulu_ui/src/routers/_app.ts \
        yulu/scripts/yulu_ui/tests/routers/llm.test.ts
git commit -m "feat(yulu_ui): llm.test router (spawn config.llm.command with stdin)"
```

---

## Task D.6 — `useSettingsRestartTracker` hook

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/hooks/useSettingsRestartTracker.ts`
- Create: `yulu/scripts/yulu_ui/tests/web/useSettingsRestartTracker.test.ts`

- [ ] **Step 1: Write failing test**

```ts
// tests/web/useSettingsRestartTracker.test.ts
import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSettingsRestartTracker } from "../../web/src/hooks/useSettingsRestartTracker.js";

describe("useSettingsRestartTracker", () => {
  it("records keys per daemon", () => {
    const { result } = renderHook(() => useSettingsRestartTracker());
    act(() => result.current.record("audio.silence_threshold", ["audiodaemon"]));
    act(() => result.current.record("audio.mic_device", ["audiodaemon"]));
    const dmap = result.current.daemons;
    expect(dmap.get("audiodaemon")?.size).toBe(2);
    expect(Array.from(dmap.get("audiodaemon") ?? [])).toEqual(
      expect.arrayContaining(["audio.silence_threshold", "audio.mic_device"])
    );
  });

  it("does not record when daemonsNeedingRestart is empty", () => {
    const { result } = renderHook(() => useSettingsRestartTracker());
    act(() => result.current.record("audio.output_dir", []));
    expect(result.current.daemons.size).toBe(0);
  });

  it("statusFor returns 'restart' for tracked keys, else null", () => {
    const { result } = renderHook(() => useSettingsRestartTracker());
    act(() => result.current.record("audio.silence_threshold", ["audiodaemon"]));
    expect(result.current.statusFor("audio.silence_threshold")).toBe("restart");
    expect(result.current.statusFor("audio.mic_device")).toBeNull();
  });

  it("clearDaemon removes the daemon entry", () => {
    const { result } = renderHook(() => useSettingsRestartTracker());
    act(() => result.current.record("audio.silence_threshold", ["audiodaemon"]));
    act(() => result.current.clearDaemon("audiodaemon"));
    expect(result.current.daemons.size).toBe(0);
  });

  it("clearKey removes a single key (may leave daemon if other keys remain)", () => {
    const { result } = renderHook(() => useSettingsRestartTracker());
    act(() => result.current.record("audio.silence_threshold", ["audiodaemon"]));
    act(() => result.current.record("audio.mic_device", ["audiodaemon"]));
    act(() => result.current.clearKey("audio.silence_threshold"));
    expect(result.current.daemons.get("audiodaemon")?.size).toBe(1);
    expect(result.current.daemons.get("audiodaemon")?.has("audio.mic_device")).toBe(true);
  });

  it("clearAll wipes all entries", () => {
    const { result } = renderHook(() => useSettingsRestartTracker());
    act(() => result.current.record("audio.silence_threshold", ["audiodaemon"]));
    act(() => result.current.record("transcription.glossary", ["sttdaemon"]));
    act(() => result.current.clearAll());
    expect(result.current.daemons.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

```bash
npm test -- tests/web/useSettingsRestartTracker.test.ts
```

- [ ] **Step 3: Implement**

```ts
// web/src/hooks/useSettingsRestartTracker.ts
import { useReducer, useMemo } from "react";

type DaemonsByKey = Map<string, Set<string>>;

export type RowStatus = "saved" | "restart" | "typing" | null;

interface State { daemons: DaemonsByKey; }

type Action =
  | { type: "record"; key: string; daemons: string[] }
  | { type: "clearDaemon"; name: string }
  | { type: "clearKey"; key: string }
  | { type: "clearAll" };

function reducer(state: State, action: Action): State {
  const next = new Map(Array.from(state.daemons, ([k, v]) => [k, new Set(v)] as const));
  switch (action.type) {
    case "record": {
      if (action.daemons.length === 0) return state;
      for (const d of action.daemons) {
        const set = next.get(d) ?? new Set();
        set.add(action.key);
        next.set(d, set);
      }
      return { daemons: next };
    }
    case "clearDaemon": {
      next.delete(action.name);
      return { daemons: next };
    }
    case "clearKey": {
      for (const [d, set] of next) {
        if (set.delete(action.key) && set.size === 0) next.delete(d);
      }
      return { daemons: next };
    }
    case "clearAll":
      return { daemons: new Map() };
  }
}

export interface SettingsRestartTracker {
  daemons: DaemonsByKey;
  record: (key: string, daemonsNeedingRestart: string[]) => void;
  statusFor: (key: string) => RowStatus;
  clearDaemon: (name: string) => void;
  clearKey: (key: string) => void;
  clearAll: () => void;
}

export function useSettingsRestartTracker(): SettingsRestartTracker {
  const [state, dispatch] = useReducer(reducer, { daemons: new Map() });

  return useMemo<SettingsRestartTracker>(() => ({
    daemons: state.daemons,
    record: (key, daemons) => dispatch({ type: "record", key, daemons }),
    statusFor: (key) => {
      for (const set of state.daemons.values()) if (set.has(key)) return "restart";
      return null;
    },
    clearDaemon: (name) => dispatch({ type: "clearDaemon", name }),
    clearKey: (key) => dispatch({ type: "clearKey", key }),
    clearAll: () => dispatch({ type: "clearAll" }),
  }), [state.daemons]);
}
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/hooks/useSettingsRestartTracker.ts \
        yulu/scripts/yulu_ui/tests/web/useSettingsRestartTracker.test.ts
git commit -m "feat(yulu_ui/web): useSettingsRestartTracker (daemons by key, reducer-based)"
```

---

## Task D.7 — `<SettingsPage>` wrapper

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/SettingsPage.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/SettingsPage.css`
- Create: `yulu/scripts/yulu_ui/tests/web/SettingsPage.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/SettingsPage.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SettingsPage } from "../../web/src/components/SettingsPage.js";

describe("SettingsPage", () => {
  it("renders children", () => {
    render(<SettingsPage>{<div>row-1</div>}</SettingsPage>);
    expect(screen.getByText("row-1")).toBeInTheDocument();
  });

  it("renders the banner above children when provided", () => {
    const { container } = render(
      <SettingsPage banner={<div data-testid="bn">BANNER</div>}>
        <div>row-1</div>
      </SettingsPage>
    );
    expect(screen.getByTestId("bn")).toBeInTheDocument();
    const bannerEl = container.querySelector(".settings-banner");
    const bodyEl = container.querySelector(".settings-body");
    expect(bannerEl?.compareDocumentPosition(bodyEl as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("does not render banner area when banner=null", () => {
    const { container } = render(<SettingsPage banner={null}><div>row-1</div></SettingsPage>);
    expect(container.querySelector(".settings-banner")).toBeNull();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// web/src/components/SettingsPage.tsx
import type { ReactNode } from "react";
import "./SettingsPage.css";

export interface SettingsPageProps {
  banner?: ReactNode;
  children: ReactNode;
}

export function SettingsPage({ banner, children }: SettingsPageProps) {
  return (
    <div className="settings-page">
      {banner && <div className="settings-banner">{banner}</div>}
      <div className="settings-body">{children}</div>
    </div>
  );
}
```

```css
/* web/src/components/SettingsPage.css */
.settings-page {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.settings-banner {
  position: sticky;
  top: 0;
  z-index: 5;
}
.settings-body {
  flex: 1;
  overflow-y: auto;
  padding: 10px 16px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/SettingsPage.tsx \
        yulu/scripts/yulu_ui/web/src/components/SettingsPage.css \
        yulu/scripts/yulu_ui/tests/web/SettingsPage.test.tsx
git commit -m "feat(yulu_ui/web): SettingsPage wrapper (banner + body)"
```

---

## Task D.8 — `<InlineEditRow>` (all 6 variants)

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/InlineEditRow.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/InlineEditRow.css`
- Create: `yulu/scripts/yulu_ui/tests/web/InlineEditRow.test.tsx`

This is the workhorse component. All 6 variants land in one task because they share state machine + CSS.

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/InlineEditRow.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InlineEditRow } from "../../web/src/components/InlineEditRow.js";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    system: {
      pickFile: { useMutation: () => ({ mutateAsync: async () => ({ path: "/picked/dir" }), isPending: false }) },
      openInFinder: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));

describe("InlineEditRow", () => {
  it("text variant: shows value, click → input, Enter commits", async () => {
    const onCommit = vi.fn();
    render(<InlineEditRow label="L" type="text" value="abc" onCommit={onCommit} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("abc"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "xyz{Enter}");
    expect(onCommit).toHaveBeenCalledWith("xyz");
  });

  it("text variant: blur commits", async () => {
    const onCommit = vi.fn();
    render(<InlineEditRow label="L" type="text" value="abc" onCommit={onCommit} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("abc"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "xyz");
    await user.tab();   // blur
    expect(onCommit).toHaveBeenCalledWith("xyz");
  });

  it("number variant: commits parsed number", async () => {
    const onCommit = vi.fn();
    render(<InlineEditRow label="L" type="number" value={0.5} onCommit={onCommit} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("0.5"));
    const input = screen.getByRole("spinbutton");
    await user.clear(input);
    await user.type(input, "0.7{Enter}");
    expect(onCommit).toHaveBeenCalledWith(0.7);
  });

  it("select variant: commits on change", async () => {
    const onCommit = vi.fn();
    render(<InlineEditRow label="L" type="select" value="a" options={[{value:"a",label:"A"},{value:"b",label:"B"}]} onCommit={onCommit} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("A"));
    const select = screen.getByRole("combobox");
    await user.selectOptions(select, "b");
    expect(onCommit).toHaveBeenCalledWith("b");
  });

  it("toggle variant: commits immediately on click", async () => {
    const onCommit = vi.fn();
    render(<InlineEditRow label="L" type="toggle" value={false} onCommit={onCommit} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("switch"));
    expect(onCommit).toHaveBeenCalledWith(true);
  });

  it("path variant: 'Choose…' button fires pickFile + onCommit", async () => {
    const onCommit = vi.fn();
    render(<InlineEditRow label="L" type="path" value="/old/dir" mode="folder" onCommit={onCommit} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /choose/i }));
    // mutateAsync resolves to { path: "/picked/dir" }
    await vi.waitFor(() => expect(onCommit).toHaveBeenCalledWith("/picked/dir"));
  });

  it("readonly variant: displays value, no edit input", async () => {
    render(<InlineEditRow label="L" type="readonly" value="immutable" />);
    expect(screen.getByText("immutable")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("status icon renders ✓ when status='saved', ⟳ when 'restart'", () => {
    const { rerender } = render(<InlineEditRow label="L" type="text" value="x" onCommit={() => {}} status="saved" />);
    expect(screen.getByTestId("row-status")).toHaveTextContent("✓");
    rerender(<InlineEditRow label="L" type="text" value="x" onCommit={() => {}} status="restart" />);
    expect(screen.getByTestId("row-status")).toHaveTextContent("⟳");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// web/src/components/InlineEditRow.tsx
import { useEffect, useRef, useState } from "react";
import { trpc } from "../trpc.js";
import "./InlineEditRow.css";

export type RowStatus = "saved" | "restart" | "typing" | null;

interface BaseProps {
  label: string;
  help?: string;
  status?: RowStatus;
}

type TextProps = BaseProps & { type: "text"; value: string; onCommit: (v: string) => void };
type NumberProps = BaseProps & { type: "number"; value: number; min?: number; max?: number; step?: number; onCommit: (v: number) => void };
type SelectProps = BaseProps & { type: "select"; value: string; options: Array<{ value: string; label: string }>; onCommit: (v: string) => void };
type ToggleProps = BaseProps & { type: "toggle"; value: boolean; onCommit: (v: boolean) => void };
type PathProps = BaseProps & { type: "path"; value: string; mode: "file" | "folder"; filter?: "wav" | "bin" | "json" | "pem"; onCommit: (v: string) => void };
type ReadonlyProps = BaseProps & { type: "readonly"; value: string; revealInFinder?: boolean };

export type InlineEditRowProps = TextProps | NumberProps | SelectProps | ToggleProps | PathProps | ReadonlyProps;

export function InlineEditRow(props: InlineEditRowProps) {
  return (
    <div className="row">
      <div className="row-label">
        <div>{props.label}</div>
        {props.help && <div className="row-help">{props.help}</div>}
      </div>
      <div className="row-value">{renderValue(props)}</div>
      <div className="row-status" data-testid="row-status">{statusGlyph(props.status)}</div>
    </div>
  );
}

function statusGlyph(status: RowStatus | undefined) {
  if (status === "saved") return <span className="status-saved">✓</span>;
  if (status === "restart") return <span className="status-restart">⟳</span>;
  if (status === "typing") return <span className="status-typing">●</span>;
  return null;
}

function renderValue(props: InlineEditRowProps): React.ReactNode {
  switch (props.type) {
    case "text":     return <TextValue {...props} />;
    case "number":   return <NumberValue {...props} />;
    case "select":   return <SelectValue {...props} />;
    case "toggle":   return <ToggleValue {...props} />;
    case "path":     return <PathValue {...props} />;
    case "readonly": return <ReadonlyValue {...props} />;
  }
}

function TextValue({ value, onCommit }: TextProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  useEffect(() => { setDraft(value); }, [value]);

  if (!editing) return <span className="value-display" onClick={() => setEditing(true)}>{value}</span>;
  const commit = () => { setEditing(false); if (draft !== value) onCommit(draft); };
  return (
    <input
      ref={ref}
      className="value-input"
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(value); setEditing(false); } }}
    />
  );
}

function NumberValue({ value, onCommit, min, max, step }: NumberProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(value));
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  useEffect(() => { setDraft(String(value)); }, [value]);

  if (!editing) return <span className="value-display" onClick={() => setEditing(true)}>{value}</span>;
  const commit = () => {
    setEditing(false);
    const n = parseFloat(draft);
    if (!Number.isFinite(n)) { setDraft(String(value)); return; }
    if (n !== value) onCommit(n);
  };
  return (
    <input
      ref={ref}
      className="value-input"
      type="number"
      value={draft}
      min={min} max={max} step={step}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { setDraft(String(value)); setEditing(false); } }}
    />
  );
}

function SelectValue({ value, options, onCommit }: SelectProps) {
  const [editing, setEditing] = useState(false);
  const ref = useRef<HTMLSelectElement>(null);
  useEffect(() => { if (editing) ref.current?.focus(); }, [editing]);
  if (!editing) {
    const label = options.find((o) => o.value === value)?.label ?? value;
    return <span className="value-display" onClick={() => setEditing(true)}>{label}</span>;
  }
  return (
    <select
      ref={ref}
      className="value-input"
      value={value}
      onChange={(e) => { setEditing(false); if (e.target.value !== value) onCommit(e.target.value); }}
      onBlur={() => setEditing(false)}
    >
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

function ToggleValue({ value, onCommit }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      className={"toggle" + (value ? " on" : "")}
      onClick={() => onCommit(!value)}
    >
      <span className="toggle-knob" />
    </button>
  );
}

function PathValue({ value, mode, filter, onCommit }: PathProps) {
  const pickFile = trpc.system.pickFile.useMutation();
  const openInFinder = trpc.system.openInFinder.useMutation();
  const choose = async () => {
    const res = await pickFile.mutateAsync({ mode, filter });
    if (res.path) onCommit(res.path);
  };
  return (
    <div className="path-value">
      <span className="path-display" title={value}>{value || "(unset)"}</span>
      <button type="button" className="path-btn" onClick={choose} disabled={pickFile.isPending}>Choose…</button>
      {value && <button type="button" className="path-btn" onClick={() => openInFinder.mutate({ path: value, reveal: true })}>Reveal</button>}
    </div>
  );
}

function ReadonlyValue({ value, revealInFinder }: ReadonlyProps) {
  const openInFinder = trpc.system.openInFinder.useMutation();
  return (
    <div className="path-value">
      <span className="path-display">{value}</span>
      {revealInFinder && <button type="button" className="path-btn" onClick={() => openInFinder.mutate({ path: value, reveal: true })}>Reveal</button>}
    </div>
  );
}
```

```css
/* web/src/components/InlineEditRow.css */
.row {
  display: grid;
  grid-template-columns: 240px 1fr 28px;
  align-items: center;
  gap: 14px;
  padding: 10px 12px;
  border-radius: var(--radius-inner);
  min-height: 40px;
}
.row:hover { background: var(--row-hover); }
.row-label {
  font-size: 13px;
  color: var(--fg);
}
.row-help {
  font-size: 11px;
  color: var(--fg-3);
  margin-top: 2px;
}
.row-value {
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 8px;
}
.row-status {
  text-align: right;
  font-size: 13px;
}
.status-saved { color: var(--green); }
.status-restart { color: var(--accent); animation: spin 1.4s linear infinite; display: inline-block; }
@keyframes spin { to { transform: rotate(360deg); } }
.status-typing { color: var(--fg-3); }
.value-display {
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 13px;
}
.value-display:hover { background: var(--glass-2); }
.value-input {
  padding: 4px 8px;
  border-radius: var(--radius-inner);
  background: var(--glass-2);
  color: var(--fg);
  font-size: 13px;
  border: none;
  outline: 2px solid var(--accent-soft);
}
.toggle {
  width: 32px;
  height: 18px;
  border-radius: 9px;
  background: var(--row-hover);
  position: relative;
  transition: background 120ms;
}
.toggle.on { background: var(--accent); }
.toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: white;
  transition: transform 120ms;
}
.toggle.on .toggle-knob { transform: translateX(14px); }
.path-value {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  flex: 1;
}
.path-display {
  font-family: "SF Mono", ui-monospace, monospace;
  font-size: 11px;
  color: var(--fg-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.path-btn {
  padding: 3px 10px;
  font-size: 11px;
  background: var(--row-hover);
  color: var(--fg-2);
  border-radius: var(--radius-inner);
}
.path-btn:hover { background: var(--glass-3); color: var(--fg); }
.path-btn:disabled { opacity: 0.5; cursor: wait; }
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/InlineEditRow.tsx \
        yulu/scripts/yulu_ui/web/src/components/InlineEditRow.css \
        yulu/scripts/yulu_ui/tests/web/InlineEditRow.test.tsx
git commit -m "feat(yulu_ui/web): InlineEditRow (6 variants: text/number/select/toggle/path/readonly)"
```

---

## Task D.9 — `<RestartBanner>` component

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/RestartBanner.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/RestartBanner.css`
- Create: `yulu/scripts/yulu_ui/tests/web/RestartBanner.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/RestartBanner.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RestartBanner } from "../../web/src/components/RestartBanner.js";

describe("RestartBanner", () => {
  const daemons = [
    { name: "audiodaemon", keys: ["audio.silence_threshold", "audio.mic_device"] },
    { name: "sttdaemon", keys: ["transcription.final_engine"] },
  ];

  it("renders each daemon + its keys", () => {
    render(<RestartBanner daemons={daemons} onRestart={vi.fn()} onRestartAll={vi.fn()} />);
    expect(screen.getByText(/audiodaemon/)).toBeInTheDocument();
    expect(screen.getByText(/silence_threshold/)).toBeInTheDocument();
    expect(screen.getByText(/mic_device/)).toBeInTheDocument();
    expect(screen.getByText(/sttdaemon/)).toBeInTheDocument();
    expect(screen.getByText(/final_engine/)).toBeInTheDocument();
  });

  it("Restart now fires onRestartAll", async () => {
    const onRestartAll = vi.fn();
    render(<RestartBanner daemons={daemons} onRestart={vi.fn()} onRestartAll={onRestartAll} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /restart now/i }));
    expect(onRestartAll).toHaveBeenCalled();
  });

  it("per-daemon restart button fires onRestart(name)", async () => {
    const onRestart = vi.fn();
    render(<RestartBanner daemons={daemons} onRestart={onRestart} onRestartAll={vi.fn()} />);
    const user = userEvent.setup();
    const audioBtn = screen.getByRole("button", { name: /restart audiodaemon/i });
    await user.click(audioBtn);
    expect(onRestart).toHaveBeenCalledWith("audiodaemon");
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// web/src/components/RestartBanner.tsx
import "./RestartBanner.css";

export interface RestartBannerProps {
  daemons: Array<{ name: string; keys: string[] }>;
  onRestart: (name: string) => void;
  onRestartAll: () => void;
}

export function RestartBanner({ daemons, onRestart, onRestartAll }: RestartBannerProps) {
  return (
    <div className="restart-banner" role="status">
      <div className="restart-banner-dot">●</div>
      <div className="restart-banner-body">
        <div className="restart-banner-title">Changes saved. Restart required:</div>
        <ul className="restart-banner-list">
          {daemons.map((d) => (
            <li key={d.name}>
              <span className="restart-banner-daemon">{d.name}</span>
              <span className="restart-banner-keys">{d.keys.join(", ")}</span>
              <button
                type="button"
                className="restart-banner-btn small"
                onClick={() => onRestart(d.name)}
                aria-label={`Restart ${d.name}`}
              >
                Restart
              </button>
            </li>
          ))}
        </ul>
      </div>
      <button type="button" className="restart-banner-btn primary" onClick={onRestartAll}>
        Restart now
      </button>
    </div>
  );
}
```

```css
/* web/src/components/RestartBanner.css */
.restart-banner {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 14px;
  background: var(--accent-soft);
  border-radius: var(--radius-panel);
  margin: 6px 12px;
  box-shadow: var(--edge-shadow);
}
.restart-banner-dot { color: var(--accent); font-size: 14px; line-height: 1.2; }
.restart-banner-body { flex: 1; min-width: 0; }
.restart-banner-title { font-size: 13px; color: var(--fg); margin-bottom: 4px; }
.restart-banner-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 3px; }
.restart-banner-list li {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 11px;
}
.restart-banner-daemon { color: var(--accent); font-weight: 500; }
.restart-banner-keys { color: var(--fg-2); font-family: "SF Mono", ui-monospace, monospace; flex: 1; }
.restart-banner-btn {
  padding: 3px 10px;
  font-size: 11px;
  border-radius: var(--radius-inner);
  background: var(--glass-3);
  color: var(--fg);
}
.restart-banner-btn:hover { background: var(--glass-2); }
.restart-banner-btn.primary {
  background: var(--accent);
  color: var(--wp-1);
  align-self: center;
}
.restart-banner-btn.primary:hover { opacity: 0.9; }
.restart-banner-btn.small { font-size: 10px; padding: 2px 8px; }
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/RestartBanner.tsx \
        yulu/scripts/yulu_ui/web/src/components/RestartBanner.css \
        yulu/scripts/yulu_ui/tests/web/RestartBanner.test.tsx
git commit -m "feat(yulu_ui/web): RestartBanner with per-daemon + restart-all actions"
```

---

## Task D.10 — `<HotkeyCapture>` component

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/HotkeyCapture.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/HotkeyCapture.css`
- Create: `yulu/scripts/yulu_ui/tests/web/HotkeyCapture.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/HotkeyCapture.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HotkeyCapture, formatHotkey } from "../../web/src/components/HotkeyCapture.js";

describe("formatHotkey", () => {
  it("renders modifiers + key as glyphs", () => {
    expect(formatHotkey({ key: "V", modifiers: ["cmd", "shift"] })).toBe("⌘⇧V");
    expect(formatHotkey({ key: "F19", modifiers: ["alt"] })).toBe("⌥F19");
    expect(formatHotkey({ key: "K", modifiers: ["cmd", "ctrl"] })).toBe("⌘⌃K");
  });
});

describe("HotkeyCapture", () => {
  it("renders current hotkey glyph", () => {
    render(<HotkeyCapture value={{ key: "V", modifiers: ["cmd", "shift"] }} onCommit={() => {}} />);
    expect(screen.getByText("⌘⇧V")).toBeInTheDocument();
  });

  it("clicking enters capture mode showing 'Press a key combination'", async () => {
    render(<HotkeyCapture value={{ key: "V", modifiers: ["cmd", "shift"] }} onCommit={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("⌘⇧V"));
    expect(screen.getByText(/press your hotkey/i)).toBeInTheDocument();
  });

  it("keydown with modifiers captures the combo + shows Save button", () => {
    render(<HotkeyCapture value={{ key: "V", modifiers: ["cmd", "shift"] }} onCommit={() => {}} />);
    fireEvent.click(screen.getByText("⌘⇧V"));
    const captureArea = screen.getByRole("textbox");   // capture area uses contenteditable / role=textbox
    fireEvent.keyDown(captureArea, { key: "K", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
    expect(screen.getByText("⌘K")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
  });

  it("Save commits the captured combo", async () => {
    const onCommit = vi.fn();
    render(<HotkeyCapture value={{ key: "V", modifiers: ["cmd", "shift"] }} onCommit={onCommit} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("⌘⇧V"));
    const captureArea = screen.getByRole("textbox");
    fireEvent.keyDown(captureArea, { key: "K", metaKey: true });
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(onCommit).toHaveBeenCalledWith({ key: "K", modifiers: ["cmd"] });
  });

  it("Escape cancels capture", async () => {
    render(<HotkeyCapture value={{ key: "V", modifiers: ["cmd", "shift"] }} onCommit={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("⌘⇧V"));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByText(/press your hotkey/i)).toBeNull();
    expect(screen.getByText("⌘⇧V")).toBeInTheDocument();   // back to displaying original
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// web/src/components/HotkeyCapture.tsx
import { useEffect, useRef, useState } from "react";
import "./HotkeyCapture.css";

export type ModifierKey = "cmd" | "shift" | "alt" | "ctrl";
export interface HotkeyValue { key: string; modifiers: ModifierKey[]; }

export interface HotkeyCaptureProps {
  value: HotkeyValue;
  onCommit: (v: HotkeyValue) => void;
}

const GLYPHS: Record<ModifierKey, string> = { cmd: "⌘", shift: "⇧", alt: "⌥", ctrl: "⌃" };
const ORDER: ModifierKey[] = ["ctrl", "alt", "shift", "cmd"];

export function formatHotkey(v: HotkeyValue): string {
  const mods = ORDER.filter((m) => v.modifiers.includes(m)).map((m) => GLYPHS[m]).join("");
  return `${mods}${v.key}`;
}

export function HotkeyCapture({ value, onCommit }: HotkeyCaptureProps) {
  const [capturing, setCapturing] = useState(false);
  const [captured, setCaptured] = useState<HotkeyValue | null>(null);
  const captureRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (capturing) captureRef.current?.focus(); }, [capturing]);

  const cancel = () => { setCapturing(false); setCaptured(null); };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") { cancel(); return; }
    if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;   // ignore modifier-only press
    const mods: ModifierKey[] = [];
    if (e.metaKey) mods.push("cmd");
    if (e.shiftKey) mods.push("shift");
    if (e.altKey) mods.push("alt");
    if (e.ctrlKey) mods.push("ctrl");
    setCaptured({ key: e.key.length === 1 ? e.key.toUpperCase() : e.key, modifiers: mods });
    e.preventDefault();
  };

  if (!capturing) {
    return (
      <div className="hotkey-display" onClick={() => setCapturing(true)}>
        {formatHotkey(value)}
      </div>
    );
  }
  return (
    <div className="hotkey-capture">
      <div
        ref={captureRef}
        role="textbox"
        tabIndex={0}
        className="hotkey-capture-area"
        onKeyDown={onKey}
        onBlur={() => { if (!captured) cancel(); }}
      >
        {captured ? formatHotkey(captured) : "Press your hotkey now…"}
      </div>
      {captured && (
        <button type="button" className="hotkey-btn save" onClick={() => { onCommit(captured); setCapturing(false); setCaptured(null); }}>
          Save
        </button>
      )}
      <button type="button" className="hotkey-btn cancel" onClick={cancel}>Cancel</button>
    </div>
  );
}
```

```css
/* web/src/components/HotkeyCapture.css */
.hotkey-display {
  display: inline-block;
  padding: 4px 12px;
  border-radius: var(--radius-inner);
  background: var(--glass-2);
  font-family: "SF Mono", ui-monospace, monospace;
  font-size: 13px;
  cursor: pointer;
}
.hotkey-display:hover { background: var(--glass-3); }
.hotkey-capture {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.hotkey-capture-area {
  padding: 4px 12px;
  border-radius: var(--radius-inner);
  background: var(--accent-soft);
  font-family: "SF Mono", ui-monospace, monospace;
  font-size: 13px;
  color: var(--accent);
  outline: 2px solid var(--accent);
  min-width: 200px;
}
.hotkey-btn {
  padding: 3px 10px;
  font-size: 11px;
  border-radius: var(--radius-inner);
}
.hotkey-btn.save { background: var(--accent); color: var(--wp-1); }
.hotkey-btn.cancel { background: var(--row-hover); color: var(--fg-2); }
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/HotkeyCapture.tsx \
        yulu/scripts/yulu_ui/web/src/components/HotkeyCapture.css \
        yulu/scripts/yulu_ui/tests/web/HotkeyCapture.test.tsx
git commit -m "feat(yulu_ui/web): HotkeyCapture component"
```

---

## Task D.11 — `<CommandEditor>` component

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/CommandEditor.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/CommandEditor.css`
- Create: `yulu/scripts/yulu_ui/tests/web/CommandEditor.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/CommandEditor.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandEditor } from "../../web/src/components/CommandEditor.js";

describe("CommandEditor", () => {
  it("renders one input per arg", () => {
    render(<CommandEditor value={["claude", "--print"]} onChange={() => {}} />);
    const inputs = screen.getAllByRole("textbox");
    expect(inputs).toHaveLength(2);
    expect((inputs[0] as HTMLInputElement).value).toBe("claude");
    expect((inputs[1] as HTMLInputElement).value).toBe("--print");
  });

  it("typing into an input + blur emits onChange with new array", async () => {
    const onChange = vi.fn();
    render(<CommandEditor value={["claude", "--print"]} onChange={onChange} />);
    const user = userEvent.setup();
    const second = screen.getAllByRole("textbox")[1]!;
    await user.clear(second);
    await user.type(second, "--quiet");
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith(["claude", "--quiet"]);
  });

  it("'+ Add arg' appends an empty string", async () => {
    const onChange = vi.fn();
    render(<CommandEditor value={["claude"]} onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /add arg/i }));
    expect(onChange).toHaveBeenCalledWith(["claude", ""]);
  });

  it("× button removes the arg", async () => {
    const onChange = vi.fn();
    render(<CommandEditor value={["claude", "--print", "--model"]} onChange={onChange} />);
    const user = userEvent.setup();
    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    await user.click(removeButtons[1]!);
    expect(onChange).toHaveBeenCalledWith(["claude", "--model"]);
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// web/src/components/CommandEditor.tsx
import { useState, useEffect } from "react";
import "./CommandEditor.css";

export interface CommandEditorProps {
  value: string[];
  onChange: (next: string[]) => void;
}

export function CommandEditor({ value, onChange }: CommandEditorProps) {
  const [draft, setDraft] = useState(value);
  useEffect(() => { setDraft(value); }, [value]);

  const commit = (next: string[]) => { setDraft(next); onChange(next); };

  const updateAt = (i: number, v: string) => {
    const next = draft.slice();
    next[i] = v;
    setDraft(next);
  };

  const onBlurAt = (i: number) => {
    if (draft[i] !== value[i]) onChange(draft);
  };

  const removeAt = (i: number) => {
    const next = draft.slice();
    next.splice(i, 1);
    commit(next);
  };

  const add = () => commit([...draft, ""]);

  const onDragStart = (i: number) => (e: React.DragEvent) => {
    e.dataTransfer.setData("text/plain", String(i));
    e.dataTransfer.effectAllowed = "move";
  };
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; };
  const onDrop = (i: number) => (e: React.DragEvent) => {
    e.preventDefault();
    const from = Number(e.dataTransfer.getData("text/plain"));
    if (from === i || Number.isNaN(from)) return;
    const next = draft.slice();
    const [moved] = next.splice(from, 1);
    next.splice(i, 0, moved!);
    commit(next);
  };

  return (
    <div className="cmd-editor">
      {draft.map((arg, i) => (
        <div
          key={i}
          className="cmd-row"
          draggable
          onDragStart={onDragStart(i)}
          onDragOver={onDragOver}
          onDrop={onDrop(i)}
        >
          <span className="cmd-grip" aria-hidden="true">⠿</span>
          <input
            className="cmd-input"
            type="text"
            value={arg}
            onChange={(e) => updateAt(i, e.target.value)}
            onBlur={() => onBlurAt(i)}
          />
          <button type="button" className="cmd-remove" onClick={() => removeAt(i)} aria-label={`Remove arg ${i}`}>×</button>
        </div>
      ))}
      <button type="button" className="cmd-add" onClick={add}>+ Add arg</button>
    </div>
  );
}
```

```css
/* web/src/components/CommandEditor.css */
.cmd-editor {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  max-width: 480px;
}
.cmd-row {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 3px 4px;
  border-radius: var(--radius-inner);
  cursor: move;
}
.cmd-row:hover { background: var(--row-hover); }
.cmd-grip { color: var(--fg-3); font-size: 11px; cursor: grab; }
.cmd-input {
  flex: 1;
  padding: 4px 10px;
  border-radius: var(--radius-inner);
  background: var(--glass-2);
  color: var(--fg);
  font-family: "SF Mono", ui-monospace, monospace;
  font-size: 12px;
  border: none;
}
.cmd-remove {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  color: var(--fg-3);
  font-size: 12px;
}
.cmd-remove:hover { color: var(--red); background: var(--row-hover); }
.cmd-add {
  align-self: flex-start;
  margin-top: 4px;
  padding: 4px 10px;
  font-size: 11px;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: var(--radius-inner);
}
.cmd-add:hover { background: var(--glass-3); }
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/CommandEditor.tsx \
        yulu/scripts/yulu_ui/web/src/components/CommandEditor.css \
        yulu/scripts/yulu_ui/tests/web/CommandEditor.test.tsx
git commit -m "feat(yulu_ui/web): CommandEditor (string[] with drag-reorder + add/remove)"
```

---

## Task D.12 — `<TestPopover>` component

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/TestPopover.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/TestPopover.css`
- Create: `yulu/scripts/yulu_ui/tests/web/TestPopover.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/TestPopover.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TestPopover } from "../../web/src/components/TestPopover.js";

describe("TestPopover", () => {
  it("renders pending status while pending=true", () => {
    render(<TestPopover state="pending" onClose={vi.fn()} />);
    expect(screen.getByText(/running/i)).toBeInTheDocument();
  });

  it("renders ok status with stdout when state='ok'", () => {
    render(<TestPopover state="ok" stdout="Hello world!" stderr="" onClose={vi.fn()} />);
    expect(screen.getByText("✓ ok")).toBeInTheDocument();
    expect(screen.getByText("Hello world!")).toBeInTheDocument();
  });

  it("renders failed status with stderr when state='failed'", () => {
    render(<TestPopover state="failed" stdout="" stderr="boom" onClose={vi.fn()} />);
    expect(screen.getByText("✗ failed")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("fires onClose when × clicked", async () => {
    const onClose = vi.fn();
    render(<TestPopover state="ok" stdout="x" stderr="" onClose={onClose} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// web/src/components/TestPopover.tsx
import "./TestPopover.css";

export interface TestPopoverProps {
  state: "pending" | "ok" | "failed";
  stdout?: string;
  stderr?: string;
  onClose: () => void;
}

export function TestPopover({ state, stdout, stderr, onClose }: TestPopoverProps) {
  return (
    <div className="testpop" role="dialog">
      <div className="testpop-header">
        <span className={"testpop-status " + state}>
          {state === "pending" && "● running…"}
          {state === "ok" && "✓ ok"}
          {state === "failed" && "✗ failed"}
        </span>
        <button type="button" className="testpop-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      {stdout && <pre className="testpop-out">{stdout}</pre>}
      {stderr && <pre className="testpop-err">{stderr}</pre>}
    </div>
  );
}
```

```css
/* web/src/components/TestPopover.css */
.testpop {
  margin-top: 6px;
  padding: 10px 12px;
  background: var(--glass-2);
  backdrop-filter: var(--blur-glass);
  border-radius: var(--radius-panel);
  box-shadow: var(--edge-shadow), var(--shadow);
  max-width: 560px;
  max-height: 300px;
  overflow: auto;
}
.testpop-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 6px;
}
.testpop-status { font-size: 12px; }
.testpop-status.pending { color: var(--fg-2); }
.testpop-status.ok { color: var(--green); }
.testpop-status.failed { color: var(--red); }
.testpop-close { width: 20px; height: 20px; border-radius: 50%; color: var(--fg-3); font-size: 13px; }
.testpop-close:hover { color: var(--fg); background: var(--row-hover); }
.testpop-out, .testpop-err {
  font-family: "SF Mono", ui-monospace, monospace;
  font-size: 11px;
  margin: 4px 0 0 0;
  padding: 6px 8px;
  background: var(--wp-1);
  border-radius: var(--radius-inner);
  white-space: pre-wrap;
  word-break: break-all;
}
.testpop-err { color: var(--red); }
.testpop-out { color: var(--fg); }
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/TestPopover.tsx \
        yulu/scripts/yulu_ui/web/src/components/TestPopover.css \
        yulu/scripts/yulu_ui/tests/web/TestPopover.test.tsx
git commit -m "feat(yulu_ui/web): TestPopover for test command/connection output"
```

---

## Task D.13 — `<DbStatsRow>` component

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/DbStatsRow.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/DbStatsRow.css`
- Create: `yulu/scripts/yulu_ui/tests/web/DbStatsRow.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/DbStatsRow.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DbStatsRow, formatBytes } from "../../web/src/components/DbStatsRow.js";

describe("formatBytes", () => {
  it("renders bytes with KB / MB units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5_242_880)).toBe("5.0 MB");
  });
});

describe("DbStatsRow", () => {
  it("renders name + path + size + rows", () => {
    render(<DbStatsRow name="prompts" path="/x/prompts.sqlite" size={5242880} rows={42} />);
    expect(screen.getByText(/prompts/)).toBeInTheDocument();
    expect(screen.getByText("/x/prompts.sqlite")).toBeInTheDocument();
    expect(screen.getByText(/5\.0 MB/)).toBeInTheDocument();
    expect(screen.getByText(/42 rows/)).toBeInTheDocument();
  });

  it("renders '— rows' when rows=null", () => {
    render(<DbStatsRow name="search" path="/x/search.sqlite" size={1024} rows={null} />);
    expect(screen.getByText(/— rows/)).toBeInTheDocument();
  });

  it("action button fires onAction when provided", async () => {
    const onAction = vi.fn();
    render(<DbStatsRow name="search" path="/x/search.sqlite" size={1024} rows={10} actionLabel="Reindex" onAction={onAction} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Reindex" }));
    expect(onAction).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// web/src/components/DbStatsRow.tsx
import "./DbStatsRow.css";

export interface DbStatsRowProps {
  name: string;
  path: string;
  size: number;
  rows: number | null;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export function DbStatsRow({ name, path, size, rows, actionLabel, onAction, actionDisabled }: DbStatsRowProps) {
  return (
    <div className="dbstats-row">
      <div className="dbstats-name">{name}</div>
      <div className="dbstats-path">{path}</div>
      <div className="dbstats-meta">
        <span>{formatBytes(size)}</span>
        <span>{rows === null ? "— rows" : `${rows} rows`}</span>
      </div>
      {actionLabel && onAction && (
        <button type="button" className="dbstats-action" onClick={onAction} disabled={actionDisabled}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
```

```css
/* web/src/components/DbStatsRow.css */
.dbstats-row {
  display: grid;
  grid-template-columns: 100px 1fr auto auto;
  align-items: center;
  gap: 14px;
  padding: 8px 12px;
  border-radius: var(--radius-inner);
}
.dbstats-row:hover { background: var(--row-hover); }
.dbstats-name { font-size: 13px; color: var(--fg); }
.dbstats-path { font-family: "SF Mono", ui-monospace, monospace; font-size: 11px; color: var(--fg-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dbstats-meta { display: flex; gap: 12px; font-size: 11px; color: var(--fg-2); font-variant-numeric: tabular-nums; }
.dbstats-action {
  padding: 3px 10px;
  font-size: 11px;
  color: var(--accent);
  background: var(--accent-soft);
  border-radius: var(--radius-inner);
}
.dbstats-action:hover { background: var(--glass-3); }
.dbstats-action:disabled { opacity: 0.5; cursor: wait; }
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/components/DbStatsRow.tsx \
        yulu/scripts/yulu_ui/web/src/components/DbStatsRow.css \
        yulu/scripts/yulu_ui/tests/web/DbStatsRow.test.tsx
git commit -m "feat(yulu_ui/web): DbStatsRow with size/rows + optional action button"
```

---

## Task D.14 — Settings/Audio page

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/settings/audio.tsx`
- Create: `yulu/scripts/yulu_ui/tests/web/settings.audio.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/settings.audio.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsAudio } from "../../web/src/routes/settings/audio.js";

const updateMutate = vi.fn(async () => ({ daemonsNeedingRestart: ["audiodaemon"], daemonsNeedingSighup: [] }));
const restartMutate = vi.fn(async () => ({ ok: true }));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    config: {
      get: { useQuery: () => ({ data: { audio: { mic_device: ":0", system_audio_device: ":1", output_dir: "/x", silence_threshold: 0.01, silence_duration_sec: 300, backend: "daemon" }, transcription: {}, llm: {} }, isPending: false }) },
      update: { useMutation: ({ onSuccess }: { onSuccess?: (res: { daemonsNeedingRestart: string[] }, vars: { key: string; value: unknown }) => void }) => ({
        mutateAsync: async (vars: { key: string; value: unknown }) => {
          const res = await updateMutate(vars);
          onSuccess?.(res, vars);
          return res;
        },
        isPending: false,
      }) },
    },
    daemons: {
      restart: { useMutation: ({ onSuccess }: { onSuccess?: (res: unknown, vars: { name: string }) => void }) => ({
        mutateAsync: async (vars: { name: string }) => {
          const res = await restartMutate();
          onSuccess?.(res, vars);
          return res;
        },
        isPending: false,
      }) },
    },
    system: {
      pickFile: { useMutation: () => ({ mutateAsync: async () => ({ path: null }) }) },
      openInFinder: { useMutation: () => ({ mutate: vi.fn() }) },
      audioDevices: { useQuery: () => ({ data: { input: [{uid:":0",name:"Built-in"},{uid:":1",name:"BlackHole"}], output: [{uid:":1",name:"BlackHole"}] }, isPending: false }) },
    },
  },
}));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/settings/audio", Component: SettingsAudio }], { initialEntries: ["/settings/audio"] });
  return render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
}

describe("Settings/Audio page", () => {
  it("renders all 6 row labels", () => {
    mount();
    for (const label of ["Mic device", "System audio device", "Output dir", "Silence threshold", "Silence duration sec", "Backend"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("editing silence_threshold triggers config.update + restart banner appears", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByText("0.01"));
    const input = screen.getByRole("spinbutton");
    await user.clear(input);
    await user.type(input, "0.02{Enter}");
    await vi.waitFor(() => expect(updateMutate).toHaveBeenCalledWith({ key: "audio.silence_threshold", value: 0.02 }));
    await vi.waitFor(() => expect(screen.getByText(/Restart required/)).toBeInTheDocument());
  });

  it("Restart now fires daemons.restart for audiodaemon", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByText("0.01"));
    const input = screen.getByRole("spinbutton");
    await user.clear(input);
    await user.type(input, "0.02{Enter}");
    await vi.waitFor(() => expect(screen.getByText(/Restart required/)).toBeInTheDocument());
    await user.click(screen.getByRole("button", { name: /restart now/i }));
    await vi.waitFor(() => expect(restartMutate).toHaveBeenCalled());
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// web/src/routes/settings/audio.tsx
import { trpc } from "../../trpc.js";
import { useSettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";
import { SettingsPage } from "../../components/SettingsPage.js";
import { InlineEditRow } from "../../components/InlineEditRow.js";
import { RestartBanner } from "../../components/RestartBanner.js";

export const handle = { breadcrumb: "Settings / Audio", filters: null };

// Daemon short name → LaunchAgent label
const DAEMON_LABEL: Record<string, string> = {
  audiodaemon: "com.yulu.audiodaemon",
  sttdaemon: "com.yulu.sttdaemon",
  agentqueue: "com.yulu.agentqueue",
  statusagent: "com.yulu.statusagent",
  scheduler: "com.yulu.scheduler",
  detector: "com.yulu.detector",
  calendar: "com.yulu.calendar",
};

export function SettingsAudio() {
  const { data: cfg } = trpc.config.get.useQuery();
  const { data: devices } = trpc.system.audioDevices.useQuery();
  const tracker = useSettingsRestartTracker();

  const updateMut = trpc.config.update.useMutation({
    onSuccess: (res: { daemonsNeedingRestart: string[] }, vars: { key: string }) => {
      tracker.record(vars.key, res.daemonsNeedingRestart);
    },
  });
  const restartMut = trpc.daemons.restart.useMutation({
    onSuccess: (_res: unknown, vars: { name: string }) => {
      const short = vars.name.replace(/^com\.yulu\./, "");
      tracker.clearDaemon(short);
    },
  });

  const commit = (key: string) => (value: unknown) => updateMut.mutateAsync({ key, value });

  const banner = tracker.daemons.size > 0 ? (
    <RestartBanner
      daemons={Array.from(tracker.daemons, ([name, keys]) => ({ name, keys: Array.from(keys) }))}
      onRestart={(name) => { restartMut.mutateAsync({ name: DAEMON_LABEL[name] ?? name }); }}
      onRestartAll={() => {
        for (const name of tracker.daemons.keys()) restartMut.mutateAsync({ name: DAEMON_LABEL[name] ?? name });
      }}
    />
  ) : null;

  if (!cfg) return <SettingsPage>Loading config…</SettingsPage>;

  const micOpts = (devices?.input ?? []).map((d) => ({ value: d.uid, label: d.name }));
  const sysOpts = [{ value: "", label: "(none)" }, ...(devices?.output ?? []).map((d) => ({ value: d.uid, label: d.name }))];

  return (
    <SettingsPage banner={banner}>
      <InlineEditRow label="Mic device" type="select" value={cfg.audio.mic_device ?? ""} options={micOpts.length ? micOpts : [{value: cfg.audio.mic_device ?? "", label: "(no devices found)"}]} onCommit={commit("audio.mic_device") as (v: string) => void} status={tracker.statusFor("audio.mic_device")} />
      <InlineEditRow label="System audio device" type="select" value={cfg.audio.system_audio_device ?? ""} options={sysOpts} onCommit={(v) => updateMut.mutateAsync({ key: "audio.system_audio_device", value: v || null })} status={tracker.statusFor("audio.system_audio_device")} />
      <InlineEditRow label="Output dir" type="path" mode="folder" value={cfg.audio.output_dir} onCommit={commit("audio.output_dir") as (v: string) => void} status={tracker.statusFor("audio.output_dir")} />
      <InlineEditRow label="Silence threshold" type="number" min={0} max={1} step={0.01} value={cfg.audio.silence_threshold} help="RMS below this counts as silence" onCommit={commit("audio.silence_threshold") as (v: number) => void} status={tracker.statusFor("audio.silence_threshold")} />
      <InlineEditRow label="Silence duration sec" type="number" min={1} step={1} value={cfg.audio.silence_duration_sec} onCommit={commit("audio.silence_duration_sec") as (v: number) => void} status={tracker.statusFor("audio.silence_duration_sec")} />
      <InlineEditRow label="Backend" type="select" value={cfg.audio.backend ?? "daemon"} options={[{ value: "daemon", label: "daemon" }]} onCommit={commit("audio.backend") as (v: string) => void} status={tracker.statusFor("audio.backend")} />
    </SettingsPage>
  );
}
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/settings/audio.tsx \
        yulu/scripts/yulu_ui/tests/web/settings.audio.test.tsx
git commit -m "feat(yulu_ui/web): Settings/Audio page with restart banner"
```

---

## Task D.15 — Settings/Transcription page

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/settings/transcription.tsx`
- Create: `yulu/scripts/yulu_ui/tests/web/settings.transcription.test.tsx`

Mirror Settings/Audio (D.14) with these rows:

- `Final engine` — select `mlx | whisper-cli`
- `Language` — select `zh | en | ja | auto`
- `Local model path` — path file mode, filter `bin`
- `MLX model` — text
- `MLX final model` — text
- `MLX preprocess audio` — toggle
- `MLX passthrough max sec` — number
- `MLX passthrough max bytes` — number

Also render a `<Link to="/knowledge/glossary">Manage glossary →</Link>` below the rows.

- [ ] **Step 1: Write test** mirroring `settings.audio.test.tsx` (assert all 8 row labels render + at least one commit goes through with restart tracker).

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement** — copy the structure of `audio.tsx`. Replace the rows. Reuse the `DAEMON_LABEL` map. (If you find yourself repeating this map across pages, extract it to `web/src/routes/settings/daemonLabels.ts` — but only after the 3rd duplication; otherwise inline.)

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/settings/transcription.tsx \
        yulu/scripts/yulu_ui/tests/web/settings.transcription.test.tsx
git commit -m "feat(yulu_ui/web): Settings/Transcription page"
```

---

## Task D.16 — Settings/LLM page

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/settings/llm.tsx`
- Create: `yulu/scripts/yulu_ui/tests/web/settings.llm.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
// tests/web/settings.llm.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SettingsLlm } from "../../web/src/routes/settings/llm.js";

const testMutateMock = vi.fn(async () => ({ ok: true, stdout: "hi there", stderr: "" }));
const updateMock = vi.fn(async () => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: ["agentqueue"] }));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    config: {
      get: { useQuery: () => ({ data: { audio: {}, transcription: {}, llm: { enabled: true, command: ["claude", "--print"] } }, isPending: false }) },
      update: { useMutation: () => ({ mutateAsync: async (vars: unknown) => updateMock() }) },
    },
    daemons: { restart: { useMutation: () => ({ mutateAsync: async () => ({ ok: true }) }) } },
    llm: { test: { useMutation: () => ({ mutateAsync: async () => testMutateMock(), isPending: false }) } },
  },
}));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter([{ path: "/settings/llm", Component: SettingsLlm }], { initialEntries: ["/settings/llm"] });
  return render(<QueryClientProvider client={qc}><RouterProvider router={router} /></QueryClientProvider>);
}

describe("Settings/LLM page", () => {
  it("renders Enabled toggle + CommandEditor + Test button", () => {
    mount();
    expect(screen.getByRole("switch")).toBeInTheDocument();
    expect(screen.getAllByRole("textbox")).toHaveLength(2);   // CommandEditor: 2 args
    expect(screen.getByRole("button", { name: /test command/i })).toBeInTheDocument();
  });

  it("clicking Test command triggers llm.test + popover shows stdout", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /test command/i }));
    await vi.waitFor(() => expect(testMutateMock).toHaveBeenCalled());
    await vi.waitFor(() => expect(screen.getByText("hi there")).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// web/src/routes/settings/llm.tsx
import { useState } from "react";
import { trpc } from "../../trpc.js";
import { useSettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";
import { SettingsPage } from "../../components/SettingsPage.js";
import { InlineEditRow } from "../../components/InlineEditRow.js";
import { RestartBanner } from "../../components/RestartBanner.js";
import { CommandEditor } from "../../components/CommandEditor.js";
import { TestPopover } from "../../components/TestPopover.js";

export const handle = { breadcrumb: "Settings / LLM", filters: null };

const DAEMON_LABEL: Record<string, string> = { agentqueue: "com.yulu.agentqueue" };

export function SettingsLlm() {
  const { data: cfg } = trpc.config.get.useQuery();
  const tracker = useSettingsRestartTracker();
  const updateMut = trpc.config.update.useMutation({
    onSuccess: (res: { daemonsNeedingRestart: string[] }, vars: { key: string }) => tracker.record(vars.key, res.daemonsNeedingRestart),
  });
  const restartMut = trpc.daemons.restart.useMutation({
    onSuccess: (_res: unknown, vars: { name: string }) => { const short = vars.name.replace(/^com\.yulu\./, ""); tracker.clearDaemon(short); },
  });
  const testMut = trpc.llm.test.useMutation();

  const [popState, setPopState] = useState<"pending" | "ok" | "failed" | null>(null);
  const [popStdout, setPopStdout] = useState("");
  const [popStderr, setPopStderr] = useState("");

  if (!cfg) return <SettingsPage>Loading config…</SettingsPage>;

  const banner = tracker.daemons.size > 0 ? (
    <RestartBanner
      daemons={Array.from(tracker.daemons, ([name, keys]) => ({ name, keys: Array.from(keys) }))}
      onRestart={(name) => restartMut.mutateAsync({ name: DAEMON_LABEL[name] ?? name })}
      onRestartAll={() => { for (const name of tracker.daemons.keys()) restartMut.mutateAsync({ name: DAEMON_LABEL[name] ?? name }); }}
    />
  ) : null;

  const runTest = async () => {
    setPopState("pending"); setPopStdout(""); setPopStderr("");
    try {
      const res = await testMut.mutateAsync();
      setPopState(res.ok ? "ok" : "failed");
      setPopStdout(res.stdout);
      setPopStderr(res.stderr);
    } catch (e) {
      setPopState("failed");
      setPopStderr((e as Error).message);
    }
  };

  return (
    <SettingsPage banner={banner}>
      <InlineEditRow label="Enabled" type="toggle" value={cfg.llm?.enabled ?? false} onCommit={(v) => updateMut.mutateAsync({ key: "llm.enabled", value: v })} status={tracker.statusFor("llm.enabled")} />
      <div className="row">
        <div className="row-label">Command<div className="row-help">Spawned with stdin = your turn text</div></div>
        <div className="row-value">
          <CommandEditor value={cfg.llm?.command ?? []} onChange={(next) => updateMut.mutateAsync({ key: "llm.command", value: next })} />
        </div>
        <div className="row-status" />
      </div>
      <div className="row">
        <div className="row-label">Test</div>
        <div className="row-value">
          <button type="button" className="cmd-add" onClick={runTest}>Test command</button>
        </div>
        <div className="row-status" />
      </div>
      {popState && <TestPopover state={popState} stdout={popStdout} stderr={popStderr} onClose={() => setPopState(null)} />}
    </SettingsPage>
  );
}
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/settings/llm.tsx \
        yulu/scripts/yulu_ui/tests/web/settings.llm.test.tsx
git commit -m "feat(yulu_ui/web): Settings/LLM page (CommandEditor + Test popover)"
```

---

## Task D.17 — Settings/Hotkey & UI page

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/settings/hotkey.tsx`
- Create: `yulu/scripts/yulu_ui/tests/web/settings.hotkey.test.tsx`

- [ ] **Step 1: Write failing test** that asserts the page renders: status_agent enabled toggle, HotkeyCapture (showing current glyph), ThemeToggle, and the readonly Port row with help text.

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// web/src/routes/settings/hotkey.tsx
import { trpc } from "../../trpc.js";
import { useSettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";
import { SettingsPage } from "../../components/SettingsPage.js";
import { InlineEditRow } from "../../components/InlineEditRow.js";
import { RestartBanner } from "../../components/RestartBanner.js";
import { HotkeyCapture, type HotkeyValue } from "../../components/HotkeyCapture.js";
import { ThemeToggle } from "../../components/ThemeToggle.js";

export const handle = { breadcrumb: "Settings / Hotkey & UI", filters: null };

const DAEMON_LABEL: Record<string, string> = { statusagent: "com.yulu.statusagent" };

export function SettingsHotkey() {
  const { data: cfg } = trpc.config.get.useQuery();
  const tracker = useSettingsRestartTracker();
  const updateMut = trpc.config.update.useMutation({
    onSuccess: (res: { daemonsNeedingRestart: string[] }, vars: { key: string }) => tracker.record(vars.key, res.daemonsNeedingRestart),
  });
  const restartMut = trpc.daemons.restart.useMutation({
    onSuccess: (_res: unknown, vars: { name: string }) => { const short = vars.name.replace(/^com\.yulu\./, ""); tracker.clearDaemon(short); },
  });

  if (!cfg) return <SettingsPage>Loading config…</SettingsPage>;

  const banner = tracker.daemons.size > 0 ? (
    <RestartBanner
      daemons={Array.from(tracker.daemons, ([name, keys]) => ({ name, keys: Array.from(keys) }))}
      onRestart={(name) => restartMut.mutateAsync({ name: DAEMON_LABEL[name] ?? name })}
      onRestartAll={() => { for (const name of tracker.daemons.keys()) restartMut.mutateAsync({ name: DAEMON_LABEL[name] ?? name }); }}
    />
  ) : null;

  const hotkey: HotkeyValue = cfg.status_agent?.hotkey ?? { key: "V", modifiers: ["cmd", "shift"] };

  return (
    <SettingsPage banner={banner}>
      <InlineEditRow label="Status agent enabled" type="toggle" value={cfg.status_agent?.enabled ?? false} onCommit={(v) => updateMut.mutateAsync({ key: "status_agent.enabled", value: v })} status={tracker.statusFor("status_agent.enabled")} />
      <div className="row">
        <div className="row-label">Hotkey</div>
        <div className="row-value"><HotkeyCapture value={hotkey} onCommit={(v) => updateMut.mutateAsync({ key: "status_agent.hotkey", value: v })} /></div>
        <div className="row-status" />
      </div>
      <div className="row">
        <div className="row-label">UI theme</div>
        <div className="row-value"><ThemeToggle /></div>
        <div className="row-status" />
      </div>
      <InlineEditRow label="UI port" type="readonly" value="7777" help="Edit com.yulu.ui.plist and `yulu restart yulu_ui` to change" />
    </SettingsPage>
  );
}
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/settings/hotkey.tsx \
        yulu/scripts/yulu_ui/tests/web/settings.hotkey.test.tsx
git commit -m "feat(yulu_ui/web): Settings/Hotkey & UI page (HotkeyCapture + ThemeToggle)"
```

---

## Task D.18 — Settings/Integrations page

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/settings/integrations.tsx`
- Create: `yulu/scripts/yulu_ui/tests/web/settings.integrations.test.tsx`

- [ ] **Step 1: Write failing test** — assert calendars from config render as cards, Test connection fires `integrations.test`, popover shows result.

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// web/src/routes/settings/integrations.tsx
import { useState } from "react";
import { trpc } from "../../trpc.js";
import { SettingsPage } from "../../components/SettingsPage.js";
import { InlineEditRow } from "../../components/InlineEditRow.js";
import { TestPopover } from "../../components/TestPopover.js";
import "./integrations.css";

export const handle = { breadcrumb: "Settings / Integrations", filters: null };

interface Calendar {
  type: "feishu" | "google";
  enabled?: boolean;
  credentials_path?: string;
  account?: string;
}

export function SettingsIntegrations() {
  const { data: cfg } = trpc.config.get.useQuery();
  const updateMut = trpc.config.update.useMutation();
  const testMut = trpc.integrations.test.useMutation();
  const [popFor, setPopFor] = useState<string | null>(null);
  const [popState, setPopState] = useState<"pending" | "ok" | "failed">("pending");
  const [popStdout, setPopStdout] = useState("");
  const [popStderr, setPopStderr] = useState("");

  if (!cfg) return <SettingsPage>Loading config…</SettingsPage>;

  const calendars = (cfg.calendars ?? []) as Calendar[];

  const runTest = async (provider: "feishu" | "google") => {
    setPopFor(provider); setPopState("pending"); setPopStdout(""); setPopStderr("");
    try {
      const res = await testMut.mutateAsync({ provider });
      setPopState(res.ok ? "ok" : "failed");
      setPopStdout(res.stdout);
      setPopStderr(res.stderr);
    } catch (e) {
      setPopState("failed");
      setPopStderr((e as Error).message);
    }
  };

  return (
    <SettingsPage>
      {calendars.length === 0 && (
        <div className="integrations-empty">No calendar providers configured.</div>
      )}
      {calendars.map((cal, idx) => (
        <div key={cal.type} className="integration-card">
          <div className="integration-header">{cal.type}</div>
          <InlineEditRow label="Enabled" type="toggle" value={cal.enabled ?? false} onCommit={(v) => updateMut.mutateAsync({ key: `calendars.${idx}.enabled`, value: v })} />
          <InlineEditRow label="Credentials path" type="path" mode="file" filter="json" value={cal.credentials_path ?? ""} onCommit={(v) => updateMut.mutateAsync({ key: `calendars.${idx}.credentials_path`, value: v })} />
          <InlineEditRow label="Account" type="text" value={cal.account ?? ""} onCommit={(v) => updateMut.mutateAsync({ key: `calendars.${idx}.account`, value: v })} />
          <div className="row">
            <div className="row-label">Test connection</div>
            <div className="row-value">
              <button type="button" className="cmd-add" onClick={() => runTest(cal.type)}>Test</button>
            </div>
            <div className="row-status" />
          </div>
          {popFor === cal.type && <TestPopover state={popState} stdout={popStdout} stderr={popStderr} onClose={() => setPopFor(null)} />}
        </div>
      ))}
    </SettingsPage>
  );
}
```

```css
/* web/src/routes/settings/integrations.css */
.integrations-empty {
  padding: 40px;
  text-align: center;
  color: var(--fg-2);
  font-size: 12px;
}
.integration-card {
  margin-bottom: 16px;
  padding: 14px;
  background: var(--glass);
  border-radius: var(--radius-panel);
  box-shadow: var(--edge-shadow);
}
.integration-header {
  font-size: 13px;
  font-weight: 500;
  color: var(--accent);
  margin-bottom: 8px;
  text-transform: capitalize;
}
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/settings/integrations.tsx \
        yulu/scripts/yulu_ui/web/src/routes/settings/integrations.css \
        yulu/scripts/yulu_ui/tests/web/settings.integrations.test.tsx
git commit -m "feat(yulu_ui/web): Settings/Integrations page (calendar cards + Test connection)"
```

---

## Task D.19 — Settings/Storage page

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/settings/storage.tsx`
- Create: `yulu/scripts/yulu_ui/tests/web/settings.storage.test.tsx`

- [ ] **Step 1: Write failing test** — assert: Output dir row, 3 DbStatsRow entries (prompts/vocab/search), Reindex button on search row fires search.reindex, log rows render under "Logs" section.

- [ ] **Step 2: Run, verify FAIL**

- [ ] **Step 3: Implement**

```tsx
// web/src/routes/settings/storage.tsx
import { trpc } from "../../trpc.js";
import { SettingsPage } from "../../components/SettingsPage.js";
import { InlineEditRow } from "../../components/InlineEditRow.js";
import { DbStatsRow } from "../../components/DbStatsRow.js";
import "./storage.css";

export const handle = { breadcrumb: "Settings / Storage", filters: null };

export function SettingsStorage() {
  const { data: cfg } = trpc.config.get.useQuery();
  const { data: dbStats } = trpc.system.dbStats.useQuery();
  const { data: logPaths } = trpc.system.logPaths.useQuery();
  const updateMut = trpc.config.update.useMutation();
  const reindexMut = trpc.search.reindex.useMutation();

  if (!cfg) return <SettingsPage>Loading config…</SettingsPage>;

  return (
    <SettingsPage>
      <InlineEditRow label="Output dir" type="path" mode="folder" value={cfg.audio.output_dir} onCommit={(v) => updateMut.mutateAsync({ key: "audio.output_dir", value: v })} />

      <div className="storage-section">Databases</div>
      {(dbStats ?? []).map((d) => (
        <DbStatsRow
          key={d.name}
          name={d.name}
          path={d.path}
          size={d.size}
          rows={d.rows}
          actionLabel={d.name === "search" ? "Reindex" : undefined}
          onAction={d.name === "search" ? () => reindexMut.mutateAsync() : undefined}
          actionDisabled={d.name === "search" && reindexMut.isPending}
        />
      ))}

      <div className="storage-section">Logs</div>
      {(logPaths ?? []).map((lp) => (
        <InlineEditRow key={lp.name} label={lp.name} type="readonly" value={lp.path} revealInFinder />
      ))}
    </SettingsPage>
  );
}
```

```css
/* web/src/routes/settings/storage.css */
.storage-section {
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.10em;
  color: var(--fg-3);
  margin: 16px 12px 4px;
  text-transform: uppercase;
}
```

- [ ] **Step 4: Re-run + full suite + typecheck**

- [ ] **Step 5: Commit**

```bash
git add yulu/scripts/yulu_ui/web/src/routes/settings/storage.tsx \
        yulu/scripts/yulu_ui/web/src/routes/settings/storage.css \
        yulu/scripts/yulu_ui/tests/web/settings.storage.test.tsx
git commit -m "feat(yulu_ui/web): Settings/Storage page (DbStatsRow + log paths)"
```

---

## Task D.20 — Real-machine smoke + push

**Files:** none — verification + push.

- [ ] **Step 1: Clean rebuild + prod smoke**

```bash
cd yulu/scripts/yulu_ui
rm -rf dist
npm install
npm run build
YULU_UI_PORT=17800 node dist/server.js > /tmp/yulu_d20_prod.log 2>&1 &
PROD_PID=$!
sleep 1
for p in /healthz /trpc/config.get /trpc/system.audioDevices /trpc/system.dbStats /trpc/system.logPaths /settings/audio /settings/transcription /settings/llm /settings/hotkey /settings/integrations /settings/storage; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:17800$p")
  echo "$p → $CODE"
done
kill $PROD_PID 2>/dev/null; wait 2>/dev/null
```

Expected: all 200.

- [ ] **Step 2: Dev mode + browser visual** via `npm run dev` + the gstack `/browse` skill. Verify:

1. `/settings/audio` renders 6 rows; clicking mic select shows dropdown of real devices (or "no devices found" fallback)
2. Editing silence_threshold triggers restart banner; clicking "Restart now" triggers daemons.restart for audiodaemon
3. `/settings/transcription` renders 8 rows
4. `/settings/llm` renders Enabled toggle + CommandEditor + Test command button; clicking Test opens TestPopover with output
5. `/settings/hotkey` renders hotkey glyph + ThemeToggle + readonly port row
6. `/settings/integrations` renders calendar cards if config.calendars populated; otherwise "No calendar providers configured."
7. `/settings/storage` renders Output dir row + 3 DB rows (sizes visible if files exist, "0 B / — rows" if missing) + 8 log path rows with Reveal buttons

- [ ] **Step 3: Push**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git log --oneline | head -25
git push
```

- [ ] **Step 4: Update PR #24 description** — extend the "Stats" section: 85 task commits + ~190 vitest tests; add Phase D summary in the body.

---

## Self-review (run before declaring Phase D done)

- [ ] Spec §5 backend procedures → D.1, D.2, D.3, D.4, D.5
- [ ] Spec §6 components → D.7, D.8, D.9, D.10, D.11, D.12, D.13
- [ ] Spec §6.4 useSettingsRestartTracker → D.6
- [ ] Spec §7 page compositions → D.14, D.15, D.16, D.17, D.18, D.19
- [ ] Spec §13 acceptance #1–#10 → covered across tasks; final verification in D.20
- [ ] No `TBD`, `TODO`, or vague steps
- [ ] Every file path concrete

Type consistency check:
- `RowStatus` defined in D.6 + D.8, same type alias both places
- `HotkeyValue` defined in D.10, consumed in D.17
- `Calendar` interface in D.18 — local to that page
- `pickFile({mode, filter})` signature in D.1, consumed in D.8 InlineEditRow
- `openInFinder({path, reveal?})` in D.1, consumed in D.8 + D.19
- `audioDevices()` return shape `{input, output}` of `{uid, name}` in D.2, consumed in D.14
- `dbStats()` return shape `{name, path, size, rows}` in D.3, consumed in D.19
- `logPaths()` return shape `{name, path}` in D.3, consumed in D.19
- `integrations.test({provider})` return `{ok, stdout, stderr}` in D.4, consumed in D.18
- `llm.test()` return `{ok, stdout, stderr}` in D.5, consumed in D.16

---

## What's NOT in Phase D (deferred)

| Phase | Scope |
|---|---|
| E | Knowledge pages (Prompts reuses MasterDetail from C; Glossary inline table reuses InlineEditRow's text variant) |
| F | Health pages (Daemons grid + Logs tail via useWsChannel('logs')); Playwright E2E sweep after all real pages exist |
| G | setup.sh integration, yulu doctor entry, release packaging |

Future polish (out of scope for D):
- MLX model picker with `~/.cache/huggingface` parser
- Add/remove calendar provider via UI (currently config.json edit)
- Per-row revert button (banner self-dismisses on revert is hard to detect — defer)
- Drag-to-reorder calendar providers
