import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { z } from "zod";
import { hasAudioFramesAtPath, verifiedCoreActivationEvidence } from "../coreActivation.js";
import { ipcSend } from "../ipc.js";
import {
  hasCurrentXaiTranscriptionConsent,
  XAI_TRANSCRIPTION_DISCLOSURE_VERSION,
} from "../transcriptionConsent.js";
import type { AppContext } from "../trpc.js";
import { publicProcedure, router, uiMutationProcedure } from "../trpc.js";
import {
  publicAgentTask,
  type ActivationAttempt,
  type AgentTask,
  type CoreActivationEvidence,
} from "../hostStore.js";
import { runRecordAudio, stopRecordingAndEnqueue } from "../recordingCommand.js";

const MICROPHONE_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";
const ACTIVATION_RECORDING_COMMAND_TIMEOUT_MS = 30_000;

const captureStatusSchema = z.object({
  micReady: z.boolean(),
  micError: z.string().optional(),
});

const audioDevicesSchema = z.object({
  input: z.array(z.object({ uid: z.string(), name: z.string() })),
  error: z.string().optional(),
});

const summaryDisclosureInput = z.object({
  provider: z.string().min(1).max(100),
  disclosureVersion: z.string().min(1).max(100),
  data: z.literal("transcript_text"),
  destination: z.string().min(1).max(200),
}).strict();

const SUMMARY_SETTINGS = { href: "/settings/llm?capability=summary" } as const;
const XAI_TRANSCRIPTION_SETTINGS = "/settings/llm?connection=direct-xai&capability=transcription";

async function currentSummaryDisclosure(
  ctx: AppContext,
  input: z.infer<typeof summaryDisclosureInput>,
) {
  const summary = await activationSummaryReadiness(ctx);
  const disclosure = summary.disclosure;
  if (
    !disclosure ||
    disclosure.provider !== input.provider ||
    disclosure.disclosureVersion !== input.disclosureVersion ||
    disclosure.data !== input.data ||
    disclosure.destination !== input.destination
  ) {
    throw new Error("The selected Summary Provider Data Path Disclosure changed; review it again");
  }
  return disclosure;
}

async function activationSummaryReadiness(ctx: AppContext) {
  if (!ctx.agentConnections) throw new Error("Agent Connection Center is unavailable");
  return await ctx.agentConnections.summaryActivation();
}

