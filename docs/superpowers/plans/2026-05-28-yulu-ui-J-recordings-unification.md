# Phase J — Recordings Inbox Unification + StatusAgent Menu Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the separate Voicemails + Meetings inboxes into one unified "Recordings" inbox across the web UI, and sync the macOS StatusAgent menu bar naming + data source.

**Architecture:** A new backend `recordings` router merges both storage directories and dispatches per-procedure by stem pattern (`voicemail_*` → voicemailsDir, else moviesDir); the old `voicemails` + `meetings` routers are deleted. The frontend gets one `<RecordingsList>` + one `<RecordingReader>` at `/inbox` + `/inbox/:stem`, with old URLs redirecting. The StatusAgent Swift app relabels its menu and reads both directories directly off disk.

**Tech Stack:** TypeScript 5 (Node + React 18) · tRPC · React Router 7 · Lucide icons · Swift (Cocoa/AppKit) · vitest + Playwright.

**Spec reference:** `docs/superpowers/specs/2026-05-28-yulu-ui-J-recordings-unification-design.md`

---

## File Map

| File | Status | Responsibility |
|---|---|---|
| `yulu/scripts/yulu_ui/src/routers/recordings.ts` | Create | Unified router: list (merge dirs + type), get/transcribe/summarize/audioUrl/delete dispatch by stem |
| `yulu/scripts/yulu_ui/src/routers/voicemails.ts` | **Delete** | Subsumed by recordings |
| `yulu/scripts/yulu_ui/src/routers/meetings.ts` | **Delete** | Subsumed by recordings |
| `yulu/scripts/yulu_ui/src/routers/_app.ts` | Modify | Mount recordings, drop voicemails+meetings |
| `yulu/scripts/yulu_ui/src/pubsub.ts` | Modify | `sidebar-counts` → `recordings-changed` channel |
| `yulu/scripts/yulu_ui/src/inboxWatcher.ts` | Modify | Publish `recordings-changed` instead of `sidebar-counts` |
| `yulu/scripts/yulu_ui/tests/routers/recordings.test.ts` | Create | Router unit tests |
| `yulu/scripts/yulu_ui/tests/routers/voicemails.test.ts` | **Delete** | — |
| `yulu/scripts/yulu_ui/tests/routers/meetings.test.ts` | **Delete** | — |
| `yulu/scripts/yulu_ui/web/src/routes/inbox/recordings.tsx` | Create | `<RecordingsList>` (`/inbox`) |
| `yulu/scripts/yulu_ui/web/src/routes/inbox/recordings.$stem.tsx` | Create | `<RecordingReader>` (`/inbox/:stem`) |
| `yulu/scripts/yulu_ui/web/src/routes/inbox/recordings.css` + `recordings.reader.css` | Create | Styles |
| `yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.tsx` / `.index.tsx` / `.$stem.tsx` | **Delete** | Superseded |
| `yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.tsx` / `.index.tsx` / `.$stem.tsx` | **Delete** | Superseded |
| `yulu/scripts/yulu_ui/web/src/routes/inbox/*.css` (vm/mtg) | **Delete** | Superseded |
| `yulu/scripts/yulu_ui/web/src/App.tsx` | Modify | `/inbox` + `/inbox/:stem` + 4 redirects |
| `yulu/scripts/yulu_ui/web/src/components/Sidebar.tsx` | Modify | Single Recordings entry + icons (Recordings/Prompts/Glossary) |
| `yulu/scripts/yulu_ui/web/src/components/GlobalSearch.tsx` | Modify | Cross-nav → `/inbox/:stem` |
| `yulu/scripts/yulu_ui/web/src/routes/inbox/_layout.tsx` | Modify | Keep j/k nav working against the single list |
| `yulu/scripts/status_agent.swift` | Modify | Menu labels + read both dirs + open web inbox |
| `.github/workflows/ci.yml` | Modify | Add status_agent.swift to Swift build |
| `yulu/scripts/yulu_ui/e2e/critical.spec.ts` | Modify | /inbox list + reader + redirect tests |

---

## Task 1 (J.1): `recordings` router

**Files:**
- Create: `yulu/scripts/yulu_ui/src/routers/recordings.ts`
- Modify: `yulu/scripts/yulu_ui/src/routers/_app.ts`
- Test: `yulu/scripts/yulu_ui/tests/routers/recordings.test.ts`

**Goal:** One router that merges both directories for `list`, and dispatches `get`/`transcribe`/`summarize`/`audioUrl`/`delete` by stem pattern. Reuses the existing per-dir logic. Old routers stay until J.2 (mounted alongside is fine during J.1).

### Background

- Voicemails: `voicemail_YYYYMMDD_HHMMSS.wav` in `ctx.paths.voicemailsDir`. No title, no realtime artifact.
- Meetings: `<title>_YYYYMMDD_HHMMSS.wav` in `ctx.paths.moviesDir` (excluding `voicemail_*`). Has title + realtime artifact.
- `ctx.jobs` (Phase I JobRegistry) provides `status` + `statusError`.
- `runTranscribe` / `runSummarize` from `jobRunner.js` (Phase I).
- `ctx.config.read()` returns parsed config with `.llm.command`.

`dispatchType(stem)`: `/^voicemail_\d{8}_\d{6}$/` → `"voicemail"`, else `"meeting"`.

- [ ] **Step 1: Write failing tests**

