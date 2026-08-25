import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingsRouter } from "../../src/routers/recordings.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { PubSub, type AppChannels } from "../../src/pubsub.js";
import { HostStore, RecordingTaskDeletionBlockedError } from "../../src/hostStore.js";
import { ArtifactStore } from "../../src/artifactStore.js";
import { ConfigManager } from "../../src/config.js";
import { RecordingPipeline } from "../../src/recordingPipeline.js";
import { paths } from "../../src/paths.js";
import { XAI_SUMMARY_DISCLOSURE_VERSION } from "../../src/summaryDataDisclosure.js";

const agentActions = vi.hoisted(() => ({
  DeliveryError: class AgentDeliveryFailedError extends Error {},
  summarize: vi.fn(async () => ({ stdout: "# Fresh summary\n", stderr: "", sessionId: "summary-session" })),
  share: vi.fn(async () => ({
    stdout: "sent",
    stderr: "",
    sessionId: "share-session",
    delivery: { status: "sent", channel: "slack", destination: "#meetings", url: "", id: "msg-1" },
  })),
}));

vi.mock("../../src/agentActions.js", () => ({
  AgentDeliveryFailedError: agentActions.DeliveryError,
  runAgentSummarize: agentActions.summarize,
  runAgentShareSummary: agentActions.share,
}));

