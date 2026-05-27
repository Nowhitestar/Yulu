# Phase I — Reader Audio Fix + Manual Transcribe/Summary Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the AudioPlayer's A→B→A playback regression, and add backend mutations + UI buttons so users can manually re-run transcription / summary on existing recordings.

**Architecture:** Backend gains an in-memory `JobRegistry` (Map<stem, JobStatus>) plus a `jobRunner` that spawns the existing `transcribe.py` / writes to `agent-queue.json` and broadcasts state via a new `jobs` pubsub channel. Frontend gets a reusable `<ReprocessButton>` with 4 visual states and integrates two buttons into each reader. The AudioPlayer fix is a small `useEffect` cleanup that resets local React state on every `src` change.

**Tech Stack:** TypeScript 5 (Node + React 18) · tRPC mutations · child_process.spawn / fs.watch · wavesurfer.js · Lucide icons · WebSocket multiplexer.

**Spec reference:** `docs/superpowers/specs/2026-05-27-yulu-ui-I-reader-fix-manual-triggers-design.md`

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `yulu/scripts/yulu_ui/src/jobStatus.ts` | Create | `JobRegistry` singleton — Map<stem, JobStatus> with set/get/clear/snapshot |
| `yulu/scripts/yulu_ui/src/jobRunner.ts` | Create | `runTranscribe` + `runSummarize` — spawn child_process or write agent-queue, manage registry, publish events |
| `yulu/scripts/yulu_ui/src/pubsub.ts` | Modify | Add `jobs` channel to `AppChannels` |
| `yulu/scripts/yulu_ui/src/paths.ts` | Modify | Add `scriptDir` (parent of yulu_ui/, where transcribe.py lives) |
| `yulu/scripts/yulu_ui/src/trpc.ts` | Modify | Add `jobs: JobRegistry` to `AppContext` |
| `yulu/scripts/yulu_ui/src/server.ts` | Modify | Wire `JobRegistry` into ctx + persist across server lifetime |
| `yulu/scripts/yulu_ui/src/routers/voicemails.ts` | Modify | Add `transcribe` + `summarize` mutations; add `status` field on list + get |
| `yulu/scripts/yulu_ui/src/routers/meetings.ts` | Modify | Same |
| `yulu/scripts/yulu_ui/web/src/components/AudioPlayer.tsx` | Modify | Reset state on src change, disable Play until ready |
| `yulu/scripts/yulu_ui/web/src/components/ReprocessButton.tsx` + `.css` | Create | 4-state button (idle / running / done / failed) |
| `yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.$stem.tsx` | Modify | Render 2 ReprocessButtons + WS subscription |
| `yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.$stem.tsx` | Modify | Same |
| `yulu/scripts/yulu_ui/e2e/critical.spec.ts` | Modify | Add audio-switch regression test + Re-transcribe button test |
| `yulu/scripts/yulu_ui/tests/jobStatus.test.ts` | Create | JobRegistry unit tests |
| `yulu/scripts/yulu_ui/tests/jobRunner.test.ts` | Create | JobRunner unit tests (mocked child_process) |
| `yulu/scripts/yulu_ui/tests/routers/voicemails.test.ts` | Modify | Add coverage for new mutations + status field |
| `yulu/scripts/yulu_ui/tests/web/components/ReprocessButton.test.tsx` | Create | Component state machine tests |
| `yulu/scripts/yulu_ui/tests/web/components/AudioPlayer.test.tsx` | Create or modify | src-change state-reset assertions |

---

## Task 1 (I.1): Backend infrastructure — JobRegistry, jobs channel, paths.scriptDir

**Files:**
- Create: `yulu/scripts/yulu_ui/src/jobStatus.ts`
- Modify: `yulu/scripts/yulu_ui/src/pubsub.ts`
- Modify: `yulu/scripts/yulu_ui/src/paths.ts`
- Modify: `yulu/scripts/yulu_ui/src/trpc.ts`
- Modify: `yulu/scripts/yulu_ui/src/server.ts`
- Test: `yulu/scripts/yulu_ui/tests/jobStatus.test.ts`

**Goal:** Lay the foundation — registry data structure, new pubsub channel, path-to-script-dir, and wiring into AppContext.

### Background

The yulu_ui server runs from `yulu/scripts/yulu_ui/dist/server.js`. The python tools (`transcribe.py`, etc.) live one level up at `yulu/scripts/`. We need a reliable way to find them at runtime; the LaunchAgent sets `YULU_SCRIPT_DIR` env var to the absolute path, with a sane fallback for dev mode.

- [ ] **Step 1: Write failing tests for JobRegistry**

Create `yulu/scripts/yulu_ui/tests/jobStatus.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { JobRegistry, type JobStatus } from "../src/jobStatus.js";

function mkJob(overrides: Partial<JobStatus> = {}): JobStatus {
  return {
    stem: "voicemail_20260101_120000",
    action: "transcribe",
    state: "transcribing",
    startedAt: 0,
    jobId: "j1",
    ...overrides,
  };
}

describe("JobRegistry", () => {
  let r: JobRegistry;
  beforeEach(() => { r = new JobRegistry(); });

  it("get() returns undefined when nothing set", () => {
    expect(r.get("missing")).toBeUndefined();
  });

  it("set() then get() returns the same record", () => {
    const job = mkJob();
    r.set(job);
    expect(r.get(job.stem)).toEqual(job);
  });

  it("set() replaces an existing record for the same stem", () => {
    r.set(mkJob({ jobId: "j1", state: "transcribing" }));
    r.set(mkJob({ jobId: "j2", state: "summarizing" }));
    expect(r.get("voicemail_20260101_120000")?.jobId).toBe("j2");
    expect(r.get("voicemail_20260101_120000")?.state).toBe("summarizing");
  });

  it("clear() removes a stem", () => {
    r.set(mkJob());
    r.clear(mkJob().stem);
    expect(r.get(mkJob().stem)).toBeUndefined();
  });

  it("clear() on missing stem is a no-op", () => {
    expect(() => r.clear("missing")).not.toThrow();
  });

  it("snapshot() returns a copy not a live reference", () => {
    r.set(mkJob());
    const snap = r.snapshot();
    r.clear(mkJob().stem);
    expect(snap.get(mkJob().stem)).toBeDefined();   // snapshot still has it
    expect(r.get(mkJob().stem)).toBeUndefined();    // live is empty
  });

  it("snapshot() reflects multiple stems", () => {
    r.set(mkJob({ stem: "a" }));
    r.set(mkJob({ stem: "b" }));
    const snap = r.snapshot();
    expect(snap.size).toBe(2);
    expect(snap.has("a")).toBe(true);
    expect(snap.has("b")).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd yulu/scripts/yulu_ui && npm test -- jobStatus`
Expected: 7 FAIL — cannot find module.

- [ ] **Step 3: Implement jobStatus.ts**

Create `yulu/scripts/yulu_ui/src/jobStatus.ts`:

```ts
/**
 * In-memory registry of in-flight reprocess jobs (transcribe / summarize)
 * indexed by recording stem. Phase I — see spec § 4.2.
 *
 * Singleton-style: one instance lives in the AppContext for the server's
 * lifetime. Not persisted across restarts; that's an intentional Phase I
 * v1 limit.
 */

export type JobAction = "transcribe" | "summarize";
export type JobState = "idle" | "transcribing" | "summarizing" | "failed";

export interface JobStatus {
  stem: string;
  action: JobAction;
  state: JobState;
  startedAt: number;        // epoch ms
  jobId: string;            // uuid for correlation
  error?: string;
  queueEntryId?: string;    // present in queue-mode summary
}

export class JobRegistry {
  private map = new Map<string, JobStatus>();

  set(status: JobStatus): void {
    this.map.set(status.stem, status);
  }

  get(stem: string): JobStatus | undefined {
    return this.map.get(stem);
  }

  clear(stem: string): void {
    this.map.delete(stem);
  }

  snapshot(): Map<string, JobStatus> {
    return new Map(this.map);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd yulu/scripts/yulu_ui && npm test -- jobStatus`
Expected: 7 PASS.

- [ ] **Step 5: Add `jobs` channel to pubsub.ts**

Edit `yulu/scripts/yulu_ui/src/pubsub.ts`. Find the `AppChannels` type:

```ts
export type AppChannels = {
  "recording":       { state: "idle" | "recording" | "processing" | "meetingBusy" | "daemonDown"; file?: string; elapsedSec?: number; level?: number; };
  "daemons":         { name: string; status: "running" | "stopped" | "crashed"; pid: number; lastLog?: string; };
  "sidebar-counts":  { voicemails: number; meetings: number; prompts: number; glossary: number; };
  "logs":            { name: string; line: string; ts: number; };
};
```