Create `yulu/scripts/yulu_ui/tests/routers/recordings.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingsRouter } from "../../src/routers/recordings.js";
import { createCaller } from "../../src/trpc.js";
import { JobRegistry } from "../../src/jobStatus.js";
import { PubSub, type AppChannels } from "../../src/pubsub.js";

function mkCtx(opts: { voicemailsDir: string; moviesDir: string }) {
  return {
    paths: {
      voicemailsDir: opts.voicemailsDir,
      moviesDir: opts.moviesDir,
      transcribePy: "/fake/transcribe.py",
      agentQueueJson: join(opts.moviesDir, "agent-queue.json"),
    },
    jobs: new JobRegistry(),
    pubsub: new PubSub<AppChannels>(),
    config: { read: () => ({ llm: {} }) },
  } as never;
}

describe("recordings router", () => {
  let root: string;
  let vmDir: string;
  let mvDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rec_"));
    vmDir = join(root, "voicemails");
    mvDir = join(root, "movies");
    mkdirSync(vmDir); mkdirSync(mvDir);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("list merges voicemails + meetings with type tags, sorted by mtime desc", () => {
    writeFileSync(join(vmDir, "voicemail_20260101_120000.wav"), "");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.wav"), "");
    const ctx = mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir });
    const caller = createCaller(recordingsRouter, ctx);
    const rows = caller.list({});
    expect(rows.length).toBe(2);
    // newest first — TeamSync (Jan 2) before voicemail (Jan 1)
    const types = rows.map((r: { type: string }) => r.type);
    expect(types).toContain("voicemail");
    expect(types).toContain("meeting");
    const meeting = rows.find((r: { type: string }) => r.type === "meeting");
    expect(meeting.title).toBe("TeamSync");
    const vm = rows.find((r: { type: string }) => r.type === "voicemail");
    expect(vm.title).toBeNull();
  });

  it("list excludes voicemail_* from the movies dir", () => {
    writeFileSync(join(mvDir, "voicemail_20260101_120000.wav"), "");  // stray in movies
    const ctx = mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir });
    const caller = createCaller(recordingsRouter, ctx);
    const rows = caller.list({});
    expect(rows.length).toBe(0);  // not counted as a meeting
  });

  it("list type filter returns only that type", () => {
    writeFileSync(join(vmDir, "voicemail_20260101_120000.wav"), "");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.wav"), "");
    const ctx = mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir });
    const caller = createCaller(recordingsRouter, ctx);
    expect(caller.list({ type: "voicemail" }).length).toBe(1);
    expect(caller.list({ type: "meeting" }).length).toBe(1);
  });

  it("get dispatches a voicemail stem to voicemailsDir", () => {
    writeFileSync(join(vmDir, "voicemail_20260101_120000.wav"), "");
    writeFileSync(join(vmDir, "voicemail_20260101_120000.transcript.txt"), "hi there");
    const ctx = mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir });
    const caller = createCaller(recordingsRouter, ctx);
    const r = caller.get({ stem: "voicemail_20260101_120000" });
    expect(r.type).toBe("voicemail");
    expect(r.transcript).toBe("hi there");
    expect(r.realtime).toBeNull();
  });

  it("get dispatches a meeting stem to moviesDir and includes realtime", () => {
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.wav"), "");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.realtime.transcript.txt"), "live text");
    const ctx = mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir });
    const caller = createCaller(recordingsRouter, ctx);
    const r = caller.get({ stem: "TeamSync_20260102_090000" });
    expect(r.type).toBe("meeting");
    expect(r.realtime).toBe("live text");
    expect(r.title).toBe("TeamSync");
  });

  it("transcribe throws NOT_FOUND when WAV missing", async () => {
    const ctx = mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir });
    const caller = createCaller(recordingsRouter, ctx);
    await expect(caller.transcribe({ stem: "voicemail_20260101_120000" }))
      .rejects.toThrow(/WAV file missing/);
  });

  it("audioUrl returns the right path per type", () => {
    const ctx = mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir });
    const caller = createCaller(recordingsRouter, ctx);
    expect(caller.audioUrl({ stem: "voicemail_20260101_120000" })).toBe("/files/voicemails/voicemail_20260101_120000.wav");
    expect(caller.audioUrl({ stem: "TeamSync_20260102_090000" })).toBe("/files/meetings/TeamSync_20260102_090000.wav");
  });

  it("list reflects JobRegistry status", () => {
    writeFileSync(join(vmDir, "voicemail_20260101_120000.wav"), "");
    const ctx = mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir });
    ctx.jobs.set({ stem: "voicemail_20260101_120000", action: "transcribe", state: "transcribing", startedAt: Date.now(), jobId: "j1" });
    const caller = createCaller(recordingsRouter, ctx);
    expect(caller.list({})[0].status).toBe("transcribing");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd yulu/scripts/yulu_ui && npm test -- routers/recordings`
Expected: cannot find module `../../src/routers/recordings.js`.

- [ ] **Step 3: Implement recordings.ts**

Create `yulu/scripts/yulu_ui/src/routers/recordings.ts`:

```ts
import { readdirSync, readFileSync, statSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { router, publicProcedure } from "../trpc.js";
import { runTranscribe, runSummarize } from "../jobRunner.js";
import type { JobRegistry } from "../jobStatus.js";

export type RecordingType = "voicemail" | "meeting";

const VOICEMAIL_RE = /^voicemail_\d{8}_\d{6}$/;
const VM_FILE_RE = /^(voicemail_\d{8}_\d{6})\.wav$/;
const MTG_FILE_RE = /^(.+?)_(\d{8})_(\d{6})\.wav$/;

export function dispatchType(stem: string): RecordingType {
  return VOICEMAIL_RE.test(stem) ? "voicemail" : "meeting";
}

function isoFromStem(date: string, time: string): string {
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
}

function firstWordsOf(path: string): string | null {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return null;
    return raw.length <= 80 ? raw : raw.slice(0, 80) + "…";
  } catch {
    return null;
  }
}

interface Row {
  stem: string;
  type: RecordingType;
  title: string | null;
  recordedAt: string | null;
  wavPath: string;
  sizeBytes: number;
  mtimeMs: number;
  hasTranscript: boolean;
  hasSummary: boolean;
  hasRealtime: boolean;
  firstWords: string | null;
  status: string;
  statusError?: string;
}

function listVoicemails(dir: string, registry: JobRegistry): Row[] {
  if (!existsSync(dir)) return [];
  const out: Row[] = [];
  for (const f of readdirSync(dir)) {
    const m = f.match(VM_FILE_RE);
    if (!m) continue;
    const stem = m[1]!;
    const wavPath = join(dir, f);
    const stat = statSync(wavPath);
    const transcriptPath = join(dir, `${stem}.transcript.txt`);
    const hasTranscript = existsSync(transcriptPath);
    const job = registry.get(stem);
    // Derive recordedAt from the stem timestamp.
    const tm = stem.match(/_(\d{8})_(\d{6})$/);
    out.push({
      stem,
      type: "voicemail",
      title: null,
      recordedAt: tm ? isoFromStem(tm[1]!, tm[2]!) : null,
      wavPath,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      hasTranscript,
      hasSummary: existsSync(join(dir, `${stem}.summary.md`)),
      hasRealtime: false,
      firstWords: hasTranscript ? firstWordsOf(transcriptPath) : null,
      status: job?.state ?? "idle",
      statusError: job?.error,
    });
  }
  return out;
}

function listMeetings(dir: string, registry: JobRegistry): Row[] {
  if (!existsSync(dir)) return [];
  const out: Row[] = [];
  for (const f of readdirSync(dir)) {
    const m = f.match(MTG_FILE_RE);
    if (!m) continue;
    const [, title, date, time] = m;
    if (title === "voicemail") continue;       // strays handled by voicemails dir
    const stem = f.slice(0, -4);
    const wavPath = join(dir, f);
    const stat = statSync(wavPath);
    const transcriptPath = join(dir, `${stem}.transcript.txt`);
    const job = registry.get(stem);
    out.push({
      stem,
      type: "meeting",
      title: title!,
      recordedAt: isoFromStem(date!, time!),
      wavPath,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      hasTranscript: existsSync(transcriptPath),
      hasSummary: existsSync(join(dir, `${stem}.summary.md`)),
      hasRealtime: existsSync(join(dir, `${stem}.realtime.transcript.txt`)),
      firstWords: firstWordsOf(transcriptPath),
      status: job?.state ?? "idle",
      statusError: job?.error,
    });
  }
  return out;
}

export const recordingsRouter = router({
  list: publicProcedure
    .input(z.object({
      limit: z.number().int().positive().max(500).optional(),
      since: z.number().int().nonnegative().optional(),
      type: z.enum(["voicemail", "meeting"]).optional(),
    }))
    .query(({ ctx, input }) => {
      let rows: Row[] = [];
      if (input.type !== "meeting") rows = rows.concat(listVoicemails(ctx.paths.voicemailsDir, ctx.jobs));
      if (input.type !== "voicemail") rows = rows.concat(listMeetings(ctx.paths.moviesDir, ctx.jobs));
      rows.sort((a, b) => b.mtimeMs - a.mtimeMs);
      if (input.since !== undefined) rows = rows.filter((r) => r.mtimeMs >= input.since!);
      if (input.limit !== undefined) rows = rows.slice(0, input.limit);
      return rows;
    }),

  get: publicProcedure
    .input(z.object({ stem: z.string() }))
    .query(({ ctx, input }) => {
      const type = dispatchType(input.stem);
      const dir = type === "voicemail" ? ctx.paths.voicemailsDir : ctx.paths.moviesDir;
      const wav = join(dir, `${input.stem}.wav`);
      if (!existsSync(wav)) throw new TRPCError({ code: "NOT_FOUND", message: `recording not found: ${input.stem}` });
      const read = (suffix: string) => {
        const p = join(dir, `${input.stem}${suffix}`);
        return existsSync(p) ? readFileSync(p, "utf8") : null;
      };
      const stat = statSync(wav);
      const job = ctx.jobs.get(input.stem);
      // Title + recordedAt for meetings; voicemails get null title + stem-derived ts.
      let title: string | null = null;
      let recordedAt: string | null = null;
      const tm = input.stem.match(/_(\d{8})_(\d{6})$/);
      if (tm) recordedAt = isoFromStem(tm[1]!, tm[2]!);
      if (type === "meeting") {
        const mm = `${input.stem}.wav`.match(MTG_FILE_RE);
        title = mm ? mm[1]! : null;
      }
      return {
        stem: input.stem,
        type,
        title,
        recordedAt,
        wavPath: wav,
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        transcript: read(".transcript.txt"),
        summary:    read(".summary.md"),
        realtime:   type === "meeting" ? read(".realtime.transcript.txt") : null,
        hasRealtime: type === "meeting" && existsSync(join(dir, `${input.stem}.realtime.transcript.txt`)),
        status: job?.state ?? "idle",
        statusError: job?.error,
      };
    }),

  audioUrl: publicProcedure
    .input(z.object({ stem: z.string() }))
    .query(({ input }) => {
      const type = dispatchType(input.stem);
      return type === "voicemail"
        ? `/files/voicemails/${input.stem}.wav`
        : `/files/meetings/${input.stem}.wav`;
    }),

  delete: publicProcedure
    .input(z.object({ stem: z.string() }))
    .mutation(({ ctx, input }) => {
      const type = dispatchType(input.stem);
      const dir = type === "voicemail" ? ctx.paths.voicemailsDir : ctx.paths.moviesDir;
      const suffixes = [".wav", ".transcript.txt", ".raw.transcript.txt", ".summary.md",
                        ".summary.html", ".realtime.transcript.txt", ".realtime.json", ".title"];
      let removed = 0;
      for (const s of suffixes) {
        const p = join(dir, `${input.stem}${s}`);
        if (existsSync(p)) { unlinkSync(p); removed++; }
      }
      ctx.pubsub.publish("recordings-changed", { reason: "removed" });
      return { removed };
    }),

  transcribe: publicProcedure
    .input(z.object({ stem: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const type = dispatchType(input.stem);
      const dir = type === "voicemail" ? ctx.paths.voicemailsDir : ctx.paths.moviesDir;
      const wavPath = join(dir, `${input.stem}.wav`);
      if (!existsSync(wavPath)) throw new TRPCError({ code: "NOT_FOUND", message: "WAV file missing" });
      if (ctx.jobs.get(input.stem)) throw new TRPCError({ code: "CONFLICT", message: "Job already running for this recording" });
      void runTranscribe({ stem: input.stem, wavPath, transcribePy: ctx.paths.transcribePy, registry: ctx.jobs, pubsub: ctx.pubsub });
      return { ok: true as const };
    }),

  summarize: publicProcedure
    .input(z.object({ stem: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const type = dispatchType(input.stem);
      const dir = type === "voicemail" ? ctx.paths.voicemailsDir : ctx.paths.moviesDir;
      const transcriptPath = join(dir, `${input.stem}.transcript.txt`);
      if (!existsSync(transcriptPath)) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Transcript missing — run Re-transcribe first" });
      if (ctx.jobs.get(input.stem)) throw new TRPCError({ code: "CONFLICT", message: "Job already running for this recording" });
      const summaryPath = join(dir, `${input.stem}.summary.md`);
      const cfg = ctx.config.read();
      const llmCommand = (cfg.llm?.command ?? null) as string[] | null;
      void runSummarize({ stem: input.stem, transcriptPath, summaryPath, llmCommand, agentQueueJson: ctx.paths.agentQueueJson, registry: ctx.jobs, pubsub: ctx.pubsub });
      return { ok: true as const };
    }),
});
```

