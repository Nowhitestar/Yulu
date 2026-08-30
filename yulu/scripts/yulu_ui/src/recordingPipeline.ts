import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";
import type { ConfigManager, YuluConfig } from "./config.js";
import { resolveHermesAgentRuntime } from "./agentRuntime.js";
import {
  AgentUnavailableError,
  HermesRecordingGateway,
  type RecordingAgentGateway,
} from "./agentGateway.js";
import { ArtifactStore } from "./artifactStore.js";
import {
  ClaudeSummaryEvidenceMismatchError,
  HostStore,
  secretSafeSummaryRuntimeEvidence,
  type ActivationSummarySnapshot,
  type AgentTask,
  type AgentTaskTrigger,
  type SummaryCommitRuntimeEvidence,
} from "./hostStore.js";
import type { SummaryCredentialClass } from "./hostStore.js";
import {
  InvalidPromptInstructionsError,
  automaticSummaryInstructions,
  recordingDateFromStem,
} from "./promptInstructions.js";
import type { PubSub, AppChannels } from "./pubsub.js";
import type { paths as RuntimePaths } from "./paths.js";
import {
  applyGlossaryContract,
  hasGlossaryContract,
  loadGlossaryContract,
  type GlossaryContract,
} from "./glossaryContract.js";
import {
  normalizeTranscriptionLanguage,
  type TranscriptionResult,
  type TranscriptionLanguage,
} from "./realtimeTranscription.js";
import type { AudioTranscriptionService } from "./audioTranscription.js";
import { XaiTextUnknownOutcomeError, type XaiTextClient } from "./xaiText.js";
import type { XaiCredentialSource } from "./xaiCredentials.js";
import { verifiedCoreActivationEvidence } from "./coreActivation.js";
import { CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS } from "./onboarding.js";
import {
  hasCurrentSummaryDataPathDisclosure,
  hasCurrentXaiSummaryDisclosure,
  XAI_SUMMARY_DISCLOSURE_VERSION,
} from "./summaryDataDisclosure.js";
import {
  hasSupportedAgentSummaryIdentity,
  hasSupportedAgentSummaryReadinessProof,
  ClaudeCodeSummaryUnknownOutcomeError,
  type SupportedAgentSummaryAdapter,
  type SupportedAgentSummaryGateway,
} from "./summaryProviderReadiness.js";
import { CodexConversationError } from "./codexAgentAdapter.js";
import { ClaudeCodeConversationError } from "./claudeCodeAdapter.js";

const REC_FILE_RE = /^(.+?)_(\d{8})_(\d{6})\.wav$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISPATCH_POLL_MS = 15_000;
const MAX_AGENT_ATTEMPTS = 3;
const MAX_AGENT_RETRY_DELAY_MS = 5 * 60_000;

export function agentRetryDelayMs(attempt: number, baseMs = DISPATCH_POLL_MS): number {
  const exponent = Math.max(0, Math.trunc(attempt) - 1);
  return Math.min(Math.max(1, baseMs) * (2 ** exponent), MAX_AGENT_RETRY_DELAY_MS);
}

export class InvalidTranscriptionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidTranscriptionInputError";
  }
}

export class InvalidRecordingCompletionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRecordingCompletionError";
  }
}

export class RecordingPipelinePolicyDisabledError extends Error {
  readonly permanent = true;

  constructor(message: string) {
    super(message);
    this.name = "RecordingPipelinePolicyDisabledError";
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith("/");
}

function taskIdempotencyKey(path: string): string {
  const stat = statSync(path);
  return createHash("sha256")
    .update(`recording.completed.v1\0${resolve(path)}\0${stat.size}\0${Math.floor(stat.mtimeMs)}`)
    .digest("hex");
}

function pipelineConfig(config: YuluConfig) {
  return config.agent_pipeline;
}

function dispatchPolicyReason(config: YuluConfig): string | null {
  const policy = pipelineConfig(config);
  if (!policy.enabled) return "Agent recording pipeline is disabled by policy";
  if (!policy.auto_process_recordings) return "Automatic Agent recording processing is paused by policy";
  return null;
}

function pipelineDisabledReason(config: YuluConfig): string | null {
  return pipelineConfig(config).enabled ? null : "Agent recording pipeline is disabled by policy";
}

export interface RecordingCompletionInput {
  audioPath: string;
  title?: string;
  /** Durable guided-attempt identity; never derived from mutable provider Settings. */
  activationAttemptId?: string;
  /** @deprecated Recording completion never authorizes an external write. */
  sendToNotion?: boolean;
  language?: TranscriptionLanguage;
  /** A non-secret provider identity proven before a guided Activation Attempt began. */
  summarySnapshot?: ActivationSummarySnapshot;
}

export interface OnDemandTranscriptionInput {
  audioPath: string;
  language?: TranscriptionLanguage;
}

export interface SummaryRegenerationInput {
  audioPath: string;
  title?: string;
  instructions: string;
}

export interface RecordingPipelineOptions {
  store: HostStore;
  artifacts: ArtifactStore;
  config: ConfigManager;
  paths: typeof RuntimePaths;
  pubsub: PubSub<AppChannels>;
  promptDb?: () => unknown;
  vocabDb?: () => unknown;
  transcription: Pick<AudioTranscriptionService, "provider" | "health" | "warm" | "transcribeFile">;
  xaiText?: Pick<XaiTextClient, "request">;
  xaiSummaryCredentialSource?: () => XaiCredentialSource | null;
  supportedAgentSummaryAdapter?: SupportedAgentSummaryAdapter;
  gatewayFactory?: (config: YuluConfig) => RecordingAgentGateway;
  pollMs?: number;
}

interface PreparedRecordingTask {
  audioPath: string;
  transcriptionLanguage: TranscriptionLanguage;
  stem: string;
  title: string;
  destinationHint: string;
  agentProvider: string;
  summaryProvider: string;
  summaryModel: string;
  summaryCredentialSource: XaiCredentialSource | null;
  summaryConnectionId: string | null;
  summaryCredentialClass: SummaryCredentialClass | null;
  summaryDisclosureVersion: string | null;
  instructions: string;
  trigger: AgentTaskTrigger;
}

export class RecordingPipeline {
  private readonly poll: ReturnType<typeof setInterval>;
  private dispatching = false;
  private dispatchPromise: Promise<void> | null = null;
  private stopped = false;
  private gateway: RecordingAgentGateway | null = null;
  private gatewayKey = "";
  private readonly retryBaseMs: number;
  private retryNotBefore = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: RecordingPipelineOptions) {
    this.retryBaseMs = options.pollMs ?? DISPATCH_POLL_MS;
    this.retireLegacyManualTasks();
    this.poll = setInterval(() => this.kick(), this.retryBaseMs);
    this.poll.unref();
  }

