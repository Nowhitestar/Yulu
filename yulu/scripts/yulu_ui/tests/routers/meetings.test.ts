import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { meetingsRouter } from "../../src/routers/meetings.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { JobRegistry } from "../../src/jobStatus.js";

function makeCtx(opts?: { withWavs?: boolean }) {
  const withWavs = opts?.withWavs ?? true;
  const dir = mkdtempSync(join(tmpdir(), "yulu_meet_"));
  mkdirSync(join(dir, "voicemails"));
  if (withWavs) {
    writeFileSync(join(dir, "voicemails/voicemail_20260526_100000.wav"), Buffer.alloc(0));
    writeFileSync(join(dir, "WeeklyStandup_20260520_100000.wav"), Buffer.alloc(0));
    writeFileSync(join(dir, "WeeklyStandup_20260520_100000.transcript.txt"), "agenda");
    writeFileSync(join(dir, "WeeklyStandup_20260520_100000.realtime.transcript.txt"), "noisy live");
    writeFileSync(join(dir, "1on1_20260521_140000.wav"), Buffer.alloc(0));
  }
  const jobs = new JobRegistry();
  const ctx = {
    paths: { moviesDir: dir, voicemailsDir: join(dir, "voicemails"), transcribePy: "/tmp/_unused.py", agentQueueJson: join(dir, "agent-queue.json") },
    pubsub: { publish: () => {} },
    jobs,
    config: { read: () => ({ llm: {} }) },
  } as unknown as AppContext;
  return { ctx, dir, jobs, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("meetingsRouter", () => {
  it("list() excludes voicemails subdir and matches <title>_DATE_TIME stems", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(meetingsRouter, ctx);
      const rows = (await caller.list({})) as Array<{ meetingTitle: string }>;
      const titles = rows.map((r) => r.meetingTitle).sort();
      expect(titles).toEqual(["1on1", "WeeklyStandup"]);
    } finally { cleanup(); }
  });

  it("get() includes realtime transcript when present", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(meetingsRouter, ctx);
      const r = await caller.get({ stem: "WeeklyStandup_20260520_100000" });
      expect(r.transcript).toBe("agenda");
      expect(r.realtime).toBe("noisy live");
    } finally { cleanup(); }
  });

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

  it("transcribe throws NOT_FOUND when WAV missing", async () => {
    const { ctx, cleanup } = makeCtx({ withWavs: false });
    try {
      const caller = createCaller(meetingsRouter, ctx);
      await expect(caller.transcribe({ stem: "TestMeeting_20260101_120000" }))
        .rejects.toThrow(/WAV file missing/);
    } finally { cleanup(); }
  });

  it("summarize throws PRECONDITION_FAILED when transcript missing", async () => {
    const { ctx, dir, cleanup } = makeCtx({ withWavs: false });
    try {
      writeFileSync(join(dir, "TestMeeting_20260101_120000.wav"), Buffer.alloc(0));
      const caller = createCaller(meetingsRouter, ctx);
      await expect(caller.summarize({ stem: "TestMeeting_20260101_120000" }))
        .rejects.toThrow(/Transcript missing/);
    } finally { cleanup(); }
  });

  it("list() returns status='summarizing' when registry has entry", async () => {
    const { ctx, jobs, cleanup } = makeCtx();
    try {
      jobs.set({
        stem: "WeeklyStandup_20260520_100000",
        action: "summarize",
        state: "summarizing",
        startedAt: Date.now(),
        jobId: "j1",
      });
      const caller = createCaller(meetingsRouter, ctx);
      const rows = (await caller.list({})) as Array<{ stem: string; status: string }>;
      const r = rows.find((row) => row.stem === "WeeklyStandup_20260520_100000")!;
      expect(r.status).toBe("summarizing");
    } finally { cleanup(); }
  });
});
