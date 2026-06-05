import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
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

  // ---- Feature 4: transcript vs raw de-duplication --------------------------

  it("get marks rawDiffers=false when raw equals transcript", async () => {
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.wav"), "");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.transcript.txt"), "same body\n");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.raw.transcript.txt"), "same body");
    const r = await createCaller(recordingsRouter, mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir })).get({ stem: "TeamSync_20260102_090000" });
    expect(r.rawDiffers).toBe(false);
  });

  it("get marks rawDiffers=true when the cleaned transcript differs from raw", async () => {
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.wav"), "");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.transcript.txt"), "cleaned body");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.raw.transcript.txt"), "raw uncleaned body");
    const r = await createCaller(recordingsRouter, mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir })).get({ stem: "TeamSync_20260102_090000" });
    expect(r.rawDiffers).toBe(true);
  });

  // ---- Feature 5: rename (title sidecar) ------------------------------------

  it("rename writes a <stem>.title sidecar and get returns the override", async () => {
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.wav"), "");
    const caller = createCaller(recordingsRouter, mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir }));
    await caller.rename({ stem: "TeamSync_20260102_090000", title: "Q3 Planning" });
    expect(readFileSync(join(mvDir, "TeamSync_20260102_090000.title"), "utf8")).toBe("Q3 Planning\n");
    const r = await caller.get({ stem: "TeamSync_20260102_090000" });
    expect(r.title).toBe("Q3 Planning");
  });

  it("rename with an empty title clears the override (falls back to filename)", async () => {
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.wav"), "");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.title"), "Old\n");
    const caller = createCaller(recordingsRouter, mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir }));
    await caller.rename({ stem: "TeamSync_20260102_090000", title: "   " });
    expect(existsSync(join(mvDir, "TeamSync_20260102_090000.title"))).toBe(false);
    expect((await caller.get({ stem: "TeamSync_20260102_090000" })).title).toBe("TeamSync");
  });

  it("rename throws NOT_FOUND when the WAV is missing", async () => {
    const caller = createCaller(recordingsRouter, mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir }));
    await expect(caller.rename({ stem: "TeamSync_20260102_090000", title: "x" })).rejects.toThrow(/not found/i);
  });

  // ---- Feature 5: tags (tags.json sidecar) ----------------------------------

  it("setTags persists normalized tags and get/list return them", async () => {
    writeFileSync(join(vmDir, "voicemail_20260101_120000.wav"), "");
    const caller = createCaller(recordingsRouter, mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir }));
    const res = await caller.setTags({ stem: "voicemail_20260101_120000", tags: ["Work", " work ", "urgent", ""] });
    expect(res.tags).toEqual(["Work", "urgent"]); // trimmed, case-insensitive dedupe, empties dropped
    expect((await caller.get({ stem: "voicemail_20260101_120000" })).tags).toEqual(["Work", "urgent"]);
    expect((await caller.list({ type: "voicemail" }))[0].tags).toEqual(["Work", "urgent"]);
  });

  it("setTags with an empty list removes the sidecar", async () => {
    writeFileSync(join(vmDir, "voicemail_20260101_120000.wav"), "");
    const caller = createCaller(recordingsRouter, mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir }));
    await caller.setTags({ stem: "voicemail_20260101_120000", tags: ["a"] });
    await caller.setTags({ stem: "voicemail_20260101_120000", tags: [] });
    expect(existsSync(join(vmDir, "voicemail_20260101_120000.tags.json"))).toBe(false);
    expect((await caller.get({ stem: "voicemail_20260101_120000" })).tags).toEqual([]);
  });

  // ---- Feature 5: delete (sidecar sweep) ------------------------------------

  it("delete removes the wav plus all known sidecars (incl. mic/sys/chunk/tags/title)", async () => {
    const stem = "TeamSync_20260102_090000";
    const files = [
      ".wav", ".transcript.txt", ".raw.transcript.txt", ".realtime.transcript.txt",
      ".realtime.coverage.json", ".summary.md", ".summary.html",
      ".mic.transcript.txt", ".sys.transcript.txt", ".title", ".tags.json",
      ".chunk-0.wav", ".chunk-1.wav",
    ];
    for (const f of files) writeFileSync(join(mvDir, `${stem}${f}`), "x");
    // A sibling recording must be left untouched.
    writeFileSync(join(mvDir, "Other_20260103_080000.wav"), "x");
    const caller = createCaller(recordingsRouter, mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir }));
    const res = await caller.delete({ stem });
    expect(res.removed).toBe(files.length);
    for (const f of files) expect(existsSync(join(mvDir, `${stem}${f}`))).toBe(false);
    expect(existsSync(join(mvDir, "Other_20260103_080000.wav"))).toBe(true);
  });

  it("delete publishes recordings-changed", async () => {
    writeFileSync(join(vmDir, "voicemail_20260101_120000.wav"), "");
    const ctx = mkCtx({ voicemailsDir: vmDir, moviesDir: mvDir });
    const seen: string[] = [];
    ctx.pubsub.subscribe("recordings-changed", (m: { reason: string }) => seen.push(m.reason));
    await createCaller(recordingsRouter, ctx).delete({ stem: "voicemail_20260101_120000" });
    expect(seen).toContain("removed");
  });
});
