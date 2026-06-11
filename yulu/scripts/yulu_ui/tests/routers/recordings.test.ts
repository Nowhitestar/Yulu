import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingsRouter } from "../../src/routers/recordings.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { JobRegistry } from "../../src/jobStatus.js";
import { PubSub, type AppChannels } from "../../src/pubsub.js";

function mkCtx(opts: { moviesDir: string }): AppContext {
  return {
    paths: {
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
  let root: string; let mvDir: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "rec_"));
    mvDir = join(root, "movies");
    mkdirSync(mvDir);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("list returns every recording in the root, sorted by mtime desc", async () => {
    writeFileSync(join(mvDir, "Memo_20260101_120000.wav"), "");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.wav"), "");
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    const rows = await caller.list({});
    expect(rows.length).toBe(2);
    expect(rows.find((r: { stem: string }) => r.stem === "TeamSync_20260102_090000")!.title).toBe("TeamSync");
    // A migrated memo derives its title from the Memo_ stem prefix.
    expect(rows.find((r: { stem: string }) => r.stem === "Memo_20260101_120000")!.title).toBe("Memo");
  });

  it("list includes a (migrated) Memo_* recording", async () => {
    writeFileSync(join(mvDir, "Memo_20260101_120000.wav"), "");
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    const rows = await caller.list({});
    expect(rows.length).toBe(1);
    expect(rows[0].stem).toBe("Memo_20260101_120000");
  });

  it("get reads a recording from the root and includes realtime", async () => {
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.wav"), "");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.realtime.transcript.txt"), "live text");
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    const r = await caller.get({ stem: "TeamSync_20260102_090000" });
    expect(r.realtime).toBe("live text");
    expect(r.title).toBe("TeamSync");
  });

  it("get prefers clean audio for playback when present", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), "");
    writeFileSync(join(mvDir, `${stem}.clean.wav`), "");
    const r = await createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir })).get({ stem });
    expect(r.audioFile).toBe(`${stem}.clean.wav`);
  });

  it("get reads a migrated Memo_* recording", async () => {
    writeFileSync(join(mvDir, "Memo_20260101_120000.wav"), "");
    writeFileSync(join(mvDir, "Memo_20260101_120000.transcript.txt"), "hi there");
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    const r = await caller.get({ stem: "Memo_20260101_120000" });
    expect(r.transcript).toBe("hi there");
    expect(r.title).toBe("Memo");
  });

  it("get includes speaker sidecar data when present", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), "");
    writeFileSync(join(mvDir, `${stem}.speakers.json`), JSON.stringify({
      schema_version: 1,
      provider: "sherpa-onnx",
      segments: [{ start: 0, end: 1, text: "hello", speaker_id: "spk-0", display_name: "Speaker 1", confident: true }],
      speakers: { "spk-0": { display_name: "Speaker 1", renamed: false, merged_into: null } },
    }));
    const r = await createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir })).get({ stem });
    expect(r.speakerData.provider).toBe("sherpa-onnx");
    expect(r.speakerData.segments[0].display_name).toBe("Speaker 1");
  });

  it("transcribe throws NOT_FOUND when WAV missing", async () => {
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    await expect(caller.transcribe({ stem: "Memo_20260101_120000" })).rejects.toThrow(/WAV file missing/);
  });

  it("list reflects JobRegistry status", async () => {
    writeFileSync(join(mvDir, "Memo_20260101_120000.wav"), "");
    const ctx = mkCtx({ moviesDir: mvDir });
    ctx.jobs.set({ stem: "Memo_20260101_120000", action: "transcribe", state: "transcribing", startedAt: Date.now(), jobId: "j1" });
    expect((await createCaller(recordingsRouter, ctx).list({}))[0].status).toBe("transcribing");
  });

  it("marks a non-WAV recording file as recording_failed", async () => {
    const stem = "GoogleChrome_20260611_160424";
    writeFileSync(join(mvDir, `${stem}.wav`), JSON.stringify({ type: "recording_crashed" }));
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    const row = (await caller.list({}))[0];
    const detail = await caller.get({ stem });
    expect(row.status).toBe("recording_failed");
    expect(row.statusError).toMatch(/valid WAV/);
    expect(detail.status).toBe("recording_failed");
  });

  // ---- transcript vs raw de-duplication -------------------------------------

  it("get marks rawDiffers=false when raw equals transcript", async () => {
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.wav"), "");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.transcript.txt"), "same body\n");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.raw.transcript.txt"), "same body");
    const r = await createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir })).get({ stem: "TeamSync_20260102_090000" });
    expect(r.rawDiffers).toBe(false);
  });

  it("get marks rawDiffers=true when the cleaned transcript differs from raw", async () => {
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.wav"), "");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.transcript.txt"), "cleaned body");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.raw.transcript.txt"), "raw uncleaned body");
    const r = await createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir })).get({ stem: "TeamSync_20260102_090000" });
    expect(r.rawDiffers).toBe(true);
  });

  // ---- rename (title sidecar) -----------------------------------------------

  it("rename writes a <stem>.title sidecar and get returns the override", async () => {
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.wav"), "");
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    await caller.rename({ stem: "TeamSync_20260102_090000", title: "Q3 Planning" });
    expect(readFileSync(join(mvDir, "TeamSync_20260102_090000.title"), "utf8")).toBe("Q3 Planning\n");
    const r = await caller.get({ stem: "TeamSync_20260102_090000" });
    expect(r.title).toBe("Q3 Planning");
  });

  it("rename with an empty title clears the override (falls back to filename)", async () => {
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.wav"), "");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.title"), "Old\n");
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    await caller.rename({ stem: "TeamSync_20260102_090000", title: "   " });
    expect(existsSync(join(mvDir, "TeamSync_20260102_090000.title"))).toBe(false);
    expect((await caller.get({ stem: "TeamSync_20260102_090000" })).title).toBe("TeamSync");
  });

  it("rename throws NOT_FOUND when the WAV is missing", async () => {
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    await expect(caller.rename({ stem: "TeamSync_20260102_090000", title: "x" })).rejects.toThrow(/not found/i);
  });

  // ---- tags (tags.json sidecar) ---------------------------------------------

  it("setTags persists normalized tags and get/list return them", async () => {
    writeFileSync(join(mvDir, "Memo_20260101_120000.wav"), "");
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    const res = await caller.setTags({ stem: "Memo_20260101_120000", tags: ["Work", " work ", "urgent", ""] });
    expect(res.tags).toEqual(["Work", "urgent"]); // trimmed, case-insensitive dedupe, empties dropped
    expect((await caller.get({ stem: "Memo_20260101_120000" })).tags).toEqual(["Work", "urgent"]);
    expect((await caller.list({}))[0].tags).toEqual(["Work", "urgent"]);
  });

  it("setTags with an empty list removes the sidecar", async () => {
    writeFileSync(join(mvDir, "Memo_20260101_120000.wav"), "");
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    await caller.setTags({ stem: "Memo_20260101_120000", tags: ["a"] });
    await caller.setTags({ stem: "Memo_20260101_120000", tags: [] });
    expect(existsSync(join(mvDir, "Memo_20260101_120000.tags.json"))).toBe(false);
    expect((await caller.get({ stem: "Memo_20260101_120000" })).tags).toEqual([]);
  });

  // ---- speaker sidecar edits -----------------------------------------------

  it("renameSpeaker updates the sidecar and re-renders the transcript", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), "");
    writeSpeakerFixture(mvDir, stem);
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    await caller.renameSpeaker({ stem, speakerId: "spk-0", displayName: "Lewis" });
    const doc = JSON.parse(readFileSync(join(mvDir, `${stem}.speakers.json`), "utf8"));
    expect(doc.speakers["spk-0"].display_name).toBe("Lewis");
    expect(doc.speakers["spk-0"].renamed).toBe(true);
    expect(readFileSync(join(mvDir, `${stem}.transcript.txt`), "utf8")).toContain("[00:00 Lewis] hello");
  });

  it("renameSpeaker preserves cleaned tagged transcript bodies", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), "");
    writeSpeakerFixture(mvDir, stem);
    writeFileSync(
      join(mvDir, `${stem}.transcript.txt`),
      "[00:00 Speaker 1] cleaned hello\n[00:02 Speaker 2] cleaned world",
    );
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    await caller.renameSpeaker({ stem, speakerId: "spk-0", displayName: "Lewis" });
    expect(readFileSync(join(mvDir, `${stem}.transcript.txt`), "utf8")).toBe(
      "[00:00 Lewis] cleaned hello\n[00:02 Speaker 2] cleaned world",
    );
  });

  it("renameSpeaker does not overwrite an untagged cleaned transcript", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), "");
    writeSpeakerFixture(mvDir, stem);
    writeFileSync(join(mvDir, `${stem}.transcript.txt`), "cleaned paragraph\n\nwith structure");
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    await caller.renameSpeaker({ stem, speakerId: "spk-0", displayName: "Lewis" });
    expect(readFileSync(join(mvDir, `${stem}.transcript.txt`), "utf8")).toBe("cleaned paragraph\n\nwith structure");
    const doc = JSON.parse(readFileSync(join(mvDir, `${stem}.speakers.json`), "utf8"));
    expect(doc.speakers["spk-0"].display_name).toBe("Lewis");
  });

  it("mergeSpeakers rewrites affected segments to the surviving speaker", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), "");
    writeSpeakerFixture(mvDir, stem);
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    await caller.mergeSpeakers({ stem, fromSpeakerId: "spk-1", toSpeakerId: "spk-0" });
    const doc = JSON.parse(readFileSync(join(mvDir, `${stem}.speakers.json`), "utf8"));
    expect(doc.speakers["spk-1"].merged_into).toBe("spk-0");
    expect(doc.segments.map((s: { speaker_id: string }) => s.speaker_id)).toEqual(["spk-0", "spk-0"]);
    expect(readFileSync(join(mvDir, `${stem}.transcript.txt`), "utf8")).not.toContain("Speaker 2");
  });

  it("assignSegmentSpeaker marks one segment as a manual correction", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), "");
    writeSpeakerFixture(mvDir, stem);
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    await caller.assignSegmentSpeaker({ stem, segmentIndex: 1, speakerId: "spk-0" });
    const doc = JSON.parse(readFileSync(join(mvDir, `${stem}.speakers.json`), "utf8"));
    expect(doc.segments[1]).toMatchObject({ speaker_id: "spk-0", source: "manual", confident: true });
    expect(readFileSync(join(mvDir, `${stem}.transcript.txt`), "utf8")).toContain("[00:02 Speaker 1] world");
  });

  // ---- delete (sidecar sweep) -----------------------------------------------

  it("delete removes the wav plus all known sidecars (incl. speakers/mic/sys/chunk/tags/title)", async () => {
    const stem = "TeamSync_20260102_090000";
    const files = [
      ".wav", ".transcript.txt", ".raw.transcript.txt", ".realtime.transcript.txt",
      ".realtime.coverage.json", ".summary.md", ".summary.html", ".speakers.json",
      ".mic.transcript.txt", ".sys.transcript.txt", ".title", ".tags.json",
      ".chunk-0.wav", ".chunk-1.wav",
    ];
    for (const f of files) writeFileSync(join(mvDir, `${stem}${f}`), "x");
    // A sibling recording must be left untouched.
    writeFileSync(join(mvDir, "Other_20260103_080000.wav"), "x");
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    const res = await caller.delete({ stem });
    expect(res.removed).toBe(files.length);
    for (const f of files) expect(existsSync(join(mvDir, `${stem}${f}`))).toBe(false);
    expect(existsSync(join(mvDir, "Other_20260103_080000.wav"))).toBe(true);
  });

  it("delete publishes recordings-changed", async () => {
    writeFileSync(join(mvDir, "Memo_20260101_120000.wav"), "");
    const ctx = mkCtx({ moviesDir: mvDir });
    const seen: string[] = [];
    ctx.pubsub.subscribe("recordings-changed", (m: { reason: string }) => seen.push(m.reason));
    await createCaller(recordingsRouter, ctx).delete({ stem: "Memo_20260101_120000" });
    expect(seen).toContain("removed");
  });
});

function writeSpeakerFixture(dir: string, stem: string) {
  writeFileSync(join(dir, `${stem}.speakers.json`), JSON.stringify({
    schema_version: 1,
    provider: "sherpa-onnx",
    num_speakers_detected: 2,
    segments: [
      { start: 0, end: 1, text: "hello", speaker_id: "spk-0", display_name: "Speaker 1", source: "overlap", confident: true },
      { start: 2, end: 3, text: "world", speaker_id: "spk-1", display_name: "Speaker 2", source: "nearest", confident: false },
    ],
    speakers: {
      "spk-0": { display_name: "Speaker 1", renamed: false, merged_into: null },
      "spk-1": { display_name: "Speaker 2", renamed: false, merged_into: null },
    },
  }));
}