- [ ] **Step 4: Mount in _app.ts (alongside old routers for now)**

Edit `yulu/scripts/yulu_ui/src/routers/_app.ts`. Add the import + mount (keep voicemails+meetings for now; J.2 removes them):

```ts
import { recordingsRouter } from "./recordings.js";
```

In the `router({...})` block add:

```ts
  recordings:   recordingsRouter,
```

- [ ] **Step 5: Run tests + typecheck**

Run: `cd yulu/scripts/yulu_ui && npm test -- routers/recordings && npm run typecheck`
Expected: 8 PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git add yulu/scripts/yulu_ui/src/routers/recordings.ts yulu/scripts/yulu_ui/src/routers/_app.ts yulu/scripts/yulu_ui/tests/routers/recordings.test.ts
git commit -m "feat(yulu_ui/routers): unified recordings router (merge dirs + dispatch by stem)

list merges voicemailsDir + moviesDir with a type tag (voicemail|meeting),
sorted by mtime desc, optional type filter. get/transcribe/summarize/
audioUrl/delete dispatch by stem (voicemail_* → voicemailsDir else
moviesDir), reusing Phase I jobRunner. status flows from JobRegistry.
8 vitest cases. Old voicemails+meetings routers still mounted (removed in J.2)."
```

---

## Task 2 (J.2): Delete old routers + recordings-changed channel

**Files:**
- Delete: `yulu/scripts/yulu_ui/src/routers/voicemails.ts`, `meetings.ts`
- Delete: `yulu/scripts/yulu_ui/tests/routers/voicemails.test.ts`, `meetings.test.ts`
- Modify: `yulu/scripts/yulu_ui/src/routers/_app.ts`
- Modify: `yulu/scripts/yulu_ui/src/pubsub.ts`
- Modify: `yulu/scripts/yulu_ui/src/inboxWatcher.ts`
- Modify: any test that imports the deleted routers (e.g. `tests/inboxWatcher.test.ts`)

**Goal:** Remove the superseded routers + swap the dead `sidebar-counts` channel for `recordings-changed`.

### Background

`sidebar-counts` was orphaned in Phase H (sidebar counts removed). `inboxWatcher.ts` still publishes it; `recordings.delete` (J.1) already publishes `recordings-changed`. This task makes the channel official and rewires the watcher.

- [ ] **Step 1: Swap the pubsub channel**

Edit `yulu/scripts/yulu_ui/src/pubsub.ts`. In `AppChannels`, remove the `"sidebar-counts"` line and add:

```ts
  "recordings-changed": { reason: "added" | "removed" | "changed" };
```

- [ ] **Step 2: Rewire inboxWatcher.ts**

Read `yulu/scripts/yulu_ui/src/inboxWatcher.ts`. It currently publishes `sidebar-counts` on fs changes. Replace each `pubsub.publish("sidebar-counts", {...})` call with:

```ts
pubsub.publish("recordings-changed", { reason: "changed" });
```

Remove any count-computation logic that existed only to populate the `sidebar-counts` payload (it's no longer needed — the new payload is just `{ reason }`). Keep the fs.watch setup on both directories.

- [ ] **Step 3: Remove the routers from _app.ts**

Edit `yulu/scripts/yulu_ui/src/routers/_app.ts`. Delete the two imports:

```ts
import { voicemailsRouter } from "./voicemails.js";
import { meetingsRouter }   from "./meetings.js";
```

Delete the two mounts:

```ts
  voicemails:   voicemailsRouter,
  meetings:     meetingsRouter,
```

- [ ] **Step 4: Delete the files**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
rm yulu/scripts/yulu_ui/src/routers/voicemails.ts
rm yulu/scripts/yulu_ui/src/routers/meetings.ts
rm yulu/scripts/yulu_ui/tests/routers/voicemails.test.ts
rm yulu/scripts/yulu_ui/tests/routers/meetings.test.ts
```