async function activationReadiness(ctx: AppContext) {
  const [captureResult, devicesResult] = await Promise.allSettled([
    ipcSend(ctx.paths.audioDaemonSock, { action: "status" }),
    ipcSend(ctx.paths.audioDaemonSock, { action: "audio_devices" }),
  ]);
  const capture = captureResult.status === "fulfilled"
    ? captureStatusSchema.safeParse(captureResult.value)
    : null;
  const devices = devicesResult.status === "fulfilled"
    ? audioDevicesSchema.safeParse(devicesResult.value)
    : null;
  const microphoneReady = capture?.success === true && capture.data.micReady;
  const microphoneDetail = capture?.success
    ? capture.data.micError || null
    : captureResult.status === "rejected"
      ? String(captureResult.reason)
      : "Audio daemon returned an invalid microphone status";

  const config = ctx.config.read();
  const configuredInputValue = config.audio.mic_device?.trim() || null;
  const configuredInput = configuredInputValue?.startsWith(":") ? null : configuredInputValue;
  const availableInputs = devices?.success ? devices.data.input : [];
  const audioInputReady = configuredInput
    ? availableInputs.some((device) => device.uid === configuredInput)
    : availableInputs.length > 0;
  const audioInputDetail = audioInputReady
    ? null
    : devices?.success
      ? configuredInput
        ? `Selected audio input is unavailable: ${configuredInput}`
        : devices.data.error || "No audio input is available"
      : devicesResult.status === "rejected"
        ? String(devicesResult.reason)
        : "Audio daemon returned an invalid device list";

  const selected = config.transcription.engine;
  const localStatus = ctx.localCaption?.status();
  const local = {
    available: localStatus?.installed === true,
    ready: localStatus?.ready === true,
    provider: localStatus?.provider ?? "local",
    detail: localStatus?.ready ? null : localStatus?.error || "Local transcription is not ready",
  };
  const xaiConnection = ctx.xaiCredentials?.cachedStatus();
  const xaiProbe = ctx.xaiReadiness?.get("transcription");
  const xaiReady = xaiConnection?.connected === true && xaiConnection.source !== null &&
    xaiProbe?.status === "ready" && xaiProbe.model === "speech-to-text" &&
    xaiProbe.credentialSource === xaiConnection.source;
  const receipt = ctx.host.getCloudTranscriptionConsent();
  const disclosureRequired = !hasCurrentXaiTranscriptionConsent(ctx.host);
  const xai = {
    ready: xaiReady,
    detail: xaiReady ? null : xaiProbe?.detail || xaiConnection?.detail || "xAI transcription is not ready",
    disclosureVersion: XAI_TRANSCRIPTION_DISCLOSURE_VERSION,
    acceptedDisclosureVersion: receipt?.disclosureVersion ?? null,
    disclosureRequired,
  };
  const transcriptionState = selected === "local"
    ? local.ready ? "ready" as const : "blocked" as const
    : disclosureRequired ? "disclosure_required" as const : xai.ready ? "ready" as const : "blocked" as const;
  const summary = await activationSummaryReadiness(ctx);
  const pipeline = config.agent_pipeline;
  const pipelineReady = pipeline.enabled && pipeline.auto_process_recordings;
  const pipelineDetail = pipelineReady
    ? null
    : pipeline.enabled
      ? "Automatic Agent recording processing is paused by policy"
      : "Agent recording pipeline is disabled by policy";
  const nextStep = !microphoneReady
    ? "microphone_permission" as const
    : !audioInputReady
      ? "audio_input" as const
      : transcriptionState !== "ready"
        ? "transcription" as const
        : summary.state !== "ready"
          ? "summary_provider" as const
          : !pipelineReady
            ? "recording_pipeline" as const
            : null;
  const blocker = !microphoneReady ? {
    capability: "microphone_permission" as const,
    detail: microphoneDetail,
    remediation: { href: MICROPHONE_SETTINGS },
  } : !audioInputReady ? {
    capability: "audio_input" as const,
    detail: audioInputDetail,
    remediation: { href: "/settings/general" },
  } : transcriptionState === "blocked" ? {
    capability: selected === "local" ? "local_transcription" as const : "xai_transcription" as const,
    detail: selected === "local" ? local.detail : xai.detail,
    remediation: { href: selected === "xai" ? XAI_TRANSCRIPTION_SETTINGS : "/settings/transcription" },
  } : transcriptionState === "disclosure_required" ? null : summary.blocker ?? (!pipelineReady ? {
    capability: "recording_pipeline" as const,
    detail: pipelineDetail,
    remediation: { href: "/settings/automation" },
  } : null);

  return {
    nextStep,
    blocker,
    readiness: {
      microphonePermission: {
        state: microphoneReady ? "ready" as const : "blocked" as const,
        detail: microphoneDetail,
        remediation: microphoneReady ? null : { href: MICROPHONE_SETTINGS },
      },
      audioInput: {
        state: audioInputReady ? "ready" as const : "blocked" as const,
        selectedDeviceUid: configuredInput,
        detail: audioInputDetail,
        remediation: audioInputReady ? null : { href: "/settings/general" },
      },
      transcription: {
        selected,
        state: transcriptionState,
        local,
        xai,
        remediation: transcriptionState === "blocked"
          ? { href: selected === "xai" ? XAI_TRANSCRIPTION_SETTINGS : "/settings/transcription" }
          : null,
      },
      summary: {
        selected: summary.selected,
        state: summary.state,
        detail: summary.detail,
        credentialSource: summary.credentialSource,
        testedAt: summary.testedAt,
        disclosure: summary.disclosure,
        publicOnboardingSupported: summary.publicOnboardingSupported,
        remediation: summary.remediation,
      },
      recordingPipeline: {
        state: pipelineReady ? "ready" as const : "blocked" as const,
        enabled: pipeline.enabled,
        autoProcessRecordings: pipeline.auto_process_recordings,
        detail: pipelineDetail,
        remediation: pipelineReady ? null : { href: "/settings/automation" },
      },
    },
  };
}