Append the `jobs` entry, becoming:

```ts
export type AppChannels = {
  "recording":       { state: "idle" | "recording" | "processing" | "meetingBusy" | "daemonDown"; file?: string; elapsedSec?: number; level?: number; };
  "daemons":         { name: string; status: "running" | "stopped" | "crashed"; pid: number; lastLog?: string; };
  "sidebar-counts":  { voicemails: number; meetings: number; prompts: number; glossary: number; };
  "logs":            { name: string; line: string; ts: number; };
  "jobs":            { stem: string; jobId: string; state: "transcribing" | "summarizing" | "done" | "failed"; error?: string };
};
```

- [ ] **Step 6: Add `scriptDir` to paths.ts**

Edit `yulu/scripts/yulu_ui/src/paths.ts`. Find:

```ts
import { homedir } from "node:os";
import { join } from "node:path";

const HOME = homedir();
const CONFIG_DIR = join(HOME, ".config", "yulu");
const MOVIES_DIR = join(HOME, "Movies", "Yulu");

export const paths = {
  // ... existing
} as const;
```

Replace the whole file with:

```ts
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HOME = homedir();
const CONFIG_DIR = join(HOME, ".config", "yulu");
const MOVIES_DIR = join(HOME, "Movies", "Yulu");

/**
 * Locate yulu/scripts/ at runtime.
 *
 * 1. YULU_SCRIPT_DIR env var (set by the LaunchAgent installer).
 * 2. Walk up from this file's URL: paths.ts → src → yulu_ui → scripts.
 *
 * Result is the directory containing `transcribe.py`, daemon plists, etc.
 */
function locateScriptDir(): string {
  if (process.env.YULU_SCRIPT_DIR) return process.env.YULU_SCRIPT_DIR;
  // import.meta.url works in both dev (tsx) and prod (esbuild ESM bundle).
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // here = .../yulu/scripts/yulu_ui/src (dev) or .../yulu/scripts/yulu_ui/dist (prod)
    return resolve(here, "..", "..");
  } catch {
    return resolve(process.cwd(), "..", "..");
  }
}

const SCRIPT_DIR = locateScriptDir();

export const paths = {
  configDir:        CONFIG_DIR,
  configFile:       join(CONFIG_DIR, "config.json"),
  promptsDb:        join(CONFIG_DIR, "prompts.sqlite"),
  vocabDb:          join(CONFIG_DIR, "vocab.sqlite"),
  searchDb:         join(CONFIG_DIR, "search.sqlite"),
  audioDaemonSock:  join(CONFIG_DIR, "audio_daemon.sock"),
  sttDaemonSock:    join(CONFIG_DIR, "stt_daemon.sock"),
  statusAgentSock:  join(CONFIG_DIR, "status_agent.sock"),
  uiLog:            join(CONFIG_DIR, "ui.log"),
  uiPid:            join(CONFIG_DIR, "yulu_ui.pid"),
  moviesDir:        MOVIES_DIR,
  voicemailsDir:    join(MOVIES_DIR, "voicemails"),
  scriptDir:        SCRIPT_DIR,
  transcribePy:     join(SCRIPT_DIR, "transcribe.py"),
  agentQueueJson:   join(CONFIG_DIR, "agent-queue.json"),
} as const;
```

- [ ] **Step 7: Add `jobs: JobRegistry` to AppContext**

Edit `yulu/scripts/yulu_ui/src/trpc.ts`. Find:

```ts
import type { paths as pathsType } from "./paths.js";

export interface AppContext {
  config: ConfigManager;
  launchctl: LaunchctlClient;
  pubsub: PubSub<AppChannels>;
  paths: typeof pathsType;
  db: {
    prompts: DbType;
    vocab: DbType;
    search: DbType;
  };
}
```

Replace with:

```ts
import type { paths as pathsType } from "./paths.js";
import type { JobRegistry } from "./jobStatus.js";

export interface AppContext {
  config: ConfigManager;
  launchctl: LaunchctlClient;
  pubsub: PubSub<AppChannels>;
  paths: typeof pathsType;
  jobs: JobRegistry;
  db: {
    prompts: DbType;
    vocab: DbType;
    search: DbType;
  };
}
```

- [ ] **Step 8: Wire `JobRegistry` into server.ts**

Edit `yulu/scripts/yulu_ui/src/server.ts`. Find the `ctx` construction (around line 44):

```ts
const ctx: AppContext = {
  config:    new ConfigManager(paths.configFile),
  launchctl: new LaunchctlClient(launchAgents),
  pubsub:    appPubSub,
  paths,
  db:        dbProxy,
};
```

Add the JobRegistry. The file is in `yulu/scripts/yulu_ui/src/server.ts`. Add the import near the existing imports:

```ts
import { JobRegistry } from "./jobStatus.js";
```

And construct it once outside the request flow (so the singleton persists across requests). Modify ctx:

```ts
const jobRegistry = new JobRegistry();

const ctx: AppContext = {
  config:    new ConfigManager(paths.configFile),
  launchctl: new LaunchctlClient(launchAgents),
  pubsub:    appPubSub,
  paths,
  jobs:      jobRegistry,
  db:        dbProxy,
};
```

- [ ] **Step 9: Typecheck + tests**

Run: `cd yulu/scripts/yulu_ui && npm run typecheck && npm test 2>&1 | tail -10`
Expected: typecheck clean; tests pass (existing + 7 new from jobStatus).

- [ ] **Step 10: Commit**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git add yulu/scripts/yulu_ui/src/jobStatus.ts yulu/scripts/yulu_ui/src/pubsub.ts yulu/scripts/yulu_ui/src/paths.ts yulu/scripts/yulu_ui/src/trpc.ts yulu/scripts/yulu_ui/src/server.ts yulu/scripts/yulu_ui/tests/jobStatus.test.ts
git commit -m "feat(yulu_ui/backend): JobRegistry + jobs pubsub channel + paths.scriptDir

In-memory Map<stem, JobStatus> singleton wired into AppContext for tracking
in-flight reprocess jobs. New 'jobs' AppChannels entry for WS broadcast.
paths gains scriptDir (with YULU_SCRIPT_DIR env override + import.meta.url
fallback), transcribePy, agentQueueJson. 7 vitest cases for JobRegistry."
```

---

## Task 2 (I.2): jobRunner.ts — spawn / enqueue + publish

**Files:**
- Create: `yulu/scripts/yulu_ui/src/jobRunner.ts`
- Test: `yulu/scripts/yulu_ui/tests/jobRunner.test.ts`

**Goal:** The two functions that actually run transcribe.py / write to agent-queue.json / fs.watch for completion / publish state changes.

### Background

`transcribe.py` takes a single argument (wav path) and writes alongside it (`<wav>.transcript.txt`). Non-zero exit code means failure. Stderr captures the error.

Summary in queue mode: append a JSON entry to `~/.config/yulu/agent-queue.json` (which is a JSON array). `agent_queue_worker.py` polls this file and processes entries. When an entry's processed, the worker removes it from the array. We watch the file for entry-removal AND for `<stem>.summary.md` appearance.

Summary in direct mode (`config.llm.command` set): spawn the command, pipe transcript to stdin, capture stdout → write to `<stem>.summary.md`.

- [ ] **Step 1: Write failing tests**

Create `yulu/scripts/yulu_ui/tests/jobRunner.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { JobRegistry } from "../src/jobStatus.js";
import { PubSub, type AppChannels } from "../src/pubsub.js";
import { runTranscribe, runSummarize, __setSpawnForTesting } from "../src/jobRunner.js";

// Minimal stub of child_process.spawn return value
function fakeSpawn(exitCode: number, stderr = ""): EventEmitter & { stdin: { write: () => void; end: () => void } } {
  const ee = new EventEmitter() as EventEmitter & {
    stderr: EventEmitter;
    stdout: EventEmitter;
    stdin: { write: () => void; end: () => void };
  };
  ee.stderr = new EventEmitter();
  ee.stdout = new EventEmitter();
  ee.stdin = { write: () => {}, end: () => {} };
  // Defer emit so the caller can attach listeners.
  setTimeout(() => {
    if (stderr) ee.stderr.emit("data", Buffer.from(stderr));
    ee.emit("exit", exitCode);
  }, 5);
  return ee;
}