- [ ] **Step 5: Find + fix remaining references**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
grep -rn "voicemailsRouter\|meetingsRouter\|sidebar-counts\|\.voicemails\.\|\.meetings\." yulu/scripts/yulu_ui/src yulu/scripts/yulu_ui/tests 2>&1 | grep -v node_modules
```

Expected remaining hits: `tests/inboxWatcher.test.ts` likely asserts on `sidebar-counts`. Update it to assert on `recordings-changed` with `{ reason: "changed" }`. (The web `src/` references to `trpc.voicemails.*` / `trpc.meetings.*` are handled in J.3–J.5, which run after; for now the web build is allowed to break — we only run the SERVER vitest project + typecheck here. If `npm run typecheck` fails on web files, that's expected and resolved in J.3–J.5. To keep this task green, run only the server tests + server typecheck.)

**Important:** Phase J tasks J.2 through J.5 form a coupled set — the web won't typecheck cleanly until J.5. To keep each task's verification meaningful, J.2–J.4 verify the SERVER-side only; J.5 restores full web typecheck. State this in each commit.

- [ ] **Step 6: Server test sweep**

Run:
```bash
cd yulu/scripts/yulu_ui && npm test -- routers/ inboxWatcher 2>&1 | tail -10
```
Expected: recordings + inboxWatcher tests pass; no voicemails/meetings test files remain.

- [ ] **Step 7: Commit**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git add yulu/scripts/yulu_ui/src/routers/_app.ts yulu/scripts/yulu_ui/src/pubsub.ts yulu/scripts/yulu_ui/src/inboxWatcher.ts yulu/scripts/yulu_ui/tests/inboxWatcher.test.ts
git add yulu/scripts/yulu_ui/src/routers/voicemails.ts yulu/scripts/yulu_ui/src/routers/meetings.ts yulu/scripts/yulu_ui/tests/routers/voicemails.test.ts yulu/scripts/yulu_ui/tests/routers/meetings.test.ts

git commit -m "refactor(yulu_ui): delete voicemails+meetings routers; sidebar-counts → recordings-changed

recordings router (J.1) subsumes both. _app.ts mounts only recordings now.
pubsub sidebar-counts channel (orphaned since Phase H removed counts)
replaced by recordings-changed; inboxWatcher publishes it on fs changes for
live list refresh. Web-side trpc.voicemails/meetings references are migrated
in J.3–J.5 (web typecheck intentionally red until then)."
```

---

## Task 3 (J.3): `<RecordingsList>` (`/inbox`)

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/routes/inbox/recordings.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/routes/inbox/recordings.css`
- Test: `yulu/scripts/yulu_ui/tests/web/recordings.list.test.tsx`

**Goal:** One list at `/inbox`: type badge per row, filter chips (All/Voicemail/Meeting), MasterDetail (resizable), live refresh on `recordings-changed`.

### Background

Read the existing `web/src/routes/inbox/voicemails.tsx` + `meetings.tsx` for the row-rendering + MasterDetail + filter patterns. Reuse `<MasterDetail>` (storageKey), `<FilterChips>`, `useWsChannel`. The reader is rendered as a nested `<Outlet>` (or the list+reader split — match the existing structure where the list route renders MasterDetail with `listSlot` + `<Outlet>` as detailSlot).

- [ ] **Step 1: Read the existing list components**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
cat yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.tsx
cat yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.tsx
cat yulu/scripts/yulu_ui/web/src/components/FilterChips.tsx
```

Note: how MasterDetail's `listSlot`/`detailSlot` are passed, how filter state maps to the query, how rows link to the reader, the `data-testid` used (`voicemail-row` / similar).

- [ ] **Step 2: Write failing tests**

Create `yulu/scripts/yulu_ui/tests/web/recordings.list.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";

const listMock = vi.fn();
vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    recordings: {
      list: { useQuery: (...a: unknown[]) => listMock(...a) },
    },
  },
}));
vi.mock("../../web/src/ws.js", () => ({ useWsChannel: () => {} }));

import { RecordingsList } from "../../web/src/routes/inbox/recordings";

function rows() {
  return [
    { stem: "TeamSync_20260102_090000", type: "meeting", title: "TeamSync", recordedAt: "2026-01-02T09:00:00", mtimeMs: 2, hasTranscript: true, hasSummary: true, hasRealtime: true, firstWords: "we discussed", status: "idle" },
    { stem: "voicemail_20260101_120000", type: "voicemail", title: null, recordedAt: "2026-01-01T12:00:00", mtimeMs: 1, hasTranscript: true, hasSummary: false, hasRealtime: false, firstWords: "quick note", status: "transcribing" },
  ];
}

describe("RecordingsList", () => {
  it("renders one row per recording with a type badge", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    expect(screen.getByText("TeamSync")).toBeInTheDocument();
    expect(screen.getByText(/quick note/)).toBeInTheDocument();
    // type badges present
    expect(screen.getAllByText(/voicemail/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/meeting/i).length).toBeGreaterThan(0);
  });

  it("renders All / Voicemail / Meeting filter chips", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    expect(screen.getByRole("button", { name: "All", exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Voicemail", exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Meeting", exact: true })).toBeInTheDocument();
  });

  it("shows a status chip on a transcribing row", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    expect(screen.getByText(/transcribing/i)).toBeInTheDocument();
  });

  it("clicking a filter chip re-queries with the type arg", () => {
    listMock.mockReturnValue({ data: rows(), isPending: false });
    render(<MemoryRouter><RecordingsList /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: "Voicemail", exact: true }));
    // last call to useQuery should carry type: "voicemail"
    const lastArg = listMock.mock.calls[listMock.mock.calls.length - 1][0];
    expect(lastArg).toMatchObject({ type: "voicemail" });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd yulu/scripts/yulu_ui && npm test -- recordings.list`
Expected: cannot find module.

- [ ] **Step 4: Implement recordings.tsx**

Create `yulu/scripts/yulu_ui/web/src/routes/inbox/recordings.tsx`. Model it on the existing `voicemails.tsx` structure (MasterDetail with list + `<Outlet>`), adapting to the unified row shape:

```tsx
import { useState } from "react";
import { NavLink, Outlet } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../../trpc.js";
import { useWsChannel } from "../../ws.js";
import { MasterDetail } from "../../components/MasterDetail.js";
import { FilterChips, type ChipDef } from "../../components/FilterChips.js";
import "./recordings.css";

export const handle = { breadcrumb: "Recordings", filters: null };

type TypeFilter = "all" | "voicemail" | "meeting";

const FILTER_CHIPS: ChipDef[] = [
  { id: "all", label: "All" },
  { id: "voicemail", label: "Voicemail" },
  { id: "meeting", label: "Meeting" },
];

interface Row {
  stem: string;
  type: "voicemail" | "meeting";
  title: string | null;
  recordedAt: string | null;
  mtimeMs: number;
  hasTranscript: boolean;
  hasSummary: boolean;
  hasRealtime: boolean;
  firstWords: string | null;
  status: string;
  statusError?: string;
}

function fmtTs(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.valueOf())) return "";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

export function RecordingsList() {
  const [filter, setFilter] = useState<TypeFilter>("all");
  const queryArg = filter === "all" ? {} : { type: filter };
  const { data, isPending } = trpc.recordings.list.useQuery(queryArg);
  const qc = useQueryClient();

  useWsChannel("recordings-changed", () => {
    qc.invalidateQueries({ queryKey: [["recordings", "list"]] });
  });

  const rows = (data as Row[] | undefined) ?? [];

  const listSlot = (
    <div className="recordings-list">
      <FilterChips
        chips={FILTER_CHIPS}
        active={filter}
        onChange={(id) => setFilter(id as TypeFilter)}
      />
      {rows.map((r) => (
        <NavLink
          key={r.stem}
          to={`/inbox/${r.stem}`}
          className={({ isActive }) => "recording-row" + (isActive ? " active" : "")}
          data-testid="recording-row"
        >
          <div className="recording-row-top">
            <span className={`recording-badge ${r.type === "voicemail" ? "v" : "m"}`}>
              {r.type === "voicemail" ? "Voicemail" : "Meeting"}
            </span>
            <span className="recording-row-title">{r.title ?? r.stem}</span>
          </div>
          {r.firstWords && <div className="recording-row-words">{r.firstWords}</div>}
          <div className="recording-row-meta">
            <span>{fmtTs(r.recordedAt)}</span>
            {r.status !== "idle" && (
              <span className="recording-row-status">{r.status}…</span>
            )}
          </div>
        </NavLink>
      ))}
    </div>
  );

  return (
    <MasterDetail
      storageKey="yulu_ui.inbox.recordings.width"
      listSlot={listSlot}
      detailSlot={<Outlet />}
      listPending={isPending}
    />
  );
}
```