  enqueueCompletion(input: RecordingCompletionInput): { task: AgentTask; created: boolean } {
    if (input.activationAttemptId !== undefined && !UUID_RE.test(input.activationAttemptId)) {
      throw new InvalidRecordingCompletionError("Activation Attempt id must be a UUID");
    }
    return this.persist(
      this.prepare(input),
      input.activationAttemptId ? `activation-attempt:${input.activationAttemptId}` : null,
    );
  }

  enqueueSummaryRegeneration(input: SummaryRegenerationInput): { task: AgentTask; created: boolean } {
    const config = this.options.config.read();
    if (!pipelineConfig(config).enabled) {
      throw new RecordingPipelinePolicyDisabledError("Agent recording pipeline is disabled by policy");
    }
    const recording = this.resolveRecording(input.audioPath);
    const instructions = input.instructions.trim();
    if (!instructions) throw new InvalidRecordingCompletionError("summary instructions are empty");
    const summary = this.summaryIdentity(config);
    return this.persist({
      audioPath: recording.audioPath,
      transcriptionLanguage: normalizeTranscriptionLanguage(config.transcription.language),
      stem: recording.stem,
      title: input.title?.trim() || recording.title,
      destinationHint: pipelineConfig(config).notion_destination,
      agentProvider: summary.provider,
      summaryProvider: summary.provider,
      summaryModel: summary.model,
      summaryCredentialSource: summary.credentialSource,
      summaryConnectionId: summary.connectionId,
      summaryCredentialClass: summary.credentialClass,
      summaryDisclosureVersion: summary.disclosureVersion,
      instructions,
      trigger: "manual",
    }, `summary-regeneration:${randomUUID()}`);
  }

  async warmTranscription(): Promise<{ provider: string }> {
    await this.options.transcription.warm();
    return { provider: this.options.transcription.provider };
  }

  async transcribeOnDemand(input: OnDemandTranscriptionInput) {
    const audioPath = this.resolveOnDemandAudioPath(input.audioPath);
    const glossary = this.glossary();
    const result = await this.options.transcription.transcribeFile(
      audioPath,
      normalizeTranscriptionLanguage(input.language ?? this.options.config.read().transcription.language),
      glossary,
    );
    return { ...result, transcript: glossary ? applyGlossaryContract(result.transcript, glossary) : result.transcript };
  }

  private prepare(input: RecordingCompletionInput): PreparedRecordingTask {
    const config = this.options.config.read();
    if (!pipelineConfig(config).enabled) {
      throw new RecordingPipelinePolicyDisabledError("Agent recording pipeline is disabled by policy");
    }
    if (!pipelineConfig(config).auto_process_recordings) {
      throw new RecordingPipelinePolicyDisabledError("Automatic Agent recording processing is paused by policy");
    }
    const recording = this.resolveRecording(input.audioPath);
    const summary = input.summarySnapshot
      ? {
          provider: input.summarySnapshot.provider,
          model: input.summarySnapshot.model,
          credentialSource: input.summarySnapshot.credentialClass === "oauth" ||
              input.summarySnapshot.credentialClass === "api-key"
            ? input.summarySnapshot.credentialClass
            : null,
          connectionId: input.summarySnapshot.connectionId,
          credentialClass: input.summarySnapshot.credentialClass,
          disclosureVersion: input.summarySnapshot.disclosureVersion,
        }
      : this.summaryIdentity(config);
    const title = input.title?.trim() || recording.title;
    const instructionContext = {
      title,
      date: recordingDateFromStem(recording.stem),
    };
    let instructions: string;
    try {
      instructions = automaticSummaryInstructions(this.options.promptDb, instructionContext);
    } catch (error) {
      if (error instanceof InvalidPromptInstructionsError) {
        throw new InvalidRecordingCompletionError(error.message);
      }
      throw error;
    }
    return {
      audioPath: recording.audioPath,
      transcriptionLanguage: normalizeTranscriptionLanguage(
        input.language ?? config.transcription.language,
      ),
      stem: recording.stem,
      title,
      destinationHint: pipelineConfig(config).notion_destination,
      agentProvider: summary.provider,
      summaryProvider: summary.provider,
      summaryModel: summary.model,
      summaryCredentialSource: summary.credentialSource,
      summaryConnectionId: summary.connectionId,
      summaryCredentialClass: summary.credentialClass,
      summaryDisclosureVersion: summary.disclosureVersion,
      instructions,
      trigger: "automatic",
    };
  }