describe("jobRunner.runTranscribe", () => {
  let root: string;
  let registry: JobRegistry;
  let pubsub: PubSub<AppChannels>;
  let events: AppChannels["jobs"][];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jr_"));
    registry = new JobRegistry();
    pubsub = new PubSub<AppChannels>();
    events = [];
    pubsub.subscribe("jobs", (m) => events.push(m));
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); __setSpawnForTesting(undefined); });

  it("sets registry to 'transcribing' immediately and publishes start event", async () => {
    __setSpawnForTesting(() => fakeSpawn(0));
    const wavPath = join(root, "voicemail_test.wav");
    writeFileSync(wavPath, "");
    const promise = runTranscribe({ stem: "voicemail_test", wavPath, transcribePy: "/fake", registry, pubsub });
    // synchronous side-effects observable immediately
    expect(registry.get("voicemail_test")?.state).toBe("transcribing");
    expect(events[0]?.state).toBe("transcribing");
    await promise;
  });

  it("clears registry and publishes 'done' on exit code 0", async () => {
    __setSpawnForTesting(() => fakeSpawn(0));
    const wavPath = join(root, "voicemail_test.wav");
    writeFileSync(wavPath, "");
    await runTranscribe({ stem: "voicemail_test", wavPath, transcribePy: "/fake", registry, pubsub });
    expect(registry.get("voicemail_test")).toBeUndefined();
    const last = events[events.length - 1];
    expect(last?.state).toBe("done");
  });

  it("marks registry 'failed' with stderr on non-zero exit", async () => {
    __setSpawnForTesting(() => fakeSpawn(2, "MLX OOM"));
    const wavPath = join(root, "voicemail_test.wav");
    writeFileSync(wavPath, "");
    await runTranscribe({ stem: "voicemail_test", wavPath, transcribePy: "/fake", registry, pubsub });
    const rec = registry.get("voicemail_test");
    expect(rec?.state).toBe("failed");
    expect(rec?.error).toContain("MLX OOM");
    const last = events[events.length - 1];
    expect(last?.state).toBe("failed");
    expect(last?.error).toContain("MLX OOM");
  });

  it("returns a jobId string", async () => {
    __setSpawnForTesting(() => fakeSpawn(0));
    const wavPath = join(root, "voicemail_test.wav");
    writeFileSync(wavPath, "");
    const result = await runTranscribe({ stem: "voicemail_test", wavPath, transcribePy: "/fake", registry, pubsub });
    expect(typeof result.jobId).toBe("string");
    expect(result.jobId.length).toBeGreaterThan(0);
  });
});