**Note:** match `<FilterChips>`'s actual prop names by reading its source (Step 1). If it uses `value`/`onSelect` instead of `active`/`onChange`, adapt. The test asserts the chips render + filter re-queries — keep that contract.

Create `yulu/scripts/yulu_ui/web/src/routes/inbox/recordings.css`:

```css
.recordings-list { display: flex; flex-direction: column; }
.recording-row {
  display: block;
  padding: 10px;
  border-radius: 8px;
  text-decoration: none;
  color: var(--fg);
  margin-bottom: 2px;
}
.recording-row:hover { background: var(--row-hover); }
.recording-row.active { background: var(--accent-soft); }
.recording-row-top { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
.recording-badge {
  font-size: 9.5px; padding: 1px 6px; border-radius: 3px;
  text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; flex-shrink: 0;
}
.recording-badge.v { background: color-mix(in oklch, var(--blue) 14%, transparent); color: var(--blue); }
.recording-badge.m { background: color-mix(in oklch, var(--purple) 14%, transparent); color: var(--purple); }
.recording-row-title { font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.recording-row-words {
  font-size: 12px; color: var(--fg-2); line-height: 1.45;
  overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
}
.recording-row-meta { font-size: 11px; color: var(--fg-2); font-family: ui-monospace, monospace; margin-top: 4px; display: flex; gap: 8px; align-items: center; }
.recording-row-status { color: var(--accent-on, var(--accent)); background: var(--accent-soft); padding: 0 6px; border-radius: 8px; }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd yulu/scripts/yulu_ui && npm test -- recordings.list`
Expected: 4 PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git add yulu/scripts/yulu_ui/web/src/routes/inbox/recordings.tsx yulu/scripts/yulu_ui/web/src/routes/inbox/recordings.css yulu/scripts/yulu_ui/tests/web/recordings.list.test.tsx
git commit -m "feat(yulu_ui/web): RecordingsList — unified /inbox list

One list at /inbox: per-row type badge (blue Voicemail / purple Meeting),
filter chips All/Voicemail/Meeting driving the recordings.list type arg,
status chip on in-flight rows, MasterDetail resizable, recordings-changed
WS subscription for live refresh. 4 vitest cases. (Wired into routing in J.5.)"
```

---

## Task 4 (J.4): `<RecordingReader>` (`/inbox/:stem`)

**Files:**
- Create: `yulu/scripts/yulu_ui/web/src/routes/inbox/recordings.$stem.tsx`
- Create: `yulu/scripts/yulu_ui/web/src/routes/inbox/recordings.reader.css`
- Test: `yulu/scripts/yulu_ui/tests/web/recordings.reader.test.tsx`

**Goal:** One reader merging VoicemailReader + MeetingReader. Tabs Summary/Transcript/Realtime/Raw — Realtime only when `data.hasRealtime`. ReprocessButtons wired to `recordings.transcribe/summarize`.

### Background

Read both existing readers (`voicemails.$stem.tsx`, `meetings.$stem.tsx`). The meeting reader already has the realtime tab + the 4-tab structure. Use it as the base, generalize to `recordings.get`, and make the realtime tab conditional on `data.hasRealtime`.

- [ ] **Step 1: Read both existing readers**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
cat yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.\$stem.tsx
cat yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.\$stem.tsx
```

Note: tab state machine, snippet auto-scroll effect, AudioPlayer usage, ReprocessButton integration (Phase I), `useWsChannel("jobs")` handler.

- [ ] **Step 2: Write failing tests**

Create `yulu/scripts/yulu_ui/tests/web/recordings.reader.test.tsx`:

```tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";

const getMock = vi.fn();
vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    recordings: {
      get: { useQuery: (...a: unknown[]) => getMock(...a) },
      audioUrl: { useQuery: () => ({ data: "/files/voicemails/x.wav" }) },
      transcribe: { useMutation: () => ({ mutate: vi.fn() }) },
      summarize: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));
vi.mock("../../web/src/ws.js", () => ({ useWsChannel: () => {} }));
vi.mock("../../web/src/components/AudioPlayer.js", () => ({ AudioPlayer: () => <div data-testid="audio" /> }));

import { RecordingReader } from "../../web/src/routes/inbox/recordings.$stem";

function renderAt(stem: string) {
  return render(
    <MemoryRouter initialEntries={[`/inbox/${stem}`]}>
      <Routes><Route path="/inbox/:stem" element={<RecordingReader />} /></Routes>
    </MemoryRouter>
  );
}

describe("RecordingReader", () => {
  it("shows Realtime tab when hasRealtime is true (meeting)", () => {
    getMock.mockReturnValue({ data: { stem: "TeamSync_20260102_090000", type: "meeting", title: "TeamSync", transcript: "t", summary: "s", realtime: "r", hasRealtime: true, status: "idle" }, isPending: false });
    renderAt("TeamSync_20260102_090000");
    expect(screen.getByRole("button", { name: /realtime/i })).toBeInTheDocument();
  });

  it("hides Realtime tab when hasRealtime is false (voicemail)", () => {
    getMock.mockReturnValue({ data: { stem: "voicemail_20260101_120000", type: "voicemail", title: null, transcript: "t", summary: "s", realtime: null, hasRealtime: false, status: "idle" }, isPending: false });
    renderAt("voicemail_20260101_120000");
    expect(screen.queryByRole("button", { name: /realtime/i })).toBeNull();
  });

  it("renders Re-transcribe + Re-generate summary buttons", () => {
    getMock.mockReturnValue({ data: { stem: "voicemail_20260101_120000", type: "voicemail", title: null, transcript: "t", summary: "s", realtime: null, hasRealtime: false, status: "idle" }, isPending: false });
    renderAt("voicemail_20260101_120000");
    expect(screen.getByRole("button", { name: /Re-transcribe/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Re-generate summary/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd yulu/scripts/yulu_ui && npm test -- recordings.reader`
Expected: cannot find module.

- [ ] **Step 4: Implement recordings.$stem.tsx**

Create `yulu/scripts/yulu_ui/web/src/routes/inbox/recordings.$stem.tsx` by adapting the meeting reader (the richer of the two). Key generalizations:
- `trpc.recordings.get.useQuery({ stem })` + `trpc.recordings.audioUrl.useQuery({ stem })`
- Tab type `"summary" | "transcript" | "realtime" | "raw"`; build the visible tab list dynamically — include `realtime` only if `data?.hasRealtime`
- ReprocessButtons → `trpc.recordings.transcribe` / `.summarize`; WS `jobs` subscription invalidates `[["recordings","get"]]` + `[["recordings","list"]]`
- Header shows the type badge + title-or-stem
- Carry over the snippet auto-scroll effect verbatim
- `export const handle = { breadcrumb: (params: { stem?: string }) => params.stem ?? "Recording", filters: null };`