  private resolveRecording(input: string): { audioPath: string; stem: string; title: string } {
    let audioPath: string;
    let moviesRoot: string;
    try {
      audioPath = realpathSync(resolve(input));
      moviesRoot = realpathSync(this.options.paths.moviesDir);
    } catch {
      throw new InvalidRecordingCompletionError("recording WAV is missing");
    }
    if (!isInside(moviesRoot, audioPath)) {
      throw new InvalidRecordingCompletionError("recording path is outside the configured recordings directory");
    }
    const stat = statSync(audioPath);
    if (!stat.isFile() || stat.size < 44) throw new InvalidRecordingCompletionError("recording WAV is incomplete");
    const name = basename(audioPath);
    const match = REC_FILE_RE.exec(name);
    if (!match) throw new InvalidRecordingCompletionError("recording filename does not match the Yulu recording contract");
    return {
      audioPath,
      stem: name.slice(0, -4),
      title: match[1]!.replaceAll("_", " "),
    };
  }

  private summaryIdentity(config: YuluConfig): {
    provider: string;
    model: string;
    credentialSource: XaiCredentialSource | null;
    connectionId: string | null;
    credentialClass: SummaryCredentialClass | null;
    disclosureVersion: string | null;
  } {
    const selection = config.intelligence.summary;
    if ("disabled" in selection && selection.disabled) {
      throw new InvalidRecordingCompletionError(
        "Summary Provider selection was cleared after its Agent connection was deleted; select and test a new connection",
      );
    }
    if (selection.provider === "xai") {
      const credentialSource = this.options.xaiSummaryCredentialSource?.() ?? null;
      if (!credentialSource) {
        throw new InvalidRecordingCompletionError("xAI Summary Provider readiness credential source is unavailable");
      }
      return {
        ...selection,
        credentialSource,
        connectionId: "direct-xai",
        credentialClass: credentialSource,
        disclosureVersion: XAI_SUMMARY_DISCLOSURE_VERSION,
      };
    }
    const explicitConnectionId = selection.provider === "agent" && "connectionId" in selection
      ? selection.connectionId
      : null;
    const readiness = explicitConnectionId
      ? this.options.supportedAgentSummaryAdapter?.current({
          connectionId: explicitConnectionId,
          provider: "agent",
          model: selection.model,
        })
      : undefined;
    if (!readiness) return {
      provider: "none",
      model: selection.model,
      credentialSource: null,
      connectionId: null,
      credentialClass: null,
      disclosureVersion: null,
    };
    if (!hasSupportedAgentSummaryIdentity(readiness)) {
      throw new InvalidRecordingCompletionError("Supported Agent Summary Provider identity is invalid");
    }
    return {
      provider: readiness.provider.trim().toLowerCase(),
      model: readiness.model.trim(),
      credentialSource: null,
      connectionId: readiness.connectionId ?? null,
      credentialClass: readiness.credentialSource === "runtime-oauth" || readiness.credentialSource === "api-key"
        ? readiness.credentialSource
        : null,
      disclosureVersion: readiness.disclosure?.kind === "external"
        ? readiness.disclosure.disclosureVersion
        : null,
    };
  }

  private persist(
    input: PreparedRecordingTask,
    idempotencyOverride: string | null,
  ): { task: AgentTask; created: boolean } {
    const result = this.options.store.enqueueRecording({
      idempotencyKey: idempotencyOverride ?? taskIdempotencyKey(input.audioPath),
      recordingStem: input.stem,
      title: input.title,
      audioPath: input.audioPath,
      transcriptionLanguage: input.transcriptionLanguage,
      sendToNotion: false,
      destinationHint: input.destinationHint,
      agentProvider: input.agentProvider,
      summaryProvider: input.summaryProvider,
      summaryModel: input.summaryModel,
      summaryCredentialSource: input.summaryCredentialSource,
      summaryConnectionId: input.summaryConnectionId,
      summaryCredentialClass: input.summaryCredentialClass,
      summaryDisclosureVersion: input.summaryDisclosureVersion,
      instructions: input.instructions,
      trigger: input.trigger,
    });
    this.reconcileDispatchPolicy(this.options.config.read());
    this.kick();
    return result;
  }

  list(limit = 100): AgentTask[] {
    return this.options.store.listTasks(limit);
  }

  get(id: string): AgentTask | null {
    return this.options.store.getTask(id);
  }

  transcriptionHealth() {
    if (this.stopped) {
      return {
        available: false,
        provider: this.options.transcription.provider,
        reason: "Yulu audio transcription service is closed",
        paused: false,
        policyReason: null,
      };
    }
    const config = this.options.config.read();
    const policyReason = dispatchPolicyReason(config);
    return {
      ...this.options.transcription.health(),
      paused: policyReason !== null,
      policyReason,
    };
  }

