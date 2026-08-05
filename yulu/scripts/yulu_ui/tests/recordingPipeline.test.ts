import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifactStore.js";
import { ConfigManager } from "../src/config.js";
import { HostStore } from "../src/hostStore.js";
import { PubSub, type AppChannels } from "../src/pubsub.js";
import { RecordingPipeline, agentRetryDelayMs } from "../src/recordingPipeline.js";
import { AgentUnavailableError, type RecordingAgentGateway } from "../src/agentGateway.js";
import { paths } from "../src/paths.js";

describe("RecordingPipeline", () => {
  let root = "";
  let store: HostStore | undefined;
  let pipeline: RecordingPipeline | undefined;

  afterEach(async () => {
    await pipeline?.close();
    store?.close();
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  function setup(opts: {
    available?: boolean;
    sendToNotion?: boolean;
    autoProcess?: boolean;
    enabled?: boolean;
    transcribeUnavailable?: boolean;
    gatewayFactoryThrows?: boolean;
    transcribeContractGate?: Promise<void>;
    skipArtifactCommit?: boolean;
    reuseArtifactSessionForDelivery?: boolean;
    notionThrowsAfterCapability?: boolean;
    notionUnavailableAfterCapability?: boolean;
    legacyManualTask?: boolean;
    pollMs?: number;
    glossaryRows?: Array<{ term: string; canonical: string; scope: "prompt" | "replace" | "both" }>;
    autoPrompts?: Array<{
      id: string;
      slug: string;
      name: string;
      category: string;
      content: string;
      is_auto_run: number;
      sort_order: number;
    }>;
  } = {}) {
    root = mkdtempSync(join(tmpdir(), "yulu-pipeline-"));
    const configDir = join(root, ".config", "yulu");
    const moviesDir = join(root, "Movies", "Yulu");
    const configFile = join(configDir, "config.json");
    const audioPath = join(moviesDir, "Demo_20260711_120000.wav");
    const artifacts = new ArtifactStore(moviesDir, join(configDir, "agent-tasks"));
    writeFileSync(configFile, JSON.stringify({
      transcription: {},
      llm: { enabled: true, agent: { provider: "hermes" } },
      agent_pipeline: { enabled: opts.enabled !== false, auto_process_recordings: opts.autoProcess !== false, notion_destination: "Yulu Meeting" },
    }));
    writeFileSync(audioPath, Buffer.alloc(44));
    store = new HostStore(join(configDir, "host.sqlite"));
    const legacyManualTask = opts.legacyManualTask ? store.enqueueRecording({
      idempotencyKey: "manual:legacy-combined-task",
      recordingStem: "Demo_20260711_120000",
      title: "Legacy manual task",
      audioPath,
      sendToNotion: false,
      destinationHint: "Yulu Meeting",
      agentProvider: "hermes",
      trigger: "manual",
    }).task : null;
    const available = opts.available !== false;
    const warmTranscription = vi.fn(async () => {});
    const transcribe = vi.fn(async (
      _audioPath: string,
      language: "zh" | "en" | "ja" | "auto",
      _glossary?: unknown,
    ) => {
      if (opts.transcribeContractGate) await opts.transcribeContractGate;
      if (opts.transcribeUnavailable) throw new AgentUnavailableError("selected audio engine unavailable");
      return { transcript: "hello transcript", provider: "test-audio", chunks: 1, language };
    });
    let notionStartedFromState = "";
    const runArtifactWorkflow = vi.fn(async ({ task, leaseToken, workspace }: Parameters<RecordingAgentGateway["runArtifactWorkflow"]>[0]) => {
      writeFileSync(workspace.summaryPath, "# Summary\n\nhello\n");
      if (!opts.skipArtifactCommit) {
        const records = artifacts.commitFromWorkspace(task, { agent: "hermes" });
        store!.recordArtifacts(task.id, leaseToken, records);
      }
      return {
        stdout: "artifacts done",
        stderr: "session_id: artifact-session",
        nativeSessionId: "artifact-session",
        audit: {
          ok: true,
          toolNames: ["mcp_yulu_artifact_recording_artifact_commit"],
          artifactCommit: true,
          notionDeliveryBegin: false,
          notionSearch: false,
          notionWrite: false,
          notionIdempotencyMarker: false,
          notionWriteResultVerified: false,
          notionDeliveryCommit: false,
          notionOrderValid: true,
          errors: [],
        },
      };
    });
    const runNotionWorkflow = vi.fn(async ({ task, leaseToken }: Parameters<RecordingAgentGateway["runNotionWorkflow"]>[0]) => {
      notionStartedFromState = store!.getTask(task.id)?.state ?? "";
      if (opts.notionThrowsAfterCapability) {
        throw new Error("Hermes delivery exited after connector access");
      }
      if (opts.notionUnavailableAfterCapability) {
        throw new AgentUnavailableError("Hermes delivery runtime became unavailable");
      }
      const delivery = store!.beginNotionDelivery(task.id, leaseToken);
      store!.recordNotionDelivery(task.id, leaseToken, {
        url: "https://notion.so/demo",
      });
      return {
        stdout: "delivery done",
        stderr: `session_id: ${opts.reuseArtifactSessionForDelivery ? "artifact-session" : "delivery-session"}`,
        nativeSessionId: opts.reuseArtifactSessionForDelivery ? "artifact-session" : "delivery-session",
        audit: {
          ok: true,
          toolNames: [
            "mcp_yulu_delivery_recording_committed_summary_read",
            "mcp_notion_notion_search",
            "mcp_notion_notion_create_pages",
            "mcp_yulu_delivery_recording_commit_notion_delivery",
          ],
          artifactCommit: true,
          notionDeliveryBegin: true,
          notionSearch: true,
          notionWrite: true,
          notionIdempotencyMarker: true,
          notionWriteResultVerified: true,
          notionDeliveryCommit: true,
          notionOrderValid: true,
          errors: [],
        },
      };
    });
    const gateway: RecordingAgentGateway = {
      provider: "hermes",
      health: () => ({ available, provider: "hermes", reason: available ? null : "Hermes offline" }),
      runArtifactWorkflow,
      runNotionWorkflow,
      close: () => {},
    };
    const gatewayFactory = vi.fn(() => {
      if (opts.gatewayFactoryThrows) throw new Error("invalid runtime config");
      return gateway;
    });
    const runtimePaths = {
      ...paths,
      configDir,
      configFile,
      moviesDir,
      hostDb: join(configDir, "host.sqlite"),
      agentTasksDir: join(configDir, "agent-tasks"),
      recordingEventsDir: join(configDir, "recording-events"),
    };
    const configManager = new ConfigManager(configFile);
    pipeline = new RecordingPipeline({
      store,
      artifacts,
      config: configManager,
      paths: runtimePaths,
      pubsub: new PubSub<AppChannels>(),
      promptDb: opts.autoPrompts ? () => ({
        prepare: () => ({
          get: (category: unknown) => opts.autoPrompts!
            .filter((row) => row.category === category && row.is_auto_run === 1)
            .sort((a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug))[0],
        }),
      }) : undefined,
      vocabDb: opts.glossaryRows ? () => ({
        prepare: () => ({ all: () => opts.glossaryRows }),
      }) : undefined,
      transcription: {
        provider: "test-audio",
        health: () => ({ available: true, provider: "test-audio", reason: null }),
        warm: warmTranscription,
        transcribeFile: transcribe,
      },
      gatewayFactory,
      pollMs: opts.pollMs ?? 60_000,
    });
    return {
      audioPath,
      moviesDir,
      configDir,
      configManager,
      gatewayFactory,
      warmTranscription,
      transcribe,
      runArtifactWorkflow,
      runNotionWorkflow,
      notionStartedFromState: () => notionStartedFromState,
      legacyManualTask,
    };
  }

  it("runs selected audio transcription, summary Agent commit, and Notion in one durable task", async () => {
    const { audioPath, moviesDir, configDir, runArtifactWorkflow, runNotionWorkflow, notionStartedFromState } = setup({ sendToNotion: true });
    const first = pipeline!.enqueueCompletion({ audioPath, title: "Demo", sendToNotion: true });
    const duplicate = pipeline!.enqueueCompletion({ audioPath, title: "Demo", sendToNotion: true });
    expect(duplicate.task.id).toBe(first.task.id);
    await vi.waitFor(() => expect(store!.getTask(first.task.id)?.state).toBe("completed"));
    expect(store!.listArtifacts(first.task.id)).toHaveLength(2);
    expect(store!.getNotionDelivery(first.task.id)?.url).toBe("https://notion.so/demo");
    expect(notionStartedFromState()).toBe("sending");
    expect(runArtifactWorkflow).toHaveBeenCalledTimes(1);
    expect(runNotionWorkflow).toHaveBeenCalledWith(expect.not.objectContaining({ nativeSessionId: expect.anything() }));
    expect(store!.getTask(first.task.id)).toMatchObject({
      artifactSessionId: "artifact-session",
      deliverySessionId: "delivery-session",
    });
    expect(store!.listArtifacts(first.task.id).every((record) => (
      record.provenance.artifactSessionId === "artifact-session"
    ))).toBe(true);
    expect(existsSync(join(configDir, "agent-tasks", first.task.id))).toBe(false);
    expect(() => writeFileSync(join(moviesDir, "proof"), "ok")).not.toThrow();
  });

  it("asks the selected audio service for the final transcript", async () => {
    const { audioPath, moviesDir, transcribe } = setup();
    writeFileSync(audioPath.replace(/\.wav$/, ".realtime.transcript.txt"), "这是会议的实时转写，with Alpha。\n");
    writeFileSync(audioPath.replace(/\.wav$/, ".realtime.coverage.json"), JSON.stringify({
      language: "zh",
      covered_ms: 60_000,
      total_ms: 60_000,
      chunks: 4,
      trusted: true,
      reason: null,
      finished: true,
    }));

    const result = pipeline!.enqueueCompletion({ audioPath, language: "zh" });
    await vi.waitFor(() => expect(store!.getTask(result.task.id)?.state).toBe("completed"));

    expect(transcribe).toHaveBeenCalledOnce();
    expect(readFileSync(join(moviesDir, "Demo_20260711_120000.transcript.txt"), "utf8"))
      .toContain("hello transcript");
    expect(readFileSync(join(moviesDir, "Demo_20260711_120000.transcript.txt"), "utf8"))
      .not.toContain("这是会议的实时转写，with Alpha。");
  });

  it("applies glossary aliases to transcription and passes canonical terms to summary", async () => {
    const setupResult = setup({
      glossaryRows: [
        { term: "阿尔法学院", canonical: "阿尔法学院", scope: "both" },
        { term: "阿法学院", canonical: "阿尔法学院", scope: "both" },
      ],
    });
    setupResult.transcribe.mockImplementationOnce(async (_audioPath, language) => {
      return { transcript: "阿法学院会议", provider: "test-audio", chunks: 1, language };
    });

    const result = pipeline!.enqueueCompletion({ audioPath: setupResult.audioPath, language: "zh" });
    await vi.waitFor(() => expect(store!.getTask(result.task.id)?.state).toBe("completed"));

    expect(readFileSync(join(setupResult.moviesDir, "Demo_20260711_120000.transcript.txt"), "utf8"))
      .toBe("阿尔法学院会议\n");
    expect(setupResult.transcribe).toHaveBeenCalledWith(
      realpathSync(setupResult.audioPath),
      "zh",
      expect.objectContaining({ prompt: expect.stringContaining("阿尔法学院") }),
    );
    expect(setupResult.runArtifactWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      glossary: expect.objectContaining({ summaryInstruction: expect.stringContaining("阿法学院 => 阿尔法学院") }),
    }));
  });

  it("snapshots only the first automatic summary prompt at enqueue time", () => {
    const autoPrompts = [
      { id: "cleanup", slug: "cleanup", name: "Cleanup", category: "cleanup", content: "wrong", is_auto_run: 1, sort_order: -1 },
      { id: "disabled", slug: "disabled", name: "Disabled", category: "summary", content: "wrong", is_auto_run: 0, sort_order: -1 },
      { id: "later", slug: "later", name: "Later", category: "summary", content: "later", is_auto_run: 1, sort_order: 20 },
      { id: "first", slug: "first", name: "First", category: "summary", content: "{{meeting_title}} {{date}} {{transcript}}", is_auto_run: 1, sort_order: 10 },
    ];
    const { audioPath } = setup({ autoPrompts });

    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Planning" });
    expect(task.instructions).toBe(
      "Planning 2026-07-11 the complete transcript returned for this task by the task-scoped MCP `recording_task_transcript_read` operation",
    );
    autoPrompts[3]!.content = "changed after enqueue";
    expect(store!.getTask(task.id)?.instructions).toBe(task.instructions);
    expect(store!.listTasks()).toHaveLength(1);
  });

  it("fails closed when the selected automatic summary has an unknown variable", () => {
    const { audioPath } = setup({
      autoPrompts: [
        { id: "bad", slug: "bad", name: "Bad", category: "summary", content: "{{private_path}}", is_auto_run: 1, sort_order: 0 },
      ],
    });

    expect(() => pipeline!.enqueueCompletion({ audioPath })).toThrow(
      "Unsupported summary template variable(s): private_path",
    );
    expect(store!.listTasks()).toEqual([]);
  });

  it("persists the transcript while the summary Agent is unavailable", async () => {
    const { audioPath } = setup({ available: false });
    expect(pipeline!.transcriptionHealth()).toEqual({
      available: true,
      provider: "test-audio",
      reason: null,
      paused: false,
      policyReason: null,
    });
    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Demo", sendToNotion: true });
    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("transcript_committed"));
    expect(store!.listArtifacts(task.id)).toEqual([
      expect.objectContaining({ kind: "transcript" }),
    ]);
  });

  it("backs off and fails after three unavailable health checks", async () => {
    const { audioPath, transcribe } = setup({ available: false, pollMs: 5 });
    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Demo" });

    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("failed"));
    expect(store!.getTask(task.id)).toMatchObject({
      attempt: 3,
      error: expect.stringContaining("Summary Agent unavailable after 3 attempts"),
    });
    expect(transcribe).toHaveBeenCalledOnce();
  });

  it("never exposes Notion when the Host did not observe the artifact commit", async () => {
    const { audioPath, runNotionWorkflow } = setup({ skipArtifactCommit: true });
    const { task } = pipeline!.enqueueCompletion({ audioPath, sendToNotion: true });

    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("failed"));
    expect(store!.getTask(task.id)?.error).toContain("artifact Host commit");
    expect(runNotionWorkflow).not.toHaveBeenCalled();
  });

  it("fails closed if Hermes reuses the raw-transcript artifact session for delivery", async () => {
    const { audioPath } = setup({ reuseArtifactSessionForDelivery: true });
    const { task } = pipeline!.enqueueCompletion({ audioPath, sendToNotion: true });

    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("delivery_unverified"));
    expect(store!.getTask(task.id)?.error).toContain("reused the artifact session");
    expect(store!.getTask(task.id)?.deliverySessionId).toBeNull();
  });

  it("fences connector uncertainty before the delivery Agent can make a write", async () => {
    const { audioPath, notionStartedFromState } = setup({ notionThrowsAfterCapability: true });
    const { task } = pipeline!.enqueueCompletion({ audioPath, sendToNotion: true });

    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("delivery_unverified"));
    expect(notionStartedFromState()).toBe("sending");
    expect(store!.getNotionDelivery(task.id)).toMatchObject({
      deliveryKey: `yulu-${task.id}`,
      status: "sending",
    });
    expect(() => pipeline!.retry(task.id)).toThrow(/cannot retry from delivery_unverified/);
  });

  it("keeps the delivery fence when Hermes becomes unavailable after connector access", async () => {
    const { audioPath, notionStartedFromState } = setup({ notionUnavailableAfterCapability: true });
    const { task } = pipeline!.enqueueCompletion({ audioPath, sendToNotion: true });

    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("delivery_unverified"));
    expect(notionStartedFromState()).toBe("sending");
    expect(store!.listEvents(task.id).map((event) => event.type)).not.toContain("task.awaiting_agent");
    expect(() => pipeline!.retry(task.id)).toThrow(/cannot retry from delivery_unverified/);
  });

  it("does not hot-loop when the selected audio engine fails after claim", async () => {
    const { audioPath, transcribe } = setup({ transcribeUnavailable: true });
    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Demo" });

    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("awaiting_agent"));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(store!.getTask(task.id)?.attempt).toBe(1);
  });

  it("backs off exponentially and fails an unavailable task after three attempts", async () => {
    expect(agentRetryDelayMs(1, 10)).toBe(10);
    expect(agentRetryDelayMs(2, 10)).toBe(20);
    expect(agentRetryDelayMs(3, 10)).toBe(40);
    expect(agentRetryDelayMs(99, 10)).toBe(5 * 60_000);

    const { audioPath, transcribe } = setup({ transcribeUnavailable: true, pollMs: 5 });
    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Demo" });

    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("failed"));
    expect(transcribe).toHaveBeenCalledTimes(3);
    expect(store!.getTask(task.id)).toMatchObject({
      attempt: 3,
      error: expect.stringContaining("Selected audio engine unavailable after 3 attempts"),
    });
  });

  it("retires active legacy manual durable tasks when the pipeline starts", () => {
    const { legacyManualTask } = setup({ legacyManualTask: true });

    expect(legacyManualTask).not.toBeNull();
    expect(store!.getTask(legacyManualTask!.id)).toMatchObject({
      state: "cancelled",
      phase: "failed",
      error: "Retired legacy combined manual task after atomic meeting actions migration",
    });
    expect(store!.listTasks().filter((task) => task.trigger === "manual" && ![
      "completed", "failed", "cancelled", "delivery_unverified",
    ].includes(task.state))).toEqual([]);
  });

  it("returns from an empty dispatch without constructing or probing a gateway", async () => {
    const { gatewayFactory } = setup();
    pipeline!.kick();
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(gatewayFactory).not.toHaveBeenCalled();
  });

  it("keeps a claimed task waiting for async contract readiness, then returns it to awaiting_agent", async () => {
    let rejectContract!: (error: Error) => void;
    const contractGate = new Promise<void>((_resolve, reject) => { rejectContract = reject; });
    const { audioPath, transcribe } = setup({ transcribeContractGate: contractGate });
    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Demo" });

    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("running"));
    expect(transcribe).toHaveBeenCalledTimes(1);
    rejectContract(new AgentUnavailableError("Hermes phase MCP contract is not ready"));
    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("awaiting_agent"));
    expect(store!.getTask(task.id)?.error).toContain("phase MCP contract");
  });

  it("contains dispatch boundary failures and leaves durable work queued", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const { audioPath } = setup({ gatewayFactoryThrows: true });
    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Demo" });

    await vi.waitFor(() => expect(log).toHaveBeenCalledWith(
      expect.stringContaining("invalid runtime config"),
    ));
    expect(store!.getTask(task.id)?.state).toBe("queued");
    await expect(pipeline!.close()).resolves.toBeUndefined();
    log.mockRestore();
  });

  it("rejects completion permanently when the whole pipeline is disabled", () => {
    const { audioPath } = setup({ enabled: false });
    expect(() => pipeline!.enqueueCompletion({ audioPath })).toThrow("disabled by policy");
    expect(store!.listTasks()).toEqual([]);
  });

  it("keeps on-demand audio independent from automatic summary policy", async () => {
    const { audioPath, gatewayFactory, warmTranscription, transcribe } = setup({ enabled: false });

    expect(pipeline!.transcriptionHealth()).toEqual({
      available: true,
      provider: "test-audio",
      reason: null,
      paused: true,
      policyReason: "Agent recording pipeline is disabled by policy",
    });
    await expect(pipeline!.warmTranscription()).resolves.toEqual({ provider: "test-audio" });
    await expect(pipeline!.transcribeOnDemand({ audioPath })).resolves.toMatchObject({ transcript: "hello transcript" });
    expect(gatewayFactory).not.toHaveBeenCalled();
    expect(warmTranscription).toHaveBeenCalledOnce();
    expect(transcribe).toHaveBeenCalledOnce();
  });

  it("does not claim pre-existing queued or awaiting work after policy is disabled", async () => {
    const { audioPath, moviesDir, configManager, transcribe } = setup();
    const queued = store!.enqueueRecording({
      idempotencyKey: "pre-policy-queued",
      recordingStem: "Demo_20260711_120000",
      title: "Queued",
      audioPath,
      sendToNotion: false,
      destinationHint: "Yulu Meeting",
      agentProvider: "hermes",
    }).task;
    const awaitingPath = join(moviesDir, "Awaiting_20260711_120001.wav");
    writeFileSync(awaitingPath, Buffer.alloc(44));
    const awaiting = store!.enqueueRecording({
      idempotencyKey: "pre-policy-awaiting",
      recordingStem: "Awaiting_20260711_120001",
      title: "Awaiting",
      audioPath: awaitingPath,
      sendToNotion: false,
      destinationHint: "Yulu Meeting",
      agentProvider: "hermes",
    }).task;
    store!.markAwaitingAgent(awaiting.id, "Hermes was offline");

    configManager.update("agent_pipeline.enabled", false);
    pipeline!.kick();
    await vi.waitFor(() => {
      expect(store!.getTask(queued.id)?.state).toBe("awaiting_policy");
      expect(store!.getTask(awaiting.id)?.state).toBe("awaiting_policy");
    });
    expect(transcribe).not.toHaveBeenCalled();
    expect(store!.claimNext("hermes")).toBeNull();
  });

  it("reuses the same task and delivery marker when reconciling an uncertain Notion result", async () => {
    const { audioPath } = setup();
    const first = pipeline!.enqueueCompletion({ audioPath, sendToNotion: true });
    await vi.waitFor(() => expect(store!.getTask(first.task.id)?.state).toBe("completed"));
    store!.db.prepare(`
      UPDATE agent_tasks SET state = 'delivery_unverified', phase = 'failed',
        error = 'Host restarted during Notion delivery' WHERE id = ?
    `).run(first.task.id);

    expect(() => pipeline!.retry(first.task.id)).toThrow(/cannot retry from delivery_unverified/);
    expect(pipeline!.confirmNotionDelivery(first.task.id, {}).state).toBe("completed");
    expect(store!.getNotionDelivery(first.task.id)?.deliveryKey).toBe(`yulu-${first.task.id}`);
  });

  it("rejects a recording symlink that escapes the recordings directory", () => {
    const setupResult = setup();
    const outside = join(root, "Escape_20260711_120000.wav");
    writeFileSync(outside, Buffer.alloc(44));
    const escapedLink = join(setupResult.moviesDir, "Escape_20260711_120000.wav");
    symlinkSync(outside, escapedLink);

    expect(() => pipeline!.enqueueCompletion({ audioPath: escapedLink })).toThrow("outside the configured recordings directory");
  });

  it("warms and reuses the selected audio service for allowed on-demand WAVs", async () => {
    const setupResult = setup({
      glossaryRows: [{ term: "预录", canonical: "玉录", scope: "both" }],
    });
    setupResult.transcribe.mockImplementation(async (_audioPath, language) => ({
      transcript: "打开预录",
      provider: "test-audio",
      chunks: 1,
      language,
    }));
    await expect(pipeline!.warmTranscription()).resolves.toEqual({ provider: "test-audio" });
    const first = await pipeline!.transcribeOnDemand({ audioPath: setupResult.audioPath });

    const dictationDir = join(setupResult.configDir, "dictation");
    mkdirSync(dictationDir, { recursive: true });
    const dictationWav = join(dictationDir, "dictation.wav");
    writeFileSync(dictationWav, Buffer.alloc(44));
    const second = await pipeline!.transcribeOnDemand({ audioPath: dictationWav, language: "ja" });

    expect(first).toEqual({ transcript: "打开玉录", provider: "test-audio", chunks: 1, language: "zh" });
    expect(second).toEqual({ transcript: "打开玉录", provider: "test-audio", chunks: 1, language: "ja" });
    expect(setupResult.gatewayFactory).not.toHaveBeenCalled();
    expect(setupResult.warmTranscription).toHaveBeenCalledTimes(1);
    expect(setupResult.transcribe).toHaveBeenNthCalledWith(
      1,
      realpathSync(setupResult.audioPath),
      "zh",
      expect.objectContaining({ prompt: expect.stringContaining("玉录") }),
    );
    expect(setupResult.transcribe).toHaveBeenNthCalledWith(
      2,
      realpathSync(dictationWav),
      "ja",
      expect.objectContaining({ prompt: expect.stringContaining("玉录") }),
    );
  });

  it("rejects WAVs outside approved roots, including symlink escapes", async () => {
    const setupResult = setup();
    const outside = join(root, "outside.wav");
    writeFileSync(outside, Buffer.alloc(44));
    await expect(pipeline!.transcribeOnDemand({ audioPath: outside })).rejects.toThrow("outside Yulu recordings");

    const dictationDir = join(setupResult.configDir, "dictation");
    mkdirSync(dictationDir, { recursive: true });
    const escapedLink = join(dictationDir, "escaped.wav");
    symlinkSync(outside, escapedLink);
    await expect(pipeline!.transcribeOnDemand({ audioPath: escapedLink })).rejects.toThrow("outside Yulu recordings");
    expect(setupResult.transcribe).not.toHaveBeenCalled();
  });

  it("propagates a selected audio service failure without constructing an Agent gateway", async () => {
    const setupResult = setup();
    setupResult.transcribe.mockRejectedValueOnce(new Error("selected audio engine failed"));

    await expect(pipeline!.transcribeOnDemand({ audioPath: setupResult.audioPath })).rejects.toThrow("selected audio engine failed");
    expect(setupResult.gatewayFactory).not.toHaveBeenCalled();
  });
});