function journeyState(ctx: { host: {
  getActivationJourneyState: () => {
    automaticEntryAcknowledgedAt: string | null;
    deferredAt: string | null;
  };
} }) {
  const state = ctx.host.getActivationJourneyState();
  return {
    ...state,
    shouldAutoEnter: state.automaticEntryAcknowledgedAt === null && state.deferredAt === null,
  };
}

async function activeAttempt(ctx: AppContext) {
  const existing = ctx.host.getActivationAttempt();
  if (!existing) return null;
  const attempt = existing.taskId || !existing.stopRequestedAt
    ? existing
    : ctx.host.recoverActivationAttemptTask(existing.id);
  const task = attempt.taskId ? ctx.host.getTask(attempt.taskId) : null;
  const blocker = activationAttemptBlocker(ctx, attempt, task);
  const transcriptCommitted = task !== null && hasValidCommittedTranscript(ctx, task);
  const currentSummary = blocker && transcriptCommitted ? await activationSummaryReadiness(ctx) : null;
  return {
    state: task || attempt.recordingStem || attempt.handoffError ? "processing" as const : "recording" as const,
    evidence: null,
    journey: journeyState(ctx),
    attempt,
    task: task ? publicAgentTask(task) : null,
    blocker,
    summaryRecovery: currentSummary ? {
      selected: currentSummary.selected,
      state: currentSummary.state,
      detail: currentSummary.detail,
      remediation: currentSummary.remediation,
      canReplace: currentSummary.state === "ready" && task !== null &&
        ["failed", "awaiting_provider"].includes(task.state) && (
        currentSummary.selected.provider !== task.summaryProvider ||
        currentSummary.selected.model !== task.summaryModel ||
        (currentSummary.selected.provider === "xai" &&
          currentSummary.credentialSource !== task.summaryCredentialSource)
      ),
    } : null,
  };
}

function hasValidCommittedTranscript(ctx: AppContext, task: AgentTask): boolean {
  const transcript = ctx.host.listArtifacts(task.id)
    .find((artifact) => artifact.kind === "transcript");
  if (!transcript) return false;
  try {
    ctx.artifacts.readCommittedTranscript(task, transcript);
    return true;
  } catch {
    return false;
  }
}

function summarySettingsForTask(task: AgentTask): string {
  const connectionId = task.summaryConnectionId ??
    (task.summaryProvider === "xai" ? "direct-xai" : null);
  return connectionId
    ? `/settings/llm?connection=${encodeURIComponent(connectionId)}&capability=summary`
    : SUMMARY_SETTINGS.href;
}