  retry(
    id: string,
    options: { allowCancelled?: boolean; allowCompleted?: boolean; discardArtifacts?: boolean } = {},
  ): AgentTask {
    const config = this.options.config.read();
    const current = this.options.store.getTask(id);
    const task = current?.state === "artifacts_committed" && current.error
      ? current
      : this.options.store.retry(id, options);
    this.resumeDispatchNow();
    this.reconcileDispatchPolicy(config);
    this.kick();
    return this.options.store.getTask(task.id)!;
  }

  replaceSummaryProvider(id: string): AgentTask {
    const config = this.options.config.read();
    const summary = this.summaryIdentity(config);
    const task = this.options.store.replaceSummaryAttempt(id, {
      summaryProvider: summary.provider,
      summaryModel: summary.model,
      summaryCredentialSource: summary.credentialSource,
      summaryConnectionId: summary.connectionId,
      summaryCredentialClass: summary.credentialClass,
      summaryDisclosureVersion: summary.disclosureVersion,
    });
    this.resumeDispatchNow();
    this.reconcileDispatchPolicy(config);
    this.kick();
    return task;
  }

  createSummaryAttemptFromUnknown(id: string): AgentTask {
    const original = this.options.store.getTask(id);
    if (!original || original.state !== "execution_unverified") {
      throw new Error(`task ${id} does not have an Unknown Summary outcome to replace`);
    }
    const task = this.options.store.replaceSummaryAttempt(id, {
      summaryProvider: original.summaryProvider,
      summaryModel: original.summaryModel,
      summaryCredentialSource: original.summaryCredentialSource,
      summaryConnectionId: original.summaryConnectionId,
      summaryCredentialClass: original.summaryCredentialClass,
      summaryDisclosureVersion: original.summaryDisclosureVersion,
    });
    this.resumeDispatchNow();
    this.reconcileDispatchPolicy(this.options.config.read());
    this.kick();
    return task;
  }

  confirmNotionDelivery(id: string, result: { url?: string; pageId?: string; detail?: string }): AgentTask {
    const task = this.options.store.confirmNotionDelivery(id, result);
    try { this.options.artifacts.cleanupWorkspace(id); } catch { /* reconciliation is already durable */ }
    this.options.pubsub.publish("recordings-changed", { reason: "changed" });
    return task;
  }

  abandonNotionDelivery(id: string, detail = ""): AgentTask {
    const task = this.options.store.abandonNotionDelivery(id, detail);
    try { this.options.artifacts.cleanupWorkspace(id); } catch { /* abandonment is already durable */ }
    this.options.pubsub.publish("recordings-changed", { reason: "changed" });
    return task;
  }

  kick(): void {
    if (this.dispatching || this.stopped) return;
    const retryDelay = this.retryNotBefore - Date.now();
    if (retryDelay > 0) {
      this.scheduleRetry(retryDelay);
      return;
    }
    this.retryNotBefore = 0;
    this.dispatching = true;
    this.dispatchPromise = this.dispatchLoop()
      .catch((error) => {
        // Keep the Host alive and the durable queue intact when config parsing,
        // or a store operation fails outside runTask.
        // The poll loop will retry after the underlying condition is repaired.
        console.error(`[recording-pipeline] dispatch failed: ${(error as Error).message}`);
      })
      .finally(() => {
        this.dispatching = false;
        this.dispatchPromise = null;
      });
  }

  async close(): Promise<void> {
    this.stopped = true;
    clearInterval(this.poll);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    await this.dispatchPromise;
    this.gateway?.close();
    this.gateway = null;
  }

  private async dispatchLoop(): Promise<void> {
    while (!this.stopped) {
      const config = this.options.config.read();
      if (this.reconcileDispatchPolicy(config)) return;
      // Do not resolve or construct an Agent runtime when there is no durable
      // work to claim. Runtime health may be queried independently by the UI,
      // but an idle dispatcher must remain a cheap Host-store operation.
      if (!this.options.store.hasDispatchableTask()) return;
      const task = this.options.store.claimNext();
      if (!task || !task.leaseToken) return;
      const canContinue = await this.runTask(config, task, task.leaseToken);
      if (!canContinue) return;
    }
  }

  private reconcileDispatchPolicy(config: YuluConfig): string | null {
    this.retireLegacyManualTasks();
    const disabledReason = pipelineDisabledReason(config);
    if (disabledReason) {
      this.options.store.pauseDispatchableForPolicy(disabledReason);
      return disabledReason;
    }
    if (!pipelineConfig(config).auto_process_recordings) {
      const reason = "Automatic Agent recording processing is paused by policy";
      this.options.store.pauseDispatchableForPolicy(reason, "automatic");
      return null;
    }
    this.options.store.resumePolicyPaused("automatic");
    return null;
  }

  private resolveGateway(config: YuluConfig): RecordingAgentGateway {
    if (this.options.gatewayFactory) {
      if (!this.gateway) this.gateway = this.options.gatewayFactory(config);
      return this.gateway;
    }
    const runtime = resolveHermesAgentRuntime(config, {
      scriptDir: this.options.paths.scriptDir,
      moviesDir: this.options.paths.moviesDir,
    });
    const key = JSON.stringify({ provider: runtime.provider, command: runtime.command });
    if (this.gateway && this.gatewayKey === key) return this.gateway;
    this.gateway?.close();
    this.gatewayKey = key;
    this.gateway = new HermesRecordingGateway(
      runtime,
      this.options.paths.durableDataDir,
      this.options.paths.scriptDir,
    );
    return this.gateway;
  }

