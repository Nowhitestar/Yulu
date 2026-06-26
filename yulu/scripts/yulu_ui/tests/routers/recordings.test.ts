import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { chmodSync, mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingsRouter } from "../../src/routers/recordings.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { JobRegistry } from "../../src/jobStatus.js";
import { PubSub, type AppChannels } from "../../src/pubsub.js";

const spawnMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: spawnMock };
});

let lastSpawnStdin = "";

function mkCtx(opts: { moviesDir: string }): AppContext {
  const configState = {
    transcription: {
      final_engine: "mlx",
      local_model_path: "~/.config/yulu/models/ggml-large-v3.bin",
      mlx: { model: "mlx-community/whisper-large-v3-mlx" },
    },
    llm: { enabled: true, command: null, agent: { provider: "custom" } },
    connectors: {},
    output: {},
    agent_console: { plugins: { added: ["summary"] } },
  };
  const promptRows: Array<Record<string, unknown>> = [];
  const promptsDb = {
    prepare: (sql: string) => ({
      all: (..._args: unknown[]) => {
        if (sql.includes("FROM prompts")) return promptRows;
        return [];
      },
      get: (...args: unknown[]) => {
        if (!sql.includes("FROM prompts")) return undefined;
        if (sql.includes("id = ?")) return promptRows.find((row) => row.id === args[0] && row.category === args[1]);
        if (sql.includes("slug = ?")) return promptRows.find((row) => row.slug === args[0] && row.category === args[1]);
        return promptRows.find((row) => row.category === args[0]);
      },
    }),
    __rows: promptRows,
  };
  return {
    paths: {
      moviesDir: opts.moviesDir,
      configDir: join(opts.moviesDir, "config"),
      transcribePy: "/fake/transcribe.py",
      agentQueueJson: join(opts.moviesDir, "agent-queue.json"),
      scriptDir: "/fake/yulu/scripts",
    },
    jobs: new JobRegistry(),
    pubsub: new PubSub<AppChannels>(),
    config: {
      read: () => configState,
      update: (key: string, value: unknown) => {
        const parts = key.split(".");
        let cursor = configState as Record<string, unknown>;
        for (let i = 0; i < parts.length - 1; i++) {
          const part = parts[i]!;
          cursor[part] = (cursor[part] ?? {}) as Record<string, unknown>;
          cursor = cursor[part] as Record<string, unknown>;
        }
        cursor[parts[parts.length - 1]!] = value;
        return { daemonsNeedingRestart: ["sttdaemon"], daemonsNeedingSighup: [] };
      },
    },
    launchctl: { restart: vi.fn(), status: vi.fn(), start: vi.fn(), stop: vi.fn(), sighup: vi.fn() },
    db: { prompts: promptsDb },
  } as unknown as AppContext;
}

function mockSpawn(stdout: string, exitCode = 0, stderr = "") {
  spawnMock.mockImplementation(() => {
    const handlers = new Map<string, (arg: unknown) => void>();
    const proc = {
      stdin: {
        write: (chunk: Buffer | string) => { lastSpawnStdin += chunk.toString(); },
        end: () => {},
      },
      stdout: { on: (e: string, cb: (b: Buffer) => void) => { if (e === "data" && stdout) cb(Buffer.from(stdout)); } },
      stderr: { on: (e: string, cb: (b: Buffer) => void) => { if (e === "data" && stderr) cb(Buffer.from(stderr)); } },
      on: (e: string, cb: (arg: unknown) => void) => { handlers.set(e, cb); },
      kill: () => {},
    };
    setImmediate(() => handlers.get("close")?.(exitCode));
    return proc;
  });
}

function wavHeaderOnly(): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(48000 * 2 * 2, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(0, 40);
  return header;
}