function activationAttemptBlocker(
  ctx: AppContext,
  attempt: ActivationAttempt,
  task: AgentTask | null,
) {
  if (attempt.handoffError) {
    if (/recording (?:processing|pipeline)|pipeline.*(?:disabled|paused)|paused by policy/i.test(attempt.handoffError)) {
      return {
        capability: "recording_pipeline" as const,
        detail: attempt.handoffError,
        retry: "same_audio" as const,
        remediation: { href: "/settings/automation" },
      };
    }
    if (!attempt.stopRequestedAt) {
      return {
        capability: "audio" as const,
        detail: attempt.handoffError,
        retry: "start_recording" as const,
        remediation: { href: "/settings/general" },
      };
    }
    let retry: "same_audio" | "rerecord" = "same_audio";
    if (attempt.recordingStem) {
      retry = hasAudioFramesAtPath(join(ctx.paths.moviesDir, `${attempt.recordingStem}.wav`))
        ? "same_audio"
        : "rerecord";
    }
    return {
      capability: "audio" as const,
      detail: attempt.handoffError,
      retry,
      remediation: { href: "/settings/general" },
    };
  }
  if (attempt.taskId && !task) {
    return {
      capability: "audio" as const,
      detail: null,
      retry: "rerecord" as const,
      remediation: { href: "/settings/general" },
    };
  }
  if (!task && attempt.stopRequestedAt && attempt.recordingStem) {
    const audioAvailable = hasAudioFramesAtPath(join(ctx.paths.moviesDir, `${attempt.recordingStem}.wav`));
    return audioAvailable ? {
      capability: "recording_pipeline" as const,
      detail: "The saved activation recording was not handed off before Yulu Host stopped",
      retry: "same_audio" as const,
      remediation: { href: "/settings/automation" },
    } : {
      capability: "audio" as const,
      detail: "The stopped activation recording is no longer available",
      retry: "rerecord" as const,
      remediation: { href: "/settings/general" },
    };
  }
  if (task?.state === "execution_unverified") {
    return {
      capability: "summary" as const,
      detail: task.error,
      retry: "new_summary_attempt" as const,
      remediation: { href: summarySettingsForTask(task) },
    };
  }
  if (!task || ![
    "awaiting_agent", "awaiting_provider", "awaiting_policy", "failed", "cancelled", "completed",
  ].includes(task.state)) {
    return null;
  }
  if (task.state === "awaiting_policy") {
    return {
      capability: "recording_pipeline" as const,
      detail: task.error,
      retry: "same_task" as const,
      remediation: { href: "/settings/automation" },
    };
  }
  const validAudio = hasAudioFramesAtPath(task.audioPath);
  if (!validAudio) {
    return {
      capability: "audio" as const,
      detail: null,
      retry: "rerecord" as const,
      remediation: { href: "/settings/general" },
    };
  }
  const transcriptCommitted = hasValidCommittedTranscript(ctx, task);
  const detail = task.error;
  const classification = detail ?? "";
  const settings = transcriptCommitted
    ? summarySettingsForTask(task)
    : /\bxai\b/i.test(classification) || ctx.config.read().transcription.engine === "xai"
      ? XAI_TRANSCRIPTION_SETTINGS
      : "/settings/transcription";
  if (/credential|oauth|api[- ]?key|unauthori[sz]ed|HTTP\s+(?:401|403)/i.test(classification)) {
    return {
      capability: "credential" as const,
      detail,
      retry: "same_task" as const,
      remediation: { href: settings },
    };
  }
  if (/\bmodel\b|HTTP\s+404/i.test(classification)) {
    return {
      capability: "model" as const,
      detail,
      retry: "same_task" as const,
      remediation: { href: settings },
    };
  }
  if (task.state === "awaiting_provider" || /provider.*unavailable|Agent.*unavailable|Hermes offline/i.test(classification)) {
    return {
      capability: "provider" as const,
      detail,
      retry: "same_task" as const,
      remediation: { href: settings },
    };
  }
  return transcriptCommitted ? {
    capability: "summary" as const,
    detail,
    retry: "same_task" as const,
    remediation: { href: summarySettingsForTask(task) },
  } : {
    capability: "transcription" as const,
    detail,
    retry: "same_task" as const,
    remediation: { href: "/settings/transcription" },
  };
}

async function stopAndCorrelateAttempt(ctx: AppContext, attempt: ActivationAttempt) {
  try {
    const result = await stopRecordingAndEnqueue(ctx, () => runRecordAudio(
      ctx,
      ["stop"],
      { timeoutMs: ACTIVATION_RECORDING_COMMAND_TIMEOUT_MS },
    ), ({ recordingStem }) => {
      ctx.host.recordActivationAttemptStopped(attempt.id, recordingStem);
    });
    if (!result.pipeline.accepted) {
      ctx.host.failActivationAttemptHandoff(attempt.id, result.pipeline.reason);
      throw new Error(result.pipeline.reason);
    }
    ctx.host.correlateActivationAttempt(attempt.id, result.pipeline.taskId);
    return await activeAttempt(ctx);
  } catch (error) {
    const current = ctx.host.getActivationAttempt();
    if (current && !current.taskId && !current.handoffError) {
      ctx.host.failActivationAttemptHandoff(
        attempt.id,
        error instanceof Error ? error.message : String(error),
      );
    }
    throw error;
  }
}