  private resolveSupportedAgentGateway(config: YuluConfig, task: AgentTask): RecordingAgentGateway {
    const adapter = this.options.supportedAgentSummaryAdapter;
    if (!adapter) {
      throw new AgentUnavailableError("The pinned Supported Agent Summary Provider adapter is unavailable");
    }
    const readiness = adapter.current({
      connectionId: task.summaryConnectionId,
      provider: task.summaryProvider,
      model: task.summaryModel,
    });
    const provider = readiness.provider.trim().toLowerCase();
    const model = readiness.model.trim();
    if (
      !hasSupportedAgentSummaryIdentity(readiness) ||
      !hasSupportedAgentSummaryReadinessProof(readiness) ||
      provider !== task.summaryProvider || model !== task.summaryModel
    ) {
      throw new AgentUnavailableError("The pinned Supported Agent Summary Provider is not currently ready");
    }
    const disclosure = readiness.disclosure;
    if (
      disclosure?.kind === "external" &&
      (disclosure.connectionId
        ? this.options.store.getAgentConnectionDisclosure(disclosure.connectionId, "summary")?.disclosureVersion !==
            disclosure.disclosureVersion ||
          this.options.store.getAgentConnectionDisclosure(disclosure.connectionId, "summary")?.decision !== "accepted"
        : !hasCurrentSummaryDataPathDisclosure(
            this.options.store,
            provider,
            disclosure.disclosureVersion,
          ))
    ) {
      throw new AgentUnavailableError(
        `${disclosure.destination} Data Path Disclosure (${disclosure.disclosureVersion}) is required; open /settings/llm`,
      );
    }
    return adapter.gateway(config, {
      connectionId: task.summaryConnectionId,
      provider: task.summaryProvider,
      model: task.summaryModel,
    });
  }

  private resolveOnDemandAudioPath(input: string): string {
    const requested = input.trim();
    if (!requested || !isAbsolute(requested)) {
      throw new InvalidTranscriptionInputError("audioPath must be an absolute WAV path");
    }
    const dictationDir = join(this.options.paths.moviesDir, "Dictation");
    mkdirSync(dictationDir, { recursive: true, mode: 0o700 });
    let audioPath: string;
    try {
      audioPath = realpathSync(requested);
    } catch {
      throw new InvalidTranscriptionInputError("transcription WAV is missing");
    }
    const allowedRoots = [this.options.paths.moviesDir, dictationDir].map((root) => realpathSync(root));
    if (!allowedRoots.some((root) => isInside(root, audioPath))) {
      throw new InvalidTranscriptionInputError("audioPath is outside Yulu recordings and dictation directories");
    }
    if (extname(audioPath).toLowerCase() !== ".wav") {
      throw new InvalidTranscriptionInputError("audioPath must reference a WAV file");
    }
    const stat = statSync(audioPath);
    if (!stat.isFile() || stat.size < 44) {
      throw new InvalidTranscriptionInputError("transcription WAV is incomplete");
    }
    return audioPath;
  }

