import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ipcSendMock = vi.hoisted(() => vi.fn());
const runRecordAudioMock = vi.hoisted(() => vi.fn());
const stopRecordingAndEnqueueMock = vi.hoisted(() => vi.fn());
vi.mock("../../src/ipc.js", () => ({ ipcSend: ipcSendMock }));
vi.mock("../../src/recordingCommand.js", () => ({
  runRecordAudio: runRecordAudioMock,
  stopRecordingAndEnqueue: stopRecordingAndEnqueueMock,
}));

import { ArtifactStore } from "../../src/artifactStore.js";
import { verifiedCoreActivationEvidence } from "../../src/coreActivation.js";
import { HostStore } from "../../src/hostStore.js";
import { XAI_TRANSCRIPTION_DISCLOSURE_VERSION } from "../../src/transcriptionConsent.js";
import { XAI_SUMMARY_DISCLOSURE_VERSION } from "../../src/summaryDataDisclosure.js";
import type { SupportedAgentSummaryReadiness } from "../../src/summaryProviderReadiness.js";
import type { AgentConnectionCenter } from "../../src/agentConnections.js";
import { activationRouter } from "../../src/routers/activation.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

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

type SummaryActivationState = Awaited<ReturnType<AgentConnectionCenter["summaryActivation"]>>;

function summaryContract(input: {
  connectionId?: string;
  provider?: string;
  label?: string;
  model?: string;
  state?: SummaryActivationState["state"];
  credentialSource?: SummaryActivationState["credentialSource"];
  testedAt?: string | null;
  disclosure?: SummaryActivationState["disclosure"];
  publicOnboardingSupported?: boolean;
  blocker?: SummaryActivationState["blocker"];
  directXaiAvailable?: boolean;
} = {}): SummaryActivationState {
  const selected = {
    connectionId: input.connectionId ?? "codex",
    provider: input.provider ?? "codex",
    label: input.label ?? "Codex",
    model: input.model ?? "runtime-managed",
  };
  const state = input.state ?? "ready";
  const blocker = input.blocker ?? null;
  const credentialSource = input.credentialSource ?? null;
  return {
    selected,
    options: state === "ready" && selected.connectionId ? [{
      ...selected,
      connectionId: selected.connectionId,
      credentialSource,
      selected: true,
    }] : [],
    directXaiAvailable: input.directXaiAvailable ?? true,
    state,
    detail: blocker?.detail ?? null,
    credentialSource,
    testedAt: input.testedAt ?? "2026-08-25T04:00:00.000Z",
    disclosure: input.disclosure ?? null,
    publicOnboardingSupported: input.publicOnboardingSupported ?? true,
    remediation: blocker?.remediation ?? null,
    blocker,
  };
}