async function verifiedAttemptEvidence(
  ctx: AppContext,
  taskId: string,
  stored: CoreActivationEvidence | null,
): Promise<CoreActivationEvidence | null> {
  if (stored?.taskId === taskId) return stored;
  const candidate = ctx.host.getCoreActivationCandidate(taskId);
  return candidate
    ? verifiedCoreActivationEvidence(candidate, ctx.artifacts, ctx.paths.moviesDir)
    : null;
}

function activatedStatus(
  ctx: AppContext,
  evidence: CoreActivationEvidence,
  evidenceCreated: boolean,
  guidedCompletionPending = false,
  guidedCompletion: { taskId: string; recordingStem: string } | null = null,
) {
  const safeStem = basename(evidence.recordingStem) === evidence.recordingStem;
  const sourceArtifacts = {
    audio: safeStem && existsSync(join(ctx.paths.moviesDir, `${evidence.recordingStem}.wav`)),
    transcript: safeStem && existsSync(join(ctx.paths.moviesDir, `${evidence.recordingStem}.transcript.txt`)),
    summary: safeStem && existsSync(join(ctx.paths.moviesDir, `${evidence.recordingStem}.summary.md`)),
  };
  let completedNote: string | null = null;
  if (safeStem) {
    const summaryPath = join(ctx.paths.moviesDir, `${evidence.recordingStem}.summary.md`);
    if (sourceArtifacts.summary) {
      try {
        completedNote = readFileSync(summaryPath, "utf8").trim() || null;
      } catch { /* a missing or unreadable note is not an available action */ }
    }
  }
  return {
    state: "activated" as const,
    evidence,
    evidenceCreated,
    guidedCompletionPending,
    guidedCompletion: guidedCompletionPending ? guidedCompletion : null,
    sourceArtifacts,
    completedNoteAvailable: completedNote !== null,
    completedNote,
  };
}