function mkCtx(opts: { moviesDir: string; glossaryRows?: Array<Record<string, unknown>> }): AppContext {
  const promptRows: Array<Record<string, unknown>> = [];
  const transcribeOnDemand = vi.fn(async () => ({
    transcript: "fresh transcript",
    provider: "hermes-test",
    chunks: 2,
  }));
  const enqueueSummaryRegeneration = vi.fn((input: { audioPath: string }) => {
    const stem = input.audioPath.replace(/^.*\//, "").replace(/\.wav$/, "");
    writeFileSync(join(opts.moviesDir, `${stem}.summary.md`), "# Fresh summary\n");
    const stalePath = join(opts.moviesDir, `${stem}.summary.stale`);
    if (existsSync(stalePath)) rmSync(stalePath);
    return {
      created: true,
      task: {
        id: "019f0000-0000-7000-8000-000000000123",
        trigger: "manual",
        summaryProvider: "hermes",
        summaryModel: "runtime-managed",
      },
    };
  });
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
      agentQueueJson: join(opts.moviesDir, "agent-queue.json"),
      scriptDir: "/fake/yulu/scripts",
    },
    host: {
      latestForRecording: vi.fn(() => null),
      getNotionDelivery: vi.fn(() => null),
      cancelPolicyPausedAutomaticForManualAction: vi.fn(() => []),
      prepareRecordingDeletion: vi.fn(() => []),
      purgeRecordingTasks: vi.fn(() => []),
    },
    artifacts: { cleanupWorkspace: vi.fn() },
    pubsub: new PubSub<AppChannels>(),
    config: { read: () => ({ llm: { command: [process.execPath] } }) },
    launchctl: { restart: vi.fn(), status: vi.fn(), start: vi.fn(), stop: vi.fn(), sighup: vi.fn() },
    db: {
      prompts: promptsDb,
      vocab: {
        prepare: () => ({ all: () => opts.glossaryRows ?? [] }),
      },
    },
    recordingPipeline: { transcribeOnDemand, enqueueSummaryRegeneration },
  } as unknown as AppContext;
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
  beforeEach(() => {
    agentActions.summarize.mockClear();
    agentActions.share.mockClear();
    root = mkdtempSync(join(tmpdir(), "rec_"));
    mvDir = join(root, "movies");
    mkdirSync(mvDir);
  });
  afterEach(() => {
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

  it("get includes summary template choices", async () => {
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

    expect(r.summaryTemplateOptions).toEqual([
      { id: "p1", slug: "summary", name: "Standard Summary", isAutoRun: true },
    ]);
    expect(r.defaultSummaryTemplateId).toBe("p1");
  });

  it("re-transcribes without running summary or delivery", async () => {
    const stem = "TeamSync_20260102_090000";
    const wavPath = join(mvDir, `${stem}.wav`);
    writeFileSync(wavPath, wavWithDuration(1));
    writeFileSync(join(mvDir, `${stem}.summary.md`), "old summary");
    const ctx = mkCtx({ moviesDir: mvDir });

    const result = await createCaller(recordingsRouter, ctx).transcribe({ stem });

    expect(ctx.recordingPipeline.transcribeOnDemand).toHaveBeenCalledWith({ audioPath: wavPath });
    expect(readFileSync(join(mvDir, `${stem}.transcript.txt`), "utf8")).toBe("fresh transcript\n");
    expect(readFileSync(join(mvDir, `${stem}.raw.transcript.txt`), "utf8")).toBe("fresh transcript\n");
    expect(readFileSync(join(mvDir, `${stem}.summary.md`), "utf8")).toBe("old summary");
    expect(existsSync(join(mvDir, `${stem}.summary.stale`))).toBe(true);
    expect(agentActions.summarize).not.toHaveBeenCalled();
    expect(agentActions.share).not.toHaveBeenCalled();
    expect(result.provider).toBe("hermes-test");
  });

  it("re-summarizes the existing transcript without transcribing", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), wavWithDuration(1));
    writeFileSync(join(mvDir, `${stem}.transcript.txt`), "existing transcript");
    const ctx = mkCtx({
      moviesDir: mvDir,
      glossaryRows: [{ term: "阿法学院", canonical: "阿尔法学院", scope: "both" }],
    });

    await createCaller(recordingsRouter, ctx).summarize({ stem });

    expect(ctx.recordingPipeline.transcribeOnDemand).not.toHaveBeenCalled();
    expect(ctx.recordingPipeline.enqueueSummaryRegeneration).toHaveBeenCalledWith(expect.objectContaining({
      audioPath: join(mvDir, `${stem}.wav`),
      title: "TeamSync",
      instructions: expect.stringContaining("阿法学院 => 阿尔法学院"),
    }));
    expect(agentActions.summarize).not.toHaveBeenCalled();
  });

  it("regenerates through a pinned xAI durable task using only the committed transcript", async () => {
    const stem = "TeamSync_20260102_090000";
    const wavPath = join(mvDir, `${stem}.wav`);
    writeFileSync(wavPath, wavWithDuration(1));
    writeFileSync(join(mvDir, `${stem}.transcript.txt`), "committed transcript\n");
    writeFileSync(join(mvDir, `${stem}.summary.md`), "# Old summary\n");
    writeFileSync(join(mvDir, `${stem}.summary.stale`), "stale\n");
    const configDir = join(root, "config");
    mkdirSync(configDir);
    const configFile = join(configDir, "config.json");
    writeFileSync(configFile, JSON.stringify({
      transcription: {},
      intelligence: {
        summary: { provider: "xai", model: "grok-manual-pinned" },
        conversation: { provider: "agent", model: "runtime-managed" },
      },
      llm: { agent: { provider: "hermes" } },
      agent_pipeline: { enabled: true, auto_process_recordings: false },
    }));
    const host = new HostStore(join(configDir, "host.sqlite"));
    host.recordSummaryDataPathDisclosure("xai", XAI_SUMMARY_DISCLOSURE_VERSION);
    const artifacts = new ArtifactStore(mvDir, join(configDir, "agent-tasks"));
    const config = new ConfigManager(configFile);
    const glossaryRows = [{ term: "阿法学院", canonical: "阿尔法学院", scope: "both" as const }];
    const xaiRequest = vi.fn(async (request: { model: string }) => ({
      text: "# 阿法学院",
      model: request.model,
      credentialSource: "oauth" as const,
    }));
    const transcribeFile = vi.fn(async () => {
      throw new Error("manual summary must not transcribe audio");
    });
    const runtimePaths = {
      ...paths,
      configDir,
      configFile,
      moviesDir: mvDir,
      hostDb: join(configDir, "host.sqlite"),
      agentTasksDir: join(configDir, "agent-tasks"),
      recordingEventsDir: join(configDir, "recording-events"),
    };
    const pubsub = new PubSub<AppChannels>();
    const pipeline = new RecordingPipeline({
      store: host,
      artifacts,
      config,
      paths: runtimePaths,
      pubsub,
      vocabDb: () => ({ prepare: () => ({ all: () => glossaryRows }) }),
      transcription: {
        provider: "test-audio",
        health: () => ({ available: true, provider: "test-audio", reason: null }),
        warm: async () => {},
        transcribeFile,
      },
      xaiText: { request: xaiRequest },
      gatewayFactory: () => { throw new Error("manual xAI summary must not construct an Agent gateway"); },
      pollMs: 60_000,
    });
    const base = mkCtx({ moviesDir: mvDir, glossaryRows });
    const ctx = {
      ...base,
      paths: runtimePaths,
      host,
      artifacts,
      config,
      pubsub,
      recordingPipeline: pipeline,
    } as AppContext;

    try {
      const result = await createCaller(recordingsRouter, ctx).summarize({ stem });
      await vi.waitFor(() => expect(host.latestForRecording(stem)?.state).toBe("completed"));

      expect(result.task).toMatchObject({
        trigger: "manual",
        summaryProvider: "xai",
        summaryModel: "grok-manual-pinned",
      });
      expect(transcribeFile).not.toHaveBeenCalled();
      expect(xaiRequest).toHaveBeenCalledWith({
        capability: "summary",
        model: "grok-manual-pinned",
        input: [
          { role: "system", content: expect.any(String) },
          { role: "user", content: "committed transcript" },
        ],
      });
      expect(readFileSync(join(mvDir, `${stem}.summary.md`), "utf8")).toBe("# 阿尔法学院\n");
      expect(existsSync(join(mvDir, `${stem}.summary.stale`))).toBe(false);
    } finally {
      await pipeline.close();
      host.close();
    }
  });

  it("blocks sharing an old summary after re-transcription until it is regenerated", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), wavWithDuration(1));
    writeFileSync(join(mvDir, `${stem}.summary.md`), "old summary");
    writeSpeakerFixture(mvDir, stem);
    const ctx = mkCtx({ moviesDir: mvDir });
    const caller = createCaller(recordingsRouter, ctx);

    await caller.transcribe({ stem });
    const stale = await caller.get({ stem });
    expect(stale.summaryStale).toBe(true);
    expect(stale.speakerData).toBeNull();
    expect((await caller.list({}))[0].hasSummary).toBe(false);
    await expect(caller.sendSummary({ stem, channel: "slack", label: "Slack", destination: "#meetings" }))
      .rejects.toThrow("older transcript");

    await caller.summarize({ stem });
    expect((await caller.get({ stem })).summaryStale).toBe(false);
    await expect(caller.sendSummary({ stem, channel: "slack", label: "Slack", destination: "#meetings" }))
      .resolves.toMatchObject({ ok: true });
  });

  it("serializes manual actions for one recording", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), wavWithDuration(1));
    const ctx = mkCtx({ moviesDir: mvDir });
    let finish!: (value: { transcript: string; provider: string; chunks: number }) => void;
    vi.mocked(ctx.recordingPipeline.transcribeOnDemand).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    const caller = createCaller(recordingsRouter, ctx);

    const first = caller.transcribe({ stem });
    await vi.waitFor(() => expect(ctx.recordingPipeline.transcribeOnDemand).toHaveBeenCalled());
    await expect(caller.summarize({ stem })).rejects.toThrow("Transcription is already running");
    finish({ transcript: "fresh transcript", provider: "test", chunks: 1 });
    await expect(first).resolves.toMatchObject({ ok: true });
  });

  it("cancels a policy-paused automatic pipeline before a manual action", async () => {
    const stem = "TeamSync_20260102_090000";
    const wavPath = join(mvDir, `${stem}.wav`);
    writeFileSync(wavPath, wavWithDuration(1));
    const ctx = mkCtx({ moviesDir: mvDir });
    vi.mocked(ctx.host.cancelPolicyPausedAutomaticForManualAction).mockReturnValue(["paused-task"]);

    await createCaller(recordingsRouter, ctx).transcribe({ stem });

    expect(ctx.host.cancelPolicyPausedAutomaticForManualAction).toHaveBeenCalledWith(stem);
    expect(ctx.artifacts.cleanupWorkspace).toHaveBeenCalledWith("paused-task");
  });

  it("allows repeated shares to any Agent-supported channel and records each attempt", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), wavWithDuration(1));
    writeFileSync(join(mvDir, `${stem}.summary.md`), "summary to share");
    const ctx = mkCtx({ moviesDir: mvDir });
    const caller = createCaller(recordingsRouter, ctx);

    await caller.sendSummary({ stem, channel: "slack", label: "Slack", destination: "#meetings" });
    await caller.sendSummary({ stem, channel: "slack", label: "Slack", destination: "#meetings" });

    expect(agentActions.share).toHaveBeenCalledTimes(2);
    expect(agentActions.share).toHaveBeenLastCalledWith(expect.objectContaining({
      channel: "slack",
      channelLabel: "Slack",
      destinationHint: "#meetings",
    }));
    const history = JSON.parse(readFileSync(join(mvDir, `${stem}.shares.json`), "utf8")) as Array<Record<string, unknown>>;
    expect(history).toHaveLength(2);
    expect(history.every((entry) => entry.channel === "slack" && entry.status === "success")).toBe(true);
  });

  it("records an explicit Agent connector rejection as failed instead of uncertain", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), wavWithDuration(1));
    writeFileSync(join(mvDir, `${stem}.summary.md`), "summary to share");
    agentActions.share.mockRejectedValueOnce(new agentActions.DeliveryError("connector unavailable"));

    await expect(createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir })).sendSummary({
      stem,
      channel: "slack",
      label: "Slack",
      destination: "#meetings",
    })).rejects.toThrow("connector unavailable");

    const history = JSON.parse(readFileSync(join(mvDir, `${stem}.shares.json`), "utf8")) as Array<Record<string, unknown>>;
    expect(history[0]).toMatchObject({ status: "failed", message: "connector unavailable" });
  });

  it("does not expose the retired combined manual reprocess procedure", () => {
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    expect("reprocess" in caller).toBe(false);
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

  it("list reflects the durable Host task status", async () => {
    writeFileSync(join(mvDir, "Memo_20260101_120000.wav"), "");
    const ctx = mkCtx({ moviesDir: mvDir });
    ctx.host = {
      latestForRecording: vi.fn(() => ({ state: "running", phase: "transcribing", error: null })),
    } as unknown as AppContext["host"];
    expect((await createCaller(recordingsRouter, ctx).list({}))[0].status).toBe("transcribing");
  });

  it("get exposes the Notion delivery recorded for the durable Agent task", async () => {
    const stem = "TeamSync_20260102_090000";
    const taskId = "019f0000-0000-7000-8000-000000000100";
    const delivery = {
      taskId,
      deliveryKey: "notion-page-1",
      status: "reported",
      destination: "Product Notes",
      url: "https://www.notion.so/0123456789abcdef0123456789abcdef",
      pageId: "0123456789abcdef0123456789abcdef",
      detail: null,
      createdAt: "2026-07-11T00:00:00.000Z",
      updatedAt: "2026-07-11T00:00:01.000Z",
    };
    writeFileSync(join(mvDir, `${stem}.wav`), "");
    const ctx = mkCtx({ moviesDir: mvDir });
    ctx.host = {
      latestForRecording: vi.fn(() => ({
        id: taskId,
        state: "delivery_reported",
        phase: "sending_notion",
        error: null,
      })),
      getNotionDelivery: vi.fn(() => delivery),
    } as unknown as AppContext["host"];

    const detail = await createCaller(recordingsRouter, ctx).get({ stem });

    expect(detail.agentTask).toMatchObject({ id: taskId, state: "delivery_reported" });
    expect(detail.notionDelivery).toEqual(delivery);
    expect(ctx.host.getNotionDelivery).toHaveBeenCalledWith(taskId);
  });

  it.each(["failed", "cancelled", "completed"])(
    "get hides a historical %s Agent task from the current meeting state",
    async (state) => {
      const stem = "TeamSync_20260102_090000";
      writeFileSync(join(mvDir, `${stem}.wav`), wavWithDuration(1));
      const ctx = mkCtx({ moviesDir: mvDir });
      ctx.host = {
        latestForRecording: vi.fn(() => ({
          id: "historical-task",
          state,
          phase: state === "completed" ? "completed" : "failed",
          sendToNotion: true,
          error: state === "failed" ? "Retired legacy task" : null,
        })),
        getNotionDelivery: vi.fn(() => ({ status: "reported" })),
      } as unknown as AppContext["host"];

      const caller = createCaller(recordingsRouter, ctx);
      const detail = await caller.get({ stem });
      const row = (await caller.list({}))[0];

      expect(detail.status).toBe("idle");
      expect(detail.statusError).toBeUndefined();
      expect(detail.agentTask).toBeNull();
      expect(detail.notionDelivery).toBeNull();
      expect(row.status).toBe("idle");
    },
  );

  it("surfaces xAI long-request expiry as a retryable transcription failure", async () => {
    const stem = "TeamSync_20260102_090000";
    const error = "Selected audio engine unavailable after 3 attempts: xAI transcription failed (500): Auth context expired.";
    writeFileSync(join(mvDir, `${stem}.wav`), wavWithDuration(1));
    const ctx = mkCtx({ moviesDir: mvDir });
    ctx.host = {
      latestForRecording: vi.fn(() => ({
        id: "expired-xai-task",
        state: "failed",
        phase: "failed",
        sendToNotion: false,
        error,
      })),
      getNotionDelivery: vi.fn(() => null),
    } as unknown as AppContext["host"];

    const caller = createCaller(recordingsRouter, ctx);
    const detail = await caller.get({ stem });
    const row = (await caller.list({}))[0];

    expect(detail).toMatchObject({
      status: "transcription_failed",
      statusError: error,
      agentTask: { id: "expired-xai-task", state: "failed", error },
    });
    expect(row).toMatchObject({ status: "transcription_failed", statusError: error });
  });

  it("clears an older transcription failure after a successful manual transcript", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), wavWithDuration(1));
    writeFileSync(join(mvDir, `${stem}.transcript.txt`), "Recovered transcript\n");
    const ctx = mkCtx({ moviesDir: mvDir });
    ctx.host = {
      latestForRecording: vi.fn(() => ({
        id: "older-failed-task",
        state: "failed",
        phase: "failed",
        sendToNotion: false,
        error: "xAI transcription failed (500): Auth context expired.",
        updatedAt: "2020-01-01T00:00:00.000Z",
      })),
      getNotionDelivery: vi.fn(() => null),
    } as unknown as AppContext["host"];

    const caller = createCaller(recordingsRouter, ctx);
    const detail = await caller.get({ stem });
    const row = (await caller.list({}))[0];

    expect(detail).toMatchObject({ status: "idle", statusError: undefined, agentTask: null });
    expect(row).toMatchObject({ status: "idle", statusError: undefined, hasTranscript: true });
  });

  it("does not label a Hermes artifact audit error containing transcript_read as transcription failure", async () => {
    const stem = "TeamSync_20260102_090000";
    writeFileSync(join(mvDir, `${stem}.wav`), wavWithDuration(1));
    const ctx = mkCtx({ moviesDir: mvDir });
    ctx.host = {
      latestForRecording: vi.fn(() => ({
        id: "artifact-audit-task",
        state: "failed",
        phase: "failed",
        sendToNotion: false,
        error: "Hermes session used tools outside the artifact capability set: recording_task_transcript_read",
      })),
      getNotionDelivery: vi.fn(() => null),
    } as unknown as AppContext["host"];

    const caller = createCaller(recordingsRouter, ctx);
    const detail = await caller.get({ stem });
    const row = (await caller.list({}))[0];

    expect(detail).toMatchObject({ status: "idle", statusError: undefined, agentTask: null });
    expect(row).toMatchObject({ status: "idle", statusError: undefined });
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

  it("delete removes every exact-stem sibling, including legacy backups, locks, and directories", async () => {
    const stem = "TeamSync_20260102_090000";
    const files = [
      ".wav", ".clean.wav", ".transcript.txt", ".raw.transcript.txt", ".realtime.transcript.txt",
      ".realtime.coverage.json", ".realtime.json", ".summary.md", ".summary.html", ".speakers.json",
      ".speakers.json.pre-coalesce.bak", ".transcript.txt.pre-coalesce.bak",
      ".mic.transcript.txt", ".sys.transcript.txt", ".title", ".tags.json", ".shares.json",
      ".voicemail-todos.summary.md", ".voicemail-todos.summary.html",
      ".chunk-0.wav", ".chunk-1.wav",
    ];
    for (const f of files) writeFileSync(join(mvDir, `${stem}${f}`), "x");
    const hiddenLock = join(mvDir, `.${stem}.summary.md.lock`);
    writeFileSync(hiddenLock, "lock");
    const realtimeDir = join(mvDir, `${stem}.realtime`);
    mkdirSync(realtimeDir);
    writeFileSync(join(realtimeDir, "segments.json"), "[]");
    // A sibling recording must be left untouched.
    writeFileSync(join(mvDir, "Other_20260103_080000.wav"), "x");
    const caller = createCaller(recordingsRouter, mkCtx({ moviesDir: mvDir }));
    const res = await caller.delete({ stem });
    expect(res.removed).toBe(files.length + 2);
    for (const f of files) expect(existsSync(join(mvDir, `${stem}${f}`))).toBe(false);
    expect(existsSync(hiddenLock)).toBe(false);
    expect(existsSync(realtimeDir)).toBe(false);
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

  it("cancels durable queued work, cleans its workspace, and purges task rows during deletion", async () => {
    const stem = "Memo_20260101_120000";
    const taskId = "019f0000-0000-7000-8000-000000000123";
    writeFileSync(join(mvDir, `${stem}.wav`), "audio");
    const ctx = mkCtx({ moviesDir: mvDir });
    vi.mocked(ctx.host.prepareRecordingDeletion).mockReturnValue([taskId]);
    vi.mocked(ctx.host.purgeRecordingTasks).mockReturnValue([taskId]);

    await createCaller(recordingsRouter, ctx).delete({ stem });

    expect(ctx.host.prepareRecordingDeletion).toHaveBeenCalledWith(stem);
    expect(ctx.artifacts.cleanupWorkspace).toHaveBeenCalledWith(taskId);
    expect(ctx.host.purgeRecordingTasks).toHaveBeenCalledWith(stem);
    expect(existsSync(join(mvDir, `${stem}.wav`))).toBe(false);
  });

  it("blocks deletion while delivery is active or unverified", async () => {
    const stem = "Memo_20260101_120000";
    writeFileSync(join(mvDir, `${stem}.wav`), "audio");
    const ctx = mkCtx({ moviesDir: mvDir });
    vi.mocked(ctx.host.prepareRecordingDeletion).mockImplementation(() => {
      throw new RecordingTaskDeletionBlockedError(stem, ["delivery_unverified"]);
    });

    await expect(createCaller(recordingsRouter, ctx).delete({ stem })).rejects.toThrow(
      /cannot be deleted.*delivery_unverified/,
    );
    expect(ctx.artifacts.cleanupWorkspace).not.toHaveBeenCalled();
    expect(ctx.host.purgeRecordingTasks).not.toHaveBeenCalled();
    expect(existsSync(join(mvDir, `${stem}.wav`))).toBe(true);
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
