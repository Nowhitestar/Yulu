import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore, type AgentTaskWorkspace } from "../src/artifactStore.js";
import { ConfigManager } from "../src/config.js";
import { HostStore } from "../src/hostStore.js";
import { PubSub, type AppChannels } from "../src/pubsub.js";
import { RecordingPipeline } from "../src/recordingPipeline.js";
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
    const available = opts.available !== false;
    const warmTranscription = vi.fn(async () => {});
    let lastOnDemandWorkspace = "";
    const transcribeAudio = vi.fn(async (_audioPath: string, workspace: AgentTaskWorkspace) => {
      lastOnDemandWorkspace = workspace.dir;
      writeFileSync(join(workspace.dir, "audio-000.wav"), "transport");
      return { transcript: "dictation transcript", provider: "test-hermes", chunks: 1 };
    });
    const transcribe = vi.fn(async (task: Parameters<RecordingAgentGateway["transcribe"]>[0]) => {
      if (opts.transcribeContractGate) await opts.transcribeContractGate;
      if (opts.transcribeUnavailable) throw new AgentUnavailableError("Hermes serve failed");
      artifacts.writeStagedTranscript(task.id, "hello transcript");
      return { transcript: "hello transcript", provider: "test-hermes", chunks: 1 };
    });
    let notionStartedFromState = "";
    const notionBeginResults: Array<{ url: string | null; pageId: string | null }> = [];
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
      notionBeginResults.push({ url: delivery.url, pageId: delivery.pageId });
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
      warmTranscription,
      transcribeAudio,
      transcribe,
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
      gatewayFactory,
      pollMs: 60_000,
    });
    return {
      audioPath,
      moviesDir,
      configDir,
      configManager,
      gatewayFactory,
      warmTranscription,
      transcribeAudio,
      transcribe,
      runArtifactWorkflow,
      runNotionWorkflow,
      notionStartedFromState: () => notionStartedFromState,
      notionBeginResults,
      lastOnDemandWorkspace: () => lastOnDemandWorkspace,
    };
  }

  it("runs Hermes transcription, artifact commit, and Notion in one durable task", async () => {
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

  it("renders manual instructions once at the pipeline boundary", () => {
    const { audioPath } = setup();
    const { task } = pipeline!.enqueueReprocess({
      audioPath,
      title: "Literal {{transcript}} title",
      instructions: "{{meeting_title}} | {{date}} | {{transcript}}",
    });

    expect(task.instructions).toBe(
      "Literal {{transcript}} title | 2026-07-11 | the complete transcript returned for this task by the task-scoped MCP `recording_task_transcript_read` operation",
    );
  });

  it("rejects unknown manual summary variables before creating a task", () => {
    const { audioPath } = setup();
    expect(() => pipeline!.enqueueReprocess({ audioPath, instructions: "Read {{secret_file}}" }))
      .toThrow("Unsupported summary template variable(s): secret_file");
    expect(store!.listTasks()).toEqual([]);
  });

  it("keeps the recording and reports awaiting_agent without a fallback", async () => {
    const { audioPath } = setup({ available: false });
    expect(pipeline!.transcriptionHealth()).toEqual({
      available: false,
      provider: "hermes",
      reason: "Hermes offline",
      paused: false,
      policyReason: null,
    });
    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Demo", sendToNotion: true });
    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("awaiting_agent"));
    expect(store!.listArtifacts(task.id)).toEqual([]);
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

  it("does not hot-loop an awaiting task when Hermes startup fails after claim", async () => {
    const { audioPath, transcribe } = setup({ transcribeUnavailable: true });
    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Demo" });

    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("awaiting_agent"));
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(store!.getTask(task.id)?.attempt).toBe(1);
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

  it("pauses automatic work but still executes explicit manual reprocessing", async () => {
    const { audioPath, moviesDir, configManager, transcribe } = setup({ autoProcess: false });
    expect(() => pipeline!.enqueueCompletion({ audioPath })).toThrow("Automatic Agent recording processing is paused by policy");

    const automaticPath = join(moviesDir, "Automatic_20260711_130000.wav");
    writeFileSync(automaticPath, Buffer.alloc(44));
    const automatic = store!.enqueueRecording({
      idempotencyKey: "preexisting-automatic",
      recordingStem: "Automatic_20260711_130000",
      title: "Automatic",
      audioPath: automaticPath,
      sendToNotion: false,
      destinationHint: "Yulu Meeting",
      agentProvider: "hermes",
      trigger: "automatic",
    }).task;

    const { task } = pipeline!.enqueueReprocess({ audioPath, title: "Manual" });
    expect(task.trigger).toBe("manual");
    expect(pipeline!.transcriptionHealth()).toMatchObject({
      available: true,
      paused: true,
      policyReason: expect.stringContaining("paused by policy"),
    });
    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("completed"));
    expect(store!.getTask(automatic.id)?.state).toBe("awaiting_policy");
    expect(transcribe).toHaveBeenCalledTimes(1);

    configManager.update("agent_pipeline.auto_process_recordings", true);
    pipeline!.kick();
    await vi.waitFor(() => expect(store!.getTask(automatic.id)?.state).toBe("completed"));
    expect(store!.listEvents(automatic.id).map((event) => event.type)).toContain("task.policy_resumed");
    expect(transcribe).toHaveBeenCalledTimes(2);
  });

  it("promotes a paused automatic task for the same recording into one manual task", async () => {
    const { audioPath, transcribe } = setup({ autoProcess: false });
    const automatic = store!.enqueueRecording({
      idempotencyKey: "automatic:same-recording",
      recordingStem: "Demo_20260711_120000",
      title: "Automatic Demo",
      audioPath,
      sendToNotion: false,
      destinationHint: "Yulu Meeting",
      agentProvider: "hermes",
      trigger: "automatic",
    }).task;

    const result = pipeline!.enqueueReprocess({ audioPath, title: "Manual Demo" });

    expect(result).toMatchObject({ created: false, task: { id: automatic.id, trigger: "manual" } });
    expect(store!.listTasks()).toHaveLength(1);
    expect(store!.listEvents(automatic.id).map((event) => event.type)).toContain("task.manual_override");
    await vi.waitFor(() => expect(store!.getTask(automatic.id)?.state).toBe("completed"));
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("reuses an active manual task when its delayed automatic completion event arrives", async () => {
    let releaseContract!: () => void;
    const contractGate = new Promise<void>((resolve) => { releaseContract = resolve; });
    const { audioPath, transcribe } = setup({ transcribeContractGate: contractGate });
    const manual = pipeline!.enqueueReprocess({ audioPath, title: "Manual Demo" });
    await vi.waitFor(() => expect(store!.getTask(manual.task.id)?.state).toBe("running"));

    const delayed = pipeline!.enqueueCompletion({ audioPath, title: "Automatic Demo" });

    expect(delayed).toMatchObject({ created: false, task: { id: manual.task.id, trigger: "manual" } });
    expect(store!.listTasks()).toHaveLength(1);
    releaseContract();
    await vi.waitFor(() => expect(store!.getTask(manual.task.id)?.state).toBe("completed"));
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("rejects completion permanently when the whole pipeline is disabled", () => {
    const { audioPath } = setup({ enabled: false });
    expect(() => pipeline!.enqueueCompletion({ audioPath })).toThrow("disabled by policy");
    expect(store!.listTasks()).toEqual([]);
  });

  it("fails closed for on-demand transcription when the whole pipeline is disabled", async () => {
    const { audioPath, gatewayFactory, warmTranscription, transcribeAudio } = setup({ enabled: false });

    expect(pipeline!.transcriptionHealth()).toEqual({
      available: false,
      provider: "hermes",
      reason: "Agent recording pipeline is disabled by policy",
      paused: true,
      policyReason: "Agent recording pipeline is disabled by policy",
    });
    await expect(pipeline!.warmTranscription()).rejects.toThrow("disabled by policy");
    await expect(pipeline!.transcribeOnDemand({ audioPath })).rejects.toThrow("disabled by policy");
    expect(gatewayFactory).not.toHaveBeenCalled();
    expect(warmTranscription).not.toHaveBeenCalled();
    expect(transcribeAudio).not.toHaveBeenCalled();
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

    expect(() => pipeline!.enqueueReprocess({ audioPath, sendToNotion: false })).toThrow(
      "confirm the existing page or abandon",
    );
    expect(() => pipeline!.enqueueReprocess({ audioPath, sendToNotion: true })).toThrow(
      "confirm the existing page or abandon",
    );
    expect(() => pipeline!.retry(first.task.id)).toThrow(/cannot retry from delivery_unverified/);
    expect(pipeline!.confirmNotionDelivery(first.task.id, {}).state).toBe("completed");
    const retry = pipeline!.enqueueReprocess({ audioPath, sendToNotion: true });
    expect(retry.created).toBe(false);
    expect(retry.task.id).toBe(first.task.id);
    expect(store!.getNotionDelivery(first.task.id)?.deliveryKey).toBe(`yulu-${first.task.id}`);
    await vi.waitFor(() => expect(store!.getTask(first.task.id)?.state).toBe("completed"));
  });

  it("reuses the delivered task and marker for repeated manual Notion sends", async () => {
    const { audioPath, notionBeginResults } = setup();
    const first = pipeline!.enqueueReprocess({
      audioPath,
      sendToNotion: true,
      instructions: "First summary",
    });
    await vi.waitFor(() => expect(store!.getTask(first.task.id)?.state).toBe("completed"));
    const marker = store!.getNotionDelivery(first.task.id)?.deliveryKey;

    const second = pipeline!.enqueueReprocess({
      audioPath,
      sendToNotion: true,
      instructions: "Updated summary",
    });

    expect(second).toMatchObject({ created: false, task: { id: first.task.id } });
    expect(store!.getNotionDelivery(first.task.id)?.deliveryKey).toBe(marker);
    await vi.waitFor(() => {
      expect(store!.getTask(first.task.id)).toMatchObject({
        state: "completed",
        attempt: 2,
        instructions: "Updated summary",
      });
    });
    expect(store!.listTasks()).toHaveLength(1);
    expect(store!.getNotionDelivery(first.task.id)?.deliveryKey).toBe(marker);
    expect(notionBeginResults).toEqual([
      { url: null, pageId: null },
      { url: "https://notion.so/demo", pageId: null },
    ]);
  });

  it("rejects a recording symlink that escapes the recordings directory", () => {
    const setupResult = setup();
    const outside = join(root, "Escape_20260711_120000.wav");
    writeFileSync(outside, Buffer.alloc(44));
    const escapedLink = join(setupResult.moviesDir, "Escape_20260711_120000.wav");
    symlinkSync(outside, escapedLink);

    expect(() => pipeline!.enqueueCompletion({ audioPath: escapedLink })).toThrow("outside the configured recordings directory");
  });

  it("warms and reuses one Hermes gateway for allowed on-demand WAVs, then removes the workspace", async () => {
    const setupResult = setup();
    await expect(pipeline!.warmTranscription()).resolves.toEqual({ provider: "hermes" });
    const first = await pipeline!.transcribeOnDemand({ audioPath: setupResult.audioPath });

    const dictationDir = join(setupResult.configDir, "dictation");
    mkdirSync(dictationDir, { recursive: true });
    const dictationWav = join(dictationDir, "dictation.wav");
    writeFileSync(dictationWav, Buffer.alloc(44));
    const second = await pipeline!.transcribeOnDemand({ audioPath: dictationWav });

    expect(first).toEqual({ transcript: "dictation transcript", provider: "test-hermes", chunks: 1 });
    expect(second.transcript).toBe("dictation transcript");
    expect(setupResult.gatewayFactory).toHaveBeenCalledTimes(1);
    expect(setupResult.warmTranscription).toHaveBeenCalledTimes(1);
    expect(setupResult.transcribeAudio).toHaveBeenNthCalledWith(1, realpathSync(setupResult.audioPath), expect.objectContaining({
      dir: expect.stringContaining(".agent-workspaces/transcribe-"),
    }));
    expect(setupResult.transcribeAudio).toHaveBeenNthCalledWith(2, realpathSync(dictationWav), expect.any(Object));
    expect(existsSync(setupResult.lastOnDemandWorkspace())).toBe(false);
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
    expect(setupResult.transcribeAudio).not.toHaveBeenCalled();
  });

  it("removes the temporary transcription workspace when Hermes fails", async () => {
    const setupResult = setup();
    let failedWorkspace = "";
    setupResult.transcribeAudio.mockImplementationOnce(async (_audioPath, workspace) => {
      failedWorkspace = workspace.dir;
      writeFileSync(join(workspace.dir, "audio-000.wav"), "sensitive transport audio");
      throw new Error("Hermes transcription failed");
    });

    await expect(pipeline!.transcribeOnDemand({ audioPath: setupResult.audioPath })).rejects.toThrow("Hermes transcription failed");
    expect(failedWorkspace).toBeTruthy();
    expect(existsSync(failedWorkspace)).toBe(false);
  });
});
