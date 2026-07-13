import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
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
}

export interface OnDemandTranscriptionInput {
  audioPath: string;
}

export interface RecordingPipelineOptions {
  store: HostStore;
  artifacts: ArtifactStore;
  config: ConfigManager;
  paths: typeof RuntimePaths;
  pubsub: PubSub<AppChannels>;
  promptDb?: () => unknown;
  gatewayFactory?: (config: YuluConfig) => RecordingAgentGateway;
  pollMs?: number;
}

interface PreparedRecordingTask {
  audioPath: string;
  stem: string;
  title: string;
  sendToNotion: boolean;
  destinationHint: string;
  agentProvider: string;
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

  async warmTranscription(): Promise<{ provider: string }> {
    const gateway = this.requireTranscriptionGateway();
    await gateway.warmTranscription();
    return { provider: gateway.provider };
  }

  async transcribeOnDemand(input: OnDemandTranscriptionInput) {
    const audioPath = this.resolveOnDemandAudioPath(input.audioPath);
    const gateway = this.requireTranscriptionGateway();
    const workspaceRoot = join(this.options.paths.configDir, "dictation", ".agent-workspaces");
    mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
    const workspaceDir = mkdtempSync(join(workspaceRoot, "transcribe-"));
    const workspace = {
      dir: workspaceDir,
      transcriptPath: join(workspaceDir, "transcript.txt"),
      summaryPath: join(workspaceDir, "summary.md"),
      chunkPattern: join(workspaceDir, "audio-%03d.wav"),
    };
    try {
      return await gateway.transcribeAudio(audioPath, workspace);
    } finally {
      if (!isInside(workspaceRoot, workspaceDir) || !basename(workspaceDir).startsWith("transcribe-")) {
        throw new Error("refusing to clean an invalid Agent transcription workspace");
      }
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  }

  private prepare(input: RecordingCompletionInput): PreparedRecordingTask {
    const config = this.options.config.read();
    if (!pipelineConfig(config).enabled) {
      throw new RecordingPipelinePolicyDisabledError("Agent recording pipeline is disabled by policy");
    }
    if (!pipelineConfig(config).auto_process_recordings) {
      throw new RecordingPipelinePolicyDisabledError("Automatic Agent recording processing is paused by policy");
    }
    let audioPath: string;
    let moviesRoot: string;
    try {
      audioPath = realpathSync(resolve(input.audioPath));
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
    const stem = name.slice(0, -4);
    const runtime = resolveHermesAgentRuntime(config, {
      scriptDir: this.options.paths.scriptDir,
      moviesDir: this.options.paths.moviesDir,
    });
    const title = input.title?.trim() || match[1]!.replaceAll("_", " ");
    const instructionContext = {
      title,
      date: recordingDateFromStem(stem),
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
      audioPath,
      stem,
      title,
      sendToNotion: input.sendToNotion === true,
      destinationHint: pipelineConfig(config).notion_destination,
      agentProvider: runtime.provider,
      instructions,
      trigger: "automatic",
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
      sendToNotion: input.sendToNotion,
      destinationHint: input.destinationHint,
      agentProvider: input.agentProvider,
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
        provider: "hermes",
        reason: "Agent recording pipeline is closed",
        paused: false,
        policyReason: null,
      };
    }
    const config = this.options.config.read();
    const policyReason = dispatchPolicyReason(config);
    const disabledReason = pipelineDisabledReason(config);
    if (disabledReason) {
      return {
        available: false,
        provider: "hermes",
        reason: disabledReason,
        paused: true,
        policyReason: disabledReason,
      };
    }
    return {
      ...this.resolveGateway(config).health(),
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
        // gateway construction, or a store operation fails outside runTask.
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
      const gateway = this.resolveGateway(config);
      const health = gateway.health();
      if (!health.available) {
        const waiting = this.options.store.listTasks(500)
          .find((task) => task.state === "queued" || task.state === "awaiting_agent");
        if (waiting) {
          const reason = health.reason ?? "Hermes is unavailable";
          const awaiting = this.options.store.markAwaitingAgent(waiting.id, reason);
          if (awaiting.attempt >= MAX_AGENT_ATTEMPTS) {
            this.options.store.fail(waiting.id, null, `Hermes unavailable after ${MAX_AGENT_ATTEMPTS} checks: ${reason}`);
            this.publish(waiting, "failed", reason);
            continue;
          }
          this.deferDispatch(awaiting.attempt);
        }
        return;
      }
      const task = this.options.store.claimNext(gateway.provider);
      if (!task || !task.leaseToken) return;
      const canContinue = await this.runTask(gateway, task, task.leaseToken);
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
      return reason;
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
    const cfg = pipelineConfig(config);
    const key = JSON.stringify({ provider: runtime.provider, command: runtime.command, port: cfg.hermes_serve_port, chunk: cfg.transcription_chunk_sec });
    if (this.gateway && this.gatewayKey === key) return this.gateway;
    this.gateway?.close();
    this.gatewayKey = key;
    this.gateway = new HermesRecordingGateway(
      runtime,
      this.options.paths.configDir,
      this.options.paths.scriptDir,
      this.options.artifacts,
      { servePort: cfg.hermes_serve_port, chunkSec: cfg.transcription_chunk_sec },
    );
    return this.gateway;
  }

  private requireTranscriptionGateway(): RecordingAgentGateway {
    if (this.stopped) throw new AgentUnavailableError("Agent recording pipeline is closed");
    const config = this.options.config.read();
    const disabledReason = pipelineDisabledReason(config);
    if (disabledReason) throw new AgentUnavailableError(disabledReason);
    const gateway = this.resolveGateway(config);
    const health = gateway.health();
    if (!health.available) throw new AgentUnavailableError(health.reason ?? "Hermes transcription is unavailable");
    return gateway;
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

  private async runTask(gateway: RecordingAgentGateway, task: AgentTask, leaseToken: string): Promise<boolean> {
    try {
      this.publish(task, "transcribing");
      const workspace = this.options.artifacts.workspace(task.id);
      const transcription = await gateway.transcribe(task, workspace);
      this.options.store.recordProgress(task.id, leaseToken, "summarizing", `Hermes transcription provider: ${transcription.provider}`);
      this.publish(task, "summarizing");
      const current = this.options.store.getTask(task.id)!;
      const workflowInput = {
        task: current,
        leaseToken,
        workspace,
        transcriptionProvider: transcription.provider,
      };
      const artifactResult = await gateway.runArtifactWorkflow(workflowInput);
      this.options.store.recordPhaseSession(task.id, leaseToken, "artifact", artifactResult.nativeSessionId);
      if (!artifactResult.audit.ok) throw new Error(artifactResult.audit.errors.join("; "));
      const afterAgent = this.options.store.getTask(task.id)!;
      if (afterAgent.state !== "artifacts_committed") {
        throw new Error(`Hermes exited without completing the artifact Host commit (state=${afterAgent.state})`);
      }

      // The delivery phase starts a new native session. It receives neither
      // the artifact session context nor filesystem capability, and can read
      // only the Host-verified committed summary through its dedicated MCP.
      let deliveryResult = null;
      if (afterAgent.sendToNotion) {
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
        if (deliveryResult.nativeSessionId === artifactResult.nativeSessionId) {
          throw new Error("Hermes reused the artifact session for Notion delivery");
        }
        this.options.store.recordPhaseSession(task.id, leaseToken, "delivery", deliveryResult.nativeSessionId);
        if (!deliveryResult.audit.ok) throw new Error(deliveryResult.audit.errors.join("; "));
      }
      const afterDelivery = this.options.store.getTask(task.id)!;
      const expected = afterDelivery.sendToNotion ? "delivery_reported" : "artifacts_committed";
      if (afterDelivery.state !== expected) {
        throw new Error(`Hermes exited without completing the required Host commits (state=${afterDelivery.state})`);
      }
      this.options.store.complete(task.id, leaseToken, {
        artifactSessionId: artifactResult.nativeSessionId,
        artifactToolNames: artifactResult.audit.toolNames,
        deliverySessionId: deliveryResult?.nativeSessionId ?? null,
        deliveryToolNames: deliveryResult?.audit.toolNames ?? [],
        transcriptChunks: transcription.chunks,
        transcriptionProvider: transcription.provider,
      });
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
        if (task.attempt >= MAX_AGENT_ATTEMPTS) {
          const message = `Hermes unavailable after ${MAX_AGENT_ATTEMPTS} attempts: ${error.message}`;
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