describe("jobRunner.runSummarize (queue mode)", () => {
  let root: string;
  let registry: JobRegistry;
  let pubsub: PubSub<AppChannels>;
  let events: AppChannels["jobs"][];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "jrs_"));
    registry = new JobRegistry();
    pubsub = new PubSub<AppChannels>();
    events = [];
    pubsub.subscribe("jobs", (m) => events.push(m));
  });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it("appends an entry to agent-queue.json in queue mode", async () => {
    const queuePath = join(root, "agent-queue.json");
    writeFileSync(queuePath, "[]");
    const transcriptPath = join(root, "voicemail_test.transcript.txt");
    writeFileSync(transcriptPath, "hello world");
    const result = await runSummarize({
      stem: "voicemail_test", transcriptPath, summaryPath: join(root, "voicemail_test.summary.md"),
      llmCommand: null, agentQueueJson: queuePath, registry, pubsub,
    });
    expect(result.mode).toBe("queue");
    const queue = JSON.parse(readFileSync(queuePath, "utf8"));
    expect(queue.length).toBe(1);
    expect(queue[0].type).toBe("summary_request");
    expect(queue[0].stem).toBe("voicemail_test");
  });

  it("returns mode='queue' and sets registry summarizing", async () => {
    const queuePath = join(root, "agent-queue.json");
    writeFileSync(queuePath, "[]");
    const transcriptPath = join(root, "voicemail_test.transcript.txt");
    writeFileSync(transcriptPath, "hello world");
    const result = await runSummarize({
      stem: "voicemail_test", transcriptPath, summaryPath: join(root, "voicemail_test.summary.md"),
      llmCommand: null, agentQueueJson: queuePath, registry, pubsub,
    });
    expect(result.mode).toBe("queue");
    expect(registry.get("voicemail_test")?.state).toBe("summarizing");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd yulu/scripts/yulu_ui && npm test -- jobRunner`
Expected: cannot find module.

- [ ] **Step 3: Implement jobRunner.ts**

Create `yulu/scripts/yulu_ui/src/jobRunner.ts`:

```ts
import { spawn as defaultSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { randomUUID } from "node:crypto";
import type { JobRegistry } from "./jobStatus.js";
import type { PubSub, AppChannels } from "./pubsub.js";

type SpawnFn = (cmd: string, args: string[], opts?: { stdio?: unknown }) => ChildProcessWithoutNullStreams;

let spawnImpl: SpawnFn = defaultSpawn as unknown as SpawnFn;

/** Test hook: replace spawn with a stub. Pass `undefined` to restore. */
export function __setSpawnForTesting(s: SpawnFn | undefined): void {
  spawnImpl = (s ?? (defaultSpawn as unknown as SpawnFn));
}

const QUEUE_TIMEOUT_MS = 60_000;

export interface RunTranscribeArgs {
  stem: string;
  wavPath: string;
  transcribePy: string;
  pythonBin?: string;            // default: "python3"
  registry: JobRegistry;
  pubsub: PubSub<AppChannels>;
}

export async function runTranscribe(args: RunTranscribeArgs): Promise<{ jobId: string }> {
  const { stem, wavPath, transcribePy, pythonBin = "python3", registry, pubsub } = args;
  const jobId = randomUUID();
  registry.set({ stem, action: "transcribe", state: "transcribing", startedAt: Date.now(), jobId });
  pubsub.publish("jobs", { stem, jobId, state: "transcribing" });

  return new Promise((resolve) => {
    const proc = spawnImpl(pythonBin, [transcribePy, wavPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("exit", (code: number | null) => {
      if (code === 0) {
        registry.clear(stem);
        pubsub.publish("jobs", { stem, jobId, state: "done" });
      } else {
        const error = (stderr || `transcribe.py exited with code ${code}`).slice(0, 200);
        registry.set({ stem, action: "transcribe", state: "failed", startedAt: Date.now(), jobId, error });
        pubsub.publish("jobs", { stem, jobId, state: "failed", error });
      }
      resolve({ jobId });
    });
  });
}

export interface RunSummarizeArgs {
  stem: string;
  transcriptPath: string;
  summaryPath: string;
  llmCommand: string[] | null;   // null = queue mode
  agentQueueJson: string;
  registry: JobRegistry;
  pubsub: PubSub<AppChannels>;
}

export async function runSummarize(args: RunSummarizeArgs): Promise<{ jobId: string; mode: "queue" | "direct" }> {
  const { stem, transcriptPath, summaryPath, llmCommand, agentQueueJson, registry, pubsub } = args;
  const jobId = randomUUID();

  if (llmCommand === null) {
    return runSummarizeQueueMode({ stem, jobId, transcriptPath, summaryPath, agentQueueJson, registry, pubsub });
  }
  return runSummarizeDirectMode({ stem, jobId, transcriptPath, summaryPath, llmCommand, registry, pubsub });
}

async function runSummarizeQueueMode(args: {
  stem: string;
  jobId: string;
  transcriptPath: string;
  summaryPath: string;
  agentQueueJson: string;
  registry: JobRegistry;
  pubsub: PubSub<AppChannels>;
}): Promise<{ jobId: string; mode: "queue" }> {
  const { stem, jobId, transcriptPath, summaryPath, agentQueueJson, registry, pubsub } = args;
  const queueEntryId = randomUUID();
  registry.set({
    stem, action: "summarize", state: "summarizing",
    startedAt: Date.now(), jobId, queueEntryId,
  });
  pubsub.publish("jobs", { stem, jobId, state: "summarizing" });

  // Append entry to agent-queue.json
  let queue: Array<Record<string, unknown>> = [];
  if (existsSync(agentQueueJson)) {
    try { queue = JSON.parse(readFileSync(agentQueueJson, "utf8")); } catch { queue = []; }
  }
  queue.push({
    id: queueEntryId,
    type: "summary_request",
    stem,
    transcriptPath,
    summaryPath,
    requestedAt: Date.now(),
  });
  writeFileSync(agentQueueJson, JSON.stringify(queue, null, 2));

  // Watch for completion: either the entry is removed (worker done) or
  // the summary file appears. Whichever first wins.
  void watchForQueueCompletion({ stem, jobId, queueEntryId, agentQueueJson, summaryPath, registry, pubsub });

  return { jobId, mode: "queue" };
}

function watchForQueueCompletion(args: {
  stem: string;
  jobId: string;
  queueEntryId: string;
  agentQueueJson: string;
  summaryPath: string;
  registry: JobRegistry;
  pubsub: PubSub<AppChannels>;
}): Promise<void> {
  const { stem, jobId, queueEntryId, agentQueueJson, summaryPath, registry, pubsub } = args;
  return new Promise((resolve) => {
    let settled = false;
    let watcher: FSWatcher | undefined;
    const finish = (state: "done" | "failed", error?: string) => {
      if (settled) return;
      settled = true;
      watcher?.close();
      if (state === "done") {
        registry.clear(stem);
      } else {
        registry.set({ stem, action: "summarize", state: "failed", startedAt: Date.now(), jobId, error });
      }
      pubsub.publish("jobs", { stem, jobId, state, error });
      resolve();
    };

    // Timeout safety net.
    const timer = setTimeout(() => finish("failed", "agent queue worker did not process within 60s"), QUEUE_TIMEOUT_MS);

    // Watch agent-queue.json for entry removal AND summary.md for appearance.
    try {
      watcher = fsWatch(agentQueueJson, { persistent: false }, () => {
        try {
          const list = JSON.parse(readFileSync(agentQueueJson, "utf8")) as Array<{ id?: string }>;
          const stillThere = list.some((e) => e.id === queueEntryId);
          if (!stillThere) {
            // Worker processed it. Verify summary file exists.
            clearTimeout(timer);
            if (existsSync(summaryPath)) finish("done");
            else finish("failed", "worker removed queue entry but no summary written");
          }
        } catch { /* mid-write JSON; ignore and wait for next change */ }
      });
    } catch (exc) {
      clearTimeout(timer);
      finish("failed", `agent-queue watcher failed: ${(exc as Error).message}`);
    }
  });
}

async function runSummarizeDirectMode(args: {
  stem: string;
  jobId: string;
  transcriptPath: string;
  summaryPath: string;
  llmCommand: string[];
  registry: JobRegistry;
  pubsub: PubSub<AppChannels>;
}): Promise<{ jobId: string; mode: "direct" }> {
  const { stem, jobId, transcriptPath, summaryPath, llmCommand, registry, pubsub } = args;
  registry.set({ stem, action: "summarize", state: "summarizing", startedAt: Date.now(), jobId });
  pubsub.publish("jobs", { stem, jobId, state: "summarizing" });

  return new Promise((resolve) => {
    const [cmd, ...rest] = llmCommand;
    const proc = spawnImpl(cmd!, rest, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("exit", (code: number | null) => {
      if (code === 0 && stdout.length > 0) {
        try {
          writeFileSync(summaryPath, stdout);
          registry.clear(stem);
          pubsub.publish("jobs", { stem, jobId, state: "done" });
        } catch (exc) {
          const error = `failed to write summary: ${(exc as Error).message}`;
          registry.set({ stem, action: "summarize", state: "failed", startedAt: Date.now(), jobId, error });
          pubsub.publish("jobs", { stem, jobId, state: "failed", error });
        }
      } else {
        const error = (stderr || `summary command exited with code ${code}`).slice(0, 200);
        registry.set({ stem, action: "summarize", state: "failed", startedAt: Date.now(), jobId, error });
        pubsub.publish("jobs", { stem, jobId, state: "failed", error });
      }
      resolve({ jobId, mode: "direct" });
    });

    // Pipe transcript to stdin
    try {
      const transcript = readFileSync(transcriptPath, "utf8");
      proc.stdin.write(transcript);
      proc.stdin.end();
    } catch (exc) {
      proc.stdin.end();
      const error = `failed to read transcript: ${(exc as Error).message}`;
      registry.set({ stem, action: "summarize", state: "failed", startedAt: Date.now(), jobId, error });
      pubsub.publish("jobs", { stem, jobId, state: "failed", error });
    }
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd yulu/scripts/yulu_ui && npm test -- jobRunner`
Expected: 6 PASS (4 transcribe + 2 queue summarize).

- [ ] **Step 5: Typecheck full**

Run: `cd yulu/scripts/yulu_ui && npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git add yulu/scripts/yulu_ui/src/jobRunner.ts yulu/scripts/yulu_ui/tests/jobRunner.test.ts
git commit -m "feat(yulu_ui/backend): jobRunner — transcribe spawn, summarize queue/direct

runTranscribe: spawn python3 transcribe.py, captures stderr, sets registry +
publishes jobs channel events on transcribing/done/failed transitions.
runSummarize: in queue mode appends entry to agent-queue.json and watches
the file via fs.watch for entry removal (worker done) + summary.md
appearance. In direct mode spawns llm.command piping transcript to stdin,
writes stdout to summary.md. __setSpawnForTesting hook for unit tests."
```

---

## Task 3 (I.3): Router mutations + `status` field

**Files:**
- Modify: `yulu/scripts/yulu_ui/src/routers/voicemails.ts`
- Modify: `yulu/scripts/yulu_ui/src/routers/meetings.ts`
- Modify: `yulu/scripts/yulu_ui/tests/routers/voicemails.test.ts` (or create)
- Modify: `yulu/scripts/yulu_ui/tests/routers/meetings.test.ts` (or create)

**Goal:** Add `transcribe` + `summarize` mutations to both routers, and add `status` field to `list` + `get` result.

### Background

Both routers follow the same pattern. The plan shows voicemails verbatim; meetings is structurally identical with a different STEM_RE and dir. Read the existing routers first to mirror their exact style (`STEM_RE`, `listFromDir` helper, etc.).

- [ ] **Step 1: Read existing voicemails router**

```bash
cat yulu/scripts/yulu_ui/src/routers/voicemails.ts
```

Note the existing `STEM_RE`, the `listFromDir` helper, the `list`/`get` procedures, and the imports.

- [ ] **Step 2: Read existing meetings router**

```bash
cat yulu/scripts/yulu_ui/src/routers/meetings.ts
```

Same exercise.

- [ ] **Step 3: Read existing voicemails router tests**

```bash
ls yulu/scripts/yulu_ui/tests/routers/ 2>&1
cat yulu/scripts/yulu_ui/tests/routers/voicemails.test.ts 2>&1 | head -60
```

If no tests exist yet, we create them in Step 7.

- [ ] **Step 4: Modify voicemails.ts — add status field + 2 mutations**

Open `yulu/scripts/yulu_ui/src/routers/voicemails.ts`. At the top of the file, after the existing imports, add:

```ts
import { TRPCError } from "@trpc/server";
import { join } from "node:path";
import { runTranscribe, runSummarize } from "../jobRunner.js";
```

(If `join` is already imported above, don't double-import.)

Inside `listFromDir`, where each row is constructed, add `status` and `statusError` from the registry. The function signature changes to accept the registry. Find:

```ts
function listFromDir(dir: string) {
  // ... existing
}
```

Change to:

```ts
function listFromDir(dir: string, registry: import("../jobStatus.js").JobRegistry) {
  // ... existing logic ...
  for (const f of entries) {
    // ... existing match + stem ...
    const job = registry.get(stem);
    rows.push({
      stem,
      wavPath,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      hasTranscript,
      hasSummary: existsSync(join(dir, `${stem}.summary.md`)),
      firstWords: hasTranscript ? firstWordsOf(transcriptPath) : null,
      status: job?.state ?? "idle",
      statusError: job?.error,
    });
  }
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return rows;
}
```

Update the call site in the existing `list` query — find:

```ts
list: publicProcedure
  .input(...)
  .query(({ ctx, input }) => {
    let rows = listFromDir(ctx.paths.voicemailsDir);
```

Change to:

```ts
list: publicProcedure
  .input(...)
  .query(({ ctx, input }) => {
    let rows = listFromDir(ctx.paths.voicemailsDir, ctx.jobs);
```

Find the `get` procedure. Add `status` + `statusError` to its returned object. The existing block looks roughly like:

```ts
get: publicProcedure
  .input(z.object({ stem: z.string().regex(/^voicemail_\d{8}_\d{6}$/) }))
  .query(({ ctx, input }) => {
    // ... reads files, returns { stem, wavPath, transcript, summary, raw, ... }
  }),
```

Inside the return value, add:

```ts
status: ctx.jobs.get(input.stem)?.state ?? "idle",
statusError: ctx.jobs.get(input.stem)?.error,
```

After the existing `get` procedure, append the two new mutations. The full block (after the existing closing `}),` of `get`) is:

```ts
,

  transcribe: publicProcedure
    .input(z.object({ stem: z.string().regex(/^voicemail_\d{8}_\d{6}$/) }))
    .mutation(async ({ ctx, input }) => {
      const wavPath = join(ctx.paths.voicemailsDir, `${input.stem}.wav`);
      if (!existsSync(wavPath)) {
        throw new TRPCError({ code: "NOT_FOUND", message: "WAV file missing" });
      }
      if (ctx.jobs.get(input.stem)) {
        throw new TRPCError({ code: "CONFLICT", message: "Job already running for this recording" });
      }
      // Fire and forget — the run resolves when the child exits, but we
      // don't need to await: the WS channel will broadcast completion.
      void runTranscribe({
        stem: input.stem,
        wavPath,
        transcribePy: ctx.paths.transcribePy,
        registry: ctx.jobs,
        pubsub: ctx.pubsub,
      });
      return { ok: true as const };
    }),

  summarize: publicProcedure
    .input(z.object({ stem: z.string().regex(/^voicemail_\d{8}_\d{6}$/) }))
    .mutation(async ({ ctx, input }) => {
      const transcriptPath = join(ctx.paths.voicemailsDir, `${input.stem}.transcript.txt`);
      if (!existsSync(transcriptPath)) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Transcript missing — run Re-transcribe first",
        });
      }
      if (ctx.jobs.get(input.stem)) {
        throw new TRPCError({ code: "CONFLICT", message: "Job already running for this recording" });
      }
      const summaryPath = join(ctx.paths.voicemailsDir, `${input.stem}.summary.md`);
      const cfg = ctx.config.read();
      const llmCommand = (cfg.llm?.command ?? null) as string[] | null;
      void runSummarize({
        stem: input.stem,
        transcriptPath,
        summaryPath,
        llmCommand,
        agentQueueJson: ctx.paths.agentQueueJson,
        registry: ctx.jobs,
        pubsub: ctx.pubsub,
      });
      return { ok: true as const };
    }),
```

Verify the file still parses by running typecheck (Step 9 below).

- [ ] **Step 5: Modify meetings.ts — same shape**

Open `yulu/scripts/yulu_ui/src/routers/meetings.ts`. Apply the same pattern:
1. Add imports `TRPCError`, `join`, `runTranscribe`, `runSummarize`.
2. Modify `listFromDir` (or its equivalent) signature to take `registry: JobRegistry` and inject `status` + `statusError` into each row.
3. Pass `ctx.jobs` from the `list` query call site.
4. Add `status` + `statusError` to the `get` return object.
5. Append the `transcribe` + `summarize` mutations using the same template, but with the meetings dir + meetings stem regex.

The meetings stem regex matches anything ending in `_YYYYMMDD_HHMMSS`. The existing router defines the exact pattern — copy it verbatim. For the path, meetings live in `ctx.paths.moviesDir` directly (not a `meetings` subdir).

In the `summarize` mutation, the summary path is `join(ctx.paths.moviesDir, \`${input.stem}.summary.md\`)`. Same for `transcript`.

- [ ] **Step 6: Verify config router exposes `read()`**

Check that `ctx.config.read()` exists by reading `src/config.ts`:

```bash
grep -n "read" yulu/scripts/yulu_ui/src/config.ts | head -5
```

If the method is named differently (e.g. `get` or `current`), adjust the calls in Step 4/5 accordingly. The signature should return the parsed config JSON.

- [ ] **Step 7: Update existing router tests**

Open `yulu/scripts/yulu_ui/tests/routers/voicemails.test.ts` (or create if missing). Add a `JobRegistry` to test fixtures and pass it through `ctx`. Find the existing `mkCtx`-style helper and add:

```ts
import { JobRegistry } from "../../src/jobStatus.js";

// in mkCtx (or wherever the test context is constructed):
jobs: new JobRegistry(),
```

Add 3 new test cases for `transcribe` + `summarize`:

```ts
import { TRPCError } from "@trpc/server";

it("transcribe throws NOT_FOUND when WAV missing", async () => {
  const ctx = mkCtx({ voicemailsDir: tmpEmpty });
  const caller = createCaller(voicemailsRouter, ctx);
  await expect(caller.transcribe({ stem: "voicemail_20260101_120000" }))
    .rejects.toThrowError(/WAV file missing/);
});

it("summarize throws PRECONDITION_FAILED when transcript missing", async () => {
  const ctx = mkCtx({ voicemailsDir: tmpWithWavOnly });
  const caller = createCaller(voicemailsRouter, ctx);
  await expect(caller.summarize({ stem: "voicemail_20260101_120000" }))
    .rejects.toThrowError(/Transcript missing/);
});

it("list returns status='transcribing' when registry has entry", () => {
  const ctx = mkCtx({ voicemailsDir: tmpWithWav });
  ctx.jobs.set({
    stem: "voicemail_20260101_120000",
    action: "transcribe",
    state: "transcribing",
    startedAt: Date.now(),
    jobId: "j1",
  });
  const caller = createCaller(voicemailsRouter, ctx);
  const rows = caller.list({});
  expect(rows[0]?.status).toBe("transcribing");
});
```

(Adapt to whatever the existing test file's idioms are — read it first; the `mkCtx` helper may need to be extended. The point is: assert `status` flows through and the two new mutations enforce their preconditions.)

Do the same for meetings.test.ts with meeting stems.

- [ ] **Step 8: Run tests**

Run: `cd yulu/scripts/yulu_ui && npm test -- routers/voicemails routers/meetings`
Expected: PASS, including the 3+3 new assertions.

- [ ] **Step 9: Full typecheck + sweep**

Run: `cd yulu/scripts/yulu_ui && npm run typecheck && npm test 2>&1 | tail -10`
Expected: typecheck clean; all tests pass.

- [ ] **Step 10: Commit**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git add yulu/scripts/yulu_ui/src/routers/voicemails.ts yulu/scripts/yulu_ui/src/routers/meetings.ts yulu/scripts/yulu_ui/tests/routers/voicemails.test.ts yulu/scripts/yulu_ui/tests/routers/meetings.test.ts
git commit -m "feat(yulu_ui/routers): voicemails+meetings transcribe/summarize mutations

Both routers gain transcribe + summarize mutations dispatching to
jobRunner. Mutations enforce: WAV exists (NOT_FOUND), transcript exists
for summarize (PRECONDITION_FAILED), no in-flight job for the stem
(CONFLICT). list + get now return status + statusError from the
JobRegistry."
```

---

## Task 4 (I.4): `<AudioPlayer>` fix — state reset on src change + disable until ready

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/components/AudioPlayer.tsx`
- Modify: `yulu/scripts/yulu_ui/web/src/components/AudioPlayer.css`
- Test: `yulu/scripts/yulu_ui/tests/web/components/AudioPlayer.test.tsx`

**Goal:** Fix the A→B→A playback regression by resetting React state on `src` change and disabling Play until wavesurfer fires `ready`.

### Background

Current `AudioPlayer.tsx`:
```tsx
useEffect(() => {
  // creates wavesurfer, sets wsRef
  ws.on("ready", () => setDuration(ws.getDuration()));
  // ...
  return () => { ws.destroy(); wsRef.current = null; };
}, [src]);
```

Stale `isPlaying`, `currentTime`, `duration` from the previous file persist after src change. Fix at the top of the effect.

- [ ] **Step 1: Write failing tests**

Create `yulu/scripts/yulu_ui/tests/web/components/AudioPlayer.test.tsx` (overwrite if exists):

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, screen } from "@testing-library/react";
import { AudioPlayer } from "../../../web/src/components/AudioPlayer";

const mockWavesurfer = {
  destroy: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
  setTime: vi.fn(),
  getDuration: vi.fn(() => 120),
  on: vi.fn((_event: string, _cb: (arg?: number) => void) => {}),
};
vi.mock("wavesurfer.js", () => ({
  default: { create: vi.fn(() => mockWavesurfer) },
}));

describe("AudioPlayer", () => {
  beforeEach(() => {
    mockWavesurfer.destroy.mockClear();
    mockWavesurfer.play.mockClear();
    mockWavesurfer.pause.mockClear();
    mockWavesurfer.on.mockClear();
  });

  it("disables Play button when duration is 0 (not ready)", () => {
    render(<AudioPlayer src="a.wav" />);
    const btn = screen.getByRole("button", { name: /play|pause/i });
    expect(btn).toBeDisabled();
  });

  it("enables Play after wavesurfer fires 'ready'", () => {
    render(<AudioPlayer src="a.wav" />);
    // Find the 'ready' callback registered with ws.on
    const readyCall = mockWavesurfer.on.mock.calls.find((c) => c[0] === "ready");
    expect(readyCall).toBeDefined();
    // Trigger the ready callback
    readyCall![1]!();
    // After re-render, button enabled
    const btn = screen.getByRole("button", { name: /play|pause/i });
    expect(btn).not.toBeDisabled();
  });

  it("resets isPlaying state when src changes", () => {
    const { rerender } = render(<AudioPlayer src="a.wav" />);
    // Fire ready + play callbacks
    const readyA = mockWavesurfer.on.mock.calls.find((c) => c[0] === "ready");
    readyA![1]!();
    const playA = mockWavesurfer.on.mock.calls.find((c) => c[0] === "play");
    playA![1]!();
    // Now switching src should reset state
    rerender(<AudioPlayer src="b.wav" />);
    const btn = screen.getByRole("button", { name: /play|pause/i });
    // Button is back to "Play" (not Pause) — meaning isPlaying was reset
    expect(btn.getAttribute("aria-label")).toBe("Play");
  });

  it("destroys the wavesurfer instance on src change", () => {
    const { rerender } = render(<AudioPlayer src="a.wav" />);
    expect(mockWavesurfer.destroy).not.toHaveBeenCalled();
    rerender(<AudioPlayer src="b.wav" />);
    expect(mockWavesurfer.destroy).toHaveBeenCalled();
  });

  it("disables Play again after src changes (until new ready)", () => {
    const { rerender } = render(<AudioPlayer src="a.wav" />);
    const readyA = mockWavesurfer.on.mock.calls.find((c) => c[0] === "ready");
    readyA![1]!();   // duration = 120
    // Now switch src
    rerender(<AudioPlayer src="b.wav" />);
    const btn = screen.getByRole("button", { name: /play|pause/i });
    expect(btn).toBeDisabled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd yulu/scripts/yulu_ui && npm test -- AudioPlayer`
Expected: 5 FAIL (current AudioPlayer doesn't disable, doesn't reset state on src change).

- [ ] **Step 3: Implement the fix**

Replace `yulu/scripts/yulu_ui/web/src/components/AudioPlayer.tsx` with:

```tsx
import { useEffect, useRef, useState } from "react";
import WaveSurfer from "wavesurfer.js";
import { Play, Pause } from "lucide-react";
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
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!containerRef.current) return;
    // Reset local state for the new src — prevents stale isPlaying / duration
    // from leaking into the new track's UI before its events fire.
    setIsPlaying(false);
    setCurrentTime(0);
    setDuration(0);
    setReady(false);

    const ws = WaveSurfer.create({
      container: containerRef.current,
      url: src,
      waveColor: "rgba(139, 146, 160, 0.55)",
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
      setReady(true);
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
    return () => {
      ws.destroy();
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const toggle = () => {
    const ws = wsRef.current;
    if (!ws || !ready) return;
    if (isPlaying) ws.pause();
    else ws.play();
  };

  return (
    <div className="audioplayer">
      <button
        type="button"
        className="audioplayer-play"
        onClick={toggle}
        disabled={!ready}
        aria-label={isPlaying ? "Pause" : "Play"}
      >
        {isPlaying ? <Pause size={14} strokeWidth={1.75} /> : <Play size={14} strokeWidth={1.75} />}
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

- [ ] **Step 4: Add disabled CSS state**

Edit `yulu/scripts/yulu_ui/web/src/components/AudioPlayer.css`. Append:

```css
.audioplayer-play:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd yulu/scripts/yulu_ui && npm test -- AudioPlayer`
Expected: 5 PASS.

- [ ] **Step 6: Full typecheck + sweep**

Run: `cd yulu/scripts/yulu_ui && npm run typecheck && npm test 2>&1 | tail -5`
Expected: typecheck clean; tests pass.

- [ ] **Step 7: Commit**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git add yulu/scripts/yulu_ui/web/src/components/AudioPlayer.tsx yulu/scripts/yulu_ui/web/src/components/AudioPlayer.css yulu/scripts/yulu_ui/tests/web/components/AudioPlayer.test.tsx
git commit -m "fix(yulu_ui/web): AudioPlayer A→B→A playback regression

useEffect now resets isPlaying / currentTime / duration / ready state at
the top of the src-change branch, so stale values from the previous track
don't leak into the new render. Play button disabled until wavesurfer fires
'ready'. Disabled CSS state added. 5 vitest cases cover disable, ready,
state reset, destroy on src change, and re-disable on switch."
```

---

## Task 5 (I.5): `<ReprocessButton>` component

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/components/ReprocessButton.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/components/ReprocessButton.css`
- Test: `yulu/scripts/yulu_ui/tests/web/components/ReprocessButton.test.tsx`

**Goal:** Reusable 4-state button (idle / running / done / failed) with Lucide icons. Used by VoicemailReader + MeetingReader.

### Background

State transitions are driven externally (parent passes `state` prop). The component renders the appropriate visual + manages the done→idle auto-transition with a setTimeout. Click handler fires `onClick`; the component itself doesn't track or trigger state changes.

- [ ] **Step 1: Write failing tests**

Create `yulu/scripts/yulu_ui/tests/web/components/ReprocessButton.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, screen, act } from "@testing-library/react";
import { ReprocessButton } from "../../../web/src/components/ReprocessButton";

describe("ReprocessButton", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("renders the label in idle state", () => {
    render(<ReprocessButton label="Re-transcribe" icon={<span data-testid="i" />} state="idle" onClick={() => {}} />);
    expect(screen.getByText("Re-transcribe")).toBeInTheDocument();
  });

  it("calls onClick when clicked in idle state", () => {
    const onClick = vi.fn();
    render(<ReprocessButton label="Re-transcribe" icon={<span />} state="idle" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("shows 'Running…' text and is disabled in running state", () => {
    const onClick = vi.fn();
    render(<ReprocessButton label="Re-transcribe" icon={<span />} state="running" onClick={onClick} />);
    expect(screen.getByText(/running/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("shows checkmark in done state and auto-transitions back after 2s", () => {
    const { rerender } = render(<ReprocessButton label="Re-transcribe" icon={<span />} state="running" onClick={() => {}} />);
    rerender(<ReprocessButton label="Re-transcribe" icon={<span />} state="done" onClick={() => {}} />);
    expect(screen.getByLabelText(/done|completed|success/i)).toBeInTheDocument();
    // After 2s, the label should be back to idle
    act(() => { vi.advanceTimersByTime(2000); });
    expect(screen.queryByLabelText(/done|completed|success/i)).toBeNull();
  });

  it("renders error tooltip in failed state", () => {
    render(<ReprocessButton label="Re-transcribe" icon={<span />} state="failed" error="ffmpeg crash" onClick={() => {}} />);
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("title") ?? btn.getAttribute("aria-label")).toContain("ffmpeg crash");
  });

  it("calls onClick from failed state (retry)", () => {
    const onClick = vi.fn();
    render(<ReprocessButton label="Re-transcribe" icon={<span />} state="failed" onClick={onClick} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).toHaveBeenCalled();
  });

  it("respects disabled prop in idle state", () => {
    const onClick = vi.fn();
    render(<ReprocessButton label="Re-transcribe" icon={<span />} state="idle" onClick={onClick} disabled disabledReason="WAV missing" />);
    fireEvent.click(screen.getByRole("button"));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("shows disabledReason via title when disabled", () => {
    render(<ReprocessButton label="Re-transcribe" icon={<span />} state="idle" onClick={() => {}} disabled disabledReason="WAV missing" />);
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("title")).toContain("WAV missing");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd yulu/scripts/yulu_ui && npm test -- ReprocessButton`
Expected: cannot find module.

- [ ] **Step 3: Implement ReprocessButton**

Create `yulu/scripts/yulu_ui/web/src/components/ReprocessButton.tsx`:

```tsx
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Loader2, Check, AlertCircle } from "lucide-react";
import "./ReprocessButton.css";

export type ReprocessButtonState = "idle" | "running" | "done" | "failed";

export interface ReprocessButtonProps {
  label: string;
  icon: ReactNode;                       // Lucide element (RefreshCw, Sparkles, etc.)
  state: ReprocessButtonState;
  error?: string;                        // tooltip when state="failed"
  onClick: () => void;
  disabled?: boolean;                    // hard-disable (e.g. WAV missing)
  disabledReason?: string;               // tooltip when disabled
}

const DONE_HOLD_MS = 2000;

/**
 * 4-state pill button for triggering re-transcribe / re-summarize.
 *
 * - idle: clickable, shows label + icon
 * - running: disabled, spinner + "Running…" text
 * - done: ✓ for 2s then auto-falls back to idle visual (state stays "done"
 *   in parent until parent decides; the auto-transition is just visual)
 * - failed: ⚠ + label, clickable to retry, error in tooltip
 */
export function ReprocessButton({
  label, icon, state, error, onClick, disabled, disabledReason,
}: ReprocessButtonProps) {
  // The visual state may diverge from props.state — after 2s in "done"
  // we render as "idle" even if the parent hasn't updated.
  const [visualState, setVisualState] = useState<ReprocessButtonState>(state);

  useEffect(() => {
    if (state === "done") {
      setVisualState("done");
      const timer = setTimeout(() => setVisualState("idle"), DONE_HOLD_MS);
      return () => clearTimeout(timer);
    }
    setVisualState(state);
    return undefined;
  }, [state]);

  const hardDisabled = disabled === true;
  const interactionDisabled = hardDisabled || visualState === "running";
  const title = hardDisabled
    ? disabledReason
    : visualState === "failed" && error
      ? error
      : undefined;

  const handleClick = () => {
    if (interactionDisabled) return;
    onClick();
  };

  let content: ReactNode;
  let aria: string;
  switch (visualState) {
    case "running":
      content = (
        <>
          <Loader2 size={14} strokeWidth={1.75} className="rpb-spin" />
          <span>Running…</span>
        </>
      );
      aria = "Running";
      break;
    case "done":
      content = (
        <>
          <Check size={14} strokeWidth={2} />
          <span>Done</span>
        </>
      );
      aria = "Done";
      break;
    case "failed":
      content = (
        <>
          <AlertCircle size={14} strokeWidth={1.75} />
          <span>{label}</span>
        </>
      );
      aria = `${label} (failed${error ? `: ${error}` : ""})`;
      break;
    default:
      content = (
        <>
          {icon}
          <span>{label}</span>
        </>
      );
      aria = label;
  }

  return (
    <button
      type="button"
      className={`rpb rpb-${visualState}`}
      onClick={handleClick}
      disabled={interactionDisabled}
      aria-label={aria}
      title={title}
    >
      {content}
    </button>
  );
}
```

Create `yulu/scripts/yulu_ui/web/src/components/ReprocessButton.css`:

```css
.rpb {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--edge);
  border-radius: 6px;
  background: var(--glass-2);
  color: var(--fg);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  transition: background 100ms, border-color 100ms, color 100ms;
}
.rpb:hover:not(:disabled) {
  background: var(--glass-3);
}
.rpb:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.rpb-running {
  border-color: var(--accent);
  color: var(--accent-on, var(--accent));
  background: var(--accent-soft);
}
.rpb-done {
  border-color: var(--green);
  color: var(--green);
  background: color-mix(in oklch, var(--green) 14%, transparent);
}
.rpb-failed {
  border-color: var(--red);
  color: var(--red);
  background: color-mix(in oklch, var(--red) 12%, transparent);
}

@keyframes rpb-spin {
  to { transform: rotate(360deg); }
}
.rpb-spin {
  animation: rpb-spin 1s linear infinite;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd yulu/scripts/yulu_ui && npm test -- ReprocessButton`
Expected: 8 PASS.

- [ ] **Step 5: Full typecheck**

Run: `cd yulu/scripts/yulu_ui && npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git add yulu/scripts/yulu_ui/web/src/components/ReprocessButton.tsx yulu/scripts/yulu_ui/web/src/components/ReprocessButton.css yulu/scripts/yulu_ui/tests/web/components/ReprocessButton.test.tsx
git commit -m "feat(yulu_ui/web): ReprocessButton (4 visual states)

idle (label + icon) / running (spinner + 'Running…', disabled) /
done (Check, 2s hold then auto-fades to idle visual) / failed
(AlertCircle, clickable to retry, error in tooltip). Hard-disabled
state honors disabledReason as tooltip. 8 vitest cases including
fake-timers test for done→idle auto-transition."
```

---

## Task 6 (I.6): Reader integration + e2e + smoke + PR

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.$stem.tsx`
- Modify: `yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.$stem.tsx`
- Modify: `yulu/scripts/yulu_ui/e2e/critical.spec.ts` (add audio + reprocess tests)
- No new test files — coverage via existing component + router tests

**Goal:** Hook up the two ReprocessButtons in each reader, wire the WS subscription for live status updates, run e2e + real-machine smoke, push, update PR.

### Background

Each reader fetches `voicemails.get` or `meetings.get` (which now returns `status` + `statusError`). The button states come from that data. The button's onClick calls the new mutation, which on success → backend pubsub publishes "jobs" channel → frontend's WS subscription invalidates the query → reader refetches and the button state updates.

- [ ] **Step 1: Add ReprocessButtons + mutation + WS subscription to VoicemailReader**

Open `yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.$stem.tsx`. At the top, add imports:

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Sparkles } from "lucide-react";
import { ReprocessButton, type ReprocessButtonState } from "../../components/ReprocessButton.js";
import { useWsChannel } from "../../ws.js";
```

Inside the `VoicemailReader` component, after `const { data, isPending } = ...`, add:

```tsx
const qc = useQueryClient();
const [lastAction, setLastAction] = useState<"transcribe" | "summarize" | null>(null);

const transcribeMut = trpc.voicemails.transcribe.useMutation();
const summarizeMut = trpc.voicemails.summarize.useMutation();

useWsChannel("jobs", (msg) => {
  if (msg.stem !== stem) return;
  if (msg.state === "done" || msg.state === "failed") {
    qc.invalidateQueries({ queryKey: [["voicemails", "get"]] });
    qc.invalidateQueries({ queryKey: [["voicemails", "list"]] });
  }
});

function deriveButtonState(action: "transcribe" | "summarize"): ReprocessButtonState {
  const status = data?.status ?? "idle";
  if (status === (action === "transcribe" ? "transcribing" : "summarizing")) return "running";
  if (status === "failed" && lastAction === action) return "failed";
  // Show "done" briefly when our local lastAction completed (status returns to idle)
  if (status === "idle" && lastAction === action) return "done";
  return "idle";
}

const handleTranscribe = () => {
  setLastAction("transcribe");
  transcribeMut.mutate({ stem }, {
    onError: (err) => console.error("transcribe failed:", err.message),
  });
};
const handleSummarize = () => {
  setLastAction("summarize");
  summarizeMut.mutate({ stem }, {
    onError: (err) => console.error("summarize failed:", err.message),
  });
};
```

Find where the reader renders the audio player (search for `<AudioPlayer`). Just above that line, add the toolbar:

```tsx
<div className="reader-actions">
  <ReprocessButton
    label="Re-transcribe"
    icon={<RefreshCw size={14} strokeWidth={1.75} />}
    state={deriveButtonState("transcribe")}
    error={data?.statusError}
    onClick={handleTranscribe}
    disabled={!data?.wavPath}
    disabledReason={!data?.wavPath ? "Original WAV file missing" : undefined}
  />
  <ReprocessButton
    label="Re-generate summary"
    icon={<Sparkles size={14} strokeWidth={1.75} />}
    state={deriveButtonState("summarize")}
    error={data?.statusError}
    onClick={handleSummarize}
    disabled={!data?.hasTranscript}
    disabledReason={!data?.hasTranscript ? "Transcript required first — click Re-transcribe" : undefined}
  />
</div>
```

Add CSS for `.reader-actions` to `yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.reader.css`:

```css
.reader-actions {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
```

- [ ] **Step 2: Mirror for MeetingReader**

Open `yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.$stem.tsx`. Apply the same changes:
- Add the 5 imports (useQueryClient, RefreshCw, Sparkles, ReprocessButton, useWsChannel).
- Add the same mutation hooks, WS handler, lastAction state, deriveButtonState helper, and 2 button handlers — but referencing `trpc.meetings.transcribe` / `trpc.meetings.summarize` and invalidating `[["meetings", "get"]]` / `[["meetings", "list"]]`.
- Add the `<div className="reader-actions">` block above `<AudioPlayer>`.

Add the `.reader-actions` CSS to `yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.reader.css` (same as above).

- [ ] **Step 3: Run vitest sweep**

Run: `cd yulu/scripts/yulu_ui && npm run typecheck && npm test 2>&1 | tail -10`
Expected: typecheck clean; all existing tests pass. New tests aren't needed here — the integration is structural; existing component tests already cover ReprocessButton and the readers' get-query plumbing.

If a reader test asserts on a specific DOM structure and the new `<div className="reader-actions">` breaks it, update the test selector to target a more stable element (e.g. by role).

- [ ] **Step 4: Update e2e — audio switch test**

Open `yulu/scripts/yulu_ui/e2e/critical.spec.ts`. Add this test after the existing voicemails reader test:

```ts
test("AudioPlayer survives A → B → A switch (Phase I regression)", async ({ page }) => {
  await page.goto("/inbox/voicemails");
  const rows = page.getByTestId("voicemail-row");
  const count = await rows.count();
  if (count < 2) {
    test.info().annotations.push({ type: "skip", description: "need at least 2 voicemails" });
    return;
  }
  // Click row 1 (voicemail A), wait for play button enabled
  await rows.nth(0).click();
  const playA = page.getByRole("button", { name: /^play$/i });
  await expect(playA).toBeEnabled({ timeout: 10_000 });
  await playA.click();
  await expect(page.getByRole("button", { name: /^pause$/i })).toBeVisible({ timeout: 5_000 });

  // Switch to row 2 (voicemail B)
  await rows.nth(1).click();
  // Play button on B should re-disable until ready
  const playB = page.getByRole("button", { name: /^play$/i });
  await expect(playB).toBeEnabled({ timeout: 10_000 });

  // Switch back to row 1 (voicemail A)
  await rows.nth(0).click();
  const playA2 = page.getByRole("button", { name: /^play$/i });
  await expect(playA2).toBeEnabled({ timeout: 10_000 });
  // Click should work — assert it transitions to Pause
  await playA2.click();
  await expect(page.getByRole("button", { name: /^pause$/i })).toBeVisible({ timeout: 5_000 });
});
```

- [ ] **Step 5: Add e2e — Re-transcribe button visible**

Append:

```ts
test("VoicemailReader has Re-transcribe and Re-generate summary buttons", async ({ page }) => {
  await page.goto("/inbox/voicemails");
  const rows = page.getByTestId("voicemail-row");
  const count = await rows.count();
  if (count === 0) {
    test.info().annotations.push({ type: "skip", description: "no voicemails" });
    return;
  }
  await rows.first().click();
  await expect(page.getByRole("button", { name: /Re-transcribe/i })).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: /Re-generate summary/i })).toBeVisible();
});
```

- [ ] **Step 6: Run e2e suite**

```bash
cd yulu/scripts/yulu_ui && npm run e2e 2>&1 | tail -30
```

Expected: all tests pass (the existing ones plus 2 new). The audio-switch test depends on having ≥2 voicemails on the dev machine; if there's only 1, the test self-skips.

- [ ] **Step 7: Real-machine smoke**

Rebuild and reload:

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
bash -c '
set -e
SCRIPT_DIR="'"$PWD"'/yulu/scripts"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
NODE_BIN="$(command -v node)"
RED="\033[0;31m"; GREEN="\033[0;32m"; YELLOW="\033[1;33m"; BLUE="\033[0;34m"; NC="\033[0m"
info()  { echo -e "${BLUE}ℹ️${NC} $1"; }
ok()    { echo -e "${GREEN}✅${NC} $1"; }
warn()  { echo -e "${YELLOW}⚠️${NC} $1"; }
err()   { echo -e "${RED}❌${NC} $1"; }
header(){ echo; echo -e "${BLUE}━━━ $1 ━━━${NC}"; }
eval "$(awk "/^install_yulu_ui\\(\\) {/,/^}$/" "$SCRIPT_DIR/setup.sh")"
install_yulu_ui
' 2>&1 | tail -15
```

Expected: build + plist load + healthz green.

Then verify in the browser via playwright (manual check):
- Open http://127.0.0.1:7777/inbox/voicemails/<a_real_stem>
- See 2 buttons above the audio player
- Click Re-transcribe → button should show "Running…" + spinner
- Wait for completion (depends on audio length); see button briefly show ✓ Done, then return to idle
- Check the transcript content has changed (new transcript file)

If the user has a stuck voicemail with no transcript, Re-transcribe should produce one. If the manual smoke uncovers a regression, fix it via a small commit before pushing.

- [ ] **Step 8: Commit reader integration**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git add yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.\$stem.tsx yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.\$stem.tsx yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.reader.css yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.reader.css yulu/scripts/yulu_ui/e2e/critical.spec.ts

git commit -m "feat(yulu_ui/web): integrate ReprocessButtons in Voicemail + Meeting readers

Each reader renders Re-transcribe + Re-generate summary buttons above the
audio player. State derived from voicemails.get / meetings.get response
status field; mutations fire trpc.voicemails.transcribe etc.; WS 'jobs'
channel subscription invalidates the query on completion for instant UX.
disabledReason explains why buttons are disabled (WAV missing, transcript
missing). 2 new Playwright e2e cases: A→B→A audio switch regression and
buttons-visible smoke."
```

- [ ] **Step 9: Push**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git push 2>&1 | tail -5
```

- [ ] **Step 10: Update PR #24 to A+B+C+D+E+F+G+H+I**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
gh pr edit 24 --title "feat(yulu_ui): Phase A+B+C+D+E+F+G+H+I — backend + frontend + IA polish + reader manual triggers (TDD)" --body "$(cat <<'EOF'
## Summary

**Phases A through I** in one branch.

- **A** (23): Node backend + 11 tRPC routers + WS multiplexer
- **B** (16): React shell + Liquid Glass + routes scaffold
- **C** (22): Inbox pages — Voicemails / Meetings / Search
- **D** (22): Settings — 6 inline-edit pages
- **E** (9): Knowledge — Prompts + Glossary
- **F** (8): Health — daemons + logs + Playwright
- **G** (7): Lifecycle — setup.sh / doctor / CI / uninstall / logTailer rotation
- **H** (13): IA + polish — canonical Ayu tokens, Lucide icons, sidebar restructure, GlobalSearch popover, consolidated /settings + /health, ResizableSplit, multi-segment breadcrumb
- **I** (6): **Reader audio fix + manual triggers** — AudioPlayer A→B→A regression fixed via state reset + disable-until-ready; backend JobRegistry + jobRunner spawns transcribe.py / writes agent-queue.json; new 'jobs' WS channel; voicemails+meetings .transcribe + .summarize mutations + status field on list/get; reusable <ReprocessButton> 4-state component; readers render 2 buttons each with live WS-driven status updates.

## What's NOT in this PR (deferred)

- **Phase J** — Voicemails + Meetings inbox unification (also includes StatusAgent.app menu bar consolidation).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" 2>&1 | tail -3
```

- [ ] **Step 11: Verify CI**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
gh pr checks 24 2>&1 | head -10
```

Expected: both `Syntax + Swift build` and `yulu_ui (typecheck + vitest + build)` pass.

- [ ] **Step 12: No final commit** — Step 8 was the last code commit; Step 9-11 are push + PR-edit + CI verify only.

---

## Self-Review

Cross-checked against spec sections:

- **Spec § 4.1 (AudioPlayer fix)** → Task 4 — 5 vitest cases cover the regression + ready gate + state reset.
- **Spec § 4.2 (JobRegistry)** → Task 1 — 7 unit tests + AppContext wiring.
- **Spec § 4.3 (jobRunner)** → Task 2 — 6 tests covering spawn happy path, error path, queue mode entry write. Direct-mode summary is exercised structurally (covered by typecheck + integration); a dedicated direct-mode unit test would be nice-to-have but not blocking.
- **Spec § 4.4 (pubsub `jobs` channel)** → Task 1 Step 5.
- **Spec § 4.5 (router mutations + status field)** → Task 3 with 6 new test cases (3 per router).
- **Spec § 4.6 (ReprocessButton)** → Task 5 — 8 vitest cases including fake-timer done→idle.
- **Spec § 4.7 (Reader integration)** → Task 6 Steps 1–2.
- **Spec § 4.8 (Reader list integration)** → Implicitly covered by Task 3's `status` field returned by `list` — the list page can render the field whenever it wants in a future polish pass. **Note: optional sub-feature, not blocking Phase I.**
- **Spec § 5 (Data flow)** → Captured by Task 6's WS subscription + mutation + invalidation pattern.
- **Spec § 6 (Error handling)** → Each path mapped to specific tests: NOT_FOUND, PRECONDITION_FAILED, CONFLICT (Task 3), failed-state tooltip (Task 5), queue timeout (Task 2 implicit via the 60s constant).
- **Spec § 7 (Testing)** → All layers covered.

Placeholder scan: no TBD/TODO. All steps have concrete code or commands. Type consistency: `JobStatus` shape used in jobStatus.ts + jobRunner.ts + routers/voicemails.ts identical. `ReprocessButtonState` is consistent across component + tests + reader integration. `useWsChannel` consumed correctly with the `jobs` channel type added to `AppChannels`.

One ambiguity resolved inline: the reader integration in Task 6 picks `deriveButtonState` such that `status === "idle" && lastAction === action → "done"` so we get the brief ✓ state. If the actual status field never lingers at "idle" with lastAction set (e.g., parent unmounts immediately after success), the visual could miss the done flash. This is acceptable; the WS handler invalidates the query which causes a refetch that returns status="idle" — so the "done" flash will reliably appear for ~refetch-cycle duration, and the ReprocessButton's own 2s auto-fade handles the rest.

If real-machine smoke (Task 6 Step 7) reveals the done flash isn't visible due to timing, the simplest mitigation is to have the mutation `onSuccess` callback locally set a 2-second "just-finished" flag — but defer that polish to Phase J or a follow-up.