describe("activation router", () => {
  let root = "";
  let host: HostStore | undefined;

  afterEach(() => {
    host?.close();
    host = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
    ipcSendMock.mockReset();
    runRecordAudioMock.mockReset();
    stopRecordingAndEnqueueMock.mockReset();
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "yulu-activation-"));
    const moviesDir = join(root, "movies");
    mkdirSync(moviesDir);
    host = new HostStore(join(root, "host.sqlite"));
    const artifacts = new ArtifactStore(moviesDir, join(root, "tasks"));
    const configValue = {
      audio: { mic_device: "BuiltInMic" },
      transcription: { engine: "local" as "local" | "xai" },
      intelligence: {
        summary: { provider: "agent" as "agent" | "xai", model: "runtime-managed" },
      },
      agent_pipeline: {
        enabled: true,
        auto_process_recordings: true,
        auto_send_notion: false,
      },
    };
    const localStatus = {
      installed: true,
      ready: true,
      provider: "sherpa-onnx-paraformer-int8",
      error: null as string | null,
    };
    ipcSendMock.mockImplementation(async (_path: string, payload: { action: string }) => {
      if (payload.action === "status") return { micReady: true, micError: "" };
      if (payload.action === "audio_devices") {
        return { input: [{ uid: "BuiltInMic", name: "MacBook Pro Microphone" }], output: [] };
      }
      throw new Error(`unexpected action: ${payload.action}`);
    });
    const xaiConnection = {
      connected: true,
      source: "oauth" as "oauth" | "api-key" | null,
      detail: "connected",
    };
    let agentReadiness: SupportedAgentSummaryReadiness = {
      capability: "summary" as const,
      provider: "codex",
      model: "runtime-managed",
      status: "ready" as "ready" | "failed",
      testedAt: "2026-08-25T04:00:00.000Z" as string | null,
      detail: "ready",
      credentialSource: "oauth" as string | null,
      disclosure: { kind: "local" as const },
    };
    const agentProbe = vi.fn(async () => agentReadiness);
    const retryTask = vi.fn((
      id: string,
      options?: { allowCancelled?: boolean; allowCompleted?: boolean; discardArtifacts?: boolean },
    ) => host!.retry(id, options));
    const replaceSummaryProvider = vi.fn((id: string) => {
      const selected = configValue.intelligence.summary.provider === "xai"
        ? configValue.intelligence.summary
        : { provider: agentReadiness.provider, model: agentReadiness.model };
      return host!.replaceSummaryAttempt(id, {
        summaryProvider: selected.provider,
        summaryModel: selected.model,
        summaryCredentialSource: selected.provider === "xai" ? xaiConnection.source : null,
      });
    });
    const enqueueCompletion = vi.fn((input: { audioPath: string; title: string; sendToNotion: boolean }) => ({
      ...host!.enqueueRecording({
        idempotencyKey: `activation-recovery:${input.audioPath}`,
        recordingStem: input.audioPath.split("/").at(-1)!.replace(/\.wav$/, ""),
        title: input.title,
        audioPath: input.audioPath,
        sendToNotion: input.sendToNotion,
        destinationHint: "",
        agentProvider: agentReadiness.provider,
        summaryProvider: agentReadiness.provider,
        summaryModel: agentReadiness.model,
      }),
    }));
    const ctx = {
      uiMutationAuthorized: true,
      host,
      artifacts,
      paths: { moviesDir, audioDaemonSock: join(root, "audio.sock") },
      config: {
        read: () => configValue,
        update: (_key: string, value: "local" | "xai") => {
          configValue.transcription.engine = value;
          return { daemonsNeedingRestart: [], daemonsNeedingSighup: [] };
        },
      },
      localCaption: {
        status: () => localStatus,
        syncSelection: async () => {},
      },
      xaiCredentials: {
        cachedStatus: () => xaiConnection,
      },
      xaiReadiness: new Map(),
      supportedAgentSummaryAdapter: {
        current: () => agentReadiness,
        probe: agentProbe,
        gateway: () => ({} as never),
      },
      recordingPipeline: {
        enqueueCompletion,
        retry: retryTask,
        replaceSummaryProvider,
        kick: vi.fn(),
      },
    } as unknown as AppContext;
    let summaryActivationState = summaryContract();
    const summaryActivation = vi.fn(async () => summaryActivationState);
    ctx.agentConnections = {
      summaryActivation,
      acceptDisclosure: vi.fn(({ connectionId, capability }: { connectionId: string; capability: string }) => {
        if (capability === "transcription" && connectionId === "direct-xai") {
          return host!.recordCloudTranscriptionConsent(XAI_TRANSCRIPTION_DISCLOSURE_VERSION);
        }
        if (capability !== "summary") throw new Error("unexpected capability");
        const disclosure = summaryActivationState.disclosure;
        if (!disclosure || disclosure.connectionId !== connectionId) throw new Error("Summary disclosure is local");
        const result = connectionId === "direct-xai"
          ? host!.recordSummaryDataPathDisclosure("xai", disclosure.disclosureVersion)
          : (() => {
        if (!host!.listAgentConnectionRecords().some((record) => record.id === connectionId)) {
          host!.upsertAgentConnectionRecord({
            id: connectionId,
            kind: "supported-agent",
            adapter: connectionId,
            label: connectionId,
            lifecycle: "available",
            settings: {},
          });
        }
            return host!.recordAgentConnectionDisclosure({
              connectionId,
              capability: "summary",
              disclosureVersion: disclosure.disclosureVersion,
              decision: "accepted",
            });
          })();
        summaryActivationState = {
          ...summaryActivationState,
          state: "ready",
          blocker: null,
          remediation: null,
          disclosure: {
            ...disclosure,
            required: false,
            declined: false,
            acceptedDisclosureVersion: disclosure.disclosureVersion,
          },
        };
        return result;
      }),
      declineDisclosure: vi.fn(({ connectionId, capability }: { connectionId: string; capability: string }) => {
        if (capability !== "summary") throw new Error("unexpected capability");
        const disclosure = summaryActivationState.disclosure;
        if (!disclosure || disclosure.connectionId !== connectionId) throw new Error("Summary disclosure is local");
        const result = connectionId === "direct-xai"
          ? host!.declineSummaryDataPathDisclosure("xai", disclosure.disclosureVersion)
          : host!.recordAgentConnectionDisclosure({
              connectionId,
              capability: "summary",
              disclosureVersion: disclosure.disclosureVersion,
              decision: "declined",
            });
        const remediation = {
          href: `/settings/llm?connection=${encodeURIComponent(connectionId)}&capability=summary`,
        };
        summaryActivationState = {
          ...summaryActivationState,
          state: "disclosure_required",
          detail: `Review the ${summaryActivationState.selected.label} Summary data path before recording`,
          disclosure: {
            ...disclosure,
            required: true,
            declined: true,
            acceptedDisclosureVersion: null,
          },
          remediation,
          blocker: {
            capability: "summary_disclosure",
            reason: "disclosure_declined",
            detail: `Review the ${summaryActivationState.selected.label} Summary data path before recording`,
            remediation,
          },
        };
        return result;
      }),
      probe: vi.fn(async () => agentProbe()),
    } as never;
    return {
      moviesDir,
      artifacts,
      caller: createCaller(activationRouter, ctx),
      configValue,
      localStatus,
      xaiConnection,
      agentProbe,
      summaryActivation,
      retryTask,
      replaceSummaryProvider,
      enqueueCompletion,
      setAgentReadiness: (value: SupportedAgentSummaryReadiness) => { agentReadiness = value; },
      setSummaryActivation: (value: SummaryActivationState) => { summaryActivationState = value; },
      ctx,
    };
  }

  it("reports microphone, selected audio input, and local probe readiness separately", async () => {
    const { caller, localStatus } = setup();

    await expect(caller.status()).resolves.toMatchObject({
      state: "unresolved",
      nextStep: null,
      blocker: null,
      readiness: {
        microphonePermission: { state: "ready" },
        audioInput: { state: "ready", selectedDeviceUid: "BuiltInMic" },
        transcription: {
          selected: "local",
          state: "ready",
          local: { available: true, ready: true },
        },
      },
    });

    localStatus.ready = false;
    localStatus.error = "local model probe failed";
    await expect(caller.status()).resolves.toMatchObject({
      nextStep: "transcription",
      blocker: {
        capability: "local_transcription",
        remediation: { href: "/settings/transcription" },
      },
      readiness: {
        transcription: {
          selected: "local",
          state: "blocked",
          local: { available: true, ready: false, detail: "local model probe failed" },
        },
      },
    });
  });

  it("starts the production recorder and resumes its exact durable task after Host restart", async () => {
    const { caller, ctx } = setup();
    runRecordAudioMock.mockResolvedValue({ ok: true, stdout: "recording started\n", stderr: "" });

    const started = await caller.startAttempt();
    expect(runRecordAudioMock).toHaveBeenCalledWith(ctx, ["start", "Core Activation"], { timeoutMs: 30_000 });
    expect(started).toMatchObject({
      state: "recording",
      attempt: { id: expect.any(String), taskId: null, recordingStem: null },
    });

    const task = host!.enqueueRecording({
      idempotencyKey: "recording:guided-activation",
      recordingStem: "Activation_20260825_141500",
      title: "Core Activation",
      audioPath: join(root, "movies", "Activation_20260825_141500.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryConnectionId: "codex",
      summaryModel: "runtime-managed",
    }).task;
    stopRecordingAndEnqueueMock.mockImplementation(async (
      _ctx: AppContext,
      _stop: unknown,
      onRecordingStopped?: (identity: { audioPath: string; recordingStem: string }) => void,
    ) => {
      onRecordingStopped?.({ audioPath: task.audioPath, recordingStem: task.recordingStem });
      return {
        ok: true,
        stdout: `FINAL_RECORDING_PATH=${task.audioPath}\n`,
        stderr: "",
        pipeline: {
          accepted: true,
          taskId: task.id,
          recordingStem: task.recordingStem,
          state: task.state,
          created: true,
          sendToNotion: false,
        },
      };
    });

    await expect(caller.stopAttempt()).resolves.toMatchObject({
      state: "processing",
      attempt: {
        taskId: task.id,
        recordingStem: task.recordingStem,
        stopRequestedAt: expect.any(String),
        handoffError: null,
      },
      task: { id: task.id, state: "queued" },
    });

    host!.close();
    host = new HostStore(join(root, "host.sqlite"));
    const restartedCaller = createCaller(activationRouter, { ...ctx, host } as unknown as AppContext);
    await expect(restartedCaller.status()).resolves.toMatchObject({
      state: "processing",
      attempt: { taskId: task.id, recordingStem: task.recordingStem },
      task: { id: task.id, state: "queued" },
    });
  });

  it("starts native capture only once for concurrent Activation Attempt requests", async () => {
    const { caller } = setup();
    let releaseStart!: () => void;
    const startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    runRecordAudioMock.mockImplementation(async () => {
      if (runRecordAudioMock.mock.calls.length > 1) throw new Error("RecordingBusy");
      await startGate;
      return { ok: true, stdout: "recording started\n", stderr: "" };
    });

    const first = caller.startAttempt();
    await vi.waitFor(() => expect(runRecordAudioMock).toHaveBeenCalledOnce());
    const second = caller.startAttempt();
    await expect(second).resolves.toMatchObject({
      state: "recording",
      attempt: { id: expect.any(String), taskId: null },
    });
    releaseStart();
    const started = await first;

    expect(runRecordAudioMock).toHaveBeenCalledOnce();
    expect(host!.getActivationAttempt()?.id).toBe(started.attempt.id);
  });

  it("durably names a bounded production-recorder start failure and retries capture", async () => {
    const { caller } = setup();
    runRecordAudioMock.mockRejectedValue(new Error("audio daemon unavailable"));

    await expect(caller.startAttempt()).rejects.toThrow("audio daemon unavailable");
    expect(host!.getActivationAttempt()).toMatchObject({
      recordingStem: null,
      taskId: null,
      handoffError: "audio daemon unavailable",
    });
    await expect(caller.status()).resolves.toMatchObject({
      state: "processing",
      blocker: {
        capability: "audio",
        retry: "start_recording",
        remediation: { href: "/settings/general" },
      },
    });

    runRecordAudioMock.mockResolvedValue({ ok: true, stdout: "recording started\n", stderr: "" });
    await expect(caller.retryAttempt()).resolves.toMatchObject({
      state: "recording",
      blocker: null,
    });
    expect(runRecordAudioMock).toHaveBeenCalledTimes(2);
  });

  it("blocks capture before start when production pipeline policy is paused", async () => {
    const { caller, configValue } = setup();
    configValue.agent_pipeline.auto_process_recordings = false;

    await expect(caller.status()).resolves.toMatchObject({
      state: "unresolved",
      nextStep: "recording_pipeline",
      blocker: {
        capability: "recording_pipeline",
        remediation: { href: "/settings/automation" },
      },
      readiness: {
        recordingPipeline: {
          state: "blocked",
          enabled: true,
          autoProcessRecordings: false,
        },
      },
    });
    await expect(caller.startAttempt()).rejects.toThrow("recording pipeline policy");
    expect(runRecordAudioMock).not.toHaveBeenCalled();
    expect(host!.getActivationAttempt()).toBeNull();
  });

  it("durably displays a stopped recording whose production handoff fails", async () => {
    const { caller, ctx } = setup();
    runRecordAudioMock.mockResolvedValue({ ok: true, stdout: "recording started\n", stderr: "" });
    await caller.startAttempt();
    stopRecordingAndEnqueueMock.mockImplementation(async (
      _ctx: AppContext,
      _stop: unknown,
      onRecordingStopped?: (identity: { audioPath: string; recordingStem: string }) => void,
    ) => {
      onRecordingStopped?.({
        audioPath: join(root, "movies", "Guided_20260825_141500.wav"),
        recordingStem: "Guided_20260825_141500",
      });
      return {
        ok: true,
        stdout: "FINAL_RECORDING_PATH=Guided_20260825_141500.wav\n",
        stderr: "",
        pipeline: {
          accepted: false,
          permanent: true,
          reason: "Automatic Agent recording processing is paused by policy",
          sendToNotion: false,
        },
      };
    });

    await expect(caller.stopAttempt()).rejects.toThrow("processing is paused by policy");
    expect(host!.getActivationAttempt()).toMatchObject({
      recordingStem: "Guided_20260825_141500",
      taskId: null,
      handoffError: "Automatic Agent recording processing is paused by policy",
    });

    host!.close();
    host = new HostStore(join(root, "host.sqlite"));
    const restartedCaller = createCaller(activationRouter, { ...ctx, host } as unknown as AppContext);
    await expect(restartedCaller.status()).resolves.toMatchObject({
      state: "processing",
      task: null,
      attempt: {
        recordingStem: "Guided_20260825_141500",
        handoffError: "Automatic Agent recording processing is paused by policy",
      },
      blocker: {
        capability: "recording_pipeline",
        retry: "same_audio",
        remediation: { href: "/settings/automation" },
      },
    });
  });

  it("recovers a saved stopped recording after a crash before enqueue", async () => {
    const { caller, moviesDir, enqueueCompletion } = setup();
    const stem = "Crash_before_enqueue_20260825_141500";
    writeFileSync(join(moviesDir, `${stem}.wav`), wavWithAudio());
    const attempt = host!.beginActivationAttempt().attempt;
    host!.markActivationAttemptStopping(attempt.id);
    host!.recordActivationAttemptStopped(attempt.id, stem);

    await expect(caller.status()).resolves.toMatchObject({
      state: "processing",
      task: null,
      blocker: {
        capability: "recording_pipeline",
        retry: "same_audio",
        remediation: { href: "/settings/automation" },
      },
    });

    await expect(caller.retryAttempt()).resolves.toMatchObject({
      state: "processing",
      attempt: { recordingStem: stem, taskId: expect.any(String) },
      task: { recordingStem: stem, state: "queued" },
    });
    expect(enqueueCompletion).toHaveBeenCalledWith({
      audioPath: join(moviesDir, `${stem}.wav`),
      title: "Core Activation",
      sendToNotion: false,
    });
  });

  it("turns a pre-correlation stop failure into a named durable audio blocker", async () => {
    const { caller, ctx } = setup();
    runRecordAudioMock.mockResolvedValue({ ok: true, stdout: "recording started\n", stderr: "" });
    const started = await caller.startAttempt();
    stopRecordingAndEnqueueMock.mockRejectedValue(new Error("audio daemon stop timed out"));

    await expect(caller.stopAttempt()).rejects.toThrow("audio daemon stop timed out");
    expect(host!.getActivationAttempt()).toMatchObject({
      id: started.attempt.id,
      recordingStem: null,
      taskId: null,
      handoffError: "audio daemon stop timed out",
    });

    host!.close();
    host = new HostStore(join(root, "host.sqlite"));
    const restartedCaller = createCaller(activationRouter, { ...ctx, host } as unknown as AppContext);
    await expect(restartedCaller.status()).resolves.toMatchObject({
      state: "processing",
      blocker: {
        capability: "audio",
        retry: "same_audio",
        remediation: { href: "/settings/general" },
      },
    });
  });

  it("names durable transcription and summary blockers with exact recovery actions", async () => {
    const { caller, moviesDir, artifacts, configValue, retryTask } = setup();
    const stem = "Guided_20260825_141500";
    const audioPath = join(moviesDir, `${stem}.wav`);
    writeFileSync(audioPath, wavWithAudio());
    const attempt = host!.beginActivationAttempt().attempt;
    const task = host!.enqueueRecording({
      idempotencyKey: "recording:guided-blocker",
      recordingStem: stem,
      title: "Core Activation",
      audioPath,
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryConnectionId: "codex",
      summaryModel: "runtime-managed",
    }).task;
    host!.correlateActivationAttempt(attempt.id, task.id);
    let claimed = host!.claim(task.id)!;
    host!.fail(task.id, claimed.leaseToken, "selected audio engine failed");

    await expect(caller.status()).resolves.toMatchObject({
      state: "processing",
      blocker: {
        capability: "transcription",
        retry: "same_task",
        remediation: { href: "/settings/transcription" },
      },
    });

    host!.retry(task.id);
    claimed = host!.claim(task.id)!;
    const transcript = artifacts.commitTranscript(claimed, "preserved transcript", {
      transcriptionProvider: "local",
      committedBy: "yulu-host",
    });
    host!.recordTranscript(task.id, claimed.leaseToken!, transcript);
    host!.fail(task.id, claimed.leaseToken, "summary output was empty");

    await expect(caller.status()).resolves.toMatchObject({
      state: "processing",
      blocker: {
        capability: "summary",
        retry: "same_task",
        remediation: { href: "/settings/llm?connection=codex&capability=summary" },
      },
      summaryRecovery: { canReplace: false },
    });

    configValue.intelligence.summary = { provider: "xai", model: "changed-default" };
    await expect(caller.retryAttempt()).resolves.toMatchObject({
      state: "processing",
      task: {
        id: task.id,
        state: "transcript_committed",
        summaryProvider: "codex",
        summaryModel: "runtime-managed",
      },
    });
    expect(retryTask).toHaveBeenCalledWith(task.id, { allowCancelled: true });
  });

  it("surfaces an unknown Summary outcome without offering an ordinary retry", async () => {
    const { caller, moviesDir, artifacts } = setup();
    const stem = "Guided_20260825_141501";
    const audioPath = join(moviesDir, `${stem}.wav`);
    writeFileSync(audioPath, wavWithAudio());
    const attempt = host!.beginActivationAttempt().attempt;
    const task = host!.enqueueRecording({
      idempotencyKey: "recording:guided-unknown-summary",
      recordingStem: stem,
      title: "Core Activation",
      audioPath,
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "claude-code",
      summaryProvider: "claude-code",
      summaryConnectionId: "claude-code",
      summaryModel: "claude-sonnet-5",
      summaryCredentialClass: "runtime-oauth",
      summaryDisclosureVersion: "claude-code-summary-v1",
    }).task;
    host!.correlateActivationAttempt(attempt.id, task.id);
    const claimed = host!.claim(task.id)!;
    const transcript = artifacts.commitTranscript(claimed, "preserved transcript", {
      transcriptionProvider: "local",
      committedBy: "yulu-host",
    });
    host!.recordTranscript(task.id, claimed.leaseToken!, transcript);
    host!.recordSummaryInputSnapshot(task.id, claimed.leaseToken!, transcript);
    host!.beginSummaryExecution(task.id, claimed.leaseToken!);
    host!.markSummaryUnknownOutcome(task.id, claimed.leaseToken!);

    await expect(caller.status()).resolves.toMatchObject({
      state: "processing",
      task: {
        id: task.id,
        state: "execution_unverified",
        summaryProvider: "claude-code",
        summaryModel: "claude-sonnet-5",
      },
      blocker: {
        capability: "summary",
        retry: "new_summary_attempt",
        remediation: { href: "/settings/llm?connection=claude-code&capability=summary" },
      },
    });
    expect(() => host!.retry(task.id)).toThrow("cannot retry from execution_unverified");
  });

  it("names credential, model, and provider failures without changing the pinned task", async () => {
    const { caller, moviesDir } = setup();
    const stem = "Guided_20260825_141502";
    const audioPath = join(moviesDir, `${stem}.wav`);
    writeFileSync(audioPath, wavWithAudio());
    const attempt = host!.beginActivationAttempt().attempt;
    const task = host!.enqueueRecording({
      idempotencyKey: "recording:guided-named-blockers",
      recordingStem: stem,
      title: "Core Activation",
      audioPath,
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "runtime-managed",
    }).task;
    host!.correlateActivationAttempt(attempt.id, task.id);

    for (const [detail, capability] of [
      ["HTTP 401 credential rejected", "credential"],
      ["selected model is unavailable", "model"],
      ["Agent provider unavailable", "provider"],
    ] as const) {
      const claimed = host!.claim(task.id)!;
      host!.fail(task.id, claimed.leaseToken, detail);
      await expect(caller.status()).resolves.toMatchObject({
        blocker: {
          capability,
          detail,
          retry: "same_task",
          remediation: { href: "/settings/transcription" },
        },
        task: {
          id: task.id,
          agentProvider: "codex",
          summaryProvider: "codex",
          summaryModel: "runtime-managed",
        },
      });
      host!.retry(task.id);
    }
  });

  it("uses an explicitly changed ready Summary Provider in a new correlated attempt", async () => {
    const {
      caller,
      moviesDir,
      artifacts,
      configValue,
      ctx,
      replaceSummaryProvider,
      setSummaryActivation,
    } = setup();
    const stem = "Guided_20260825_141501";
    const audioPath = join(moviesDir, `${stem}.wav`);
    writeFileSync(audioPath, wavWithAudio());
    const attempt = host!.beginActivationAttempt().attempt;
    const original = host!.enqueueRecording({
      idempotencyKey: "recording:guided-provider-change",
      recordingStem: stem,
      title: "Core Activation",
      audioPath,
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "runtime-managed",
    }).task;
    host!.correlateActivationAttempt(attempt.id, original.id);
    const claimed = host!.claim(original.id)!;
    const transcript = artifacts.commitTranscript(claimed, "preserved transcript", {
      transcriptionProvider: "local",
      committedBy: "yulu-host",
    });
    host!.recordTranscript(original.id, claimed.leaseToken!, transcript);
    host!.releaseToAwaitingProvider(original.id, claimed.leaseToken!, "Codex unavailable");

    configValue.intelligence.summary = { provider: "xai", model: "grok-new-explicit" };
    ctx.xaiReadiness!.set("summary", {
      capability: "summary",
      status: "ready",
      model: "grok-new-explicit",
      testedAt: "2026-08-25T04:00:00.000Z",
      detail: "ready",
      credentialSource: "oauth",
    });
    host!.recordSummaryDataPathDisclosure("xai", XAI_SUMMARY_DISCLOSURE_VERSION);
    setSummaryActivation(summaryContract({
      connectionId: "direct-xai",
      provider: "xai",
      label: "xAI",
      model: "grok-new-explicit",
      credentialSource: "oauth",
    }));

    await expect(caller.status()).resolves.toMatchObject({
      blocker: { capability: "provider", retry: "same_task" },
      summaryRecovery: {
        selected: { provider: "xai", model: "grok-new-explicit" },
        state: "ready",
        canReplace: true,
      },
    });
    const replaced = await caller.replaceSummaryProvider();

    expect(replaceSummaryProvider).toHaveBeenCalledWith(original.id);
    expect(replaced).toMatchObject({
      state: "processing",
      task: {
        id: expect.not.stringMatching(original.id),
        state: "transcript_committed",
        summaryProvider: "xai",
        summaryModel: "grok-new-explicit",
      },
    });
    expect(host!.getTask(original.id)?.state).toBe("cancelled");
    expect(host!.getActivationAttempt()?.taskId).toBe(replaced.task!.id);
  });

  it("creates a new xAI attempt when only the ready credential source changes", async () => {
    const {
      caller,
      moviesDir,
      artifacts,
      configValue,
      ctx,
      xaiConnection,
      setSummaryActivation,
    } = setup();
    const stem = "Guided_credential_change_20260825_141501";
    const audioPath = join(moviesDir, `${stem}.wav`);
    writeFileSync(audioPath, wavWithAudio());
    const attempt = host!.beginActivationAttempt().attempt;
    const original = host!.enqueueRecording({
      idempotencyKey: "recording:guided-credential-change",
      recordingStem: stem,
      title: "Core Activation",
      audioPath,
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "xai",
      summaryProvider: "xai",
      summaryModel: "grok-pinned",
      summaryCredentialSource: "oauth",
    }).task;
    host!.correlateActivationAttempt(attempt.id, original.id);
    const claimed = host!.claim(original.id)!;
    const transcript = artifacts.commitTranscript(claimed, "preserved transcript", {
      transcriptionProvider: "local",
      committedBy: "yulu-host",
    });
    host!.recordTranscript(original.id, claimed.leaseToken!, transcript);
    host!.releaseToAwaitingProvider(original.id, claimed.leaseToken!, "OAuth credential unavailable");

    configValue.intelligence.summary = { provider: "xai", model: "grok-pinned" };
    xaiConnection.source = "api-key";
    ctx.xaiReadiness!.set("summary", {
      capability: "summary",
      status: "ready",
      model: "grok-pinned",
      testedAt: "2026-08-25T04:00:00.000Z",
      detail: "ready",
      credentialSource: "api-key",
    });
    host!.recordSummaryDataPathDisclosure("xai", XAI_SUMMARY_DISCLOSURE_VERSION);
    setSummaryActivation(summaryContract({
      connectionId: "direct-xai",
      provider: "xai",
      label: "xAI",
      model: "grok-pinned",
      credentialSource: "api-key",
    }));

    await expect(caller.status()).resolves.toMatchObject({
      summaryRecovery: { canReplace: true },
    });
    await expect(caller.replaceSummaryProvider()).resolves.toMatchObject({
      task: {
        id: expect.not.stringMatching(original.id),
        summaryProvider: "xai",
        summaryModel: "grok-pinned",
        summaryCredentialSource: "api-key",
      },
    });
  });

  it("requires re-recording only when the preserved activation audio is invalid", async () => {
    const { caller, moviesDir } = setup();
    const stem = "Broken_20260825_141500";
    const audioPath = join(moviesDir, `${stem}.wav`);
    writeFileSync(audioPath, Buffer.alloc(44));
    const attempt = host!.beginActivationAttempt().attempt;
    const task = host!.enqueueRecording({
      idempotencyKey: "recording:guided-invalid-audio",
      recordingStem: stem,
      title: "Core Activation",
      audioPath,
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "runtime-managed",
    }).task;
    host!.correlateActivationAttempt(attempt.id, task.id);
    const claimed = host!.claim(task.id)!;
    host!.fail(task.id, claimed.leaseToken, "transcription failed");

    await expect(caller.status()).resolves.toMatchObject({
      state: "processing",
      blocker: {
        capability: "audio",
        retry: "rerecord",
        remediation: { href: "/settings/general" },
      },
    });
  });

  it("turns a completed guided task with invalid artifacts into an actionable named blocker", async () => {
    const { caller, moviesDir, artifacts, retryTask } = setup();
    const attempt = host!.beginActivationAttempt().attempt;
    const task = completeRecording(
      moviesDir,
      artifacts,
      "Guided_invalid_summary_20260825_141500",
      "2026-08-25T06:15:00.000Z",
    );
    host!.correlateActivationAttempt(attempt.id, task.id);
    writeFileSync(join(moviesDir, `${task.recordingStem}.summary.md`), "tampered\n");

    await expect(caller.status()).resolves.toMatchObject({
      state: "processing",
      task: { id: task.id, state: "completed" },
      blocker: {
        capability: "summary",
        retry: "same_task",
        remediation: { href: "/settings/llm?capability=summary" },
      },
      summaryRecovery: { canReplace: false },
    });
    await expect(caller.retryAttempt()).resolves.toMatchObject({
      task: {
        id: task.id,
        state: "transcript_committed",
        summaryProvider: task.summaryProvider,
        summaryModel: task.summaryModel,
      },
    });
    expect(retryTask).toHaveBeenCalledWith(task.id, {
      allowCancelled: true,
      allowCompleted: true,
    });
  });

  it("re-transcribes valid audio when a completed transcript can no longer be verified", async () => {
    const { caller, moviesDir, artifacts, retryTask } = setup();
    const attempt = host!.beginActivationAttempt().attempt;
    const task = completeRecording(
      moviesDir,
      artifacts,
      "Guided_invalid_transcript_20260825_141500",
      "2026-08-25T06:15:00.000Z",
    );
    host!.correlateActivationAttempt(attempt.id, task.id);
    writeFileSync(join(moviesDir, `${task.recordingStem}.transcript.txt`), "tampered\n");

    await expect(caller.status()).resolves.toMatchObject({
      state: "processing",
      task: { id: task.id, state: "completed" },
      blocker: {
        capability: "transcription",
        retry: "same_task",
        remediation: { href: "/settings/transcription" },
      },
    });
    await caller.retryAttempt();
    expect(host!.listArtifacts(task.id)).toEqual([]);
    expect(retryTask).toHaveBeenCalledWith(task.id, {
      allowCancelled: true,
      allowCompleted: true,
      discardArtifacts: true,
    });
  });

  it("starts a new recording when a completed guided task no longer has valid audio", async () => {
    const { caller, moviesDir, artifacts, ctx } = setup();
    const attempt = host!.beginActivationAttempt().attempt;
    const task = completeRecording(
      moviesDir,
      artifacts,
      "Guided_invalid_audio_20260825_141500",
      "2026-08-25T06:15:00.000Z",
    );
    host!.correlateActivationAttempt(attempt.id, task.id);
    writeFileSync(task.audioPath, Buffer.alloc(44));
    runRecordAudioMock.mockResolvedValue({ ok: true, stdout: "recording started\n", stderr: "" });

    await expect(caller.status()).resolves.toMatchObject({
      state: "processing",
      blocker: { capability: "audio", retry: "rerecord" },
    });
    await expect(caller.rerecordAttempt()).resolves.toMatchObject({
      state: "recording",
      attempt: { id: expect.not.stringMatching(attempt.id), taskId: null },
    });
    expect(runRecordAudioMock).toHaveBeenCalledWith(ctx, ["start", "Core Activation"], { timeoutMs: 30_000 });
  });

  it("keeps a named audio blocker when starting the replacement recording fails", async () => {
    const { caller, moviesDir } = setup();
    const stem = "Broken_rerecord_20260825_141500";
    const audioPath = join(moviesDir, `${stem}.wav`);
    writeFileSync(audioPath, Buffer.alloc(44));
    const attempt = host!.beginActivationAttempt().attempt;
    const task = host!.enqueueRecording({
      idempotencyKey: "recording:guided-rerecord-start-failure",
      recordingStem: stem,
      title: "Core Activation",
      audioPath,
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "runtime-managed",
    }).task;
    host!.correlateActivationAttempt(attempt.id, task.id);
    const claimed = host!.claim(task.id)!;
    host!.fail(task.id, claimed.leaseToken, "no audio frames");
    runRecordAudioMock.mockRejectedValue(new Error("microphone disconnected"));

    await expect(caller.rerecordAttempt()).rejects.toThrow("microphone disconnected");
    await expect(caller.status()).resolves.toMatchObject({
      state: "processing",
      blocker: {
        capability: "audio",
        detail: "microphone disconnected",
        retry: "start_recording",
        remediation: { href: "/settings/general" },
      },
    });
  });

  it("inspects large saved WAVs without reading the whole recording into Host memory", async () => {
    const { caller, moviesDir, artifacts } = setup();
    const stem = "Guided_large_audio_20260825_141500";
    const audioPath = join(moviesDir, `${stem}.wav`);
    writeFileSync(audioPath, wavWithAudio());
    truncateSync(audioPath, 3 * 1024 ** 3);
    const attempt = host!.beginActivationAttempt().attempt;
    const task = host!.enqueueRecording({
      idempotencyKey: "recording:guided-large-audio",
      recordingStem: stem,
      title: "Core Activation",
      audioPath,
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "runtime-managed",
    }).task;
    host!.correlateActivationAttempt(attempt.id, task.id);
    const claimed = host!.claim(task.id)!;
    const transcript = artifacts.commitTranscript(claimed, "preserved transcript", {
      transcriptionProvider: "local",
      committedBy: "yulu-host",
    });
    host!.recordTranscript(task.id, claimed.leaseToken!, transcript);
    host!.fail(task.id, claimed.leaseToken, "summary failed");

    await expect(caller.status()).resolves.toMatchObject({
      state: "processing",
      blocker: { capability: "summary", retry: "same_task" },
    });
  });

  it("can resume a cancelled activation task while leaving generic cancellation terminal", async () => {
    const { caller, moviesDir, retryTask } = setup();
    const stem = "Cancelled_20260825_141500";
    const audioPath = join(moviesDir, `${stem}.wav`);
    writeFileSync(audioPath, wavWithAudio());
    const attempt = host!.beginActivationAttempt().attempt;
    const task = host!.enqueueRecording({
      idempotencyKey: "recording:guided-cancelled",
      recordingStem: stem,
      title: "Core Activation",
      audioPath,
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "runtime-managed",
    }).task;
    host!.correlateActivationAttempt(attempt.id, task.id);
    host!.prepareRecordingDeletion(stem);

    expect(() => host!.retry(task.id)).toThrow(/cannot retry from cancelled/);
    await expect(caller.status()).resolves.toMatchObject({
      state: "processing",
      blocker: { capability: "transcription", retry: "same_task" },
    });
    await expect(caller.retryAttempt()).resolves.toMatchObject({
      task: { id: task.id, state: "queued" },
    });
    expect(retryTask).toHaveBeenCalledWith(task.id, { allowCancelled: true });
  });

  it("recovers when recording deletion purges the correlated activation task", async () => {
    const { caller, moviesDir } = setup();
    const stem = "Deleted_activation_20260825_141500";
    const audioPath = join(moviesDir, `${stem}.wav`);
    writeFileSync(audioPath, wavWithAudio());
    const attempt = host!.beginActivationAttempt().attempt;
    const task = host!.enqueueRecording({
      idempotencyKey: "recording:guided-deleted",
      recordingStem: stem,
      title: "Core Activation",
      audioPath,
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "runtime-managed",
    }).task;
    host!.correlateActivationAttempt(attempt.id, task.id);
    host!.prepareRecordingDeletion(stem);
    expect(host!.purgeRecordingTasks(stem)).toEqual([task.id]);
    rmSync(audioPath);

    await expect(caller.status()).resolves.toMatchObject({
      state: "processing",
      task: null,
      blocker: {
        capability: "audio",
        retry: "rerecord",
        remediation: { href: "/settings/general" },
      },
    });
    runRecordAudioMock.mockResolvedValue({ ok: true, stdout: "recording started\n", stderr: "" });
    await expect(caller.rerecordAttempt()).resolves.toMatchObject({
      state: "recording",
      attempt: { id: expect.not.stringMatching(attempt.id), taskId: null },
    });
  });

  it("does not correlate unrelated work while the guided recorder is still active", async () => {
    const { caller } = setup();
    runRecordAudioMock.mockResolvedValue({ ok: true, stdout: "recording started\n", stderr: "" });
    await caller.startAttempt();
    host!.enqueueRecording({
      idempotencyKey: "recording:scheduled-after-activation-start",
      recordingStem: "Scheduled_20260825_141500",
      title: "Scheduled",
      audioPath: join(root, "movies", "Scheduled_20260825_141500.wav"),
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "codex",
      summaryProvider: "codex",
      summaryModel: "runtime-managed",
    });

    await expect(caller.status()).resolves.toMatchObject({
      state: "recording",
      attempt: { taskId: null, recordingStem: null },
      task: null,
    });
  });

  it("treats the legacy CoreAudio index as the current default input", async () => {
    const { caller, configValue } = setup();
    configValue.audio.mic_device = ":0";

    await expect(caller.status()).resolves.toMatchObject({
      nextStep: null,
      readiness: {
        audioInput: { state: "ready", selectedDeviceUid: null },
      },
    });
  });

  it("requires the current xAI audio disclosure independently of authorization", async () => {
    const { caller, configValue, ctx } = setup();
    configValue.transcription.engine = "xai";
    ctx.xaiReadiness!.set("transcription", {
      capability: "transcription",
      status: "ready",
      model: "speech-to-text",
      testedAt: "2026-08-25T04:00:00.000Z",
      detail: "ready",
      credentialSource: "oauth",
    });
    host!.recordCloudTranscriptionConsent("xai-audio-v0");

    await expect(caller.status()).resolves.toMatchObject({
      nextStep: "transcription",
      readiness: {
        transcription: {
          selected: "xai",
          state: "disclosure_required",
          xai: {
            ready: true,
            disclosureVersion: XAI_TRANSCRIPTION_DISCLOSURE_VERSION,
            acceptedDisclosureVersion: "xai-audio-v0",
            disclosureRequired: true,
          },
        },
      },
    });

    await expect(caller.acceptXaiTranscriptionDisclosure()).resolves.toMatchObject({
      disclosureVersion: XAI_TRANSCRIPTION_DISCLOSURE_VERSION,
      acceptedAt: expect.any(String),
    });
    await expect(caller.status()).resolves.toMatchObject({
      nextStep: null,
      readiness: {
        transcription: {
          selected: "xai",
          state: "ready",
          xai: { disclosureRequired: false },
        },
      },
    });
  });

  it("requires xAI summary readiness and a separate transcript Data Path Disclosure", async () => {
    const { caller, configValue, ctx, setSummaryActivation } = setup();
    configValue.intelligence.summary = { provider: "xai", model: "grok-summary-exact" };
    ctx.xaiReadiness!.set("summary", {
      capability: "summary",
      status: "ready",
      model: "grok-summary-exact",
      testedAt: "2026-08-25T04:00:00.000Z",
      detail: "ready",
      credentialSource: "oauth",
    });
    const remediation = { href: "/settings/llm?connection=direct-xai&capability=summary" };
    setSummaryActivation(summaryContract({
      connectionId: "direct-xai",
      provider: "xai",
      label: "xAI",
      model: "grok-summary-exact",
      state: "disclosure_required",
      credentialSource: "oauth",
      disclosure: {
        provider: "xai",
        connectionId: "direct-xai",
        disclosureVersion: XAI_SUMMARY_DISCLOSURE_VERSION,
        acceptedDisclosureVersion: null,
        declined: false,
        required: true,
        data: "transcript_text",
        destination: "xAI",
      },
      blocker: {
        capability: "summary_disclosure",
        reason: "disclosure_required",
        detail: "Review the xAI Summary data path before recording",
        remediation,
      },
    }));

    await expect(caller.status()).resolves.toMatchObject({
      nextStep: "summary_provider",
      blocker: {
        capability: "summary_disclosure",
        reason: "disclosure_required",
        remediation: { href: "/settings/llm?connection=direct-xai&capability=summary" },
      },
      readiness: {
        summary: {
          selected: { provider: "xai", model: "grok-summary-exact" },
          state: "disclosure_required",
          disclosure: {
            provider: "xai",
            disclosureVersion: XAI_SUMMARY_DISCLOSURE_VERSION,
            acceptedDisclosureVersion: null,
            data: "transcript_text",
            destination: "xAI",
          },
        },
      },
    });

    await expect(caller.acceptSummaryDataPathDisclosure({
      provider: "xai",
      disclosureVersion: XAI_SUMMARY_DISCLOSURE_VERSION,
      data: "transcript_text",
      destination: "xAI",
    })).resolves.toMatchObject({
      provider: "xai",
      disclosureVersion: XAI_SUMMARY_DISCLOSURE_VERSION,
    });
    await expect(caller.status()).resolves.toMatchObject({
      nextStep: null,
      blocker: null,
      readiness: { summary: { state: "ready" } },
    });

    await expect(caller.declineSummaryDataPathDisclosure({
      provider: "xai",
      disclosureVersion: XAI_SUMMARY_DISCLOSURE_VERSION,
      data: "transcript_text",
      destination: "xAI",
    })).resolves.toMatchObject({
      provider: "xai",
      disclosureVersion: XAI_SUMMARY_DISCLOSURE_VERSION,
      decision: "declined",
    });
    await expect(caller.status()).resolves.toMatchObject({
      nextStep: "summary_provider",
      blocker: { capability: "summary_disclosure", reason: "disclosure_declined" },
      readiness: { summary: { state: "disclosure_required", disclosure: { declined: true } } },
    });

    host!.close();
    host = new HostStore(join(root, "host.sqlite"));
    const restartedCaller = createCaller(activationRouter, {
      ...ctx,
      host,
    } as unknown as AppContext);
    await expect(restartedCaller.status()).resolves.toMatchObject({
      blocker: { capability: "summary_disclosure", reason: "disclosure_declined" },
      readiness: { summary: { disclosure: { declined: true } } },
    });
  });

  it("consumes provider-neutral Supported Agent readiness without a Hermes prerequisite", async () => {
    const { caller, ctx, setSummaryActivation } = setup();
    ctx.supportedAgentSummaryAdapter = undefined;
    const unavailableRemediation = { href: "/settings/llm?connection=codex&capability=summary" };
    setSummaryActivation(summaryContract({
      connectionId: "codex",
      provider: "agent",
      label: "Summary Provider",
      state: "blocked",
      publicOnboardingSupported: false,
      blocker: {
        capability: "summary_provider",
        reason: "provider_unavailable",
        detail: "A Supported Agent summary adapter is not available in this release",
        remediation: unavailableRemediation,
      },
    }));

    await expect(caller.status()).resolves.toMatchObject({
      nextStep: "summary_provider",
      blocker: {
        capability: "summary_provider",
        reason: "provider_unavailable",
        detail: expect.not.stringMatching(/Hermes/i),
        remediation: { href: "/settings/llm?connection=codex&capability=summary" },
      },
      readiness: {
        summary: {
          selected: { provider: "agent", model: "runtime-managed" },
          state: "blocked",
          publicOnboardingSupported: false,
        },
      },
    });

    let externalReadiness: SupportedAgentSummaryReadiness = {
        capability: "summary",
        provider: "codex",
        model: "runtime-managed",
        status: "ready",
        testedAt: "2026-08-25T04:00:00.000Z",
        detail: "ready",
        credentialSource: "oauth",
        disclosure: {
          kind: "external",
          disclosureVersion: "codex-summary-v1",
          data: "transcript_text",
          destination: "Codex service",
        },
      };
    ctx.supportedAgentSummaryAdapter = {
      current: () => externalReadiness,
      probe: async () => { throw new Error("not used"); },
      gateway: () => ({} as never),
    };
    const disclosureRemediation = { href: "/settings/llm?connection=codex&capability=summary" };
    const codexDisclosure = (disclosureVersion: string, destination: string) => summaryContract({
      connectionId: "codex",
      provider: "codex",
      label: "Codex",
      state: "disclosure_required",
      credentialSource: "oauth",
      disclosure: {
        provider: "codex",
        connectionId: "codex",
        disclosureVersion,
        acceptedDisclosureVersion: null,
        declined: false,
        required: true,
        data: "transcript_text",
        destination,
      },
      blocker: {
        capability: "summary_disclosure",
        reason: "disclosure_required",
        detail: "Review the Codex Summary data path before recording",
        remediation: disclosureRemediation,
      },
    });
    setSummaryActivation(codexDisclosure("codex-summary-v1", "Codex service"));
    await expect(caller.status()).resolves.toMatchObject({
      blocker: { capability: "summary_disclosure", reason: "disclosure_required" },
      readiness: {
        summary: {
          selected: { provider: "codex", model: "runtime-managed" },
          state: "disclosure_required",
          publicOnboardingSupported: true,
          disclosure: { destination: "Codex service" },
        },
      },
    });
    const displayedDisclosure = {
      provider: "codex",
      disclosureVersion: "codex-summary-v1",
      data: "transcript_text" as const,
      destination: "Codex service",
    };
    externalReadiness = {
      ...externalReadiness,
      disclosure: {
        kind: "external",
        disclosureVersion: "codex-summary-v2",
        data: "transcript_text",
        destination: "Changed service",
      },
    };
    setSummaryActivation(codexDisclosure("codex-summary-v2", "Changed service"));
    await expect(caller.acceptSummaryDataPathDisclosure(displayedDisclosure)).rejects.toThrow(
      "Data Path Disclosure changed",
    );
    externalReadiness = {
      ...externalReadiness,
      disclosure: {
        kind: "external",
        disclosureVersion: "codex-summary-v1",
        data: "transcript_text",
        destination: "Codex service",
      },
    };
    setSummaryActivation(codexDisclosure("codex-summary-v1", "Codex service"));
    await caller.acceptSummaryDataPathDisclosure(displayedDisclosure);
    await expect(caller.status()).resolves.toMatchObject({
      nextStep: null,
      readiness: { summary: { state: "ready", selected: { provider: "codex" } } },
    });
  });

  it("names xAI credential, model, provider, and readiness blockers from the shared contract", async () => {
    const { caller, setSummaryActivation } = setup();
    const remediation = { href: "/settings/llm?connection=direct-xai&capability=summary" };
    const blockedXai = (
      capability: NonNullable<SummaryActivationState["blocker"]>["capability"],
      reason: NonNullable<SummaryActivationState["blocker"]>["reason"],
      detail: string,
    ) => summaryContract({
      connectionId: "direct-xai",
      provider: "xai",
      label: "xAI",
      model: "grok-summary-exact",
      state: "blocked",
      credentialSource: "oauth",
      blocker: { capability, reason, detail, remediation },
    });

    setSummaryActivation(blockedXai("summary_credentials", "missing_credentials", "xAI is not authorized"));
    await expect(caller.status()).resolves.toMatchObject({
      blocker: { capability: "summary_credentials", reason: "missing_credentials" },
    });

    setSummaryActivation(blockedXai("summary_model", "invalid_model", "xAI Summary model is invalid"));
    await expect(caller.status()).resolves.toMatchObject({
      blocker: { capability: "summary_model", reason: "invalid_model" },
    });

    setSummaryActivation(blockedXai("summary_provider", "provider_unavailable", "xAI is unavailable"));
    await expect(caller.status()).resolves.toMatchObject({
      blocker: { capability: "summary_provider", reason: "provider_unavailable" },
    });

    setSummaryActivation(blockedXai("summary_readiness", "readiness_failed", "probe failed"));
    await expect(caller.status()).resolves.toMatchObject({
      blocker: { capability: "summary_readiness", reason: "readiness_failed" },
    });

    setSummaryActivation(blockedXai("summary_model", "invalid_model", "HTTP 404: model not found"));
    await expect(caller.status()).resolves.toMatchObject({
      blocker: { capability: "summary_model", reason: "invalid_model" },
    });
  });

  it("consumes a failed shared readiness contract and exposes the selected connection probe", async () => {
    const { caller, setAgentReadiness, setSummaryActivation, agentProbe } = setup();
    setAgentReadiness({
      capability: "summary",
      provider: "codex",
      model: "runtime-managed",
      status: "ready",
      testedAt: null,
      detail: "claimed ready without proof",
      credentialSource: null,
      disclosure: { kind: "local" },
    });
    setSummaryActivation(summaryContract({
      state: "blocked",
      blocker: {
        capability: "summary_readiness",
        reason: "readiness_failed",
        detail: "The Supported Agent did not return current readiness proof",
        remediation: { href: "/settings/llm?connection=codex&capability=summary" },
      },
    }));
    await expect(caller.status()).resolves.toMatchObject({
      blocker: { capability: "summary_readiness", reason: "readiness_failed" },
      readiness: { summary: { state: "blocked" } },
    });

    setAgentReadiness({
      capability: "summary",
      provider: "codex",
      model: "runtime-managed",
      status: "failed",
      testedAt: "2026-08-25T04:00:00.000Z",
      detail: "failed",
      credentialSource: "oauth",
      disclosure: { kind: "local" },
    });
    await caller.probeSummaryProvider();
    expect(agentProbe).toHaveBeenCalledOnce();
  });

  it("names microphone and missing selected-input blockers with exact remediation", async () => {
    const { caller } = setup();
    ipcSendMock.mockImplementation(async (_path: string, payload: { action: string }) => {
      if (payload.action === "status") return { micReady: false, micError: "TCC denied" };
      return { input: [{ uid: "OtherMic", name: "Other microphone" }], output: [] };
    });

    await expect(caller.status()).resolves.toMatchObject({
      nextStep: "microphone_permission",
      blocker: {
        capability: "microphone_permission",
        remediation: {
          href: "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
        },
      },
      readiness: {
        microphonePermission: { state: "blocked", detail: "TCC denied" },
        audioInput: {
          state: "blocked",
          selectedDeviceUid: "BuiltInMic",
          remediation: { href: "/settings/general" },
        },
      },
    });
  });

  function completeRecording(
    moviesDir: string,
    artifacts: ArtifactStore,
    stem: string,
    completedAt: string,
  ) {
    const audioPath = join(moviesDir, `${stem}.wav`);
    writeFileSync(audioPath, wavWithAudio());
    const queued = host!.enqueueRecording({
      idempotencyKey: `recording:${stem}`,
      recordingStem: stem,
      title: stem,
      audioPath,
      sendToNotion: false,
      destinationHint: "",
      agentProvider: "hermes",
      summaryProvider: "hermes",
      summaryModel: "runtime-managed",
    }).task;
    const claimed = host!.claim(queued.id)!;
    const transcript = artifacts.commitTranscript(claimed, "verified transcript", {
      transcriptionProvider: "local",
      committedBy: "yulu-host",
    });
    host!.recordTranscript(claimed.id, claimed.leaseToken!, transcript);
    host!.recordProgress(
      claimed.id,
      claimed.leaseToken!,
      "summarizing",
      "Transcription provider: local",
    );
    artifacts.writeStagedSummary(claimed.id, "# Verified summary");
    const artifactTask = host!.getTask(claimed.id)!;
    const records = artifacts.prepareFromWorkspace(artifactTask, {
      agentProvider: "hermes",
      committedBy: "yulu-host",
    });
    host!.recordArtifacts(claimed.id, claimed.leaseToken!, records);
    artifacts.publishPreparedArtifacts(artifactTask, records);
    host!.markArtifactsPublished(claimed.id, claimed.leaseToken!);
    host!.complete(claimed.id, claimed.leaseToken!, { transcriptionProvider: "local" });
    host!.db.prepare("UPDATE agent_tasks SET updated_at = ? WHERE id = ?").run(completedAt, claimed.id);
    return host!.getTask(claimed.id)!;
  }

  it("bootstraps the most recent fully verified historical recording", async () => {
    const { moviesDir, artifacts, caller } = setup();
    completeRecording(moviesDir, artifacts, "Older_20260710_100000", "2026-07-10T10:05:00.000Z");
    const recent = completeRecording(moviesDir, artifacts, "Recent_20260711_120000", "2026-07-11T12:05:00.000Z");

    await expect(caller.status()).resolves.toMatchObject({
      state: "activated",
      evidenceCreated: true,
      evidence: {
        recordingStem: recent.recordingStem,
        taskId: recent.id,
        transcriptionProvider: "local",
        summaryProvider: "hermes",
        summaryModel: "runtime-managed",
      },
      sourceArtifacts: { audio: true, transcript: true, summary: true },
      completedNoteAvailable: true,
    });
    expect(host!.getCoreActivationEvidence()?.taskId).toBe(recent.id);

    rmSync(recent.audioPath);
    await expect(caller.status()).resolves.toMatchObject({
      state: "activated",
      evidenceCreated: false,
      evidence: { taskId: recent.id },
      sourceArtifacts: { audio: false, transcript: true, summary: true },
      completedNoteAvailable: true,
      completedNote: "# Verified summary",
    });

    writeFileSync(recent.audioPath, wavWithAudio());
    rmSync(join(moviesDir, `${recent.recordingStem}.transcript.txt`));
    await expect(caller.status()).resolves.toMatchObject({
      state: "activated",
      evidence: { taskId: recent.id },
      sourceArtifacts: { audio: true, transcript: false, summary: true },
    });

    writeFileSync(join(moviesDir, `${recent.recordingStem}.transcript.txt`), "verified transcript");
    rmSync(join(moviesDir, `${recent.recordingStem}.summary.md`));
    await expect(caller.status()).resolves.toMatchObject({
      state: "activated",
      evidence: { taskId: recent.id },
      sourceArtifacts: { audio: true, transcript: true, summary: false },
      completedNoteAvailable: false,
      completedNote: null,
    });
  });

  it("keeps an active guided recording in place when unrelated work establishes activation", async () => {
    const { moviesDir, artifacts, caller } = setup();
    const attempt = host!.beginActivationAttempt().attempt;
    const unrelated = completeRecording(
      moviesDir,
      artifacts,
      "Scheduled_20260711_120000",
      "2026-07-11T12:05:00.000Z",
    );
    const candidate = host!.getCoreActivationCandidate(unrelated.id);
    const unrelatedEvidence = candidate
      ? await verifiedCoreActivationEvidence(candidate, artifacts, moviesDir)
      : null;
    expect(unrelatedEvidence).not.toBeNull();
    host!.recordCoreActivationEvidence(unrelatedEvidence!);

    await expect(caller.status()).resolves.toMatchObject({
      state: "recording",
      attempt: { id: attempt.id, taskId: null },
      task: null,
      backgroundEvidence: { taskId: unrelated.id, recordingStem: unrelated.recordingStem },
    });
  });

  it("durably opens only the exact guided task once after Host restart", async () => {
    const { moviesDir, artifacts, ctx } = setup();
    const attempt = host!.beginActivationAttempt().attempt;
    const exact = completeRecording(
      moviesDir,
      artifacts,
      "Guided_20260711_120000",
      "2026-07-11T12:05:00.000Z",
    );
    host!.correlateActivationAttempt(attempt.id, exact.id);

    host!.close();
    host = new HostStore(join(root, "host.sqlite"));
    const restartedCaller = createCaller(activationRouter, { ...ctx, host } as unknown as AppContext);
    await expect(restartedCaller.status()).resolves.toMatchObject({
      state: "activated",
      guidedCompletionPending: true,
      evidence: { taskId: exact.id, recordingStem: exact.recordingStem },
    });
    await expect(restartedCaller.acknowledgeGuidedCompletion({ taskId: exact.id })).resolves.toEqual({
      acknowledged: true,
    });
    await expect(restartedCaller.status()).resolves.toMatchObject({
      state: "activated",
      guidedCompletionPending: false,
      evidence: { taskId: exact.id },
    });
    await expect(restartedCaller.acknowledgeGuidedCompletion({ taskId: "unrelated-task" })).resolves.toEqual({
      acknowledged: false,
    });
  });

  it("does not acknowledge a guided task whose activation artifacts no longer verify", async () => {
    const { moviesDir, artifacts, caller } = setup();
    const attempt = host!.beginActivationAttempt().attempt;
    const invalid = completeRecording(
      moviesDir,
      artifacts,
      "Invalid_guided_20260711_120000",
      "2026-07-11T12:05:00.000Z",
    );
    host!.correlateActivationAttempt(attempt.id, invalid.id);
    rmSync(invalid.audioPath);

    await expect(caller.acknowledgeGuidedCompletion({ taskId: invalid.id })).resolves.toEqual({
      acknowledged: false,
    });
    expect(host!.getActivationAttempt()?.completionOpenedAt).toBeNull();
  });

  it("keeps immutable evidence separate from a later guided completion target", async () => {
    const { moviesDir, artifacts, caller } = setup();
    const attempt = host!.beginActivationAttempt().attempt;
    const background = completeRecording(
      moviesDir,
      artifacts,
      "Scheduled_20260711_120000",
      "2026-07-11T12:05:00.000Z",
    );
    const backgroundCandidate = host!.getCoreActivationCandidate(background.id)!;
    const backgroundEvidence = (await verifiedCoreActivationEvidence(backgroundCandidate, artifacts, moviesDir))!;
    host!.recordCoreActivationEvidence(backgroundEvidence);
    const guided = completeRecording(
      moviesDir,
      artifacts,
      "Guided_20260711_120100",
      "2026-07-11T12:06:00.000Z",
    );
    host!.correlateActivationAttempt(attempt.id, guided.id);

    await expect(caller.status()).resolves.toMatchObject({
      state: "activated",
      evidence: { taskId: background.id, recordingStem: background.recordingStem },
      guidedCompletionPending: true,
      guidedCompletion: { taskId: guided.id, recordingStem: guided.recordingStem },
    });
    await caller.acknowledgeGuidedCompletion({ taskId: guided.id });
    await expect(caller.status()).resolves.toMatchObject({
      state: "activated",
      evidence: { taskId: background.id },
      guidedCompletionPending: false,
      guidedCompletion: null,
    });
  });

  it("bootstraps verified artifacts even when optional delivery was unverified", async () => {
    const { moviesDir, artifacts, caller } = setup();
    const task = completeRecording(
      moviesDir,
      artifacts,
      "Delivered_20260711_120000",
      "2026-07-11T12:05:00.000Z",
    );
    host!.db.prepare(`
      UPDATE agent_tasks
      SET state = 'delivery_unverified', audit_json = NULL
      WHERE id = ?
    `).run(task.id);

    await expect(caller.status()).resolves.toMatchObject({
      state: "activated",
      evidence: {
        taskId: task.id,
        transcriptionProvider: "local",
      },
    });
  });

  it("keeps unverifiable historical recordings unresolved", async () => {
    const { moviesDir, artifacts, caller } = setup();
    const task = completeRecording(
      moviesDir,
      artifacts,
      "Stale_20260711_120000",
      "2026-07-11T12:05:00.000Z",
    );
    writeFileSync(join(moviesDir, `${task.recordingStem}.summary.stale`), "stale\n");

    await expect(caller.status()).resolves.toMatchObject({ state: "unresolved", evidence: null });
    expect(host!.getCoreActivationEvidence()).toBeNull();
  });

  it("acknowledges automatic entry once across Host restarts", async () => {
    const { caller, ctx } = setup();

    await expect(caller.status()).resolves.toMatchObject({
      state: "unresolved",
      journey: {
        shouldAutoEnter: true,
        automaticEntryAcknowledgedAt: null,
        deferredAt: null,
      },
    });
    await expect(caller.acknowledgeAutomaticEntry()).resolves.toMatchObject({
      acknowledged: true,
      journey: { shouldAutoEnter: false },
    });
    await expect(caller.acknowledgeAutomaticEntry()).resolves.toMatchObject({
      acknowledged: false,
      journey: { shouldAutoEnter: false },
    });

    host!.close();
    host = new HostStore(join(root, "host.sqlite"));
    const restartedCaller = createCaller(activationRouter, {
      ...ctx,
      host,
    } as unknown as AppContext);
    await expect(restartedCaller.status()).resolves.toMatchObject({
      state: "unresolved",
      journey: {
        shouldAutoEnter: false,
        automaticEntryAcknowledgedAt: expect.any(String),
        deferredAt: null,
      },
    });
  });

  it("does not acknowledge automatic entry after Core Activation is proven", async () => {
    const { moviesDir, artifacts, caller } = setup();
    completeRecording(
      moviesDir,
      artifacts,
      "Activated_20260711_120000",
      "2026-07-11T12:05:00.000Z",
    );
    await expect(caller.status()).resolves.toMatchObject({ state: "activated" });

    await expect(caller.acknowledgeAutomaticEntry()).resolves.toMatchObject({
      acknowledged: false,
      journey: { automaticEntryAcknowledgedAt: null },
    });
  });

  it("persists Activation Deferral without claiming Core Activation", async () => {
    const { caller, ctx } = setup();

    const firstDeferral = await caller.defer();
    expect(firstDeferral).toMatchObject({
      journey: {
        shouldAutoEnter: false,
        automaticEntryAcknowledgedAt: null,
        deferredAt: expect.any(String),
      },
    });
    await expect(caller.defer()).resolves.toMatchObject({
      journey: { deferredAt: firstDeferral.journey.deferredAt },
    });
    await expect(caller.status()).resolves.toMatchObject({ state: "unresolved", evidence: null });

    host!.close();
    host = new HostStore(join(root, "host.sqlite"));
    const restartedCaller = createCaller(activationRouter, {
      ...ctx,
      host,
    } as unknown as AppContext);
    await expect(restartedCaller.status()).resolves.toMatchObject({
      state: "unresolved",
      evidence: null,
      journey: {
        shouldAutoEnter: false,
        automaticEntryAcknowledgedAt: null,
        deferredAt: expect.any(String),
      },
    });
  });

  it("reports durable entry and deferral write failures without changing the decision", async () => {
    const { caller, ctx } = setup();
    host!.close();
    host = undefined;

    await expect(caller.acknowledgeAutomaticEntry()).rejects.toThrow();
    await expect(caller.defer()).rejects.toThrow();

    host = new HostStore(join(root, "host.sqlite"));
    const restartedCaller = createCaller(activationRouter, {
      ...ctx,
      host,
    } as unknown as AppContext);
    await expect(restartedCaller.status()).resolves.toMatchObject({
      state: "unresolved",
      journey: {
        shouldAutoEnter: true,
        automaticEntryAcknowledgedAt: null,
        deferredAt: null,
      },
    });
  });
});