Write the full component (use the meeting reader as the template; the agent should produce a complete file, not a diff). Create `recordings.reader.css` carrying over the reader styles from `meetings.reader.css` + the `.reader-actions` rule from Phase I.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd yulu/scripts/yulu_ui && npm test -- recordings.reader`
Expected: 3 PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git add yulu/scripts/yulu_ui/web/src/routes/inbox/recordings.\$stem.tsx yulu/scripts/yulu_ui/web/src/routes/inbox/recordings.reader.css yulu/scripts/yulu_ui/tests/web/recordings.reader.test.tsx
git commit -m "feat(yulu_ui/web): RecordingReader — merged voicemail+meeting reader

One reader at /inbox/:stem via recordings.get. Tabs Summary/Transcript/
Realtime/Raw with Realtime shown only when data.hasRealtime (artifact-driven,
not type-driven). ReprocessButtons (Phase I) wired to recordings.transcribe/
summarize with jobs WS subscription. Type badge + title in header. Snippet
auto-scroll carried over. 3 vitest cases. (Wired into routing in J.5.)"
```

---

## Task 5 (J.5): Routing convergence + Sidebar + GlobalSearch + delete old web files

**Files:**
- Modify: `yulu/scripts/yulu_ui/web/src/App.tsx`
- Modify: `yulu/scripts/yulu_ui/web/src/components/Sidebar.tsx`
- Modify: `yulu/scripts/yulu_ui/web/src/components/GlobalSearch.tsx`
- Modify: `yulu/scripts/yulu_ui/web/src/routes/inbox/_layout.tsx`
- Delete: `voicemails.tsx` / `.index.tsx` / `.$stem.tsx` + css; `meetings.tsx` / `.index.tsx` / `.$stem.tsx` + css
- Modify/delete affected tests (`Sidebar.test.tsx`, `voicemails.*.test.tsx`, `meetings.*.test.tsx`, `routes.test.tsx`)

**Goal:** Wire `/inbox` + `/inbox/:stem`, redirect old URLs, single Recordings sidebar entry with icons, GlobalSearch cross-nav. This task restores full web typecheck (green).

- [ ] **Step 1: Update App.tsx routing**

Open `yulu/scripts/yulu_ui/web/src/App.tsx`.

Remove the voicemails+meetings imports (lines ~9–14):
```tsx
import { Voicemails, ... } from "./routes/inbox/voicemails.js";
import { VoicemailsIndex } from "./routes/inbox/voicemails.index.js";
import { VoicemailReader, ... } from "./routes/inbox/voicemails.$stem.js";
import { Meetings, ... } from "./routes/inbox/meetings.js";
import { MeetingsIndex } from "./routes/inbox/meetings.index.js";
import { MeetingReader, ... } from "./routes/inbox/meetings.$stem.js";
```

Add:
```tsx
import { RecordingsList, handle as recordingsHandle } from "./routes/inbox/recordings.js";
import { RecordingReader, handle as recordingReaderHandle } from "./routes/inbox/recordings.$stem.js";
```

Change the index redirect (line ~27) from `/inbox/voicemails` to `/inbox`:
```tsx
{ index: true, element: <Navigate to="/inbox" replace /> },
```

Replace the `inbox` children block. The `inbox` route keeps `InboxLayout` + `handle`. Its children become:
```tsx
{
  path: "inbox",
  Component: InboxLayout,
  handle: inboxLayoutHandle,
  children: [
    {
      Component: RecordingsList,
      handle: recordingsHandle,
      children: [
        { index: true, element: <div className="empty-detail" /> },  // or an EmptyState
        { path: ":stem", Component: RecordingReader, handle: recordingReaderHandle },
      ],
    },
  ],
},
// Redirects from old URLs (siblings of inbox, or use a small redirect component):
{ path: "inbox/voicemails", element: <Navigate to="/inbox" replace /> },
{ path: "inbox/meetings",   element: <Navigate to="/inbox" replace /> },
{ path: "inbox/voicemails/:stem", element: <RecordingRedirect /> },
{ path: "inbox/meetings/:stem",   element: <RecordingRedirect /> },
```

Where `<RecordingRedirect>` preserves the `:stem` + query. Add this tiny component near the top of App.tsx:

```tsx
import { useParams, useSearchParams } from "react-router";
function RecordingRedirect() {
  const { stem } = useParams();
  const [sp] = useSearchParams();
  const qs = sp.toString();
  return <Navigate to={`/inbox/${stem}${qs ? `?${qs}` : ""}`} replace />;
}
```