  private async runTask(config: YuluConfig, task: AgentTask, leaseToken: string): Promise<boolean> {
    try {
      const resumesCommittedArtifacts = task.state === "artifacts_committed";
      const usesXaiSummary = task.summaryProvider === "xai";
      const usesSupportedAgentSummary = Boolean(task.summaryConnectionId);
      let summaryGateway: RecordingAgentGateway | null = null;
      if (!resumesCommittedArtifacts && !usesXaiSummary && !usesSupportedAgentSummary) {
        try {
          summaryGateway = this.resolveGateway(config);
        } catch (error) {
          throw new AgentUnavailableError((error as Error).message);
        }
      }
      const workspace = this.options.artifacts.workspace(task.id);
      const glossary = this.glossary();
      const existingTranscript = this.options.store.listArtifacts(task.id)
        .find((artifact) => artifact.kind === "transcript");
      this.publish(task, existingTranscript ? "summarizing" : "transcribing");
      let transcription: TranscriptionResult;
      if (existingTranscript) {
        const transcript = this.options.artifacts.readCommittedTranscript(task, existingTranscript);
        this.options.artifacts.writeStagedTranscript(task.id, transcript);
        transcription = {
          transcript,
          provider: String(existingTranscript.provenance.transcriptionProvider ?? "unknown"),
          chunks: Number(existingTranscript.provenance.transcriptChunks ?? 1),
          language: task.transcriptionLanguage,
        };
      } else if (task.trigger === "manual") {
        const record = this.options.artifacts.adoptCommittedTranscript(task, {
          transcriptionProvider: "committed-transcript",
          transcriptChunks: 1,
          committedBy: "yulu-host",
        });
        this.options.store.recordTranscript(task.id, leaseToken, record);
        transcription = {
          transcript: this.options.artifacts.readCommittedTranscript(task, record),
          provider: "committed-transcript",
          chunks: 1,
          language: task.transcriptionLanguage,
        };
        this.options.pubsub.publish("recordings-changed", { reason: "changed" });
      } else {
        const rawTranscription = await this.options.transcription.transcribeFile(
          task.audioPath,
          task.transcriptionLanguage,
          glossary,
        );
        const transcript = glossary
          ? applyGlossaryContract(rawTranscription.transcript, glossary)
          : rawTranscription.transcript;
        transcription = { ...rawTranscription, transcript };
        const record = this.options.artifacts.commitTranscript(task, transcript, {
          transcriptionProvider: transcription.provider,
          transcriptChunks: transcription.chunks,
          committedBy: "yulu-host",
        });
        this.options.store.recordTranscript(task.id, leaseToken, record);
        this.options.pubsub.publish("recordings-changed", { reason: "changed" });
      }
      const transcriptArtifact = this.options.store.listArtifacts(task.id)
        .find((artifact) => artifact.kind === "transcript");
      if (!transcriptArtifact) throw new Error("Summary execution requires a committed transcript artifact");
      let recoveredArtifactSessionId: string | null = null;
      if (resumesCommittedArtifacts) {
        const recoveredRecords = this.options.store.listArtifacts(task.id);
        const summaryArtifact = recoveredRecords
          .find((artifact) => artifact.kind === "summary");
        if (
          !summaryArtifact ||
          summaryArtifact.provenance.summaryProvider !== task.summaryProvider ||
          summaryArtifact.provenance.summaryModel !== task.summaryModel
        ) {
          throw new Error("Recovered Summary artifacts do not match the pinned committed identity");
        }
        if (this.options.store.isArtifactPublishPending(task.id)) {
          this.options.artifacts.publishPreparedArtifacts(task, recoveredRecords);
          this.options.store.markArtifactsPublished(task.id, leaseToken);
        }
        this.options.artifacts.readCommittedSummary(task, summaryArtifact);
        const provenanceSessionId = summaryArtifact.provenance.artifactSessionId;
        if (typeof provenanceSessionId === "string" && provenanceSessionId) {
          recoveredArtifactSessionId = provenanceSessionId;
          this.options.store.recordPhaseSession(task.id, leaseToken, "artifact", recoveredArtifactSessionId);
        }
      }
      if (!resumesCommittedArtifacts) {
        this.options.store.recordProgress(
          task.id,
          leaseToken,
          "summarizing",
          `Transcription provider: ${transcription.provider}`,
        );
        this.publish(task, "summarizing");
      }
      const current = resumesCommittedArtifacts
        ? task
        : this.options.store.recordSummaryInputSnapshot(task.id, leaseToken, transcriptArtifact);
      const committedTranscript = this.options.artifacts.readCommittedTranscript(current, transcriptArtifact);
      const workflowInput = {
        task: current,
        leaseToken,
        workspace,
        transcriptionProvider: transcription.provider,
        committedTranscript,
        glossary,
      };
      let artifactSessionId: string | null = recoveredArtifactSessionId;
      let artifactToolNames: string[] = [];
      if (!resumesCommittedArtifacts && usesXaiSummary) {
        if (!task.summaryCredentialSource) {
          throw new AgentUnavailableError(
            "xAI Summary Provider credential source was not pinned; create an explicit replacement attempt",
          );
        }
        if (!hasCurrentXaiSummaryDisclosure(this.options.store)) {
          throw new AgentUnavailableError(
            `xAI Summary Data Path Disclosure (${XAI_SUMMARY_DISCLOSURE_VERSION}) is required; open /settings/llm`,
          );
        }
        const xaiText = this.options.xaiText;
        if (!xaiText) {
          throw new AgentUnavailableError(
            `Pinned Summary Provider xai is unavailable for model ${task.summaryModel}`,
          );
        }
        let result: Awaited<ReturnType<XaiTextClient["request"]>>;
        try {
          this.options.store.beginSummaryExecution(task.id, leaseToken);
          result = await xaiText.request({
            capability: "summary",
            model: task.summaryModel,
            credentialSource: task.summaryCredentialSource ?? undefined,
            input: [
              { role: "system", content: task.instructions },
              { role: "user", content: transcription.transcript },
            ],
          });
        } catch (error) {
          if (error instanceof XaiTextUnknownOutcomeError) throw error;
          throw new AgentUnavailableError((error as Error).message);
        }
        if (result.model !== task.summaryModel) {
          throw new AgentUnavailableError("xAI summary returned a different model identity");
        }
        if (result.credentialSource !== task.summaryCredentialSource) {
          throw new AgentUnavailableError("xAI summary returned a different credential source");
        }
        try {
          this.options.artifacts.writeStagedSummary(
            task.id,
            glossary ? applyGlossaryContract(result.text, glossary) : result.text,
          );
        } catch (error) {
          throw new AgentUnavailableError((error as Error).message);
        }
        const records = this.options.artifacts.prepareFromWorkspace(current, {
          summaryProvider: "xai",
          summaryModel: result.model,
          storageDisabled: true,
          credentialSource: result.credentialSource,
          committedBy: "yulu-host",
        });
        this.options.store.recordArtifacts(task.id, leaseToken, records);
        this.options.artifacts.publishPreparedArtifacts(current, records);
        this.options.store.markArtifactsPublished(task.id, leaseToken);
        this.options.pubsub.publish("recordings-changed", { reason: "changed" });
      } else if (!resumesCommittedArtifacts) {
        summaryGateway ??= usesSupportedAgentSummary
          ? this.resolveSupportedAgentGateway(config, task)
          : this.resolveGateway(config);
        if (!summaryGateway || summaryGateway.provider !== task.summaryProvider) {
          throw new AgentUnavailableError(
            `Pinned Summary Provider ${task.summaryProvider} is unavailable for model ${task.summaryModel}`,
          );
        }
        const gatewayHealth = summaryGateway.health();
        if (!usesSupportedAgentSummary && !gatewayHealth.available) {
          throw new AgentUnavailableError(gatewayHealth.reason ?? "Summary Agent is unavailable");
        }
        if (usesSupportedAgentSummary) {
          this.options.store.beginSummaryExecution(task.id, leaseToken);
        }
        const artifactResult = usesSupportedAgentSummary
          ? await (summaryGateway as SupportedAgentSummaryGateway).runArtifactWorkflow(workflowInput)
          : await summaryGateway.runArtifactWorkflow(workflowInput);
        if (usesSupportedAgentSummary) {
          const supportedResult = artifactResult as Awaited<
            ReturnType<SupportedAgentSummaryGateway["runArtifactWorkflow"]>
          >;
          const identity = supportedResult.summaryIdentity;
          if (
            identity?.provider.trim().toLowerCase() !== task.summaryProvider ||
            identity.model.trim() !== task.summaryModel
          ) {
            throw new Error("Supported Agent returned a different Summary Provider/model identity");
          }
          if (task.summaryConnectionId && supportedResult.summary === undefined) {
            throw new Error("Supported Agent Summary returned no staged output");
          }
          if (supportedResult.summary !== undefined) {
            if (supportedResult.summary.includes("\u0000")) {
              throw new Error("Supported Agent Summary returned invalid summary output");
            }
            this.options.artifacts.writeStagedSummary(
              task.id,
              glossary ? applyGlossaryContract(supportedResult.summary, glossary) : supportedResult.summary,
            );
          }
          if (!supportedResult.audit.ok) throw new Error(supportedResult.audit.errors.join("; "));
          const runtimeEvidence = supportedResult.runtimeEvidence
            ? secretSafeSummaryRuntimeEvidence(supportedResult.runtimeEvidence)
            : undefined;
          if (task.summaryConnectionId) {
            if (!runtimeEvidence || !task.summaryCredentialClass || !task.summaryDisclosureVersion) {
              throw new Error("Supported Agent Summary did not return complete Runtime Evidence for the pinned task snapshot");
            }
            this.options.store.validateSummaryCommit(task.id, leaseToken, {
              connectionId: task.summaryConnectionId,
              credentialClass: task.summaryCredentialClass,
              disclosureVersion: task.summaryDisclosureVersion,
              inputArtifact: transcriptArtifact,
              runtimeEvidence,
              toolCalls: supportedResult.audit.toolNames,
            });
          }
          const stagedTask = this.options.store.getTask(task.id)!;
          const records = this.options.artifacts.prepareFromWorkspace(stagedTask, {
            agentProvider: task.summaryProvider,
            summaryProvider: task.summaryProvider,
            summaryModel: task.summaryModel,
            summaryConnectionId: current.summaryConnectionId,
            summaryCredentialClass: current.summaryCredentialClass,
            summaryDisclosureVersion: current.summaryDisclosureVersion,
            summaryInputArtifactId: current.summaryInputArtifactId,
            summaryInputArtifactSha256: current.summaryInputArtifactSha256,
            runtimeEvidence,
            artifactSessionId: artifactResult.nativeSessionId,
            committedBy: "yulu-host",
          });
          this.options.store.recordArtifacts(task.id, leaseToken, records);
          this.options.artifacts.publishPreparedArtifacts(stagedTask, records);
          this.options.store.markArtifactsPublished(task.id, leaseToken);
          this.options.pubsub.publish("recordings-changed", { reason: "changed" });
        }
        artifactSessionId = artifactResult.nativeSessionId;
        artifactToolNames = artifactResult.audit.toolNames;
        this.options.store.recordPhaseSession(task.id, leaseToken, "artifact", artifactResult.nativeSessionId);
        if (!artifactResult.audit.ok) throw new Error(artifactResult.audit.errors.join("; "));
      }
      const afterAgent = this.options.store.getTask(task.id)!;
      if (afterAgent.state !== "artifacts_committed") {
        throw new Error(`Summary Provider exited without completing the artifact Host commit (state=${afterAgent.state})`);
      }
      const activationEvidence = await verifiedCoreActivationEvidence({
        task: afterAgent,
        artifacts: this.options.store.listArtifacts(task.id),
        transcriptionProvider: transcription.provider,
      }, this.options.artifacts, this.options.paths.moviesDir);
      if (activationEvidence && !this.options.store.getCoreActivationEvidence()) {
        const evidence = this.options.store.recordCoreActivationEvidence(
          activationEvidence,
          CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS,
        );
        this.options.pubsub.publish("core-activation", {
          taskId: evidence.taskId,
          recordingStem: evidence.recordingStem,
        });
      }

      const completionAudit = {
        artifactSessionId,
        artifactToolNames,
        deliverySessionId: null,
        deliveryToolNames: [],
        transcriptChunks: transcription.chunks,
        transcriptionProvider: transcription.provider,
      };
      this.options.store.complete(task.id, leaseToken, completionAudit);
      try { this.options.artifacts.cleanupWorkspace(task.id); }
      catch { /* artifacts are already committed; cleanup is best effort */ }
      this.publish(task, "done");
      this.resumeDispatchNow();
      this.options.pubsub.publish("recordings-changed", { reason: "changed" });
      return true;
    } catch (error) {
      const current = this.options.store.getTask(task.id);
      if (
        current?.state === "artifacts_committed" && current.leaseToken === leaseToken &&
        this.options.store.isArtifactPublishPending(task.id)
      ) {
        this.options.store.releaseArtifactPublication(task.id, leaseToken, (error as Error).message);
        this.publish(task, "failed", (error as Error).message);
        this.deferDispatch(task.attempt);
        return false;
      }
      if (error instanceof ClaudeCodeSummaryUnknownOutcomeError) {
        let unknown: AgentTask;
        if (error.nativeSessionId) {
          try {
            unknown = this.options.store.markClaudeSummaryUnknownOutcome(
              task.id,
              leaseToken,
              error.message,
              error.nativeSessionId,
              error.evidence,
            );
          } catch (fenceError) {
            if (!(fenceError instanceof ClaudeSummaryEvidenceMismatchError)) {
              throw fenceError;
            }
            unknown = this.options.store.markSummaryUnknownOutcome(task.id, leaseToken, {
              nativeSessionId: error.nativeSessionId,
              runtimeEvidence: error.evidence,
            });
          }
        } else {
          unknown = this.options.store.markSummaryUnknownOutcome(task.id, leaseToken, {
            runtimeEvidence: error.evidence,
          });
        }
        this.publish(task, "failed", unknown.error ?? error.message);
        return true;
      } else if (error instanceof ClaudeCodeConversationError && error.unknownOutcome) {
        const unknown = this.options.store.markSummaryUnknownOutcome(task.id, leaseToken, {
          nativeSessionId: error.nativeSessionId,
          runtimeEvidence: error.evidence,
        });
        this.publish(task, "failed", unknown.error ?? error.message);
        return true;
      } else if (error instanceof CodexConversationError && error.unknownOutcome) {
        const unknown = this.options.store.markSummaryUnknownOutcome(task.id, leaseToken, {
          nativeSessionId: error.nativeSessionId,
          runtimeEvidence: error.evidence,
        });
        this.publish(task, "failed", unknown.error ?? error.message);
        return true;
      } else if (error instanceof XaiTextUnknownOutcomeError) {
        const unknown = this.options.store.markSummaryUnknownOutcome(task.id, leaseToken);
        this.publish(task, "failed", unknown.error ?? error.message);
        return true;
      } else if (error instanceof AgentUnavailableError) {
        const current = this.options.store.getTask(task.id);
        if (current && ["sending", "delivery_reported", "delivery_unverified"].includes(current.state)) {
          this.options.store.fail(task.id, leaseToken, error.message);
          this.publish(task, "failed", error.message);
          return true;
        }
        if (current?.state === "artifacts_committed") {
          this.options.store.releaseCommittedArtifactsToAwaitingDelivery(task.id, leaseToken, error.message);
          this.publish(task, "failed", error.message);
          this.deferDispatch(task.attempt);
          return false;
        }
        if (current?.state === "transcript_committed") {
          this.options.store.releaseToAwaitingProvider(task.id, leaseToken, error.message);
          this.publish(task, "failed", error.message);
          return false;
        }
        if (task.attempt >= MAX_AGENT_ATTEMPTS) {
          const message = `Selected audio engine unavailable after ${MAX_AGENT_ATTEMPTS} attempts: ${error.message}`;
          this.options.store.fail(task.id, leaseToken, message);
          this.publish(task, "failed", message);
          return true;
        }
        this.options.store.releaseToAwaitingAgent(task.id, leaseToken, error.message);
        this.deferDispatch(task.attempt);
        return false;
      } else {
        this.options.store.fail(task.id, leaseToken, (error as Error).message);
        this.publish(task, "failed", (error as Error).message);
        return true;
      }
    }
  }

  private glossary(): GlossaryContract | undefined {
    try {
      const contract = loadGlossaryContract(this.options.vocabDb?.());
      return hasGlossaryContract(contract) ? contract : undefined;
    } catch {
      return undefined;
    }
  }

  private publish(task: AgentTask, state: "transcribing" | "summarizing" | "done" | "failed", error?: string): void {
    this.options.pubsub.publish("jobs", { stem: task.recordingStem, jobId: task.id, state, error });
  }

  private retireLegacyManualTasks(): void {
    for (const taskId of this.options.store.retireLegacyManualTasks()) {
      try { this.options.artifacts.cleanupWorkspace(taskId); } catch { /* migration is already durable */ }
    }
  }

  private deferDispatch(attempt: number): void {
    const delay = agentRetryDelayMs(attempt, this.retryBaseMs);
    this.retryNotBefore = Date.now() + delay;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.scheduleRetry(delay);
  }

  private scheduleRetry(delay: number): void {
    if (this.retryTimer || this.stopped) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.kick();
    }, Math.max(1, delay));
    this.retryTimer.unref();
  }

  private resumeDispatchNow(): void {
    this.retryNotBefore = 0;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
