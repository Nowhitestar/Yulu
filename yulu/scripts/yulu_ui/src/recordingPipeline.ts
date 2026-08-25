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
import { HostStore, type AgentTask, type AgentTaskTrigger } from "./hostStore.js";
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
import type { XaiTextClient } from "./xaiText.js";
import { verifiedCoreActivationEvidence } from "./coreActivation.js";
import {
  hasCurrentSummaryDataPathDisclosure,
  hasCurrentXaiSummaryDisclosure,
  XAI_SUMMARY_DISCLOSURE_VERSION,
} from "./summaryDataDisclosure.js";
import {
  hasSupportedAgentSummaryIdentity,
  hasSupportedAgentSummaryReadinessProof,
  type SupportedAgentSummaryAdapter,
} from "./summaryProviderReadiness.js";

const REC_FILE_RE = /^(.+?)_(\d{8})_(\d{6})\.wav$/;
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
  sendToNotion?: boolean;
  language?: TranscriptionLanguage;
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
  supportedAgentSummaryAdapter?: SupportedAgentSummaryAdapter;
  gatewayFactory?: (config: YuluConfig) => RecordingAgentGateway;
  pollMs?: number;
}

interface PreparedRecordingTask {
  audioPath: string;
  transcriptionLanguage: TranscriptionLanguage;
  stem: string;
  title: string;
  sendToNotion: boolean;
  destinationHint: string;
  agentProvider: string;
  summaryProvider: string;
  summaryModel: string;
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
    return this.persist(this.prepare(input), null);
  }

  enqueueSummaryRegeneration(input: SummaryRegenerationInput): { task: AgentTask; created: boolean } {
    const config = this.options.config.read();
    if (!pipelineConfig(config).enabled) {
      throw new RecordingPipelinePolicyDisabledError("Agent recording pipeline is disabled by policy");
    }
    const recording = this.resolveRecording(input.audioPath);
    const instructions = input.instructions.trim();
    if (!instructions) throw new InvalidRecordingCompletionError("summary instructions are empty");
    const runtime = resolveHermesAgentRuntime(config, {
      scriptDir: this.options.paths.scriptDir,
      moviesDir: this.options.paths.moviesDir,
    });
    const summary = this.summaryIdentity(config, runtime.provider);
    return this.persist({
      audioPath: recording.audioPath,
      transcriptionLanguage: normalizeTranscriptionLanguage(config.transcription.language),
      stem: recording.stem,
      title: input.title?.trim() || recording.title,
      sendToNotion: false,
      destinationHint: pipelineConfig(config).notion_destination,
      agentProvider: summary.provider,
      summaryProvider: summary.provider,
      summaryModel: summary.model,
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
    const runtime = resolveHermesAgentRuntime(config, {
      scriptDir: this.options.paths.scriptDir,
      moviesDir: this.options.paths.moviesDir,
    });
    const summary = this.summaryIdentity(config, runtime.provider);
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
      sendToNotion: input.sendToNotion === true,
      destinationHint: pipelineConfig(config).notion_destination,
      agentProvider: summary.provider,
      summaryProvider: summary.provider,
      summaryModel: summary.model,
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

  private summaryIdentity(config: YuluConfig, legacyProvider: string): { provider: string; model: string } {
    const selection = config.intelligence.summary;
    if (selection.provider === "xai") return selection;
    const readiness = this.options.supportedAgentSummaryAdapter?.current();
    if (!readiness) return { provider: legacyProvider, model: selection.model };
    if (!hasSupportedAgentSummaryIdentity(readiness)) {
      throw new InvalidRecordingCompletionError("Supported Agent Summary Provider identity is invalid");
    }
    return { provider: readiness.provider.trim().toLowerCase(), model: readiness.model.trim() };
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
      sendToNotion: input.sendToNotion,
      destinationHint: input.destinationHint,
      agentProvider: input.agentProvider,
      summaryProvider: input.summaryProvider,
      summaryModel: input.summaryModel,
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

  retry(id: string): AgentTask {
    const config = this.options.config.read();
    const task = this.options.store.retry(id);
    this.resumeDispatchNow();
    this.reconcileDispatchPolicy(config);
    this.kick();
    return this.options.store.getTask(task.id)!;
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
      this.options.paths.configDir,
      this.options.paths.scriptDir,
    );
    return this.gateway;
  }

  private resolveSupportedAgentGateway(config: YuluConfig, task: AgentTask): RecordingAgentGateway {
    const adapter = this.options.supportedAgentSummaryAdapter;
    if (!adapter) return this.resolveGateway(config);
    const readiness = adapter.current();
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
      !hasCurrentSummaryDataPathDisclosure(
        this.options.store,
        provider,
        disclosure.disclosureVersion,
      )
    ) {
      throw new AgentUnavailableError(
        `${disclosure.destination} Data Path Disclosure (${disclosure.disclosureVersion}) is required; open /settings/llm`,
      );
    }
    return adapter.gateway(config);
  }

  private resolveOnDemandAudioPath(input: string): string {
    const requested = input.trim();
    if (!requested || !isAbsolute(requested)) {
      throw new InvalidTranscriptionInputError("audioPath must be an absolute WAV path");
    }
    const dictationDir = join(this.options.paths.configDir, "dictation");
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
      const usesXaiSummary = task.summaryProvider === "xai";
      let gateway: RecordingAgentGateway | null = null;
      if (usesXaiSummary && task.sendToNotion) {
        try {
          gateway = this.resolveGateway(config);
        } catch (error) {
          throw new AgentUnavailableError((error as Error).message);
        }
      }
      if (!usesXaiSummary && !this.options.supportedAgentSummaryAdapter) {
        try {
          gateway = this.resolveGateway(config);
        } catch (error) {
          throw new AgentUnavailableError((error as Error).message);
        }
      }
      this.publish(task, "transcribing");
      const workspace = this.options.artifacts.workspace(task.id);
      const glossary = this.glossary();
      const existingTranscript = this.options.store.listArtifacts(task.id)
        .find((artifact) => artifact.kind === "transcript");
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
      this.options.store.recordProgress(task.id, leaseToken, "summarizing", `Transcription provider: ${transcription.provider}`);
      this.publish(task, "summarizing");
      const current = this.options.store.getTask(task.id)!;
      const workflowInput = {
        task: current,
        leaseToken,
        workspace,
        transcriptionProvider: transcription.provider,
        glossary,
      };
      let artifactSessionId: string | null = null;
      let artifactToolNames: string[] = [];
      if (usesXaiSummary) {
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
          result = await xaiText.request({
            capability: "summary",
            model: task.summaryModel,
            input: [
              { role: "system", content: task.instructions },
              { role: "user", content: transcription.transcript },
            ],
          });
        } catch (error) {
          throw new AgentUnavailableError((error as Error).message);
        }
        if (result.model !== task.summaryModel) {
          throw new AgentUnavailableError("xAI summary returned a different model identity");
        }
        try {
          this.options.artifacts.writeStagedSummary(
            task.id,
            glossary ? applyGlossaryContract(result.text, glossary) : result.text,
          );
        } catch (error) {
          throw new AgentUnavailableError((error as Error).message);
        }
        const records = this.options.artifacts.commitFromWorkspace(current, {
          summaryProvider: "xai",
          summaryModel: result.model,
          storageDisabled: true,
          credentialSource: result.credentialSource,
          committedBy: "yulu-host",
        });
        this.options.store.recordArtifacts(task.id, leaseToken, records);
        this.options.pubsub.publish("recordings-changed", { reason: "changed" });
      } else {
        gateway ??= this.resolveSupportedAgentGateway(config, task);
        if (!gateway || gateway.provider !== task.summaryProvider) {
          throw new AgentUnavailableError(
            `Pinned Summary Provider ${task.summaryProvider} is unavailable for model ${task.summaryModel}`,
          );
        }
        const gatewayHealth = gateway.health();
        if (!gatewayHealth.available) {
          throw new AgentUnavailableError(gatewayHealth.reason ?? "Summary Agent is unavailable");
        }
        const artifactResult = await gateway.runArtifactWorkflow(workflowInput);
        if (this.options.supportedAgentSummaryAdapter) {
          const identity = artifactResult.summaryIdentity;
          if (
            identity?.provider.trim().toLowerCase() !== task.summaryProvider ||
            identity.model.trim() !== task.summaryModel
          ) {
            const committedTask = this.options.store.getTask(task.id);
            const summaryRecord = this.options.store.listArtifacts(task.id)
              .find((artifact) => artifact.kind === "summary");
            if (committedTask?.state === "artifacts_committed" && summaryRecord) {
              this.options.artifacts.rejectCommittedSummary(committedTask, summaryRecord);
            }
            throw new Error("Supported Agent returned a different Summary Provider/model identity");
          }
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
      const activationEvidence = verifiedCoreActivationEvidence({
        task: afterAgent,
        artifacts: this.options.store.listArtifacts(task.id),
        transcriptionProvider: transcription.provider,
      }, this.options.artifacts, this.options.paths.moviesDir);
      if (activationEvidence && !this.options.store.getCoreActivationEvidence()) {
        const evidence = this.options.store.recordCoreActivationEvidence(activationEvidence);
        this.options.pubsub.publish("core-activation", {
          taskId: evidence.taskId,
          recordingStem: evidence.recordingStem,
        });
      }

      // The delivery phase starts a new native session. It receives neither
      // the artifact session context nor filesystem capability, and can read
      // only the Host-verified committed summary through its dedicated MCP.
      let deliveryResult = null;
      if (afterAgent.sendToNotion) {
        if (!gateway) throw new AgentUnavailableError("Agent delivery runtime is unavailable");
        // Persist the uncertainty fence before the Agent receives any external
        // connector capability. Even a write-before-begin policy violation or
        // process crash must become delivery_unverified, never a retryable task.
        this.options.store.beginNotionDelivery(task.id, leaseToken);
        deliveryResult = await gateway.runNotionWorkflow({
          ...workflowInput,
          task: this.options.store.getTask(task.id)!,
        });
      }
      if (deliveryResult) {
        if (artifactSessionId && deliveryResult.nativeSessionId === artifactSessionId) {
          throw new Error("Hermes reused the artifact session for Notion delivery");
        }
        this.options.store.recordPhaseSession(task.id, leaseToken, "delivery", deliveryResult.nativeSessionId);
        if (!deliveryResult.audit.ok) throw new Error(deliveryResult.audit.errors.join("; "));
      }
      const afterDelivery = this.options.store.getTask(task.id)!;
      const expected = afterDelivery.sendToNotion ? "delivery_reported" : "artifacts_committed";
      if (afterDelivery.state !== expected) {
        throw new Error(`Summary Provider exited without completing the required Host commits (state=${afterDelivery.state})`);
      }
      const completionAudit = {
        artifactSessionId,
        artifactToolNames,
        deliverySessionId: deliveryResult?.nativeSessionId ?? null,
        deliveryToolNames: deliveryResult?.audit.toolNames ?? [],
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
      if (error instanceof AgentUnavailableError) {
        const current = this.options.store.getTask(task.id);
        if (current && ["sending", "delivery_reported", "delivery_unverified"].includes(current.state)) {
          this.options.store.fail(task.id, leaseToken, error.message);
          this.publish(task, "failed", error.message);
          return true;
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