export const activationRouter = router({
  status: publicProcedure.query(async ({ ctx }) => {
    let evidence = ctx.host.getCoreActivationEvidence();
    let evidenceCreated = false;
    const attempt = await activeAttempt(ctx);
    if (attempt) {
      const guidedEvidence = attempt.attempt.taskId
        ? await verifiedAttemptEvidence(ctx, attempt.attempt.taskId, evidence)
        : null;
      if (guidedEvidence) {
        if (!evidence) {
          evidence = ctx.host.recordCoreActivationEvidence(guidedEvidence);
          evidenceCreated = true;
        }
        const guidedCompletionPending = attempt.attempt.completionOpenedAt === null;
        return activatedStatus(
          ctx,
          evidence,
          evidenceCreated,
          guidedCompletionPending,
          guidedCompletionPending ? {
            taskId: guidedEvidence.taskId,
            recordingStem: guidedEvidence.recordingStem,
          } : null,
        );
      }
      return {
        ...attempt,
        backgroundEvidence: evidence,
        backgroundEvidenceCreated: evidenceCreated,
      };
    }
    if (!evidence) {
      for (const candidate of ctx.host.listCoreActivationCandidates()) {
        const verified = await verifiedCoreActivationEvidence(candidate, ctx.artifacts, ctx.paths.moviesDir);
        if (verified) {
          evidence = ctx.host.recordCoreActivationEvidence(verified);
          evidenceCreated = true;
          break;
        }
      }
    }
    if (!evidence) {
      return {
        state: "unresolved" as const,
        evidence: null,
        journey: journeyState(ctx),
        ...await activationReadiness(ctx),
      };
    }
    return activatedStatus(ctx, evidence, evidenceCreated);
  }),
  startAttempt: uiMutationProcedure.mutation(async ({ ctx }) => {
    const readiness = await activationReadiness(ctx);
    if (readiness.nextStep === "recording_pipeline") {
      throw new Error("Activation is blocked by recording pipeline policy");
    }
    if (readiness.nextStep) throw new Error(`Activation is blocked by ${readiness.nextStep}`);
    const policy = ctx.config.read().agent_pipeline;
    if (!policy.enabled || !policy.auto_process_recordings) {
      throw new Error("Activation is blocked by recording pipeline policy");
    }
    const { attempt, created } = ctx.host.beginActivationAttempt();
    if (!created) return await activeAttempt(ctx);
    try {
      await runRecordAudio(
        ctx,
        ["start", "Core Activation"],
        { timeoutMs: ACTIVATION_RECORDING_COMMAND_TIMEOUT_MS },
      );
    } catch (error) {
      ctx.host.failActivationAttemptHandoff(
        attempt.id,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    return { state: "recording" as const, attempt };
  }),
  stopAttempt: uiMutationProcedure.mutation(async ({ ctx }) => {
    const attempt = ctx.host.getActivationAttempt();
    if (!attempt) throw new Error("Activation Attempt not found");
    if (attempt.taskId) return await activeAttempt(ctx);
    ctx.host.markActivationAttemptStopping(attempt.id);
    return await stopAndCorrelateAttempt(ctx, attempt);
  }),
  retryAttempt: uiMutationProcedure.mutation(async ({ ctx }) => {
    const attempt = ctx.host.getActivationAttempt();
    if (!attempt) throw new Error("Activation Attempt not found");
    const task = attempt.taskId ? ctx.host.getTask(attempt.taskId) : null;
    const blocker = activationAttemptBlocker(ctx, attempt, task);
    if (!blocker) throw new Error("Activation Attempt is still making progress");
    if (blocker.retry === "rerecord") throw new Error("Activation audio must be recorded again");
    if (blocker.retry === "start_recording") {
      const restarted = ctx.host.restartActivationAttempt(attempt.id);
      try {
        await runRecordAudio(
          ctx,
          ["start", "Core Activation"],
          { timeoutMs: ACTIVATION_RECORDING_COMMAND_TIMEOUT_MS },
        );
      } catch (error) {
        ctx.host.failActivationAttemptHandoff(
          restarted.id,
          error instanceof Error ? error.message : String(error),
        );
        throw error;
      }
      return await activeAttempt(ctx);
    }
    if (task) {
      if (task.state === "awaiting_policy") {
        ctx.recordingPipeline.kick();
      } else {
        const hasTranscriptRecord = ctx.host.listArtifacts(task.id)
          .some((artifact) => artifact.kind === "transcript");
        ctx.recordingPipeline.retry(task.id, {
          allowCancelled: true,
          ...(task.state === "completed" ? { allowCompleted: true } : {}),
          ...(hasTranscriptRecord && !hasValidCommittedTranscript(ctx, task)
            ? { discardArtifacts: true }
            : {}),
        });
      }
      return await activeAttempt(ctx);
    }
    if (!attempt.recordingStem) return await stopAndCorrelateAttempt(ctx, attempt);
    const audioPath = join(ctx.paths.moviesDir, `${attempt.recordingStem}.wav`);
    const result = ctx.recordingPipeline.enqueueCompletion({
      audioPath,
      title: "Core Activation",
    });
    ctx.host.correlateActivationAttempt(attempt.id, result.task.id);
    return await activeAttempt(ctx);
  }),
  rerecordAttempt: uiMutationProcedure.mutation(async ({ ctx }) => {
    const attempt = ctx.host.getActivationAttempt();
    if (!attempt) throw new Error("Activation Attempt not found");
    const task = attempt.taskId ? ctx.host.getTask(attempt.taskId) : null;
    if (activationAttemptBlocker(ctx, attempt, task)?.retry !== "rerecord") {
      throw new Error("Activation audio remains recoverable");
    }
    const restarted = ctx.host.restartActivationAttempt(attempt.id);
    try {
      await runRecordAudio(
        ctx,
        ["start", "Core Activation"],
        { timeoutMs: ACTIVATION_RECORDING_COMMAND_TIMEOUT_MS },
      );
    } catch (error) {
      ctx.host.failActivationAttemptHandoff(
        restarted.id,
        error instanceof Error ? error.message : String(error),
      );
      throw error;
    }
    return { state: "recording" as const, attempt: restarted };
  }),
  replaceSummaryProvider: uiMutationProcedure.mutation(async ({ ctx }) => {
    const attempt = ctx.host.getActivationAttempt();
    if (!attempt?.taskId) throw new Error("Activation summary attempt not found");
    const task = ctx.host.getTask(attempt.taskId);
    if (!task || !hasValidCommittedTranscript(ctx, task)) {
      throw new Error("Activation transcript is not committed");
    }
    const summary = await activationSummaryReadiness(ctx);
    if (summary.state !== "ready") throw new Error("The newly selected Summary Provider is not ready");
    if (
      summary.selected.provider === task.summaryProvider &&
      summary.selected.model === task.summaryModel &&
      (summary.selected.provider !== "xai" || summary.credentialSource === task.summaryCredentialSource)
    ) {
      throw new Error("Select a different Summary Provider, model, or xAI credential source before creating a new attempt");
    }
    ctx.recordingPipeline.replaceSummaryProvider(task.id);
    return await activeAttempt(ctx);
  }),
  acknowledgeGuidedCompletion: uiMutationProcedure
    .input(z.object({ taskId: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const attempt = ctx.host.getActivationAttempt();
      if (!attempt || attempt.taskId !== input.taskId) return { acknowledged: false };
      const evidence = await verifiedAttemptEvidence(
        ctx,
        input.taskId,
        ctx.host.getCoreActivationEvidence(),
      );
      if (!evidence) return { acknowledged: false };
      return { acknowledged: ctx.host.acknowledgeGuidedCompletion(input.taskId) };
    }),
  acknowledgeAutomaticEntry: uiMutationProcedure.mutation(({ ctx }) => {
    const result = ctx.host.acknowledgeAutomaticActivationEntry();
    return {
      acknowledged: result.acknowledged,
      journey: {
        ...result.state,
        shouldAutoEnter: false,
      },
    };
  }),
  defer: uiMutationProcedure.mutation(({ ctx }) => {
    const state = ctx.host.deferActivationJourney();
    return {
      journey: {
        ...state,
        shouldAutoEnter: false,
      },
    };
  }),
  acceptXaiTranscriptionDisclosure: uiMutationProcedure.mutation(({ ctx }) =>
    ctx.agentConnections
      ? ctx.agentConnections.acceptDisclosure({ connectionId: "direct-xai", capability: "transcription" })
      : ctx.host.recordCloudTranscriptionConsent(XAI_TRANSCRIPTION_DISCLOSURE_VERSION)),
  acceptSummaryDataPathDisclosure: uiMutationProcedure.input(summaryDisclosureInput).mutation(async ({ ctx, input }) => {
    const disclosure = await currentSummaryDisclosure(ctx, input);
    if (!ctx.agentConnections) throw new Error("Agent Connection Center is unavailable");
    return ctx.agentConnections.acceptDisclosure({
      connectionId: disclosure.connectionId,
      capability: "summary",
    });
  }),
  declineSummaryDataPathDisclosure: uiMutationProcedure.input(summaryDisclosureInput).mutation(async ({ ctx, input }) => {
    const disclosure = await currentSummaryDisclosure(ctx, input);
    if (!ctx.agentConnections) throw new Error("Agent Connection Center is unavailable");
    return ctx.agentConnections.declineDisclosure({
      connectionId: disclosure.connectionId,
      capability: "summary",
    });
  }),
  probeSummaryProvider: uiMutationProcedure.mutation(async ({ ctx }) => {
    if (!ctx.agentConnections) throw new Error("Agent Connection Center is unavailable");
    const summary = await ctx.agentConnections.summaryActivation();
    if (!summary.selected.connectionId) throw new Error("Select an explicit Summary connection before testing it");
    return await ctx.agentConnections.probe({
      connectionId: summary.selected.connectionId,
      capability: "summary",
      model: summary.selected.model,
    });
  }),
});