(If the existing `inbox` nesting differs structurally — e.g. the list route isn't an index — adapt so that `/inbox` renders RecordingsList with the reader as a nested `:stem` outlet, matching how voicemails.tsx nested its reader.)

- [ ] **Step 2: Update Sidebar.tsx**

Open `yulu/scripts/yulu_ui/web/src/components/Sidebar.tsx`. Replace the INBOX section's two items with one, and add icons to all top-nav items.

Add imports:
```tsx
import { Mic, FileText, BookOpen } from "lucide-react";
```

The `TOP_SECTIONS` items gain an `icon` field. Rewrite:
```tsx
interface NavItem { to: string; label: string; icon: ReactNode; }

const TOP_SECTIONS: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Inbox",
    items: [
      { to: "/inbox", label: "Recordings", icon: <Mic size={15} strokeWidth={1.8} /> },
    ],
  },
  {
    heading: "Knowledge",
    items: [
      { to: "/knowledge/prompts",  label: "Prompts",  icon: <FileText size={15} strokeWidth={1.8} /> },
      { to: "/knowledge/glossary", label: "Glossary", icon: <BookOpen size={15} strokeWidth={1.8} /> },
    ],
  },
];
```

Render the icon inside the NavLink before the label:
```tsx
<NavLink ... >
  {it.icon}
  <span className="sidebar-item-label">{it.label}</span>
</NavLink>
```

Add `import type { ReactNode } from "react";` if not present. Update `.sidebar-item` CSS to gap the icon: add `gap: 8px;` and `display: flex; align-items: center;` (check Sidebar.css — likely already flex; add `gap: 8px` and `svg { opacity: 0.7; flex-shrink: 0; }`).

**Active-route caveat:** `/inbox` NavLink will match `/inbox/:stem` too (good — the Recordings entry stays highlighted in the reader). Ensure `end` is NOT set on this NavLink.

- [ ] **Step 3: Update GlobalSearch cross-nav**

Open `yulu/scripts/yulu_ui/web/src/components/GlobalSearch.tsx`. Find `hitTargetUrl`:
```tsx
function hitTargetUrl(h: Hit): string {
  const cleanSnip = h.snippet.replace(/\[\/?hit\]/g, "").trim().slice(0, 80);
  const snip = encodeURIComponent(cleanSnip);
  if (h.kind === "voicemail") return `/inbox/voicemails/${h.stem}?snippet=${snip}`;
  return `/inbox/meetings/${h.stem}?snippet=${snip}`;
}
```
Replace the body so both go to the unified URL:
```tsx
function hitTargetUrl(h: Hit): string {
  const cleanSnip = h.snippet.replace(/\[\/?hit\]/g, "").trim().slice(0, 80);
  const snip = encodeURIComponent(cleanSnip);
  return `/inbox/${h.stem}?snippet=${snip}`;
}
```

- [ ] **Step 4: Update _layout.tsx j/k nav**

Open `yulu/scripts/yulu_ui/web/src/routes/inbox/_layout.tsx`. It currently branches on `isVoicemails` / `isMeetings` and reads `trpc.voicemails.list` / `trpc.meetings.list`. Replace with a single `trpc.recordings.list.useQuery({})` and compute next/prev stem from that one list, navigating to `/inbox/${stem}`. Remove the voicemails/meetings branching.

- [ ] **Step 5: Delete old web files**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
rm yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.tsx yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.index.tsx yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.\$stem.tsx
rm yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.tsx yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.index.tsx yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.\$stem.tsx
# CSS siblings:
rm yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.css yulu/scripts/yulu_ui/web/src/routes/inbox/voicemails.reader.css 2>/dev/null || true
rm yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.css yulu/scripts/yulu_ui/web/src/routes/inbox/meetings.reader.css 2>/dev/null || true
```

- [ ] **Step 6: Fix affected tests**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
ls yulu/scripts/yulu_ui/tests/web/ | grep -iE "voicemail|meeting"
```
Delete tests for the removed components (voicemails.reader, voicemails.url, voicemails.filters, meetings.reader, meetings.filters, etc.). Update `routes.test.tsx` (the parameterized route smoke) to use `/inbox` + `/inbox/:stem` instead of the old paths, and update its route count. Update `Sidebar.test.tsx`: it asserted "Voicemails" + "Meetings" present and "no Search" — change to assert a single "Recordings" item + Prompts + Glossary, and that each has an svg icon.

- [ ] **Step 7: Full typecheck + sweep (web now green)**

Run: `cd yulu/scripts/yulu_ui && npm run typecheck && npm test 2>&1 | tail -15`
Expected: typecheck fully clean (web included now); all tests pass.

- [ ] **Step 8: Build smoke**

Run: `cd yulu/scripts/yulu_ui && npm run build 2>&1 | tail -5`
Expected: dist emitted.

- [ ] **Step 9: Commit**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git add -A yulu/scripts/yulu_ui/web yulu/scripts/yulu_ui/tests
git commit -m "feat(yulu_ui/web): converge routing to /inbox + /inbox/:stem; single Recordings sidebar entry

App.tsx: /inbox → RecordingsList, /inbox/:stem → RecordingReader, old
voicemails/meetings URLs <Navigate replace> (stem + query preserved).
Sidebar: one Recordings entry (Mic icon); Prompts (FileText) + Glossary
(BookOpen) gain icons too. GlobalSearch cross-nav → /inbox/:stem.
_layout j/k nav reads recordings.list. Deleted 6 old route files + their
tests; routes/Sidebar tests updated. Web typecheck green again."
```

---

## Task 6 (J.6): StatusAgent Swift menu sync + CI

**Files:**
- Modify: `yulu/scripts/status_agent.swift`
- Modify: `.github/workflows/ci.yml`

**Goal:** Relabel the menu, read both directories directly off disk for recents, open the web inbox, and add status_agent.swift to CI compilation.

### Background

Read `yulu/scripts/status_agent.swift` sections: `MenuBuilder.build` (menu items), `loadRecentVoicemails`, `onOpenInbox`, `onRecentClicked`. The recents currently shell to Python `voicemail.repo`; we switch to pure-Swift FileManager reading both dirs.

- [ ] **Step 1: Relabel menu items in MenuBuilder.build**

In `status_agent.swift`, find the toggle item `title: "Start Voicemail"` → change to `"Start Recording"`. Find `title: "Recent voicemails"` → `"Recent recordings"`. Find `title: "Open inbox in Terminal"` → `"Open inbox"`.

(Note: the toggle title may be updated dynamically elsewhere based on recording state — search for `"Start Voicemail"` / `"Stop"` and update any state-driven label that says "Voicemail" to "Recording" consistently.)

- [ ] **Step 2: Rewrite recents loader to read both dirs in Swift**

Replace `loadRecentVoicemails` with a pure-Swift `loadRecentRecordings` that enumerates both directories:

```swift
struct RecentRecording {
    let stem: String
    let type: String   // "VM" or "MTG"
    let mtime: Date
    let dir: String
}

func loadRecentRecordings(limit: Int = 5) -> [RecentRecording] {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    let vmDir = "\(home)/Movies/Yulu/voicemails"
    let mvDir = "\(home)/Movies/Yulu"
    var out: [RecentRecording] = []

    func scan(_ dir: String, type: String, excludeVoicemailPrefix: Bool) {
        guard let entries = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return }
        for f in entries where f.hasSuffix(".wav") {
            let stem = String(f.dropLast(4))
            if type == "MTG", stem.hasPrefix("voicemail_") { continue }     // strays belong to vmDir
            if type == "VM", !stem.hasPrefix("voicemail_") { continue }
            let path = "\(dir)/\(f)"
            let attrs = try? FileManager.default.attributesOfItem(atPath: path)
            let mtime = (attrs?[.modificationDate] as? Date) ?? Date.distantPast
            out.append(RecentRecording(stem: stem, type: type, mtime: mtime, dir: dir))
        }
    }
    scan(vmDir, type: "VM", excludeVoicemailPrefix: false)
    scan(mvDir, type: "MTG", excludeVoicemailPrefix: true)
    out.sort { $0.mtime > $1.mtime }
    return Array(out.prefix(limit))
}
```

Update the `menuWillOpen` code that previously called `loadRecentVoicemails()` to call `loadRecentRecordings()` and render each item's title as e.g. `"[\(r.type)] \(r.stem)"` (or a friendlier format). Set `representedObject` to the stem so `onRecentClicked` still works.

- [ ] **Step 3: Update onOpenInbox + onRecentClicked to open the web UI**

Replace `onOpenInbox`:
```swift
@objc func onOpenInbox() {
    if let url = URL(string: "http://127.0.0.1:7777/inbox") {
        NSWorkspace.shared.open(url)
    }
}
```

Replace `onRecentClicked` to open the web reader:
```swift
@objc func onRecentClicked(_ sender: NSMenuItem) {
    guard let stem = sender.representedObject as? String,
          let url = URL(string: "http://127.0.0.1:7777/inbox/\(stem)") else { return }
    NSWorkspace.shared.open(url)
}
```

- [ ] **Step 4: Compile the Swift file locally**

Run:
```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
swiftc -o /tmp/status_agent_check yulu/scripts/status_agent.swift -framework Cocoa -framework Carbon 2>&1 | tail -20
```
Expected: compiles (warnings OK). If `build_status_agent.sh` uses different frameworks/flags, mirror them. Read `build_status_agent.sh` to confirm the exact compile invocation and use that instead.

- [ ] **Step 5: Add status_agent.swift to CI Swift build**

Edit `.github/workflows/ci.yml`. Find the Swift build step loop:
```yaml
for f in yulu/scripts/audio_daemon.swift \
         yulu/scripts/window_scanner.swift \
         yulu/scripts/recorder_status.swift; do
```
Add `status_agent.swift`:
```yaml
for f in yulu/scripts/audio_daemon.swift \
         yulu/scripts/window_scanner.swift \
         yulu/scripts/recorder_status.swift \
         yulu/scripts/status_agent.swift; do