function wavWithDuration(seconds: number): Buffer {
  const byteRate = 48000 * 2 * 2;
  const dataBytes = Math.round(seconds * byteRate);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(48000, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return Buffer.concat([header, Buffer.alloc(dataBytes)]);
}

describe("recordings router", () => {
  let root: string; let mvDir: string;
  let oldPath: string | undefined;
  let oldCodexRoots: string | undefined;
  let oldRootsOnly: string | undefined;
  beforeEach(() => {
    spawnMock.mockReset();
    lastSpawnStdin = "";
    oldPath = process.env.PATH;
    oldCodexRoots = process.env.YULU_CODEX_PLUGIN_ROOTS;
    oldRootsOnly = process.env.YULU_AGENT_PLUGIN_ROOTS_ONLY;
    root = mkdtempSync(join(tmpdir(), "rec_"));
    mvDir = join(root, "movies");
    mkdirSync(mvDir);
  });
  afterEach(() => {
    process.env.PATH = oldPath;
    if (oldCodexRoots === undefined) delete process.env.YULU_CODEX_PLUGIN_ROOTS;
    else process.env.YULU_CODEX_PLUGIN_ROOTS = oldCodexRoots;
    if (oldRootsOnly === undefined) delete process.env.YULU_AGENT_PLUGIN_ROOTS_ONLY;
    else process.env.YULU_AGENT_PLUGIN_ROOTS_ONLY = oldRootsOnly;
    rmSync(root, { recursive: true, force: true });
  });

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

  it("list includes WAV duration for compact recording rows", async () => {
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.wav"), wavWithDuration(125));
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    const rows = await caller.list({});
    expect(rows[0].durationSeconds).toBe(125);
  });

  it("get reads a recording from the root and includes realtime", async () => {
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.wav"), "");
    writeFileSync(join(mvDir, "TeamSync_20260102_090000.realtime.transcript.txt"), "live text");
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    const r = await caller.get({ stem: "TeamSync_20260102_090000" });
    expect(r.realtime).toBe("live text");
    expect(r.title).toBe("TeamSync");
  });

  it("get includes transcription model and summary template choices", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), "");
    const ctx = mkCtx({ moviesDir: mvDir });
    (ctx.db.prompts as unknown as { __rows: Array<Record<string, unknown>> }).__rows.push({
      id: "p1",
      slug: "summary",
      name: "Standard Summary",
      category: "summary",
      content: "Use {{transcript}}",
      is_auto_run: 1,
    });

    const r = await createCaller(recordingsRouter, ctx).get({ stem });

    expect(r.transcriptionModelOptions.some((option: { label: string; active: boolean }) =>
      option.label.includes("MLX") && option.active
    )).toBe(true);
    expect(r.summaryTemplateOptions).toEqual([
      { id: "p1", slug: "summary", name: "Standard Summary", isAutoRun: true },
    ]);
    expect(r.defaultSummaryTemplateId).toBe("p1");
  });

  it("summarize can use realtime transcript when final transcript is missing", async () => {
    const stem = "TeamSync_20260102_090000";
    const wavPath = join(mvDir, `${stem}.wav`);
    const realtimePath = join(mvDir, `${stem}.realtime.transcript.txt`);
    writeFileSync(wavPath, "");
    writeFileSync(realtimePath, "live text");
    const ctx = mkCtx({ moviesDir: mvDir });
    const caller = createCaller(recordingsRouter, ctx);

    await caller.summarize({ stem });

    const queue = JSON.parse(readFileSync(ctx.paths.agentQueueJson, "utf8"));
    expect(queue).toHaveLength(1);
    expect(queue[0].type).toBe("summary_request");
    expect(queue[0].stem).toBe(stem);
    expect(queue[0].title).toBe("TeamSync");
    expect(queue[0].transcriptPath).toBe(realtimePath);
    expect(queue[0].audio_path).toBe(wavPath);
  });

  it("summarize enqueues the selected summary template snapshot", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), "");
    writeFileSync(join(mvDir, `${stem}.transcript.txt`), "final text");
    const ctx = mkCtx({ moviesDir: mvDir });
    (ctx.db.prompts as unknown as { __rows: Array<Record<string, unknown>> }).__rows.push({
      id: "p-decision",
      slug: "decisions",
      name: "Decision Memo",
      category: "summary",
      content: "Decisions from {{transcript}}",
      is_auto_run: 0,
    });

    await createCaller(recordingsRouter, ctx).summarize({ stem, promptId: "p-decision" });

    const queue = JSON.parse(readFileSync(ctx.paths.agentQueueJson, "utf8"));
    expect(queue[0]).toMatchObject({
      prompt_id: "p-decision",
      prompt_slug: "decisions",
      prompt_name: "Decision Memo",
      prompt_content_snapshot: "Decisions from {{transcript}}",
    });
  });

  it("transcribe applies a selected transcription model and restarts sttdaemon", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), "");
    mockSpawn("", 0);
    const ctx = mkCtx({ moviesDir: mvDir });

    await createCaller(recordingsRouter, ctx).transcribe({
      stem,
      transcriptionModel: { engine: "whisper", model: "/models/ggml-medium.bin" },
    });

    expect(ctx.config.read().transcription.final_engine).toBe("whisper");
    expect(ctx.config.read().transcription.local_model_path).toBe("/models/ggml-medium.bin");
    expect(ctx.launchctl.restart).toHaveBeenCalledWith("com.yulu.sttdaemon");
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

  it("marks a WAV header with no frames as recording_failed", async () => {
    const stem = "Codex_20260612_100342";
    writeFileSync(join(mvDir, `${stem}.wav`), wavHeaderOnly());
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    const row = (await caller.list({}))[0];
    const detail = await caller.get({ stem });
    expect(row.status).toBe("recording_failed");
    expect(row.statusError).toMatch(/no audio frames/);
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

  it("sendSummary routes through the selected Agent CLI when the Console plugin is configured", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), "");
    writeFileSync(join(mvDir, `${stem}.summary.md`), "summary");
    const ctx = mkCtx({ moviesDir: mvDir });
    const fakeCodex = join(root, "bin", "codex");
    const pluginRoot = join(root, "codex-plugins");
    mkdirSync(join(root, "bin"));
    mkdirSync(join(pluginRoot, "notion"), { recursive: true });
    writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${join(root, "bin")}:${oldPath ?? ""}`;
    process.env.YULU_CODEX_PLUGIN_ROOTS = pluginRoot;
    process.env.YULU_AGENT_PLUGIN_ROOTS_ONLY = "1";
    ctx.config = { read: () => ({
      llm: { enabled: true, command: [fakeCodex], agent: { provider: "codex" } },
      agent_console: {
        plugins: { added: ["summary", "notion"] },
        destinations: { codex: { notion: { target: "Product Notes" } } },
      },
    }) } as unknown as AppContext["config"];
    const nativeSessionId = "019f0000-0000-7000-8000-000000000002";
    mockSpawn(
      `${JSON.stringify({ type: "session", session_id: nativeSessionId })}\n` +
      `${JSON.stringify({ type: "message", text: "sent" })}\n`,
    );

    const r = await createCaller(recordingsRouter, ctx).sendSummary({ stem, channel: "notion" });

    expect(r.ok).toBe(true);
    const call = spawnMock.mock.calls[0]!;
    expect(call[0]).toBe(fakeCodex);
    expect(call[2].cwd).toBe("/fake/yulu/scripts");
    expect(lastSpawnStdin).toContain("Destination: Product Notes");
    const history = JSON.parse(readFileSync(join(mvDir, `${stem}.shares.json`), "utf8"));
    expect(history[0]).toMatchObject({ channel: "notion", status: "success", destination: "Product Notes" });
    const sessions = JSON.parse(readFileSync(join(ctx.paths.configDir, "agent-sessions.json"), "utf8"));
    expect(sessions.sessions[0]).toMatchObject({
      purpose: "background",
      nativeSessionId,
    });
  });

  it("get exposes Agent Console share targets for added plugins only", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), "");
    writeFileSync(join(mvDir, `${stem}.summary.md`), "summary");
    const ctx = mkCtx({ moviesDir: mvDir });
    const fakeCodex = join(root, "bin", "codex");
    const pluginRoot = join(root, "codex-plugins");
    mkdirSync(join(root, "bin"));
    mkdirSync(join(pluginRoot, "notion"), { recursive: true });
    writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${join(root, "bin")}:${oldPath ?? ""}`;
    process.env.YULU_CODEX_PLUGIN_ROOTS = pluginRoot;
    process.env.YULU_AGENT_PLUGIN_ROOTS_ONLY = "1";
    ctx.config = { read: () => ({
      llm: { enabled: true, command: [fakeCodex], agent: { provider: "codex" } },
      agent_console: { plugins: { added: ["summary", "notion"] } },
    }) } as unknown as AppContext["config"];

    const r = await createCaller(recordingsRouter, ctx).get({ stem });

    expect(r.enabledSummaryTargets).toEqual([]);
    expect(r.shareTargets).toEqual([
      expect.objectContaining({ channel: "notion", label: "Notion", destination: "Yulu Meeting", enabled: true }),
    ]);
  });

  it("keeps configured Zulip disabled until a stream and topic are selected in Agent Console", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), "");
    writeFileSync(join(mvDir, `${stem}.summary.md`), "summary");
    const ctx = mkCtx({ moviesDir: mvDir });
    const fakeCodex = join(root, "bin", "codex");
    const pluginRoot = join(root, "codex-plugins");
    mkdirSync(join(root, "bin"));
    mkdirSync(join(pluginRoot, "zulip"), { recursive: true });
    writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${join(root, "bin")}:${oldPath ?? ""}`;
    process.env.YULU_CODEX_PLUGIN_ROOTS = pluginRoot;
    process.env.YULU_AGENT_PLUGIN_ROOTS_ONLY = "1";
    ctx.config = { read: () => ({
      llm: { enabled: true, command: [fakeCodex], agent: { provider: "codex" } },
      agent_console: { plugins: { added: ["summary", "zulip"] } },
    }) } as unknown as AppContext["config"];

    const r = await createCaller(recordingsRouter, ctx).get({ stem });

    expect(r.shareTargets).toEqual([
      expect.objectContaining({
        channel: "zulip",
        destination: "选择 Channel 和 Topic",
        enabled: false,
        disabledReason: "请选择 Zulip Channel 和 Topic",
      }),
    ]);
  });

  it("get ignores legacy Telegram summary targets", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), "");
    writeFileSync(join(mvDir, `${stem}.summary.md`), "summary");
    const ctx = mkCtx({ moviesDir: mvDir });
    ctx.config = { read: () => ({
      connectors: { telegram: { send_summary: true } },
      output: { telegram: { chat_id: "123" } },
    }) } as unknown as AppContext["config"];

    const r = await createCaller(recordingsRouter, ctx).get({ stem });

    expect(r.enabledSummaryTargets).toEqual([]);
  });

  it("sendSummary rejects a plugin that was not added in Agent Console", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), "");
    writeFileSync(join(mvDir, `${stem}.summary.md`), "summary");
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));

    await expect(caller.sendSummary({ stem, channel: "notion" })).rejects.toThrow(/not added/i);
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("sendSummary rejects an added plugin that the selected Agent has not configured", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), "");
    writeFileSync(join(mvDir, `${stem}.summary.md`), "summary");
    const fakeCodex = join(root, "bin", "codex");
    mkdirSync(join(root, "bin"));
    writeFileSync(fakeCodex, "#!/bin/sh\nexit 0\n");
    chmodSync(fakeCodex, 0o755);
    process.env.PATH = `${join(root, "bin")}:${oldPath ?? ""}`;
    process.env.YULU_CODEX_PLUGIN_ROOTS = join(root, "empty-plugins");
    process.env.YULU_AGENT_PLUGIN_ROOTS_ONLY = "1";
    const ctx = mkCtx({ moviesDir: mvDir });
    ctx.config = { read: () => ({
      llm: { enabled: true, command: [fakeCodex], agent: { provider: "codex" } },
      agent_console: { plugins: { added: ["summary", "notion"] } },
    }) } as unknown as AppContext["config"];
    const caller = createCaller(recordingsRouter, ctx);

    await expect(caller.sendSummary({ stem, channel: "notion" })).rejects.toThrow(/尚未配置|not configured/i);
    expect(spawnMock).not.toHaveBeenCalled();
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
