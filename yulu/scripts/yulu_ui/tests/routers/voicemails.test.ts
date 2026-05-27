import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { voicemailsRouter } from "../../src/routers/voicemails.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { JobRegistry } from "../../src/jobStatus.js";

interface VmCtx { ctx: AppContext; voicemailsDir: string; jobs: JobRegistry; cleanup: () => void }

function makeCtx(opts?: { withWavs?: boolean }): VmCtx {
  const withWavs = opts?.withWavs ?? true;
  const dir = mkdtempSync(join(tmpdir(), "yulu_vm_"));
  const voicemailsDir = join(dir, "voicemails");
  mkdirSync(voicemailsDir);
  if (withWavs) {
    writeFileSync(join(voicemailsDir, "voicemail_20260526_100000.wav"), Buffer.alloc(1024));
    writeFileSync(join(voicemailsDir, "voicemail_20260526_100000.transcript.txt"), "hello world");
    writeFileSync(join(voicemailsDir, "voicemail_20260526_110000.wav"), Buffer.alloc(2048));
    writeFileSync(join(voicemailsDir, "voicemail_20260526_120000.wav"), Buffer.alloc(512));
    writeFileSync(join(voicemailsDir, "voicemail_20260526_120000.transcript.txt"), "second message");
    writeFileSync(join(voicemailsDir, "voicemail_20260526_120000.summary.md"), "## summary\nbullet");
    const now = Date.now();
    // Force mtime ordering: 120000 newest, 110000 middle, 100000 oldest
    utimesSync(join(voicemailsDir, "voicemail_20260526_100000.wav"), new Date(now - 20000), new Date(now - 20000));
    utimesSync(join(voicemailsDir, "voicemail_20260526_110000.wav"), new Date(now - 10000), new Date(now - 10000));
    utimesSync(join(voicemailsDir, "voicemail_20260526_120000.wav"), new Date(now), new Date(now));
  }
  const jobs = new JobRegistry();
  const ctx = {
    paths: { voicemailsDir, transcribePy: "/tmp/_unused_transcribe.py", agentQueueJson: join(dir, "agent-queue.json") },
    pubsub: { publish: () => {} },
    jobs,
    config: { read: () => ({ llm: {} }) },
  } as unknown as AppContext;
  return { ctx, voicemailsDir, jobs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("voicemailsRouter", () => {
  it("list() returns newest-first with transcript+summary presence flags", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(voicemailsRouter, ctx);
      const rows = (await caller.list({})) as Array<{ stem: string; hasTranscript: boolean; hasSummary: boolean }>;
      expect(rows.map((r) => r.stem)).toEqual([
        "voicemail_20260526_120000",
        "voicemail_20260526_110000",
        "voicemail_20260526_100000",
      ]);
      expect(rows[0]!.hasTranscript).toBe(true);
      expect(rows[0]!.hasSummary).toBe(true);
      expect(rows[1]!.hasTranscript).toBe(false);
    } finally { cleanup(); }
  });

  it("get() returns transcript + summary content", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(voicemailsRouter, ctx);
      const r = await caller.get({ stem: "voicemail_20260526_120000" });
      expect(r.transcript).toBe("second message");
      expect(r.summary).toContain("bullet");
    } finally { cleanup(); }
  });

  it("delete() removes wav + sidecars", async () => {
    const { ctx, voicemailsDir, cleanup } = makeCtx();
    try {
      const caller = createCaller(voicemailsRouter, ctx);
      await caller.delete({ stem: "voicemail_20260526_100000" });
      expect(existsSync(join(voicemailsDir, "voicemail_20260526_100000.wav"))).toBe(false);
      expect(existsSync(join(voicemailsDir, "voicemail_20260526_100000.transcript.txt"))).toBe(false);
    } finally { cleanup(); }
  });

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
      const { unlinkSync } = await import("node:fs");
      unlinkSync(join(voicemailsDir, "voicemail_20260526_120000.transcript.txt"));
      const caller = createCaller(voicemailsRouter, ctx);
      const rows = (await caller.list({})) as Array<{ stem: string; firstWords: string | null }>;
      const r120 = rows.find((r) => r.stem === "voicemail_20260526_120000")!;
      expect(r120.firstWords).toBeNull();
    } finally { cleanup(); }
  });

  it("transcribe throws NOT_FOUND when WAV missing", async () => {
    const { ctx, cleanup } = makeCtx({ withWavs: false });
    try {
      const caller = createCaller(voicemailsRouter, ctx);
      await expect(caller.transcribe({ stem: "voicemail_20260101_120000" }))
        .rejects.toThrow(/WAV file missing/);
    } finally { cleanup(); }
  });

  it("summarize throws PRECONDITION_FAILED when transcript missing", async () => {
    const { ctx, voicemailsDir, cleanup } = makeCtx({ withWavs: false });
    try {
      // Create only a wav, no transcript
      writeFileSync(join(voicemailsDir, "voicemail_20260101_120000.wav"), Buffer.alloc(64));
      const caller = createCaller(voicemailsRouter, ctx);
      await expect(caller.summarize({ stem: "voicemail_20260101_120000" }))
        .rejects.toThrow(/Transcript missing/);
    } finally { cleanup(); }
  });

  it("list() returns status='transcribing' when registry has entry", async () => {
    const { ctx, jobs, cleanup } = makeCtx();
    try {
      jobs.set({
        stem: "voicemail_20260526_120000",
        action: "transcribe",
        state: "transcribing",
        startedAt: Date.now(),
        jobId: "j1",
      });
      const caller = createCaller(voicemailsRouter, ctx);
      const rows = (await caller.list({})) as Array<{ stem: string; status: string }>;
      const r = rows.find((row) => row.stem === "voicemail_20260526_120000")!;
      expect(r.status).toBe("transcribing");
    } finally { cleanup(); }
  });
});