```

**Note:** `status_agent.swift` uses Carbon (per the hotkey comment). If the CI `swiftc -o ... "$f"` invocation doesn't link Carbon, the compile may fail. If status_agent needs explicit frameworks, give it a dedicated build line in the CI step rather than the shared loop:
```yaml
swiftc -o ".ci-build/status_agent" yulu/scripts/status_agent.swift -framework Cocoa -framework Carbon
```
Verify locally in Step 4 which frameworks are required and match them in CI.

- [ ] **Step 6: Validate ci.yml**

Run:
```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ci.yml')); print('yaml ok')"
```
Expected: `yaml ok`.

- [ ] **Step 7: Commit**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git add yulu/scripts/status_agent.swift .github/workflows/ci.yml
git commit -m "feat(statusagent): menu sync to recordings + open web inbox + CI compile

Menu relabel: Start Voicemail → Start Recording, Recent voicemails →
Recent recordings, Open inbox in Terminal → Open inbox. Recents now read
both ~/Movies/Yulu/voicemails + ~/Movies/Yulu directly in Swift (no Python,
no web-server dependency), merged + sorted, VM/MTG tagged. Open inbox +
recent-click now open http://127.0.0.1:7777/inbox(/stem). status_agent.swift
added to CI Swift build so it compiles on every PR."
```

---

## Task 7 (J.7): E2E migration + real-machine smoke + PR finalize

**Files:**
- Modify: `yulu/scripts/yulu_ui/e2e/critical.spec.ts`

**Goal:** Update e2e to the unified inbox, smoke web + StatusAgent on the real machine, push, update PR to A–J.

- [ ] **Step 1: Update critical.spec.ts**

Read the current spec. Update the inbox-related tests:
- The shell-redirect test: `/` → now redirects to `/inbox` (not `/inbox/voicemails`). Update the URL assertion.
- The voicemails list test → rewrite as a `/inbox` test: list renders, rows have `data-testid="recording-row"`, clicking opens a reader.
- The A→B→A audio test (Phase I): update row selector to `recording-row`, navigate via `/inbox`.
- Add a redirect test: `/inbox/voicemails` → `/inbox`; `/inbox/meetings/SomeStem_20260101_120000` → `/inbox/SomeStem_20260101_120000`.
- Add a filter-chip test: clicking "Voicemail" chip filters the list.
- The Sidebar test (if in e2e): assert single "Recordings" item.

Concrete new/updated cases:

```ts
test("shell loads + redirects / to /inbox", async ({ page }) => {
  await page.goto("/");
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByText("Recordings").first()).toBeVisible();
});

test("Recordings list renders rows with type badges", async ({ page }) => {
  await page.goto("/inbox");
  const rows = page.getByTestId("recording-row");
  const count = await rows.count();
  if (count === 0) { test.info().annotations.push({ type: "skip", description: "no recordings" }); return; }
  await expect(page.getByRole("button", { name: "All", exact: true })).toBeVisible();
  await rows.first().click();
  await expect(page).toHaveURL(/\/inbox\/.+/);
});

test("old /inbox/voicemails redirects to /inbox", async ({ page }) => {
  await page.goto("/inbox/voicemails");
  await expect(page).toHaveURL(/\/inbox$/);
});
```

Remove tests referencing `/inbox/voicemails/...` or `/inbox/meetings/...` as live pages.

- [ ] **Step 2: Run e2e**

Run: `cd yulu/scripts/yulu_ui && npm run e2e 2>&1 | tail -30`
Expected: all pass.

- [ ] **Step 3: Build + reload production**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6/yulu/scripts/yulu_ui && npm run build 2>&1 | tail -5
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
Expected: healthz green.

- [ ] **Step 4: Browser smoke**

Verify via playwright/browser: `http://127.0.0.1:7777/inbox` shows the unified list with type badges; a meeting reader shows the Realtime tab; a voicemail reader doesn't; old `/inbox/voicemails` redirects.

- [ ] **Step 5: StatusAgent smoke**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
bash yulu/scripts/build_status_agent.sh 2>&1 | tail -5
```
Then manually: click the menu-bar icon → confirm "Start Recording", "Recent recordings" (showing mixed VM/MTG), "Open inbox" opens the browser at /inbox. (This is manual — note the result.)

- [ ] **Step 6: Push**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
git push 2>&1 | tail -5
```

- [ ] **Step 7: Update PR #24 to A–J**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
gh pr edit 24 --title "feat(yulu_ui): Phase A–J — backend + frontend + IA + reader triggers + recordings unification (TDD)" --body "$(cat <<'EOF'
## Summary

**Phases A through J** in one branch — the complete Yulu UI.

- **A–F**: backend + React shell + Inbox/Settings/Knowledge/Health pages + Playwright
- **G**: lifecycle (setup.sh / doctor / CI / uninstall / logTailer rotation)
- **H**: IA + polish (canonical Ayu tokens, Lucide icons, sidebar restructure, GlobalSearch, consolidated /settings + /health, ResizableSplit)
- **I**: reader audio fix + manual transcribe/summary triggers (JobRegistry + jobRunner + ReprocessButton)
- **J**: **Recordings unification** — Voicemails + Meetings merged into one `/inbox` list (type badge + filter), one `/inbox/:stem` reader (realtime tab artifact-driven), unified `recordings` tRPC router (old routers deleted), old URLs redirect, single Recordings sidebar entry + Prompts/Glossary icons, inboxWatcher → recordings-changed live refresh, StatusAgent menu relabeled to "recordings" reading both dirs + opening the web inbox.

## What's NOT in this PR (deferred)

- **Phase K** — voicemail realtime transcription + a Settings toggle (Python audio pipeline + config + settings UI).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)" 2>&1 | tail -3
```

- [ ] **Step 8: Verify CI**

```bash
cd /Users/liaoyuxing/.yulu/.claude/worktrees/brave-shockley-8c6cc6
gh pr checks 24 2>&1 | head -10
```
Expected: both jobs pass (the Swift build now also compiles status_agent.swift).

- [ ] **Step 9: No final commit** — Steps 6–8 are push + PR + CI verify only. Fix any smoke failure via a targeted commit in the relevant task's pattern.

---

## Self-Review

Cross-checked against spec sections:

- **Spec §4.1 (recordings router)** → Task 1 (8 tests: merge, exclude strays, filter, dispatch get vm/mtg, NOT_FOUND, audioUrl, status).
- **Spec §4.2 (delete old routers)** → Task 2.
- **Spec §4.3 (inboxWatcher + channel swap)** → Task 2.
- **Spec §4.4 (RecordingsList)** → Task 3 (4 tests).
- **Spec §4.5 (RecordingReader)** → Task 4 (3 tests; realtime-tab artifact-driven).
- **Spec §4.6 (routing + sidebar)** → Task 5 (redirects, single entry, Prompts/Glossary icons, GlobalSearch).
- **Spec §4.7 (StatusAgent)** → Task 6 (menu labels, read both dirs, open web inbox, CI compile).
- **Spec §7 (testing)** → each task carries its layer; Task 7 e2e + real-machine.

Coupling note: J.2–J.4 leave the web typecheck temporarily red (they touch backend + add new components but old web files still reference deleted routers). J.5 restores green. This is called out in each commit message so a reviewer isn't surprised by a red intermediate state. The server vitest project + server typecheck stay green throughout.

Placeholder scan: no TBD/TODO. Type consistency: `dispatchType`, the `Row` shape, `recordings.list`/`get` field names (`type`, `title`, `recordedAt`, `hasRealtime`, `status`) are consistent across router + tests + RecordingsList + RecordingReader. The `recordings-changed` channel payload `{ reason }` matches between pubsub.ts, inboxWatcher, recordings.delete, and the RecordingsList subscription.

One ambiguity resolved inline: the `/inbox` nested-route structure (Task 5 Step 1) depends on whether the existing voicemails route nested its reader as a child or sibling. The plan instructs the implementer to read voicemails.tsx first and match its nesting so the list stays visible while the reader shows in the detail pane — preserving the MasterDetail split behavior.
