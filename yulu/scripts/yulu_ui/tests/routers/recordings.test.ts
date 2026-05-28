import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingsRouter } from "../../src/routers/recordings.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { JobRegistry } from "../../src/jobStatus.js";
import { PubSub, type AppChannels } from "../../src/pubsub.js";

function mkCtx(opts: { voicemailsDir: string; moviesDir: string }): AppContext {
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
  } as unknown as AppContext;
}

describe("recordings router", () => {
  let root: string; let vmDir: string; let mvDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rec_"));
    vmDir = join(root, "voicemails"); mvDir = join(root, "movies");
    mkdirSync(vmDir); mkdirSync(mvDir);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("list merges voicemails + meetings with type tags, sorted by mtime desc", async () => {
    writeFileSync(join(vmDir, "voicemail_20260101_120000.wav"), "");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.wav"), "");
    const caller = createCaller(recordingsRouter, mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir }));
    const rows = await caller.list({});
    expect(rows.length).toBe(2);
    const types = rows.map((r: { type: string }) => r.type);
    expect(types).toContain("voicemail");
    expect(types).toContain("meeting");
    expect(rows.find((r: { type: string }) => r.type === "meeting").title).toBe("TeamSync");
    expect(rows.find((r: { type: string }) => r.type === "voicemail").title).toBeNull();
  });

  it("list excludes voicemail_* from the movies dir", async () => {
    writeFileSync(join(mvDir, "voicemail_20260101_120000.wav"), "");
    const caller = createCaller(recordingsRouter, mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir }));
    expect((await caller.list({})).length).toBe(0);
  });

  it("list type filter returns only that type", async () => {
    writeFileSync(join(vmDir, "voicemail_20260101_120000.wav"), "");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.wav"), "");
    const caller = createCaller(recordingsRouter, mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir }));
    expect((await caller.list({ type: "voicemail" })).length).toBe(1);
    expect((await caller.list({ type: "meeting" })).length).toBe(1);
  });

  it("get dispatches a voicemail stem to voicemailsDir", async () => {
    writeFileSync(join(vmDir, "voicemail_20260101_120000.wav"), "");
    writeFileSync(join(vmDir, "voicemail_20260101_120000.transcript.txt"), "hi there");
    const caller = createCaller(recordingsRouter, mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir }));
    const r = await caller.get({ stem: "voicemail_20260101_120000" });
    expect(r.type).toBe("voicemail");
    expect(r.transcript).toBe("hi there");
    expect(r.realtime).toBeNull();
  });

  it("get dispatches a meeting stem to moviesDir and includes realtime", async () => {
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.wav"), "");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.realtime.transcript.txt"), "live text");
    const caller = createCaller(recordingsRouter, mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir }));
    const r = await caller.get({ stem: "TeamSync_20260102_090000" });
    expect(r.type).toBe("meeting");
    expect(r.realtime).toBe("live text");
    expect(r.title).toBe("TeamSync");
  });

  it("transcribe throws NOT_FOUND when WAV missing", async () => {
    const caller = createCaller(recordingsRouter, mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir }));
    await expect(caller.transcribe({ stem: "voicemail_20260101_120000" })).rejects.toThrow(/WAV file missing/);
  });

  it("list reflects JobRegistry status", async () => {
    writeFileSync(join(vmDir, "voicemail_20260101_120000.wav"), "");
    const ctx = mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir });
    ctx.jobs.set({ stem: "voicemail_20260101_120000", action: "transcribe", state: "transcribing", startedAt: Date.now(), jobId: "j1" });
    expect((await createCaller(recordingsRouter, ctx).list({}))[0].status).toBe("transcribing");
  });
});
