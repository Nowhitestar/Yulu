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
import { ClaudeCodeSummaryUnknownOutcomeError } from "../src/summaryProviderReadiness.js";
import { paths } from "../src/paths.js";

function wavWithAudio(): Buffer {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(37, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24);
  header.writeUInt32LE(32_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(1, 40);
  return Buffer.concat([header, Buffer.from([1])]);
}

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
    xaiText?: boolean;
    xaiReadinessCredentialSource?: "oauth" | "api-key";
    xaiExecutionCredentialSource?: "oauth" | "api-key";
    xaiSummaryDisclosure?: boolean;
    supportedAgentAdapter?: boolean;
    supportedAgentProvider?: "codex" | "claude-code";
    supportedAgentResultModel?: string;
    supportedAgentMissingEvidence?: boolean;
    supportedAgentToolNames?: string[];
    supportedAgentSummaryText?: string;
    supportedAgentUnknownOutcome?: boolean;
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
    const supportedAgentProvider = opts.supportedAgentProvider ?? "codex";
    const supportedAgentDisclosureVersion = supportedAgentProvider === "codex"
      ? "codex-summary-v1"
      : "claude-code-summary-v1";
    const artifacts = new ArtifactStore(moviesDir, join(configDir, "agent-tasks"));
    writeFileSync(configFile, JSON.stringify({
      transcription: {},
      ...(opts.supportedAgentAdapter ? {
        intelligence: {
          summary: { provider: "agent", connectionId: supportedAgentProvider, model: "runtime-managed" },
          conversation: { provider: "agent", model: "runtime-managed" },
        },
      } : {}),
      llm: { enabled: true, agent: { provider: "hermes" } },
      agent_pipeline: { enabled: opts.enabled !== false, auto_process_recordings: opts.autoProcess !== false, notion_destination: "Yulu Meeting" },
    }));
    writeFileSync(audioPath, Buffer.alloc(44));
    store = new HostStore(join(configDir, "host.sqlite"));
    if (opts.supportedAgentAdapter) {
      store.upsertAgentConnectionRecord({
        id: supportedAgentProvider,
        kind: "supported-agent",
        adapter: supportedAgentProvider,
        label: supportedAgentProvider === "codex" ? "Codex" : "Claude Code",
        lifecycle: "available",
        settings: {
          executablePath: supportedAgentProvider === "codex" ? "/fake/codex" : "/fake/claude",
          summaryModel: "runtime-managed",
        },
      });
    }
    if (opts.xaiSummaryDisclosure === true || (opts.xaiText && opts.xaiSummaryDisclosure !== false)) {
      store.recordSummaryDataPathDisclosure("xai", "xai-summary-v1");
    }
    const legacyManualTask = opts.legacyManualTask ? store.enqueueRecording({
      idempotencyKey: "manual:legacy-combined-task",
      recordingStem: "Demo_20260711_120000",
      title: "Legacy manual task",
      audioPath,
      sendToNotion: false,
      destinationHint: "Yulu Meeting",
      agentProvider: "hermes",
      summaryProvider: "hermes",
      summaryModel: "runtime-managed",
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
    const xaiRequest = vi.fn(async (request: { model: string; credentialSource?: "oauth" | "api-key" }) => {
      const credentialSource = opts.xaiExecutionCredentialSource ?? "oauth";
      if (request.credentialSource && request.credentialSource !== credentialSource) {
        throw new Error(
          `Pinned xAI credential ${request.credentialSource} does not match resolved credential ${credentialSource}`,
        );
      }
      return {
        text: "# xAI Summary\n\nhello",
        model: request.model,
        credentialSource,
      };
    });
    let notionStartedFromState = "";
    const runArtifactWorkflow = vi.fn(async ({ task, leaseToken, workspace }: Parameters<RecordingAgentGateway["runArtifactWorkflow"]>[0]) => {
      const reportedIdentity = opts.supportedAgentAdapter ? {
        provider: supportedAgentProvider,
        model: opts.supportedAgentResultModel ?? "runtime-managed",
      } : undefined;
      writeFileSync(workspace.summaryPath, opts.supportedAgentSummaryText ?? "# Summary\n\nhello\n");
      if (!opts.skipArtifactCommit && !opts.supportedAgentAdapter) {
        const records = artifacts.commitFromWorkspace(task, {
          agentProvider: task.summaryProvider,
          summaryProvider: task.summaryProvider,
          summaryModel: task.summaryModel,
          committedBy: "yulu-host",
        });
        store!.recordArtifacts(task.id, leaseToken, records);
      }
      return {
        stdout: "artifacts done",
        stderr: "session_id: artifact-session",
        nativeSessionId: "artifact-session",
        summaryIdentity: reportedIdentity,
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
    const supportedAgentGateway = {
      ...gateway,
      provider: supportedAgentProvider,
      runArtifactWorkflow: async (input: Parameters<RecordingAgentGateway["runArtifactWorkflow"]>[0]) => {
        if (opts.supportedAgentUnknownOutcome) {
          throw new ClaudeCodeSummaryUnknownOutcomeError(
            "Claude Code Summary entered Unknown Outcome; inspect the native session before a new attempt",
            {
              nativeSessionId: "unknown-session-140",
              evidence: {
                adapter: "claude-code",
                transport: "claude-code-print-stream-json",
                runtimeVersion: "2.1.169",
                requestedProvider: null,
                requestedModel: "runtime-managed",
                actualProvider: null,
                actualModel: "runtime-managed",
                requestId: null,
                sessionId: "unknown-session-140",
                terminalStatus: "unknown",
                fallbackOccurred: false,
              },
            },
          );
        }
        const result = await runArtifactWorkflow(input);
        return {
          ...result,
          summaryIdentity: {
            provider: supportedAgentProvider,
            model: opts.supportedAgentResultModel ?? "runtime-managed",
          },
          summary: opts.supportedAgentSummaryText ?? "# Summary\n\nhello\n",
          runtimeEvidence: opts.supportedAgentMissingEvidence ? undefined : {
            adapter: supportedAgentProvider,
            transport: supportedAgentProvider === "codex"
              ? "codex-app-server-stdio"
              : "claude-code-print-stream-json",
            runtimeVersion: supportedAgentProvider === "codex" ? "0.144.4" : "2.1.169",
            requestedProvider: supportedAgentProvider === "codex" ? "openai" : null,
            requestedModel: "runtime-managed",
            actualProvider: supportedAgentProvider === "codex" ? "openai" : null,
            actualModel: opts.supportedAgentResultModel ?? "runtime-managed",
            requestId: "turn-139",
            sessionId: "artifact-session",
            terminalStatus: "ready" as const,
            fallbackOccurred: false,
          },
          audit: {
            ...result.audit,
            toolNames: opts.supportedAgentToolNames ?? [],
            artifactCommit: false,
          },
        };
      },
    };
    const supportedAgentSummaryAdapter = opts.supportedAgentAdapter ? {
      current: () => ({
        capability: "summary" as const,
        provider: supportedAgentProvider,
        model: "runtime-managed",
        status: "ready" as const,
        testedAt: "2026-08-25T04:00:00.000Z",
        detail: "ready",
        credentialSource: "runtime-oauth",
        connectionId: supportedAgentProvider,
        disclosure: {
          kind: "external" as const,
          connectionId: supportedAgentProvider,
          disclosureVersion: supportedAgentDisclosureVersion,
          data: "transcript_text" as const,
          destination: `${supportedAgentProvider === "codex" ? "Codex" : "Claude Code"} service`,
        },
      }),
      probe: async () => { throw new Error("not used"); },
      gateway: () => supportedAgentGateway,
    } : undefined;
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
    const pubsub = new PubSub<AppChannels>();
    pipeline = new RecordingPipeline({
      store,
      artifacts,
      config: configManager,
      paths: runtimePaths,
      pubsub,
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
      xaiText: opts.xaiText ? { request: xaiRequest } : undefined,
      xaiSummaryCredentialSource: () => opts.xaiReadinessCredentialSource ?? "oauth",
      supportedAgentSummaryAdapter,
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
      xaiRequest,
      runArtifactWorkflow,
      runNotionWorkflow,
      pubsub,
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

  it("persists Core Activation Evidence when a production recording completes", async () => {
    const { audioPath, pubsub } = setup();
    const completed: AppChannels["core-activation"][] = [];
    pubsub.subscribe("core-activation", (event) => completed.push(event));
    writeFileSync(audioPath, wavWithAudio());

    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Demo" });
    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("completed"));

    expect(store!.getCoreActivationEvidence()).toMatchObject({
      recordingStem: task.recordingStem,
      taskId: task.id,
      transcriptionProvider: "test-audio",
      summaryProvider: "hermes",
      summaryModel: "runtime-managed",
      artifacts: {
        audio: { bytes: 45, sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        transcript: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
        summary: { sha256: expect.stringMatching(/^[a-f0-9]{64}$/) },
      },
    });
    expect(completed).toEqual([{
      taskId: task.id,
      recordingStem: task.recordingStem,
    }]);
  });

  it("announces only the recording that first establishes Core Activation Evidence", async () => {
    const { audioPath, moviesDir, pubsub } = setup();
    const completed: AppChannels["core-activation"][] = [];
    pubsub.subscribe("core-activation", (event) => completed.push(event));
    writeFileSync(audioPath, wavWithAudio());

    const first = pipeline!.enqueueCompletion({ audioPath, title: "First" });
    await vi.waitFor(() => expect(store!.getTask(first.task.id)?.state).toBe("completed"));
    const secondPath = join(moviesDir, "Second_20260711_121000.wav");
    writeFileSync(secondPath, wavWithAudio());
    const second = pipeline!.enqueueCompletion({ audioPath: secondPath, title: "Second" });
    await vi.waitFor(() => expect(store!.getTask(second.task.id)?.state).toBe("completed"));

    expect(completed).toEqual([{
      taskId: first.task.id,
      recordingStem: first.task.recordingStem,
    }]);
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

  it("pauses an unavailable summary provider until explicit same-snapshot retry", async () => {
    const { audioPath, configManager, transcribe } = setup({ available: false, pollMs: 5 });
    expect(pipeline!.transcriptionHealth()).toEqual({
      available: true,
      provider: "test-audio",
      reason: null,
      paused: false,
      policyReason: null,
    });
    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Demo", sendToNotion: true });
    await vi.waitFor(() => expect(store!.getTask(task.id)).toMatchObject({
      state: "awaiting_provider",
      attempt: 1,
      summaryProvider: "hermes",
      summaryModel: "runtime-managed",
    }));
    expect(store!.listArtifacts(task.id)).toEqual([
      expect.objectContaining({ kind: "transcript" }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(store!.getTask(task.id)?.attempt).toBe(1);
    expect(transcribe).toHaveBeenCalledOnce();

    configManager.update("intelligence.summary", { provider: "xai", model: "grok-new-default" });
    pipeline!.retry(task.id);
    await vi.waitFor(() => expect(store!.getTask(task.id)).toMatchObject({
      state: "awaiting_provider",
      attempt: 1,
      summaryProvider: "hermes",
      summaryModel: "runtime-managed",
    }));
    expect(store!.getTask(task.id)).toMatchObject({
      error: "Hermes offline",
    });
    expect(store!.listEvents(task.id).filter((event) => event.type === "task.awaiting_provider")).toHaveLength(2);
    expect(transcribe).toHaveBeenCalledOnce();
  });

  it("never dispatches a task through a provider other than its pinned snapshot", async () => {
    const { audioPath, configManager, runArtifactWorkflow, transcribe } = setup({
      pollMs: 5,
      xaiSummaryDisclosure: true,
    });
    configManager.update("intelligence.summary", { provider: "xai", model: "grok-4.6-exact" });

    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Pinned xAI" });
    await vi.waitFor(() => expect(store!.getTask(task.id)).toMatchObject({
      state: "awaiting_provider",
      summaryProvider: "xai",
      summaryModel: "grok-4.6-exact",
      error: expect.stringContaining("Pinned Summary Provider xai is unavailable"),
    }));

    expect(transcribe).toHaveBeenCalledOnce();
    expect(runArtifactWorkflow).not.toHaveBeenCalled();
  });

  it("blocks undisclosed xAI transcript processing at the production summary boundary", async () => {
    const { audioPath, configManager, xaiRequest, runArtifactWorkflow } = setup({
      pollMs: 5,
      xaiText: true,
      xaiSummaryDisclosure: false,
    });
    configManager.update("intelligence.summary", { provider: "xai", model: "grok-pinned" });

    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Undisclosed xAI" });
    await vi.waitFor(() => expect(store!.getTask(task.id)).toMatchObject({
      state: "awaiting_provider",
      summaryProvider: "xai",
      summaryModel: "grok-pinned",
      error: expect.stringContaining("xAI Summary Data Path Disclosure"),
    }));
    expect(xaiRequest).not.toHaveBeenCalled();
    expect(runArtifactWorkflow).not.toHaveBeenCalled();

    store!.recordSummaryDataPathDisclosure("xai", "xai-summary-v1");
    pipeline!.retry(task.id);
    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("completed"));
    expect(xaiRequest).toHaveBeenCalledOnce();
    expect(runArtifactWorkflow).not.toHaveBeenCalled();
  });

  it("binds a Supported Agent readiness adapter to the same production identity and disclosure", async () => {
    const { audioPath, runArtifactWorkflow } = setup({
      pollMs: 5,
      supportedAgentAdapter: true,
    });
    writeFileSync(audioPath, wavWithAudio());

    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Supported Agent" });
    expect(task).toMatchObject({
      summaryConnectionId: "codex",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "codex-summary-v1",
    });
    await vi.waitFor(() => expect(store!.getTask(task.id)).toMatchObject({
      state: "awaiting_provider",
      summaryProvider: "codex",
      summaryModel: "runtime-managed",
      error: expect.stringContaining("Codex service Data Path Disclosure"),
    }));
    expect(runArtifactWorkflow).not.toHaveBeenCalled();

    store!.recordAgentConnectionDisclosure({
      connectionId: "codex",
      capability: "summary",
      disclosureVersion: "codex-summary-v1",
      decision: "accepted",
    });
    pipeline!.retry(task.id);
    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("completed"));
    expect(runArtifactWorkflow).toHaveBeenCalledOnce();
    expect(runArtifactWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      committedTranscript: "hello transcript",
    }));
    expect(store!.getTask(task.id)).toMatchObject({
      summaryConnectionId: "codex",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "codex-summary-v1",
      summaryInputArtifactId: expect.any(String),
      summaryInputArtifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      summaryInputArtifactBytes: 17,
    });
    expect(store!.listArtifacts(task.id).find((artifact) => artifact.kind === "summary")?.provenance)
      .toMatchObject({
        agentProvider: "codex",
        summaryProvider: "codex",
        summaryModel: "runtime-managed",
        summaryConnectionId: "codex",
        summaryCredentialClass: "runtime-oauth",
        summaryDisclosureVersion: "codex-summary-v1",
        summaryInputArtifactId: expect.any(String),
        summaryInputArtifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        runtimeEvidence: expect.objectContaining({
          actualProvider: "openai",
          actualModel: "runtime-managed",
          fallbackOccurred: false,
          terminalStatus: "ready",
        }),
      });
    expect(store!.getCoreActivationEvidence()).toMatchObject({
      taskId: task.id,
      summaryProvider: "codex",
      summaryModel: "runtime-managed",
    });
  });

  it("snapshots and commits Claude Code Summary through the shared Host-owned artifact fence", async () => {
    const { audioPath, runArtifactWorkflow } = setup({
      pollMs: 5,
      supportedAgentAdapter: true,
      supportedAgentProvider: "claude-code",
    });
    writeFileSync(audioPath, wavWithAudio());
    store!.recordAgentConnectionDisclosure({
      connectionId: "claude-code",
      capability: "summary",
      disclosureVersion: "claude-code-summary-v1",
      decision: "accepted",
    });

    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Claude Summary" });
    expect(task).toMatchObject({
      summaryProvider: "claude-code",
      summaryModel: "runtime-managed",
      summaryConnectionId: "claude-code",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "claude-code-summary-v1",
      summaryInputArtifactId: null,
    });
    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("completed"));
    expect(runArtifactWorkflow).toHaveBeenCalledOnce();
    expect(runArtifactWorkflow).toHaveBeenCalledWith(expect.objectContaining({
      committedTranscript: "hello transcript",
      task: expect.objectContaining({
        summaryProvider: "claude-code",
        summaryConnectionId: "claude-code",
        summaryInputArtifactId: expect.any(String),
        summaryInputArtifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        summaryInputArtifactBytes: 17,
      }),
    }));
    expect(store!.listArtifacts(task.id).find((artifact) => artifact.kind === "summary")?.provenance)
      .toMatchObject({
        agentProvider: "claude-code",
        summaryProvider: "claude-code",
        summaryModel: "runtime-managed",
        summaryConnectionId: "claude-code",
        summaryCredentialClass: "runtime-oauth",
        summaryDisclosureVersion: "claude-code-summary-v1",
        summaryInputArtifactId: expect.any(String),
        summaryInputArtifactSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        runtimeEvidence: expect.objectContaining({
          adapter: "claude-code",
          requestedProvider: null,
          actualProvider: null,
          actualModel: "runtime-managed",
          fallbackOccurred: false,
          terminalStatus: "ready",
        }),
      });
    expect(store!.getCoreActivationEvidence()).toMatchObject({
      taskId: task.id,
      summaryProvider: "claude-code",
      summaryModel: "runtime-managed",
    });
  });

  it.each([
    ["tool call", { supportedAgentToolNames: ["commandExecution"] }, "attempted a tool call"],
    ["missing Runtime Evidence", { supportedAgentMissingEvidence: true }, "complete Runtime Evidence"],
    ["empty output", { supportedAgentSummaryText: "   " }, "empty summary"],
    ["invalid output", { supportedAgentSummaryText: "bad\u0000summary" }, "invalid summary"],
  ])("fails closed on Codex %s without replacing a prior summary", async (_name, failure, error) => {
    const { audioPath, moviesDir, configDir } = setup({
      pollMs: 5,
      supportedAgentAdapter: true,
      ...failure,
    });
    writeFileSync(audioPath, wavWithAudio());
    const summaryPath = join(moviesDir, "Demo_20260711_120000.summary.md");
    writeFileSync(summaryPath, "# Prior verified summary\n");
    store!.recordAgentConnectionDisclosure({
      connectionId: "codex",
      capability: "summary",
      disclosureVersion: "codex-summary-v1",
      decision: "accepted",
    });

    const { task } = pipeline!.enqueueCompletion({ audioPath, title: `Fail closed ${_name}` });
    await vi.waitFor(() => expect(store!.getTask(task.id)).toMatchObject({
      state: "failed",
      error: expect.stringContaining(error),
    }));
    expect(readFileSync(summaryPath, "utf8")).toBe("# Prior verified summary\n");
    expect(existsSync(join(moviesDir, `${task.recordingStem}.summary.stale`))).toBe(false);
    expect(existsSync(join(configDir, "agent-tasks", task.id, "rejected-summary.md"))).toBe(false);
    expect(store!.getCoreActivationEvidence()).toBeNull();
  });

  it("fails closed on Claude Code tool use without replacing a prior summary", async () => {
    const { audioPath, moviesDir, configDir } = setup({
      pollMs: 5,
      supportedAgentAdapter: true,
      supportedAgentProvider: "claude-code",
      supportedAgentToolNames: ["Bash"],
    });
    writeFileSync(audioPath, wavWithAudio());
    const summaryPath = join(moviesDir, "Demo_20260711_120000.summary.md");
    writeFileSync(summaryPath, "# Prior verified summary\n");
    store!.recordAgentConnectionDisclosure({
      connectionId: "claude-code",
      capability: "summary",
      disclosureVersion: "claude-code-summary-v1",
      decision: "accepted",
    });

    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Reject Claude tool use" });
    await vi.waitFor(() => expect(store!.getTask(task.id)).toMatchObject({
      state: "failed",
      error: expect.stringContaining("attempted a tool call"),
    }));
    expect(readFileSync(summaryPath, "utf8")).toBe("# Prior verified summary\n");
    expect(existsSync(join(moviesDir, `${task.recordingStem}.summary.stale`))).toBe(false);
    expect(existsSync(join(configDir, "agent-tasks", task.id, "rejected-summary.md"))).toBe(false);
    expect(store!.getCoreActivationEvidence()).toBeNull();
  });

  it("persists Claude Code Summary Unknown Outcome without allowing retry or replacing a prior summary", async () => {
    const { audioPath, moviesDir, configDir } = setup({
      pollMs: 5,
      supportedAgentAdapter: true,
      supportedAgentProvider: "claude-code",
      supportedAgentUnknownOutcome: true,
    });
    writeFileSync(audioPath, wavWithAudio());
    const summaryPath = join(moviesDir, "Demo_20260711_120000.summary.md");
    writeFileSync(summaryPath, "# Prior verified summary\n");
    store!.recordAgentConnectionDisclosure({
      connectionId: "claude-code",
      capability: "summary",
      disclosureVersion: "claude-code-summary-v1",
      decision: "accepted",
    });

    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Unknown Claude Summary" });
    await vi.waitFor(() => expect(store!.getTask(task.id)).toMatchObject({
      state: "execution_unverified",
      nativeSessionId: "unknown-session-140",
      error: expect.stringContaining("Unknown Outcome"),
    }));
    expect(() => pipeline!.retry(task.id)).toThrow("cannot retry from execution_unverified");
    expect(readFileSync(summaryPath, "utf8")).toBe("# Prior verified summary\n");
    expect(existsSync(join(moviesDir, `${task.recordingStem}.summary.stale`))).toBe(false);
    expect(existsSync(join(configDir, "agent-tasks", task.id, "rejected-summary.md"))).toBe(false);
    expect(store!.getCoreActivationEvidence()).toBeNull();
    expect(store!.listEvents(task.id)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "claude.summary_unknown_outcome",
        payload: expect.objectContaining({
          nativeSessionId: "unknown-session-140",
          runtimeEvidence: expect.objectContaining({ terminalStatus: "unknown" }),
        }),
      }),
    ]));
  });

  it("rejects Supported Agent artifacts without the pinned model provenance", async () => {
    const { audioPath, moviesDir, configDir } = setup({
      pollMs: 5,
      supportedAgentAdapter: true,
      supportedAgentResultModel: "different-model",
    });
    writeFileSync(audioPath, wavWithAudio());
    const summaryPath = join(moviesDir, "Demo_20260711_120000.summary.md");
    writeFileSync(summaryPath, "# Prior verified summary\n");
    store!.recordAgentConnectionDisclosure({
      connectionId: "codex",
      capability: "summary",
      disclosureVersion: "codex-summary-v1",
      decision: "accepted",
    });

    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Wrong Agent model" });
    await vi.waitFor(() => expect(store!.getTask(task.id)).toMatchObject({
      state: "failed",
      error: expect.stringContaining("different Summary Provider/model identity"),
    }));
    expect(readFileSync(summaryPath, "utf8")).toBe("# Prior verified summary\n");
    expect(existsSync(join(moviesDir, `${task.recordingStem}.summary.stale`))).toBe(false);
    expect(existsSync(join(configDir, "agent-tasks", task.id, "rejected-summary.md"))).toBe(false);
    expect(store!.getCoreActivationEvidence()).toBeNull();
  });

  it("does not quarantine a prior summary when the mismatched Agent never committed this task", async () => {
    const { audioPath, moviesDir, configDir } = setup({
      pollMs: 5,
      supportedAgentAdapter: true,
      supportedAgentResultModel: "different-model",
      skipArtifactCommit: true,
    });
    writeFileSync(audioPath, wavWithAudio());
    const summaryPath = join(moviesDir, "Demo_20260711_120000.summary.md");
    writeFileSync(summaryPath, "# Prior verified summary\n");
    store!.recordAgentConnectionDisclosure({
      connectionId: "codex",
      capability: "summary",
      disclosureVersion: "codex-summary-v1",
      decision: "accepted",
    });

    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Preserve prior summary" });
    await vi.waitFor(() => expect(store!.getTask(task.id)).toMatchObject({
      state: "failed",
      error: expect.stringContaining("different Summary Provider/model identity"),
    }));
    expect(readFileSync(summaryPath, "utf8")).toBe("# Prior verified summary\n");
    expect(existsSync(join(moviesDir, `${task.recordingStem}.summary.stale`))).toBe(false);
    expect(existsSync(join(configDir, "agent-tasks", task.id, "rejected-summary.md"))).toBe(false);
  });

  it("commits an automatic xAI summary from only the pinned instructions and committed transcript", async () => {
    const { audioPath, configManager, moviesDir, xaiRequest, runArtifactWorkflow } = setup({ xaiText: true });
    writeFileSync(audioPath, wavWithAudio());
    configManager.update("intelligence.summary", { provider: "xai", model: "grok-4.6-exact" });

    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Pinned xAI" });
    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("completed"));

    expect(xaiRequest).toHaveBeenCalledOnce();
    expect(xaiRequest).toHaveBeenCalledWith({
      capability: "summary",
      model: "grok-4.6-exact",
      credentialSource: "oauth",
      input: [
        { role: "system", content: task.instructions },
        { role: "user", content: "hello transcript" },
      ],
    });
    expect(runArtifactWorkflow).not.toHaveBeenCalled();
    expect(readFileSync(join(moviesDir, "Demo_20260711_120000.summary.md"), "utf8"))
      .toBe("# xAI Summary\n\nhello\n");
    expect(store!.listArtifacts(task.id).find((artifact) => artifact.kind === "summary")?.provenance)
      .toEqual({
        summaryProvider: "xai",
        summaryModel: "grok-4.6-exact",
        storageDisabled: true,
        credentialSource: "oauth",
        committedBy: "yulu-host",
      });
    expect(store!.getCoreActivationEvidence()).toMatchObject({
      taskId: task.id,
      summaryProvider: "xai",
      summaryModel: "grok-4.6-exact",
    });
  });

  it("routes the exact claimed xAI task without a bounded queue pre-scan", async () => {
    const { audioPath, configManager, gatewayFactory, xaiRequest } = setup({
      xaiText: true,
      gatewayFactoryThrows: true,
    });
    configManager.update("intelligence.summary", { provider: "xai", model: "grok-4.6-exact" });
    const listTasks = vi.spyOn(store!, "listTasks").mockImplementation(() => {
      throw new Error("bounded queue listing must not select the provider runner");
    });

    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Claimed xAI" });
    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("completed"));

    expect(xaiRequest).toHaveBeenCalledOnce();
    expect(gatewayFactory).not.toHaveBeenCalled();
    listTasks.mockRestore();
  });

  it("pauses an xAI summary failure after one attempt and retries the same snapshot without fallback", async () => {
    const { audioPath, configManager, xaiRequest, runArtifactWorkflow, transcribe } = setup({
      pollMs: 5,
      xaiText: true,
    });
    configManager.update("intelligence.summary", { provider: "xai", model: "grok-pinned" });
    xaiRequest.mockRejectedValueOnce(new Error("xAI summary request failed (HTTP 403)"));

    const { task } = pipeline!.enqueueCompletion({ audioPath });
    await vi.waitFor(() => expect(store!.getTask(task.id)).toMatchObject({
      state: "awaiting_provider",
      attempt: 1,
      summaryProvider: "xai",
      summaryModel: "grok-pinned",
      error: "xAI summary request failed (HTTP 403)",
    }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(xaiRequest).toHaveBeenCalledOnce();
    expect(transcribe).toHaveBeenCalledOnce();
    expect(runArtifactWorkflow).not.toHaveBeenCalled();
    expect(store!.listArtifacts(task.id).map((artifact) => artifact.kind)).toEqual(["transcript"]);

    configManager.update("intelligence.summary", { provider: "agent", model: "runtime-managed" });
    configManager.update("agent_pipeline.auto_process_recordings", false);
    pipeline!.retry(task.id);
    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("awaiting_policy"));
    expect(xaiRequest).toHaveBeenCalledOnce();
    expect(transcribe).toHaveBeenCalledOnce();

    configManager.update("agent_pipeline.auto_process_recordings", true);
    pipeline!.kick();
    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("completed"));

    expect(xaiRequest).toHaveBeenCalledTimes(2);
    expect(xaiRequest).toHaveBeenLastCalledWith(expect.objectContaining({ model: "grok-pinned" }));
    expect(transcribe).toHaveBeenCalledOnce();
    expect(runArtifactWorkflow).not.toHaveBeenCalled();
  });

  it("pins xAI summary execution to the readiness credential source", async () => {
    const { audioPath, configManager, xaiRequest } = setup({
      pollMs: 5,
      xaiText: true,
      xaiReadinessCredentialSource: "oauth",
      xaiExecutionCredentialSource: "api-key",
    });
    configManager.update("intelligence.summary", { provider: "xai", model: "grok-pinned" });

    const { task } = pipeline!.enqueueCompletion({ audioPath });
    expect(task).toMatchObject({
      summaryProvider: "xai",
      summaryModel: "grok-pinned",
      summaryCredentialSource: "oauth",
    });
    await vi.waitFor(() => expect(store!.getTask(task.id)).toMatchObject({
      state: "awaiting_provider",
      summaryCredentialSource: "oauth",
      error: expect.stringContaining("Pinned xAI credential oauth"),
    }));
    expect(xaiRequest).toHaveBeenCalledWith(expect.objectContaining({ credentialSource: "oauth" }));
  });

  it("does not send a legacy xAI task whose credential source was never pinned", async () => {
    const { audioPath, configManager, xaiRequest } = setup({
      pollMs: 5,
      xaiText: true,
    });
    configManager.update("intelligence.summary", { provider: "xai", model: "grok-pinned" });
    const task = store!.enqueueRecording({
      idempotencyKey: "recording:legacy-xai-without-source",
      recordingStem: "Demo_20260711_120000",
      title: "Legacy xAI",
      audioPath,
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "xai",
      summaryProvider: "xai",
      summaryModel: "grok-pinned",
      summaryCredentialSource: "oauth",
    }).task;
    store!.db.prepare("UPDATE agent_tasks SET summary_credential_source = NULL WHERE id = ?").run(task.id);

    pipeline!.kick();

    await vi.waitFor(() => expect(store!.getTask(task.id)).toMatchObject({
      state: "awaiting_provider",
      summaryCredentialSource: null,
      error: expect.stringContaining("credential source was not pinned"),
    }));
    expect(xaiRequest).not.toHaveBeenCalled();
  });

  it("creates an explicit new-provider summary attempt over the same committed transcript", async () => {
    const { audioPath, configManager, xaiRequest, transcribe } = setup({
      available: false,
      pollMs: 5,
      xaiText: true,
    });
    writeFileSync(audioPath, wavWithAudio());
    const guided = store!.beginActivationAttempt().attempt;
    const original = pipeline!.enqueueCompletion({ audioPath, title: "Guided activation" }).task;
    store!.correlateActivationAttempt(guided.id, original.id);
    await vi.waitFor(() => expect(store!.getTask(original.id)?.state).toBe("awaiting_provider"));

    configManager.update("intelligence.summary", { provider: "xai", model: "grok-new-explicit" });
    const replacement = pipeline!.replaceSummaryProvider(original.id);
    await vi.waitFor(() => expect(store!.getTask(replacement.id)?.state).toBe("completed"));

    expect(store!.getTask(original.id)).toMatchObject({
      state: "cancelled",
      summaryProvider: "hermes",
      summaryModel: "runtime-managed",
    });
    expect(store!.getTask(replacement.id)).toMatchObject({
      summaryProvider: "xai",
      summaryModel: "grok-new-explicit",
    });
    expect(store!.getActivationAttempt()).toMatchObject({ taskId: replacement.id });
    expect(transcribe).toHaveBeenCalledOnce();
    expect(xaiRequest).toHaveBeenCalledOnce();
    expect(xaiRequest).toHaveBeenCalledWith(expect.objectContaining({ model: "grok-new-explicit" }));
    expect(store!.listArtifacts(original.id).map((artifact) => artifact.kind)).toEqual(["transcript"]);
    expect(store!.listArtifacts(replacement.id)).toEqual([
      expect.objectContaining({
        kind: "summary",
        provenance: expect.objectContaining({
          summaryProvider: "xai",
          summaryModel: "grok-new-explicit",
        }),
      }),
      expect.objectContaining({
        kind: "transcript",
        provenance: expect.objectContaining({ reusedFromTaskId: original.id }),
      }),
    ]);
    expect(store!.getCoreActivationEvidence()).toMatchObject({
      taskId: replacement.id,
      summaryProvider: "xai",
      summaryModel: "grok-new-explicit",
    });
  });

  it("pauses a replacement transcript when the global pipeline is disabled", async () => {
    const { audioPath, configManager, xaiRequest, transcribe } = setup({
      available: false,
      pollMs: 5,
      xaiText: true,
    });
    writeFileSync(audioPath, wavWithAudio());
    const original = pipeline!.enqueueCompletion({ audioPath, title: "Guided activation" }).task;
    await vi.waitFor(() => expect(store!.getTask(original.id)?.state).toBe("awaiting_provider"));

    configManager.update("intelligence.summary", { provider: "xai", model: "grok-new-explicit" });
    configManager.update("agent_pipeline.enabled", false);
    const replacement = pipeline!.replaceSummaryProvider(original.id);

    await vi.waitFor(() => expect(store!.getTask(replacement.id)).toMatchObject({
      state: "awaiting_policy",
      summaryProvider: "xai",
      summaryModel: "grok-new-explicit",
    }));
    expect(store!.listArtifacts(replacement.id).map((artifact) => artifact.kind)).toEqual(["transcript"]);
    expect(transcribe).toHaveBeenCalledOnce();
    expect(xaiRequest).not.toHaveBeenCalled();
    expect(store!.claimNext()).toBeNull();
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
    const { audioPath, notionStartedFromState, pubsub } = setup({ notionThrowsAfterCapability: true });
    const completed: AppChannels["core-activation"][] = [];
    pubsub.subscribe("core-activation", (event) => completed.push(event));
    writeFileSync(audioPath, wavWithAudio());
    const { task } = pipeline!.enqueueCompletion({ audioPath, sendToNotion: true });

    await vi.waitFor(() => expect(store!.getTask(task.id)?.state).toBe("delivery_unverified"));
    expect(notionStartedFromState()).toBe("sending");
    expect(store!.getNotionDelivery(task.id)).toMatchObject({
      deliveryKey: `yulu-${task.id}`,
      status: "sending",
    });
    expect(store!.getCoreActivationEvidence()).toMatchObject({ taskId: task.id });
    expect(completed).toEqual([{ taskId: task.id, recordingStem: task.recordingStem }]);
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

  it("contains dispatch boundary failures and releases claimed work for retry", async () => {
    const { audioPath } = setup({ gatewayFactoryThrows: true });
    const { task } = pipeline!.enqueueCompletion({ audioPath, title: "Demo" });

    await vi.waitFor(() => expect(store!.getTask(task.id)).toMatchObject({
      state: "awaiting_agent",
      attempt: 1,
      error: "invalid runtime config",
    }));
    await expect(pipeline!.close()).resolves.toBeUndefined();
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
      summaryProvider: "hermes",
      summaryModel: "runtime-managed",
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
      summaryProvider: "hermes",
      summaryModel: "runtime-managed",
    }).task;
    store!.markAwaitingAgent(awaiting.id, "Hermes was offline");

    configManager.update("agent_pipeline.enabled", false);
    pipeline!.kick();
    await vi.waitFor(() => {
      expect(store!.getTask(queued.id)?.state).toBe("awaiting_policy");
      expect(store!.getTask(awaiting.id)?.state).toBe("awaiting_policy");
    });
    expect(transcribe).not.toHaveBeenCalled();
    expect(store!.claimNext()).toBeNull();
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
