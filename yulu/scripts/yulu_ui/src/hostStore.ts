import Database, { type Database as DbType } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { basename, dirname } from "node:path";
import { isTrustedNotionUrl, isValidNotionPageId, notionPageIdentityProblem } from "./notionDelivery.js";
import type { TranscriptionLanguage } from "./realtimeTranscription.js";
import type { XaiCredentialSource } from "./xaiCredentials.js";
import {
  CLIPROXYAPI_CONTRACT_VERSION,
  isExactGatewayRuntimeEvidence,
} from "./cliProxyApiAdapter.js";

export type AgentTaskState =
  | "queued"
  | "awaiting_agent"
  | "awaiting_provider"
  | "awaiting_policy"
  | "running"
  | "transcript_committed"
  | "artifacts_committed"
  | "sending"
  | "delivery_reported"
  | "delivery_unverified"
  | "execution_unverified"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentTaskPhase =
  | "queued"
  | "transcribing"
  | "transcript_committed"
  | "summarizing"
  | "committing_artifacts"
  | "sending_notion"
  | "completed"
  | "failed";

export type AgentTaskTrigger = "automatic" | "manual";
export type SummaryCredentialClass = XaiCredentialSource | "runtime-oauth";

export interface AgentTask {
  id: string;
  idempotencyKey: string;
  recordingStem: string;
  title: string;
  audioPath: string;
  transcriptionLanguage: TranscriptionLanguage;
  trigger: AgentTaskTrigger;
  state: AgentTaskState;
  phase: AgentTaskPhase;
  sendToNotion: boolean;
  destinationHint: string;
  instructions: string;
  agentProvider: string;
  summaryProvider: string;
  summaryModel: string;
  summaryCredentialSource: XaiCredentialSource | null;
  summaryConnectionId: string | null;
  summaryCredentialClass: SummaryCredentialClass | null;
  summaryCredentialIdentity: string | null;
  summaryDisclosureVersion: string | null;
  summaryEndpointIdentity: string | null;
  summaryInputArtifactId: string | null;
  summaryInputArtifactSha256: string | null;
  summaryInputArtifactBytes: number | null;
  nativeSessionId: string | null;
  artifactSessionId: string | null;
  deliverySessionId: string | null;
  leaseToken: string | null;
  attempt: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type PublicAgentTask = Omit<AgentTask, "leaseToken">;

export function publicAgentTask(task: AgentTask): PublicAgentTask {
  const { leaseToken: _leaseToken, ...safe } = task;
  return safe;
}

export interface ArtifactRecord {
  id: string;
  taskId: string;
  recordingStem: string;
  kind: "transcript" | "summary";
  path: string;
  sha256: string;
  bytes: number;
  mimeType: string;
  provenance: Record<string, unknown>;
  createdAt: string;
}

export interface SummaryCommitRuntimeEvidence {
  adapter: string;
  transport: string;
  runtimeVersion: string;
  requestedProvider: string | null;
  requestedModel: string;
  actualProvider: string | null;
  actualModel: string | null;
  requestId: string | null;
  sessionId: string | null;
  terminalStatus: "ready" | "failed" | "unknown";
  fallbackOccurred: boolean;
  endpoint?: string | null;
  toolsEnabled?: boolean;
}

export interface ActivationArtifactFingerprint {
  sha256: string;
  bytes: number;
}

export interface CoreActivationEvidence {
  recordingStem: string;
  taskId: string;
  transcriptionProvider: string;
  summaryProvider: string;
  summaryModel: string;
  artifacts: {
    audio: ActivationArtifactFingerprint;
    transcript: ActivationArtifactFingerprint;
    summary: ActivationArtifactFingerprint;
  };
  completedAt: string;
}

export interface CoreActivationCandidate {
  task: AgentTask;
  artifacts: ArtifactRecord[];
  transcriptionProvider: string | null;
}

export interface ActivationJourneyState {
  automaticEntryAcknowledgedAt: string | null;
  deferredAt: string | null;
}

export interface ActivationAttempt {
  id: string;
  startedAt: string;
  stopRequestedAt: string | null;
  completionOpenedAt: string | null;
  handoffError: string | null;
  taskId: string | null;
  recordingStem: string | null;
}

export interface CloudTranscriptionConsent {
  disclosureVersion: string;
  acceptedAt: string;
}

export interface SummaryDataPathDisclosure {
  provider: string;
  disclosureVersion: string;
  decision: "accepted" | "declined";
  decidedAt: string;
}

export interface PersistedAgentConnection {
  id: string;
  kind: "direct-provider" | "supported-agent" | "gateway" | "legacy-custom";
  adapter: string;
  label: string;
  lifecycle: "available" | "legacy";
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedAgentConnectionCandidate {
  id: string;
  adapter: string;
  label: string;
  source: "discovered" | "migrated";
  detectedPath: string | null;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface PersistedAgentConnectionReadiness {
  id: string;
  connectionId: string;
  capability: "transcription" | "summary" | "conversation";
  status: "ready" | "failed";
  model: string;
  credentialSource: XaiCredentialSource | null;
  detail: string;
  reason: "invalid_model" | "readiness_failed" | "unknown_outcome" | null;
  runtimeEvidence: {
    adapter: string;
    transport: string;
    runtimeVersion: string | null;
    requestedProvider: string | null;
    requestedModel: string;
    actualProvider: string | null;
    actualModel: string | null;
    requestId: string | null;
    sessionId: string | null;
    terminalStatus: "ready" | "failed" | "unknown";
    fallbackOccurred: boolean | null;
    endpoint?: string | null;
    toolsEnabled?: boolean;
  };
  testedAt: string;
}

export interface AgentConnectionDataPathDisclosure {
  connectionId: string;
  capability: "transcription" | "summary" | "conversation";
  disclosureVersion: string;
  decision: "accepted" | "declined";
  decidedAt: string;
}

function summaryDisclosureIdentity(provider: string, disclosureVersion: string) {
  const normalized = provider.trim().toLowerCase();
  const version = disclosureVersion.trim();
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(normalized) || !version || version.length > 100) {
    throw new Error("Summary Data Path Disclosure identity is invalid");
  }
  return { provider: normalized, disclosureVersion: version };
}

export interface NotionDelivery {
  taskId: string;
  deliveryKey: string;
  status: "sending" | "reported" | "abandoned";
  destination: string;
  url: string | null;
  pageId: string | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentTaskEvent {
  id: string;
  taskId: string;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface TaskRow {
  id: string;
  idempotency_key: string;
  recording_stem: string;
  title: string;
  audio_path: string;
  transcription_language: TranscriptionLanguage;
  trigger: AgentTaskTrigger;
  state: AgentTaskState;
  phase: AgentTaskPhase;
  send_to_notion: number;
  destination_hint: string;
  instructions: string;
  agent_provider: string;
  summary_provider: string;
  summary_model: string;
  summary_credential_source: XaiCredentialSource | null;
  summary_connection_id: string | null;
  summary_credential_class: SummaryCredentialClass | null;
  summary_credential_identity: string | null;
  summary_disclosure_version: string | null;
  summary_endpoint_identity: string | null;
  summary_input_artifact_id: string | null;
  summary_input_artifact_sha256: string | null;
  summary_input_artifact_bytes: number | null;
  native_session_id: string | null;
  artifact_session_id: string | null;
  delivery_session_id: string | null;
  lease_token: string | null;
  attempt: number;
  error: string | null;
  created_at: string;
  updated_at: string;
}

type GatewaySummaryExecutionStage = "preflight" | "summary";

interface GatewaySummaryExecutionJournal {
  stage: GatewaySummaryExecutionStage;
  executionId: string;
  endpoint: string;
  model: string;
}

function gatewaySummaryExecutionJournal(raw: string | null): GatewaySummaryExecutionJournal | null {
  try {
    const audit = JSON.parse(raw ?? "null") as Record<string, unknown> | null;
    const value = audit?.gatewayExecution;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const journal = value as Record<string, unknown>;
    const stage = journal.stage;
    const executionId = journal.executionId;
    const endpoint = journal.endpoint;
    const model = journal.model;
    if (
      (stage !== "preflight" && stage !== "summary") ||
      typeof executionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(executionId) ||
      typeof endpoint !== "string" || !endpoint || endpoint.length > 2_000 ||
      typeof model !== "string" || !model || model.length > 128
    ) return null;
    return { stage, executionId, endpoint, model };
  } catch {
    return null;
  }
}

function now(): string {
  return new Date().toISOString();
}

function toTask(row: TaskRow): AgentTask {
  return {
    id: row.id,
    idempotencyKey: row.idempotency_key,
    recordingStem: row.recording_stem,
    title: row.title,
    audioPath: row.audio_path,
    transcriptionLanguage: row.transcription_language,
    trigger: row.trigger,
    state: row.state,
    phase: row.phase,
    sendToNotion: row.send_to_notion === 1,
    destinationHint: row.destination_hint,
    instructions: row.instructions,
    agentProvider: row.agent_provider,
    summaryProvider: row.summary_provider,
    summaryModel: row.summary_model,
    summaryCredentialSource: row.summary_credential_source,
    summaryConnectionId: row.summary_connection_id,
    summaryCredentialClass: row.summary_credential_class,
    summaryCredentialIdentity: row.summary_credential_identity,
    summaryDisclosureVersion: row.summary_disclosure_version,
    summaryEndpointIdentity: row.summary_endpoint_identity,
    summaryInputArtifactId: row.summary_input_artifact_id,
    summaryInputArtifactSha256: row.summary_input_artifact_sha256,
    summaryInputArtifactBytes: row.summary_input_artifact_bytes,
    nativeSessionId: row.native_session_id,
    artifactSessionId: row.artifact_session_id,
    deliverySessionId: row.delivery_session_id,
    leaseToken: row.lease_token,
    attempt: row.attempt,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const RECORDING_DELETE_BLOCKING_STATES = new Set<AgentTaskState>([
  "running",
  "transcript_committed",
  "artifacts_committed",
  "sending",
  "delivery_reported",
  "delivery_unverified",
  "execution_unverified",
]);

export class RecordingTaskDeletionBlockedError extends Error {
  constructor(stem: string, states: AgentTaskState[]) {
    super(`recording ${stem} cannot be deleted while Agent task state is ${[...new Set(states)].join(", ")}`);
    this.name = "RecordingTaskDeletionBlockedError";
  }
}

export class HostStore {
  readonly db: DbType;

  constructor(path: string) {
    const parent = dirname(path);
    const previousUmask = process.umask(0o077);
    try {
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      chmodSync(parent, 0o700);
      this.db = new Database(path);
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("busy_timeout = 5000");
      this.migrate();
      this.recoverInterrupted();
      for (const dbPath of [path, `${path}-wal`, `${path}-shm`]) {
        if (existsSync(dbPath)) chmodSync(dbPath, 0o600);
      }
    } finally {
      process.umask(previousUmask);
    }
  }

  close(): void {
    this.db.close();
  }

  listAgentConnectionRecords(): PersistedAgentConnection[] {
    const rows = this.db.prepare(`
      SELECT * FROM agent_connections ORDER BY created_at, id
    `).all() as Array<{
      id: string;
      kind: PersistedAgentConnection["kind"];
      adapter: string;
      label: string;
      lifecycle: PersistedAgentConnection["lifecycle"];
      settings_json: string;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      adapter: row.adapter,
      label: row.label,
      lifecycle: row.lifecycle,
      settings: JSON.parse(row.settings_json) as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  upsertAgentConnectionRecord(input: Omit<PersistedAgentConnection, "createdAt" | "updatedAt">): void {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO agent_connections (
        id, kind, adapter, label, lifecycle, settings_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        kind = excluded.kind,
        adapter = excluded.adapter,
        label = excluded.label,
        lifecycle = excluded.lifecycle,
        settings_json = excluded.settings_json,
        updated_at = excluded.updated_at
    `).run(
      input.id,
      input.kind,
      input.adapter,
      input.label,
      input.lifecycle,
      JSON.stringify(input.settings),
      timestamp,
      timestamp,
    );
  }

  deleteAgentConnectionRecord(id: string): void {
    this.db.prepare("DELETE FROM agent_connections WHERE id = ?").run(id);
  }

  listAgentConnectionCandidates(): PersistedAgentConnectionCandidate[] {
    const rows = this.db.prepare(`
      SELECT * FROM agent_connection_candidates ORDER BY created_at, id
    `).all() as Array<{
      id: string;
      adapter: string;
      label: string;
      source: PersistedAgentConnectionCandidate["source"];
      detected_path: string | null;
      settings_json: string;
      created_at: string;
      updated_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      adapter: row.adapter,
      label: row.label,
      source: row.source,
      detectedPath: row.detected_path,
      settings: JSON.parse(row.settings_json) as Record<string, unknown>,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  upsertAgentConnectionCandidate(input: Omit<PersistedAgentConnectionCandidate, "createdAt" | "updatedAt">): void {
    const timestamp = now();
    this.db.prepare(`
      INSERT INTO agent_connection_candidates (
        id, adapter, label, source, detected_path, settings_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        adapter = excluded.adapter,
        label = excluded.label,
        source = excluded.source,
        detected_path = excluded.detected_path,
        settings_json = excluded.settings_json,
        updated_at = excluded.updated_at
    `).run(
      input.id,
      input.adapter,
      input.label,
      input.source,
      input.detectedPath,
      JSON.stringify(input.settings),
      timestamp,
      timestamp,
    );
  }

  hasAgentConnectionMigration(id: string): boolean {
    return this.db.prepare("SELECT 1 FROM agent_connection_migrations WHERE id = ?")
      .get(id) !== undefined;
  }

  recordAgentConnectionMigration(id: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO agent_connection_migrations (id, completed_at) VALUES (?, ?)
    `).run(id, now());
  }

  listAgentConnectionReadinessHistory(
    connectionId: string,
    capability: PersistedAgentConnectionReadiness["capability"],
    limit = 10,
  ): PersistedAgentConnectionReadiness[] {
    const rows = this.db.prepare(`
      SELECT * FROM agent_connection_readiness_history
      WHERE connection_id = ? AND capability = ?
      ORDER BY tested_at DESC, id DESC LIMIT ?
    `).all(connectionId, capability, Math.max(1, Math.min(100, limit))) as Array<{
      id: string;
      connection_id: string;
      capability: PersistedAgentConnectionReadiness["capability"];
      status: PersistedAgentConnectionReadiness["status"];
      model: string;
      credential_source: XaiCredentialSource | null;
      detail: string;
      reason: PersistedAgentConnectionReadiness["reason"];
      runtime_evidence_json: string;
      tested_at: string;
    }>;
    return rows.map((row) => {
      const runtimeEvidence = JSON.parse(row.runtime_evidence_json) as PersistedAgentConnectionReadiness["runtimeEvidence"];
      return {
        id: row.id,
        connectionId: row.connection_id,
        capability: row.capability,
        status: row.status,
        model: row.model,
        credentialSource: row.credential_source,
        detail: row.detail,
        reason: runtimeEvidence.terminalStatus === "unknown" ? "unknown_outcome" : row.reason,
        runtimeEvidence,
        testedAt: row.tested_at,
      };
    });
  }

  recordAgentConnectionReadiness(
    input: Omit<PersistedAgentConnectionReadiness, "id">,
  ): PersistedAgentConnectionReadiness {
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO agent_connection_readiness_history (
        id, connection_id, capability, status, model, credential_source, detail, reason,
        runtime_evidence_json, tested_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.connectionId,
      input.capability,
      input.status,
      input.model,
      input.credentialSource,
      input.detail,
      input.reason === "unknown_outcome" ? "readiness_failed" : input.reason,
      JSON.stringify(input.runtimeEvidence),
      input.testedAt,
    );
    return { id, ...input };
  }

  clearAgentConnectionReadinessHistory(connectionId: string): void {
    this.db.prepare("DELETE FROM agent_connection_readiness_history WHERE connection_id = ?")
      .run(connectionId);
  }

  getAgentConnectionDisclosure(
    connectionId: string,
    capability: AgentConnectionDataPathDisclosure["capability"],
  ): AgentConnectionDataPathDisclosure | null {
    const row = this.db.prepare(`
      SELECT * FROM agent_connection_disclosures
      WHERE connection_id = ? AND capability = ?
    `).get(connectionId, capability) as {
      connection_id: string;
      capability: AgentConnectionDataPathDisclosure["capability"];
      disclosure_version: string;
      decision: AgentConnectionDataPathDisclosure["decision"];
      decided_at: string;
    } | undefined;
    return row ? {
      connectionId: row.connection_id,
      capability: row.capability,
      disclosureVersion: row.disclosure_version,
      decision: row.decision,
      decidedAt: row.decided_at,
    } : null;
  }

  recordAgentConnectionDisclosure(input: {
    connectionId: string;
    capability: AgentConnectionDataPathDisclosure["capability"];
    disclosureVersion: string;
    decision: AgentConnectionDataPathDisclosure["decision"];
  }): AgentConnectionDataPathDisclosure {
    const decidedAt = now();
    this.db.prepare(`
      INSERT INTO agent_connection_disclosures (
        connection_id, capability, disclosure_version, decision, decided_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, capability) DO UPDATE SET
        disclosure_version = excluded.disclosure_version,
        decision = excluded.decision,
        decided_at = excluded.decided_at
    `).run(input.connectionId, input.capability, input.disclosureVersion, input.decision, decidedAt);
    return { ...input, decidedAt };
  }

  clearAgentConnectionDisclosures(connectionId: string): void {
    this.db.prepare("DELETE FROM agent_connection_disclosures WHERE connection_id = ?")
      .run(connectionId);
  }

  enqueueRecording(input: {
    idempotencyKey: string;
    recordingStem: string;
    title: string;
    audioPath: string;
    transcriptionLanguage?: TranscriptionLanguage;
    sendToNotion: boolean;
    destinationHint: string;
    agentProvider: string;
    summaryProvider: string;
    summaryModel: string;
    summaryCredentialSource?: XaiCredentialSource | null;
    summaryConnectionId?: string | null;
    summaryCredentialClass?: SummaryCredentialClass | null;
    summaryCredentialIdentity?: string | null;
    summaryDisclosureVersion?: string | null;
    summaryEndpointIdentity?: string | null;
    instructions?: string;
    trigger?: AgentTaskTrigger;
  }): { task: AgentTask; created: boolean } {
    const summaryCredentialSource = input.summaryCredentialSource ?? null;
    if (input.summaryProvider.trim().toLowerCase() === "xai" && !summaryCredentialSource) {
      throw new Error("xAI Summary Provider credential source is required");
    }
    const id = randomUUID();
    const timestamp = now();
    const insert = this.db.transaction(() => {
      const existing = this.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return { task: existing, created: false };
      const active = this.db.prepare(`
        SELECT * FROM agent_tasks
        WHERE recording_stem = ?
          AND state IN ('queued', 'awaiting_agent', 'awaiting_provider', 'awaiting_policy', 'running',
                        'transcript_committed', 'artifacts_committed', 'sending', 'delivery_reported', 'delivery_unverified',
                        'execution_unverified')
        ORDER BY updated_at DESC, created_at DESC LIMIT 1
      `).get(input.recordingStem) as TaskRow | undefined;
      if (active) return { task: toTask(active), created: false };
      if ((input.trigger ?? "automatic") === "automatic") {
        const completed = this.db.prepare(`
          SELECT * FROM agent_tasks
          WHERE recording_stem = ? AND state = 'completed'
          ORDER BY updated_at DESC, created_at DESC LIMIT 1
        `).get(input.recordingStem) as TaskRow | undefined;
        if (completed) return { task: toTask(completed), created: false };
      }
      this.db.prepare(`
        INSERT OR IGNORE INTO agent_tasks (
          id, idempotency_key, recording_stem, title, audio_path, transcription_language, trigger,
          state, phase, send_to_notion, destination_hint, agent_provider,
          summary_provider, summary_model, summary_credential_source,
          summary_connection_id, summary_credential_class, summary_credential_identity,
          summary_disclosure_version, summary_endpoint_identity, instructions,
          attempt, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        id,
        input.idempotencyKey,
        input.recordingStem,
        input.title,
        input.audioPath,
        input.transcriptionLanguage ?? "zh",
        input.trigger ?? "automatic",
        input.sendToNotion ? 1 : 0,
        input.destinationHint,
        input.agentProvider,
        input.summaryProvider,
        input.summaryModel,
        summaryCredentialSource,
        input.summaryConnectionId ?? null,
        input.summaryCredentialClass ?? summaryCredentialSource,
        input.summaryCredentialIdentity ?? null,
        input.summaryDisclosureVersion ?? null,
        input.summaryEndpointIdentity ?? null,
        input.instructions ?? "",
        timestamp,
        timestamp,
      );
      const task = this.findByIdempotencyKey(input.idempotencyKey);
      if (!task) throw new Error("failed to persist Agent task");
      if (task.id === id) this.appendEvent(task.id, "task.queued", {
        sendToNotion: input.sendToNotion,
        trigger: input.trigger ?? "automatic",
        summaryProvider: input.summaryProvider,
        summaryModel: input.summaryModel,
        summaryCredentialSource,
        summaryConnectionId: input.summaryConnectionId ?? null,
        summaryCredentialClass: input.summaryCredentialClass ?? summaryCredentialSource,
        summaryCredentialIdentity: input.summaryCredentialIdentity ?? null,
        summaryDisclosureVersion: input.summaryDisclosureVersion ?? null,
        summaryEndpointIdentity: input.summaryEndpointIdentity ?? null,
      });
      return { task, created: task.id === id };
    });
    // Acquire the SQLite write lock before checking for active work so a second
    // HostStore connection cannot admit a competing task for the same recording.
    return insert.immediate();
  }

  getTask(id: string): AgentTask | null {
    const row = this.db.prepare("SELECT * FROM agent_tasks WHERE id = ?").get(id) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  findByIdempotencyKey(key: string): AgentTask | null {
    const row = this.db.prepare("SELECT * FROM agent_tasks WHERE idempotency_key = ?").get(key) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  listTasks(limit = 100): AgentTask[] {
    const rows = this.db.prepare(
      "SELECT * FROM agent_tasks ORDER BY updated_at DESC, created_at DESC LIMIT ?",
    ).all(limit) as TaskRow[];
    return rows.map(toTask);
  }

  retireLegacyImportedTasks(): string[] {
    const retire = this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT id FROM agent_tasks
        WHERE idempotency_key LIKE 'legacy-agent-queue:%'
          AND state IN ('queued', 'awaiting_agent', 'awaiting_provider', 'awaiting_policy', 'running', 'transcript_committed', 'artifacts_committed')
      `).all() as Array<{ id: string }>;
      const timestamp = now();
      for (const row of rows) {
        this.db.prepare(`
          UPDATE agent_tasks SET state = 'cancelled', phase = 'failed', lease_token = NULL,
            error = 'Legacy queue task retired without automatic execution', updated_at = ?
          WHERE id = ?
        `).run(timestamp, row.id);
        this.appendEvent(row.id, "legacy.task_retired", {
          reason: "legacy queue tasks require explicit reprocessing after Agent-native migration",
        });
      }
      return rows.map((row) => row.id);
    });
    return retire();
  }

  retireLegacyManualTasks(): string[] {
    const reason = "Retired legacy combined manual task after atomic meeting actions migration";
    const retire = this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT * FROM agent_tasks
        WHERE trigger = 'manual' AND idempotency_key NOT LIKE 'summary-regeneration:%' AND (
          state IN ('queued', 'awaiting_agent', 'awaiting_provider', 'awaiting_policy', 'running',
                    'transcript_committed', 'artifacts_committed', 'sending', 'delivery_reported')
          OR (state = 'failed' AND error = ?)
        )
        ORDER BY created_at
      `).all(reason) as TaskRow[];
      const timestamp = now();
      for (const row of rows) {
        const deliveryMayHaveStarted = ["sending", "delivery_reported"].includes(row.state);
        const state: AgentTaskState = deliveryMayHaveStarted ? "delivery_unverified" : "cancelled";
        this.db.prepare(`
          UPDATE agent_tasks SET state = ?, phase = 'failed', lease_token = NULL,
            error = ?, updated_at = ? WHERE id = ?
        `).run(state, reason, timestamp, row.id);
        this.appendEvent(
          row.id,
          deliveryMayHaveStarted ? "notion.delivery_unverified" : "legacy.manual_task_retired",
          { reason },
        );
      }
      return rows.map((row) => row.id);
    });
    return retire();
  }

  cancelPolicyPausedAutomaticForManualAction(stem: string): string[] {
    const reason = "Superseded by an explicit manual meeting action";
    const cancel = this.db.transaction(() => {
      const rows = this.db.prepare(`
        SELECT id FROM agent_tasks
        WHERE recording_stem = ? AND trigger = 'automatic' AND state = 'awaiting_policy'
        ORDER BY created_at
      `).all(stem) as Array<{ id: string }>;
      const timestamp = now();
      for (const row of rows) {
        this.db.prepare(`
          UPDATE agent_tasks SET state = 'cancelled', phase = 'failed', lease_token = NULL,
            error = ?, updated_at = ?
          WHERE id = ? AND trigger = 'automatic' AND state = 'awaiting_policy'
        `).run(reason, timestamp, row.id);
        this.appendEvent(row.id, "task.cancelled", { reason: "manual_action" });
      }
      return rows.map((row) => row.id);
    });
    return cancel();
  }

  latestForRecording(stem: string): AgentTask | null {
    const row = this.db.prepare(
      "SELECT * FROM agent_tasks WHERE recording_stem = ? ORDER BY updated_at DESC, created_at DESC LIMIT 1",
    ).get(stem) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  prepareRecordingDeletion(stem: string): string[] {
    const prepare = this.db.transaction(() => {
      const rows = this.db.prepare(
        "SELECT * FROM agent_tasks WHERE recording_stem = ? ORDER BY created_at",
      ).all(stem) as TaskRow[];
      const blocking = rows.filter((row) => RECORDING_DELETE_BLOCKING_STATES.has(row.state));
      if (blocking.length > 0) {
        throw new RecordingTaskDeletionBlockedError(stem, blocking.map((row) => row.state));
      }
      const timestamp = now();
      for (const row of rows) {
        if (!['queued', 'awaiting_agent', 'awaiting_provider', 'awaiting_policy'].includes(row.state)) continue;
        this.db.prepare(`
          UPDATE agent_tasks SET state = 'cancelled', phase = 'failed', lease_token = NULL,
            error = 'Recording deleted before Agent task started', updated_at = ?
          WHERE id = ? AND state IN ('queued', 'awaiting_agent', 'awaiting_provider', 'awaiting_policy')
        `).run(timestamp, row.id);
        this.appendEvent(row.id, "task.cancelled", { reason: "recording_deleted" });
      }
      return rows.map((row) => row.id);
    });
    return prepare();
  }

  purgeRecordingTasks(stem: string): string[] {
    const purge = this.db.transaction(() => {
      const rows = this.db.prepare(
        "SELECT * FROM agent_tasks WHERE recording_stem = ? ORDER BY created_at",
      ).all(stem) as TaskRow[];
      const unsafe = rows.filter((row) => !["completed", "failed", "cancelled"].includes(row.state));
      if (unsafe.length > 0) {
        throw new RecordingTaskDeletionBlockedError(stem, unsafe.map((row) => row.state));
      }
      this.db.prepare("DELETE FROM agent_tasks WHERE recording_stem = ?").run(stem);
      return rows.map((row) => row.id);
    });
    return purge();
  }

  claimNext(): AgentTask | null {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM agent_tasks
        WHERE state IN ('queued', 'awaiting_agent', 'transcript_committed', 'artifacts_committed')
        ORDER BY created_at ASC LIMIT 1
      `).get() as TaskRow | undefined;
      if (!row) return null;
      const lease = randomUUID();
      const timestamp = now();
      const result = this.db.prepare(`
        UPDATE agent_tasks
        SET state = CASE
              WHEN state IN ('transcript_committed', 'artifacts_committed') THEN state
              ELSE 'running'
            END,
            phase = CASE
              WHEN state = 'transcript_committed' THEN 'summarizing'
              WHEN state = 'artifacts_committed' THEN 'committing_artifacts'
              ELSE 'transcribing'
            END,
            native_session_id = CASE WHEN state = 'artifacts_committed' THEN native_session_id ELSE NULL END,
            artifact_session_id = CASE WHEN state = 'artifacts_committed' THEN artifact_session_id ELSE NULL END,
            delivery_session_id = NULL,
            lease_token = ?, attempt = attempt + 1, error = NULL, audit_json = NULL, updated_at = ?
        WHERE id = ? AND state IN ('queued', 'awaiting_agent', 'transcript_committed', 'artifacts_committed')
      `).run(lease, timestamp, row.id);
      if (result.changes !== 1) return null;
      this.appendEvent(row.id, "task.claimed", {
        summaryProvider: row.summary_provider,
        summaryModel: row.summary_model,
        summaryCredentialSource: row.summary_credential_source,
        attempt: row.attempt + 1,
      });
      return this.getTask(row.id);
    });
    return claim();
  }

  hasDispatchableTask(): boolean {
    return this.db.prepare(`
      SELECT 1 FROM agent_tasks
      WHERE state IN ('queued', 'awaiting_agent', 'transcript_committed', 'artifacts_committed')
      LIMIT 1
    `).get() !== undefined;
  }

  claim(id: string): AgentTask | null {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT * FROM agent_tasks WHERE id = ? AND state IN ('queued', 'awaiting_agent', 'transcript_committed', 'artifacts_committed')",
      ).get(id) as TaskRow | undefined;
      if (!row) return null;
      const lease = randomUUID();
      const result = this.db.prepare(`
        UPDATE agent_tasks
        SET state = CASE
              WHEN state IN ('transcript_committed', 'artifacts_committed') THEN state
              ELSE 'running'
            END,
            phase = CASE
              WHEN state = 'transcript_committed' THEN 'summarizing'
              WHEN state = 'artifacts_committed' THEN 'committing_artifacts'
              ELSE 'transcribing'
            END,
            native_session_id = CASE WHEN state = 'artifacts_committed' THEN native_session_id ELSE NULL END,
            artifact_session_id = CASE WHEN state = 'artifacts_committed' THEN artifact_session_id ELSE NULL END,
            delivery_session_id = NULL,
            lease_token = ?, attempt = attempt + 1, error = NULL, audit_json = NULL, updated_at = ?
        WHERE id = ? AND state IN ('queued', 'awaiting_agent', 'transcript_committed', 'artifacts_committed')
      `).run(lease, now(), id);
      if (result.changes !== 1) return null;
      this.appendEvent(id, "task.claimed", {
        summaryProvider: row.summary_provider,
        summaryModel: row.summary_model,
        summaryCredentialSource: row.summary_credential_source,
        attempt: row.attempt + 1,
      });
      return this.getTask(id);
    });
    return claim();
  }

  markAwaitingAgent(id: string, reason: string): AgentTask {
    const mark = this.db.transaction(() => {
      const timestamp = now();
      const result = this.db.prepare(`
        UPDATE agent_tasks SET state = 'awaiting_agent', phase = 'queued', error = ?,
          lease_token = NULL, attempt = attempt + 1, updated_at = ?
        WHERE id = ? AND state IN ('queued', 'awaiting_agent')
      `).run(reason.slice(0, 1000), timestamp, id);
      if (result.changes !== 1) throw new Error(`task ${id} cannot await Agent before claim`);
      const task = this.getTask(id)!;
      this.appendEvent(id, "task.awaiting_agent", { reason, attempt: task.attempt });
      return task;
    });
    return mark();
  }

  pauseDispatchableForPolicy(reason: string, trigger?: AgentTaskTrigger): AgentTask[] {
    const pause = this.db.transaction(() => {
      const rows = (trigger ? this.db.prepare(`
        SELECT * FROM agent_tasks
        WHERE state IN ('queued', 'awaiting_agent', 'transcript_committed') AND trigger = ?
        ORDER BY created_at
      `).all(trigger) : this.db.prepare(`
        SELECT * FROM agent_tasks
        WHERE state IN ('queued', 'awaiting_agent', 'transcript_committed')
        ORDER BY created_at
      `).all()) as TaskRow[];
      const timestamp = now();
      for (const row of rows) {
        this.db.prepare(`
          UPDATE agent_tasks SET state = 'awaiting_policy', phase = 'queued', error = ?,
            lease_token = NULL, updated_at = ?
          WHERE id = ? AND state IN ('queued', 'awaiting_agent', 'transcript_committed')
        `).run(reason.slice(0, 1000), timestamp, row.id);
        this.appendEvent(row.id, "task.awaiting_policy", { reason });
      }
      return rows.map((row) => this.getTask(row.id)!);
    });
    return pause();
  }

  resumePolicyPaused(trigger?: AgentTaskTrigger): AgentTask[] {
    const resume = this.db.transaction(() => {
      const rows = (trigger ? this.db.prepare(`
        SELECT id FROM agent_tasks
        WHERE state = 'awaiting_policy' AND trigger = ? ORDER BY created_at
      `).all(trigger) : this.db.prepare(`
        SELECT id FROM agent_tasks WHERE state = 'awaiting_policy' ORDER BY created_at
      `).all()) as Array<{ id: string }>;
      const timestamp = now();
      for (const row of rows) {
        this.db.prepare(`
          UPDATE agent_tasks SET
            state = CASE
              WHEN EXISTS (SELECT 1 FROM artifacts WHERE task_id = agent_tasks.id AND kind = 'transcript')
                THEN 'transcript_committed'
              ELSE 'queued'
            END,
            phase = CASE
              WHEN EXISTS (SELECT 1 FROM artifacts WHERE task_id = agent_tasks.id AND kind = 'transcript')
                THEN 'summarizing'
              ELSE 'queued'
            END,
            error = NULL,
            lease_token = NULL, updated_at = ? WHERE id = ? AND state = 'awaiting_policy'
        `).run(timestamp, row.id);
        this.appendEvent(row.id, "task.policy_resumed", {});
      }
      return rows.map((row) => this.getTask(row.id)!);
    });
    return resume();
  }

  releaseToAwaitingAgent(id: string, leaseToken: string, reason: string): AgentTask {
    const task = this.requireLease(id, leaseToken);
    if (!["running", "transcript_committed", "artifacts_committed"].includes(task.state)) {
      throw new Error(`task ${id} cannot await Agent from ${task.state}`);
    }
    const result = this.db.prepare(`
      UPDATE agent_tasks SET state = CASE
          WHEN EXISTS (SELECT 1 FROM artifacts WHERE task_id = ? AND kind = 'transcript') THEN 'transcript_committed'
          ELSE 'awaiting_agent'
        END, phase = CASE
          WHEN EXISTS (SELECT 1 FROM artifacts WHERE task_id = ? AND kind = 'transcript') THEN 'summarizing'
          ELSE 'queued'
        END, error = ?,
        lease_token = NULL, updated_at = ?
      WHERE id = ? AND lease_token = ? AND state IN ('running', 'transcript_committed', 'artifacts_committed')
    `).run(id, id, reason.slice(0, 1000), now(), id, leaseToken);
    if (result.changes !== 1) throw new Error(`task ${id} changed before it could await Agent`);
    this.appendEvent(id, "task.awaiting_agent", { reason });
    return this.getTask(id)!;
  }

  releaseToAwaitingProvider(id: string, leaseToken: string, reason: string): AgentTask {
    const task = this.requireLease(id, leaseToken);
    if (task.state !== "transcript_committed" || !this.listArtifacts(id).some((artifact) => artifact.kind === "transcript")) {
      throw new Error(`task ${id} cannot await provider before transcript commit`);
    }
    const safeReason = reason.slice(0, 1000);
    const result = this.db.prepare(`
      UPDATE agent_tasks SET state = 'awaiting_provider', phase = 'summarizing',
        error = ?, lease_token = NULL, updated_at = ?
      WHERE id = ? AND lease_token = ? AND state = 'transcript_committed'
    `).run(safeReason, now(), id, leaseToken);
    if (result.changes !== 1) throw new Error(`task ${id} changed before it could await provider`);
    this.appendEvent(id, "task.awaiting_provider", {
      reason: safeReason,
      summaryProvider: task.summaryProvider,
      summaryModel: task.summaryModel,
      summaryCredentialSource: task.summaryCredentialSource,
    });
    return this.getTask(id)!;
  }

  recordPhaseSession(
    id: string,
    leaseToken: string,
    phase: "artifact" | "delivery",
    nativeSessionId: string,
  ): void {
    const record = this.db.transaction(() => {
      this.requireLease(id, leaseToken);
      const column = phase === "artifact" ? "artifact_session_id" : "delivery_session_id";
      this.db.prepare(`UPDATE agent_tasks SET native_session_id = ?, ${column} = ?, updated_at = ? WHERE id = ?`)
        .run(nativeSessionId, nativeSessionId, now(), id);
      if (phase === "artifact") {
        const rows = this.db.prepare(
          "SELECT id, provenance_json FROM artifacts WHERE task_id = ?",
        ).all(id) as Array<{ id: string; provenance_json: string }>;
        for (const row of rows) {
          const provenance = JSON.parse(row.provenance_json) as Record<string, unknown>;
          provenance.nativeSessionId = nativeSessionId;
          provenance.artifactSessionId = nativeSessionId;
          this.db.prepare("UPDATE artifacts SET provenance_json = ? WHERE id = ?")
            .run(JSON.stringify(provenance), row.id);
        }
      }
      this.appendEvent(id, "agent.session", { phase, nativeSessionId });
    });
    record();
  }

  recordProgress(id: string, leaseToken: string, phase: AgentTaskPhase, message = ""): AgentTask {
    const task = this.requireLease(id, leaseToken);
    if (!["running", "transcript_committed", "artifacts_committed"].includes(task.state)) {
      throw new Error(`task ${id} cannot report progress from ${task.state}`);
    }
    this.db.prepare("UPDATE agent_tasks SET phase = ?, updated_at = ? WHERE id = ?")
      .run(phase, now(), id);
    this.appendEvent(id, "task.progress", { phase, message: message.slice(0, 1000) });
    return this.getTask(id)!;
  }

  recordArtifacts(id: string, leaseToken: string, artifacts: ArtifactRecord[]): AgentTask {
    const commit = this.db.transaction(() => {
      const task = this.requireLease(id, leaseToken);
      if (!["running", "transcript_committed", "artifacts_committed"].includes(task.state)) {
        throw new Error(`task ${id} cannot commit artifacts from ${task.state}`);
      }
      const kinds = new Set(artifacts.map((artifact) => artifact.kind));
      if (!kinds.has("transcript") || !kinds.has("summary")) {
        throw new Error("summary commit must include the verified transcript and summary records");
      }
      const committedTranscript = this.listArtifacts(id)
        .find((artifact) => artifact.kind === "transcript");
      for (const artifact of artifacts) {
        const preservedTranscript = artifact.kind === "transcript" ? committedTranscript : undefined;
        this.db.prepare(`
          INSERT INTO artifacts (
            id, task_id, recording_stem, kind, path, sha256, bytes,
            mime_type, provenance_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(task_id, kind) DO UPDATE SET
            path = excluded.path, sha256 = excluded.sha256, bytes = excluded.bytes,
            mime_type = excluded.mime_type, provenance_json = excluded.provenance_json,
            created_at = excluded.created_at
        `).run(
          artifact.id,
          id,
          artifact.recordingStem,
          artifact.kind,
          artifact.path,
          artifact.sha256,
          artifact.bytes,
          artifact.mimeType,
          JSON.stringify(preservedTranscript?.provenance ?? artifact.provenance),
          preservedTranscript?.createdAt ?? artifact.createdAt,
        );
      }
      this.db.prepare(`
        UPDATE agent_tasks SET state = 'artifacts_committed', phase = 'committing_artifacts',
          error = NULL,
          audit_json = CASE WHEN summary_provider = 'cliproxyapi' THEN NULL ELSE audit_json END,
          updated_at = ? WHERE id = ?
      `).run(now(), id);
      this.appendEvent(id, "artifacts.committed", {
        artifacts: artifacts.map((artifact) => ({ kind: artifact.kind, sha256: artifact.sha256, bytes: artifact.bytes })),
      });
      return this.getTask(id)!;
    });
    return commit();
  }

  recordTranscript(id: string, leaseToken: string, artifact: ArtifactRecord): AgentTask {
    const commit = this.db.transaction(() => {
      const task = this.requireLease(id, leaseToken);
      if (!["running", "transcript_committed"].includes(task.state)) {
        throw new Error(`task ${id} cannot commit transcript from ${task.state}`);
      }
      if (artifact.kind !== "transcript" || artifact.taskId !== id) {
        throw new Error("transcript artifact does not belong to this task");
      }
      this.db.prepare(`
        INSERT INTO artifacts (
          id, task_id, recording_stem, kind, path, sha256, bytes,
          mime_type, provenance_json, created_at
        ) VALUES (?, ?, ?, 'transcript', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id, kind) DO UPDATE SET
          path = excluded.path, sha256 = excluded.sha256, bytes = excluded.bytes,
          mime_type = excluded.mime_type, provenance_json = excluded.provenance_json,
          created_at = excluded.created_at
      `).run(
        artifact.id, id, artifact.recordingStem, artifact.path, artifact.sha256,
        artifact.bytes, artifact.mimeType, JSON.stringify(artifact.provenance), artifact.createdAt,
      );
      this.db.prepare(`
        UPDATE agent_tasks SET state = 'transcript_committed', phase = 'transcript_committed',
          error = NULL, updated_at = ? WHERE id = ?
      `).run(now(), id);
      this.appendEvent(id, "transcript.committed", { sha256: artifact.sha256, bytes: artifact.bytes });
      return this.getTask(id)!;
    });
    return commit();
  }

  recordSummaryInputSnapshot(id: string, leaseToken: string, artifact: ArtifactRecord): AgentTask {
    const snapshot = this.db.transaction(() => {
      const task = this.requireLease(id, leaseToken);
      if (task.state !== "transcript_committed" || artifact.taskId !== id || artifact.kind !== "transcript") {
        throw new Error(`task ${id} cannot snapshot Summary input before transcript commit`);
      }
      const committed = this.listArtifacts(id).find((record) => record.kind === "transcript");
      if (
        !committed || committed.id !== artifact.id || committed.sha256 !== artifact.sha256 ||
        committed.bytes !== artifact.bytes || committed.path !== artifact.path
      ) {
        throw new Error("Summary input snapshot does not match the committed transcript artifact");
      }
      if (
        task.summaryInputArtifactId &&
        (task.summaryInputArtifactId !== artifact.id ||
          task.summaryInputArtifactSha256 !== artifact.sha256 ||
          task.summaryInputArtifactBytes !== artifact.bytes)
      ) {
        throw new Error("Summary input artifact identity changed after it was snapshotted");
      }
      this.db.prepare(`
        UPDATE agent_tasks SET summary_input_artifact_id = ?, summary_input_artifact_sha256 = ?,
          summary_input_artifact_bytes = ?, updated_at = ?
        WHERE id = ? AND lease_token = ? AND state = 'transcript_committed'
      `).run(artifact.id, artifact.sha256, artifact.bytes, now(), id, leaseToken);
      this.appendEvent(id, "summary.input_snapshotted", {
        artifactId: artifact.id,
        sha256: artifact.sha256,
        bytes: artifact.bytes,
      });
      return this.getTask(id)!;
    });
    return snapshot();
  }

  beginGatewaySummaryExecution(
    id: string,
    leaseToken: string,
    stage: GatewaySummaryExecutionStage,
  ): string {
    const begin = this.db.transaction(() => {
      const task = this.requireLease(id, leaseToken);
      this.requireGatewaySummarySnapshot(task);
      const current = this.gatewaySummaryExecutionJournal(id);
      if (current && (stage === "preflight" || current.stage !== "preflight")) {
        throw new Error(`task ${id} already has a durable CLIProxyAPI ${current.stage} execution intent`);
      }
      const executionId = `gateway-${stage}-${randomUUID()}`;
      const journal: GatewaySummaryExecutionJournal = {
        stage,
        executionId,
        endpoint: task.summaryEndpointIdentity!,
        model: task.summaryModel,
      };
      const result = this.db.prepare(`
        UPDATE agent_tasks SET audit_json = ?, updated_at = ?
        WHERE id = ? AND lease_token = ? AND state = 'transcript_committed'
      `).run(JSON.stringify({ gatewayExecution: journal }), now(), id, leaseToken);
      if (result.changes !== 1) throw new Error(`task ${id} changed before CLIProxyAPI ${stage} dispatch`);
      this.appendEvent(id, stage === "preflight"
        ? "gateway.summary_preflight_intent"
        : "gateway.summary_dispatch_intent", { ...journal });
      return executionId;
    });
    return begin.immediate();
  }

  validateSummaryCommit(
    id: string,
    leaseToken: string,
    input: {
      connectionId: string;
      credentialClass: SummaryCredentialClass;
      disclosureVersion: string;
      inputArtifact: ArtifactRecord;
      runtimeEvidence: SummaryCommitRuntimeEvidence;
      toolCalls: string[];
    },
  ): AgentTask {
    const task = this.requireLease(id, leaseToken);
    if (task.state !== "transcript_committed") {
      throw new Error(`task ${id} cannot authorize a Summary commit from ${task.state}`);
    }
    if (
      !["codex", "claude-code", "cliproxyapi"].includes(task.summaryProvider) ||
      task.summaryConnectionId !== input.connectionId ||
      task.summaryCredentialClass !== input.credentialClass ||
      task.summaryDisclosureVersion !== input.disclosureVersion
    ) {
      throw new Error("Summary task snapshot changed before commit authorization");
    }
    const artifact = this.listArtifacts(id).find((record) => record.kind === "transcript");
    if (
      !artifact || artifact.id !== input.inputArtifact.id || artifact.sha256 !== input.inputArtifact.sha256 ||
      artifact.bytes !== input.inputArtifact.bytes || artifact.path !== input.inputArtifact.path ||
      task.summaryInputArtifactId !== artifact.id || task.summaryInputArtifactSha256 !== artifact.sha256 ||
      task.summaryInputArtifactBytes !== artifact.bytes
    ) {
      throw new Error("Summary input artifact identity changed before commit authorization");
    }
    const evidence = input.runtimeEvidence;
    const providerIdentityMatches = task.summaryProvider === "codex"
      ? evidence.adapter === "codex" && evidence.transport === "codex-app-server-stdio" &&
        evidence.requestedProvider === "openai" && evidence.actualProvider === "openai"
      : task.summaryProvider === "claude-code"
        ? evidence.adapter === "claude-code" && evidence.transport === "claude-code-print-stream-json" &&
          evidence.requestedProvider === null && evidence.actualProvider === null
        : Boolean(task.summaryEndpointIdentity) && Boolean(task.summaryCredentialIdentity) &&
          isExactGatewayRuntimeEvidence(evidence, {
            endpoint: task.summaryEndpointIdentity!,
            model: task.summaryModel,
            terminalStatus: "ready",
          });
    const sessionIdentityValid = task.summaryProvider === "cliproxyapi"
      ? evidence.sessionId === null
      : Boolean(evidence.sessionId);
    if (
      !providerIdentityMatches || !evidence.runtimeVersion.trim() ||
      evidence.requestedModel !== task.summaryModel || evidence.actualModel !== task.summaryModel ||
      !evidence.requestId || !sessionIdentityValid || evidence.terminalStatus !== "ready" ||
      evidence.fallbackOccurred
    ) {
      throw new Error("Supported Agent Summary Runtime Evidence does not match the pinned task identity");
    }
    if (input.toolCalls.length > 0) {
      throw new Error("Supported Agent Summary attempted a tool call or direct side effect");
    }
    return task;
  }

  listArtifacts(taskId: string): ArtifactRecord[] {
    const rows = this.db.prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY kind").all(taskId) as Array<{
      id: string; task_id: string; recording_stem: string; kind: "transcript" | "summary";
      path: string; sha256: string; bytes: number; mime_type: string; provenance_json: string; created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      recordingStem: row.recording_stem,
      kind: row.kind,
      path: row.path,
      sha256: row.sha256,
      bytes: row.bytes,
      mimeType: row.mime_type,
      provenance: JSON.parse(row.provenance_json) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
  }

  getCoreActivationEvidence(): CoreActivationEvidence | null {
    const row = this.db.prepare("SELECT * FROM core_activation_evidence WHERE id = 1").get() as {
      recording_stem: string;
      task_id: string;
      transcription_provider: string;
      summary_provider: string;
      summary_model: string;
      audio_sha256: string;
      audio_bytes: number;
      transcript_sha256: string;
      transcript_bytes: number;
      summary_sha256: string;
      summary_bytes: number;
      completed_at: string;
    } | undefined;
    return row ? {
      recordingStem: row.recording_stem,
      taskId: row.task_id,
      transcriptionProvider: row.transcription_provider,
      summaryProvider: row.summary_provider,
      summaryModel: row.summary_model,
      artifacts: {
        audio: { sha256: row.audio_sha256, bytes: row.audio_bytes },
        transcript: { sha256: row.transcript_sha256, bytes: row.transcript_bytes },
        summary: { sha256: row.summary_sha256, bytes: row.summary_bytes },
      },
      completedAt: row.completed_at,
    } : null;
  }

  getActivationJourneyState(): ActivationJourneyState {
    const row = this.db.prepare(`
      SELECT automatic_entry_acknowledged_at, deferred_at
      FROM activation_journey_state WHERE id = 1
    `).get() as {
      automatic_entry_acknowledged_at: string | null;
      deferred_at: string | null;
    } | undefined;
    return {
      automaticEntryAcknowledgedAt: row?.automatic_entry_acknowledged_at ?? null,
      deferredAt: row?.deferred_at ?? null,
    };
  }

  getActivationAttempt(): ActivationAttempt | null {
    const row = this.db.prepare(`
      SELECT attempt_id, started_at, stop_requested_at, completion_opened_at,
        handoff_error, task_id, recording_stem
      FROM activation_attempt WHERE id = 1
    `).get() as {
      attempt_id: string;
      started_at: string;
      stop_requested_at: string | null;
      completion_opened_at: string | null;
      handoff_error: string | null;
      task_id: string | null;
      recording_stem: string | null;
    } | undefined;
    return row ? {
      id: row.attempt_id,
      startedAt: row.started_at,
      stopRequestedAt: row.stop_requested_at,
      completionOpenedAt: row.completion_opened_at,
      handoffError: row.handoff_error,
      taskId: row.task_id,
      recordingStem: row.recording_stem,
    } : null;
  }

  beginActivationAttempt(): { attempt: ActivationAttempt; created: boolean } {
    const existing = this.getActivationAttempt();
    if (existing) return { attempt: existing, created: false };
    if (this.getCoreActivationEvidence()) throw new Error("Core Activation is already established");
    const result = this.db.prepare(`
      INSERT OR IGNORE INTO activation_attempt (id, attempt_id, started_at)
      VALUES (1, ?, ?)
    `).run(randomUUID(), now());
    return { attempt: this.getActivationAttempt()!, created: result.changes === 1 };
  }

  abandonActivationAttempt(attemptId: string): boolean {
    const result = this.db.prepare(`
      DELETE FROM activation_attempt
      WHERE id = 1 AND attempt_id = ? AND task_id IS NULL
    `).run(attemptId);
    return result.changes === 1;
  }

  restartActivationAttempt(attemptId: string): ActivationAttempt {
    const restart = this.db.transaction(() => {
      const attempt = this.getActivationAttempt();
      if (!attempt || attempt.id !== attemptId) throw new Error("Activation Attempt not found");
      if (attempt.taskId) {
        const task = this.getTask(attempt.taskId);
        if (task && !["failed", "cancelled", "completed"].includes(task.state)) {
          throw new Error("Activation Attempt still owns recoverable work");
        }
      }
      this.db.prepare("DELETE FROM activation_attempt WHERE id = 1 AND attempt_id = ?").run(attemptId);
      this.db.prepare(`
        INSERT INTO activation_attempt (id, attempt_id, started_at)
        VALUES (1, ?, ?)
      `).run(randomUUID(), now());
      return this.getActivationAttempt()!;
    });
    return restart.immediate();
  }

  markActivationAttemptStopping(attemptId: string): ActivationAttempt {
    const result = this.db.prepare(`
      UPDATE activation_attempt SET stop_requested_at = ?
      WHERE id = 1 AND attempt_id = ? AND task_id IS NULL
    `).run(now(), attemptId);
    if (result.changes !== 1) throw new Error("Activation Attempt is not recording");
    return this.getActivationAttempt()!;
  }

  recordActivationAttemptStopped(attemptId: string, recordingStem: string): ActivationAttempt {
    const stem = recordingStem.trim();
    if (!stem || stem.length > 255 || basename(stem) !== stem) {
      throw new Error("Activation recording identity is invalid");
    }
    const result = this.db.prepare(`
      UPDATE activation_attempt SET recording_stem = ?, handoff_error = NULL
      WHERE id = 1 AND attempt_id = ? AND stop_requested_at IS NOT NULL AND task_id IS NULL
    `).run(stem, attemptId);
    if (result.changes !== 1) throw new Error("Activation Attempt is not stopping");
    return this.getActivationAttempt()!;
  }

  failActivationAttemptHandoff(attemptId: string, error: string): ActivationAttempt {
    const detail = error.trim() || "Recording pipeline handoff failed";
    const result = this.db.prepare(`
      UPDATE activation_attempt SET handoff_error = ?
      WHERE id = 1 AND attempt_id = ? AND task_id IS NULL
    `).run(detail, attemptId);
    if (result.changes !== 1) throw new Error("Activation Attempt handoff cannot fail");
    return this.getActivationAttempt()!;
  }

  acknowledgeGuidedCompletion(taskId: string): boolean {
    const result = this.db.prepare(`
      UPDATE activation_attempt SET completion_opened_at = ?
      WHERE id = 1 AND task_id = ? AND completion_opened_at IS NULL
    `).run(now(), taskId);
    return result.changes === 1;
  }

  correlateActivationAttempt(attemptId: string, taskId: string): ActivationAttempt {
    const attempt = this.getActivationAttempt();
    if (!attempt || attempt.id !== attemptId) throw new Error("Activation Attempt not found");
    const task = this.getTask(taskId);
    if (
      !task ||
      task.createdAt < attempt.startedAt ||
      (attempt.recordingStem !== null && attempt.recordingStem !== task.recordingStem)
    ) {
      throw new Error("Activation Attempt task identity is invalid");
    }
    if (attempt.taskId && attempt.taskId !== task.id) {
      throw new Error("Activation Attempt is already correlated to another task");
    }
    this.db.prepare(`
      UPDATE activation_attempt SET task_id = ?, recording_stem = ?
      WHERE id = 1 AND attempt_id = ?
    `).run(task.id, task.recordingStem, attemptId);
    return this.getActivationAttempt()!;
  }

  recoverActivationAttemptTask(attemptId: string): ActivationAttempt {
    const attempt = this.getActivationAttempt();
    if (!attempt || attempt.id !== attemptId) throw new Error("Activation Attempt not found");
    if (attempt.taskId) return attempt;
    if (!attempt.recordingStem) return attempt;
    const rows = this.db.prepare(`
      SELECT * FROM agent_tasks
      WHERE created_at >= ? AND recording_stem = ?
      ORDER BY created_at ASC
      LIMIT 2
    `).all(attempt.stopRequestedAt ?? attempt.startedAt, attempt.recordingStem) as TaskRow[];
    return rows.length === 1
      ? this.correlateActivationAttempt(attempt.id, rows[0]!.id)
      : attempt;
  }

  acknowledgeAutomaticActivationEntry(): {
    acknowledged: boolean;
    state: ActivationJourneyState;
  } {
    const result = this.db.prepare(`
      INSERT INTO activation_journey_state (id, automatic_entry_acknowledged_at)
      SELECT 1, ?
      WHERE NOT EXISTS (SELECT 1 FROM core_activation_evidence WHERE id = 1)
      ON CONFLICT(id) DO UPDATE SET automatic_entry_acknowledged_at = excluded.automatic_entry_acknowledged_at
      WHERE activation_journey_state.automatic_entry_acknowledged_at IS NULL
        AND activation_journey_state.deferred_at IS NULL
    `).run(now());
    return { acknowledged: result.changes === 1, state: this.getActivationJourneyState() };
  }

  deferActivationJourney(): ActivationJourneyState {
    this.db.prepare(`
      INSERT INTO activation_journey_state (id, deferred_at)
      VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE SET deferred_at = excluded.deferred_at
      WHERE activation_journey_state.deferred_at IS NULL
    `).run(now());
    return this.getActivationJourneyState();
  }

  getCloudTranscriptionConsent(): CloudTranscriptionConsent | null {
    const row = this.db.prepare(`
      SELECT disclosure_version, accepted_at
      FROM cloud_transcription_consent WHERE id = 1
    `).get() as { disclosure_version: string; accepted_at: string } | undefined;
    return row ? {
      disclosureVersion: row.disclosure_version,
      acceptedAt: row.accepted_at,
    } : null;
  }

  recordCloudTranscriptionConsent(disclosureVersion: string): CloudTranscriptionConsent {
    const version = disclosureVersion.trim();
    if (!version || version.length > 100) throw new Error("Cloud Transcription Consent version is invalid");
    this.db.prepare(`
      INSERT INTO cloud_transcription_consent (id, disclosure_version, accepted_at)
      VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        disclosure_version = excluded.disclosure_version,
        accepted_at = excluded.accepted_at
    `).run(version, now());
    return this.getCloudTranscriptionConsent()!;
  }

  clearCloudTranscriptionConsent(): void {
    this.db.prepare("DELETE FROM cloud_transcription_consent WHERE id = 1").run();
  }

  getSummaryDataPathDisclosure(provider: string): SummaryDataPathDisclosure | null {
    const normalized = provider.trim().toLowerCase();
    const row = this.db.prepare(`
      SELECT provider, disclosure_version, decision, decided_at
      FROM summary_data_path_disclosures WHERE provider = ?
    `).get(normalized) as {
      provider: string;
      disclosure_version: string;
      decision: "accepted" | "declined";
      decided_at: string;
    } | undefined;
    return row ? {
      provider: row.provider,
      disclosureVersion: row.disclosure_version,
      decision: row.decision,
      decidedAt: row.decided_at,
    } : null;
  }

  recordSummaryDataPathDisclosure(provider: string, disclosureVersion: string): SummaryDataPathDisclosure {
    const identity = summaryDisclosureIdentity(provider, disclosureVersion);
    this.db.prepare(`
      INSERT INTO summary_data_path_disclosures (provider, disclosure_version, decision, decided_at)
      VALUES (?, ?, 'accepted', ?)
      ON CONFLICT(provider) DO UPDATE SET
        disclosure_version = excluded.disclosure_version,
        decision = excluded.decision,
        decided_at = excluded.decided_at
    `).run(identity.provider, identity.disclosureVersion, now());
    return this.getSummaryDataPathDisclosure(identity.provider)!;
  }

  declineSummaryDataPathDisclosure(provider: string, disclosureVersion: string): SummaryDataPathDisclosure {
    const identity = summaryDisclosureIdentity(provider, disclosureVersion);
    this.db.prepare(`
      INSERT INTO summary_data_path_disclosures (provider, disclosure_version, decision, decided_at)
      VALUES (?, ?, 'declined', ?)
      ON CONFLICT(provider) DO UPDATE SET
        disclosure_version = excluded.disclosure_version,
        decision = excluded.decision,
        decided_at = excluded.decided_at
    `).run(identity.provider, identity.disclosureVersion, now());
    return this.getSummaryDataPathDisclosure(identity.provider)!;
  }

  clearSummaryDataPathDisclosure(provider: string): void {
    this.db.prepare("DELETE FROM summary_data_path_disclosures WHERE provider = ?")
      .run(provider.trim().toLowerCase());
  }

  recordCoreActivationEvidence(evidence: CoreActivationEvidence): CoreActivationEvidence {
    const fingerprints = Object.values(evidence.artifacts);
    if (
      !evidence.recordingStem.trim() || !evidence.taskId.trim() ||
      !evidence.transcriptionProvider.trim() || !evidence.summaryProvider.trim() ||
      !evidence.summaryModel.trim() || !Number.isFinite(Date.parse(evidence.completedAt)) ||
      fingerprints.some((item) => !/^[a-f0-9]{64}$/i.test(item.sha256) || item.bytes <= 0)
    ) {
      throw new Error("Core Activation Evidence is incomplete");
    }
    this.db.prepare(`
      INSERT OR IGNORE INTO core_activation_evidence (
        id, recording_stem, task_id, transcription_provider, summary_provider, summary_model,
        audio_sha256, audio_bytes, transcript_sha256, transcript_bytes,
        summary_sha256, summary_bytes, completed_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      evidence.recordingStem,
      evidence.taskId,
      evidence.transcriptionProvider,
      evidence.summaryProvider,
      evidence.summaryModel,
      evidence.artifacts.audio.sha256,
      evidence.artifacts.audio.bytes,
      evidence.artifacts.transcript.sha256,
      evidence.artifacts.transcript.bytes,
      evidence.artifacts.summary.sha256,
      evidence.artifacts.summary.bytes,
      evidence.completedAt,
    );
    return this.getCoreActivationEvidence()!;
  }

  listCoreActivationCandidates(limit = 50): CoreActivationCandidate[] {
    const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 100));
    const rows = this.db.prepare(`
      SELECT * FROM agent_tasks
      ORDER BY updated_at DESC, created_at DESC
      LIMIT ?
    `).all(boundedLimit) as Array<TaskRow & { audit_json: string | null }>;
    return rows.map((row) => this.coreActivationCandidate(row));
  }

  getCoreActivationCandidate(taskId: string): CoreActivationCandidate | null {
    const row = this.db.prepare("SELECT * FROM agent_tasks WHERE id = ?").get(taskId) as
      (TaskRow & { audit_json: string | null }) | undefined;
    return row ? this.coreActivationCandidate(row) : null;
  }

  private coreActivationCandidate(row: TaskRow & { audit_json: string | null }): CoreActivationCandidate {
    let transcriptionProvider: string | null = null;
    try {
      const audit = JSON.parse(row.audit_json ?? "null") as Record<string, unknown> | null;
      if (typeof audit?.transcriptionProvider === "string") {
        transcriptionProvider = audit.transcriptionProvider;
      }
    } catch { /* malformed legacy audit cannot establish activation */ }
    if (!transcriptionProvider) {
      const progress = this.listEvents(row.id).reverse().find((event) => {
        const message = event.payload.message;
        return event.type === "task.progress" &&
          typeof message === "string" &&
          message.startsWith("Transcription provider:");
      });
      const message = progress?.payload.message;
      if (typeof message === "string") {
        transcriptionProvider = message.slice("Transcription provider:".length).trim() || null;
      }
    }
    return {
      task: toTask(row),
      artifacts: this.listArtifacts(row.id),
      transcriptionProvider,
    };
  }

  beginNotionDelivery(id: string, leaseToken: string): NotionDelivery {
    const begin = this.db.transaction(() => {
      const task = this.requireLease(id, leaseToken);
      if (!task.sendToNotion) throw new Error("Notion delivery was not authorized for this task");
      if (this.listArtifacts(id).length < 2) throw new Error("artifacts must be committed before Notion delivery");
      if (task.state === "sending") {
        const existing = this.getNotionDelivery(id);
        if (!existing || existing.status !== "sending") {
          throw new Error(`task ${id} has an inconsistent Notion delivery fence`);
        }
        return existing;
      }
      if (task.state !== "artifacts_committed") {
        throw new Error(`task ${id} cannot begin Notion delivery from ${task.state}`);
      }
      const timestamp = now();
      const delivery: NotionDelivery = {
        taskId: id,
        deliveryKey: `yulu-${id}`,
        status: "sending",
        destination: task.destinationHint,
        url: null,
        pageId: null,
        detail: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.db.prepare(`
        INSERT INTO notion_deliveries (
          task_id, delivery_key, status, destination, created_at, updated_at
        ) VALUES (?, ?, 'sending', ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET status = 'sending',
          destination = excluded.destination, updated_at = excluded.updated_at
      `).run(id, delivery.deliveryKey, delivery.destination, timestamp, timestamp);
      this.db.prepare("UPDATE agent_tasks SET state = 'sending', phase = 'sending_notion', updated_at = ? WHERE id = ?")
        .run(timestamp, id);
      this.appendEvent(id, "notion.delivery_started", { deliveryKey: delivery.deliveryKey, destination: delivery.destination });
      return this.getNotionDelivery(id)!;
    });
    return begin();
  }

  recordNotionDelivery(id: string, leaseToken: string, result: {
    url?: string;
    pageId?: string;
    detail?: string;
  }): NotionDelivery {
    const url = result.url?.trim() ?? "";
    const pageId = result.pageId?.trim() ?? "";
    if (!url && !pageId) {
      throw new Error("Notion delivery must include a page URL or page ID");
    }
    if (url && !isTrustedNotionUrl(url)) {
      throw new Error("Notion delivery URL must use HTTPS on an approved Notion host");
    }
    if (pageId && !isValidNotionPageId(pageId)) {
      throw new Error("Notion delivery page ID must be a 32-character hex ID or UUID");
    }
    const identityProblem = notionPageIdentityProblem(url, pageId);
    if (identityProblem) throw new Error(identityProblem);
    const report = this.db.transaction(() => {
      const task = this.requireLease(id, leaseToken);
      if (task.state !== "sending") throw new Error(`task ${id} is not sending to Notion`);
      const timestamp = now();
      this.db.prepare(`
        UPDATE notion_deliveries
        SET status = 'reported', url = ?, page_id = ?, detail = ?, updated_at = ?
        WHERE task_id = ?
      `).run(
        url.slice(0, 2000) || null,
        pageId || null,
        result.detail?.slice(0, 2000) || null,
        timestamp,
        id,
      );
      this.db.prepare("UPDATE agent_tasks SET state = 'delivery_reported', updated_at = ? WHERE id = ?")
        .run(timestamp, id);
      const delivery = this.getNotionDelivery(id)!;
      this.appendEvent(id, "notion.delivery_reported", { ...delivery });
      return delivery;
    });
    return report();
  }

  getNotionDelivery(taskId: string): NotionDelivery | null {
    const row = this.db.prepare("SELECT * FROM notion_deliveries WHERE task_id = ?").get(taskId) as {
      task_id: string; delivery_key: string; status: "sending" | "reported" | "abandoned"; destination: string;
      url: string | null; page_id: string | null; detail: string | null; created_at: string; updated_at: string;
    } | undefined;
    return row ? {
      taskId: row.task_id,
      deliveryKey: row.delivery_key,
      status: row.status,
      destination: row.destination,
      url: row.url,
      pageId: row.page_id,
      detail: row.detail,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    } : null;
  }

  listEvents(taskId: string): AgentTaskEvent[] {
    const rows = this.db.prepare(
      "SELECT id, task_id, type, payload_json, created_at FROM agent_task_events WHERE task_id = ? ORDER BY created_at, rowid",
    ).all(taskId) as Array<{
      id: string;
      task_id: string;
      type: string;
      payload_json: string;
      created_at: string;
    }>;
    return rows.map((row) => {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      // Early Host builds persisted the lease in claim events. Never expose it
      // through diagnostic APIs, even for those existing rows.
      delete payload.lease;
      return {
        id: row.id,
        taskId: row.task_id,
        type: row.type,
        payload,
        createdAt: row.created_at,
      };
    });
  }

  complete(id: string, leaseToken: string, audit: Record<string, unknown>): AgentTask {
    const task = this.requireLease(id, leaseToken);
    const expectedState = task.sendToNotion ? "delivery_reported" : "artifacts_committed";
    if (task.state !== expectedState) {
      throw new Error(`task ${id} cannot complete from ${task.state}; expected ${expectedState}`);
    }
    this.db.prepare(`
      UPDATE agent_tasks SET state = 'completed', phase = 'completed', lease_token = NULL,
        error = NULL, audit_json = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(audit), now(), id);
    this.appendEvent(id, "task.completed", audit);
    return this.getTask(id)!;
  }

  confirmNotionDelivery(id: string, result: {
    url?: string;
    pageId?: string;
    detail?: string;
  } = {}): AgentTask {
    const reconcile = this.db.transaction(() => {
      const task = this.getTask(id);
      if (!task) throw new Error(`task not found: ${id}`);
      if (task.state !== "delivery_unverified") {
        throw new Error(`task ${id} cannot reconcile Notion delivery from ${task.state}`);
      }
      const delivery = this.getNotionDelivery(id);
      if (!delivery) throw new Error(`task ${id} has no Notion delivery to reconcile`);
      const url = result.url?.trim() || delivery.url || "";
      const pageId = result.pageId?.trim() || delivery.pageId || "";
      if (!url && !pageId) {
        throw new Error("confirming Notion delivery requires a page URL or page ID");
      }
      if (url && !isTrustedNotionUrl(url)) {
        throw new Error("Notion delivery URL must use HTTPS on an approved Notion host");
      }
      if (pageId && !isValidNotionPageId(pageId)) {
        throw new Error("Notion delivery page ID must be a 32-character hex ID or UUID");
      }
      const identityProblem = notionPageIdentityProblem(url, pageId);
      if (identityProblem) throw new Error(identityProblem);
      const timestamp = now();
      this.db.prepare(`
        UPDATE notion_deliveries SET status = 'reported', url = ?, page_id = ?, detail = ?, updated_at = ?
        WHERE task_id = ?
      `).run(
        url || null,
        pageId || null,
        result.detail?.trim().slice(0, 2000) || delivery.detail,
        timestamp,
        id,
      );
      const audit = {
        reconciledBy: "user",
        outcome: "confirmed_existing_notion_page",
        deliveryKey: delivery.deliveryKey,
        url: url || null,
        pageId: pageId || null,
      };
      this.db.prepare(`
        UPDATE agent_tasks SET state = 'completed', phase = 'completed', lease_token = NULL,
          error = NULL, audit_json = ?, updated_at = ? WHERE id = ? AND state = 'delivery_unverified'
      `).run(JSON.stringify(audit), timestamp, id);
      this.appendEvent(id, "notion.delivery_reconciled", audit);
      return this.getTask(id)!;
    });
    return reconcile();
  }

  abandonNotionDelivery(id: string, detail = ""): AgentTask {
    const abandon = this.db.transaction(() => {
      const task = this.getTask(id);
      if (!task) throw new Error(`task not found: ${id}`);
      if (task.state !== "delivery_unverified") {
        throw new Error(`task ${id} cannot abandon Notion delivery from ${task.state}`);
      }
      const delivery = this.getNotionDelivery(id);
      if (!delivery) throw new Error(`task ${id} has no Notion delivery to abandon`);
      const timestamp = now();
      const reason = detail.trim().slice(0, 2000) || "Unverified Notion delivery abandoned by user";
      this.db.prepare(`
        UPDATE notion_deliveries SET status = 'abandoned', detail = ?, updated_at = ? WHERE task_id = ?
      `).run(reason, timestamp, id);
      this.db.prepare(`
        UPDATE agent_tasks SET state = 'cancelled', phase = 'failed', lease_token = NULL,
          error = ?, audit_json = NULL, updated_at = ?
        WHERE id = ? AND state = 'delivery_unverified'
      `).run(reason, timestamp, id);
      this.appendEvent(id, "notion.delivery_abandoned", {
        outcome: "abandoned",
        deliveryKey: delivery.deliveryKey,
        detail: reason,
      });
      return this.getTask(id)!;
    });
    return abandon();
  }

  fail(id: string, leaseToken: string | null, error: string): AgentTask {
    const task = this.getTask(id);
    if (!task) throw new Error(`task not found: ${id}`);
    if (leaseToken && task.leaseToken !== leaseToken) throw new Error(`stale lease for task ${id}`);
    if (["completed", "cancelled", "delivery_unverified", "execution_unverified"].includes(task.state)) return task;
    const state: AgentTaskState = ["sending", "delivery_reported"].includes(task.state)
      ? "delivery_unverified"
      : "failed";
    this.db.prepare(`
      UPDATE agent_tasks SET state = ?, phase = 'failed', lease_token = NULL,
        error = ?, updated_at = ? WHERE id = ?
    `).run(state, error.slice(0, 4000), now(), id);
    this.appendEvent(id, state === "delivery_unverified" ? "notion.delivery_unverified" : "task.failed", { error });
    return this.getTask(id)!;
  }

  markClaudeSummaryUnknownOutcome(
    id: string,
    leaseToken: string,
    error: string,
    nativeSessionId: string,
    evidence: SummaryCommitRuntimeEvidence,
  ): AgentTask {
    const task = this.requireLease(id, leaseToken);
    if (task.state !== "transcript_committed") {
      throw new Error(`task ${id} cannot enter Unknown Outcome from ${task.state}`);
    }
    const artifact = this.listArtifacts(id).find((record) => record.kind === "transcript");
    if (
      !artifact || task.summaryInputArtifactId !== artifact.id ||
      task.summaryInputArtifactSha256 !== artifact.sha256 || task.summaryInputArtifactBytes !== artifact.bytes
    ) {
      throw new Error("Summary input artifact identity changed before Unknown Outcome persistence");
    }
    const providerIdentityMatches = task.summaryProvider === "claude-code" &&
      evidence.adapter === "claude-code" && evidence.transport === "claude-code-print-stream-json" &&
      evidence.requestedProvider === null && evidence.actualProvider === null;
    if (
      !providerIdentityMatches || !evidence.runtimeVersion.trim() ||
      evidence.requestedModel !== task.summaryModel || evidence.actualModel !== task.summaryModel ||
      evidence.sessionId !== nativeSessionId ||
      evidence.terminalStatus !== "unknown" || evidence.fallbackOccurred
    ) {
      throw new Error("Claude Code Unknown Outcome evidence does not match the pinned Summary task identity");
    }
    this.db.prepare(`
      UPDATE agent_tasks SET state = 'execution_unverified', phase = 'failed', lease_token = NULL,
        native_session_id = ?, artifact_session_id = ?, error = ?, audit_json = ?, updated_at = ? WHERE id = ?
    `).run(nativeSessionId, nativeSessionId, error.slice(0, 4000), JSON.stringify({ runtimeEvidence: evidence }), now(), id);
    this.appendEvent(id, "claude.summary_unknown_outcome", { error, nativeSessionId, runtimeEvidence: evidence });
    return this.getTask(id)!;
  }

  markGatewaySummaryUnknownOutcome(
    id: string,
    leaseToken: string,
    error: string,
    executionId: string,
    evidence: SummaryCommitRuntimeEvidence,
  ): AgentTask {
    const task = this.requireLease(id, leaseToken);
    if (task.state !== "transcript_committed") {
      throw new Error(`task ${id} cannot enter Unknown Outcome from ${task.state}`);
    }
    this.requireGatewaySummarySnapshot(task);
    const evidenceMatches = task.summaryProvider === "cliproxyapi" &&
      task.summaryCredentialClass === "api-key" && Boolean(task.summaryCredentialIdentity) &&
      Boolean(task.summaryEndpointIdentity) && isExactGatewayRuntimeEvidence(evidence, {
        endpoint: task.summaryEndpointIdentity!,
        model: task.summaryModel,
        terminalStatus: "unknown",
      });
    const journal = this.gatewaySummaryExecutionJournal(id);
    const journalMatches = journal?.stage === "summary" &&
      journal.endpoint === task.summaryEndpointIdentity && journal.model === task.summaryModel;
    const suppliedExecutionId = executionId.trim();
    const safeExecutionId = journalMatches
      ? journal.executionId
      : /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(suppliedExecutionId)
        ? suppliedExecutionId
        : `gateway-summary-${randomUUID()}`;
    const safeEvidence: SummaryCommitRuntimeEvidence = evidenceMatches ? evidence : {
      adapter: "cliproxyapi",
      transport: task.summaryEndpointIdentity!.startsWith("https:")
        ? "openai-responses-approved-https"
        : "openai-responses-loopback-http",
      runtimeVersion: CLIPROXYAPI_CONTRACT_VERSION,
      endpoint: task.summaryEndpointIdentity,
      requestedProvider: null,
      requestedModel: task.summaryModel,
      actualProvider: null,
      actualModel: null,
      requestId: null,
      sessionId: null,
      terminalStatus: "unknown",
      fallbackOccurred: false,
      toolsEnabled: false,
    };
    const safeError = "CLIProxyAPI Gateway Summary entered Unknown Outcome; do not retry this execution";
    const audit = {
      gatewayExecution: {
        stage: "summary",
        executionId: safeExecutionId,
        endpoint: task.summaryEndpointIdentity,
        model: task.summaryModel,
        outcome: "unknown",
      },
      runtimeEvidence: safeEvidence,
      evidenceValidated: evidenceMatches,
    };
    this.db.prepare(`
      UPDATE agent_tasks SET state = 'execution_unverified', phase = 'failed', lease_token = NULL,
        native_session_id = ?, artifact_session_id = ?, error = ?, audit_json = ?, updated_at = ? WHERE id = ?
    `).run(safeExecutionId, safeExecutionId, safeError, JSON.stringify(audit), now(), id);
    this.appendEvent(id, "gateway.summary_unknown_outcome", {
      error: safeError,
      executionId: safeExecutionId,
      runtimeEvidence: safeEvidence,
      evidenceValidated: evidenceMatches,
    });
    return this.getTask(id)!;
  }

  retry(
    id: string,
    options: { allowCancelled?: boolean; allowCompleted?: boolean; discardArtifacts?: boolean } = {},
  ): AgentTask {
    const retry = this.db.transaction(() => {
      const task = this.getTask(id);
      if (!task) throw new Error(`task not found: ${id}`);
      const retryable = ["failed", "awaiting_agent", "awaiting_provider"];
      if (options.allowCancelled) retryable.push("cancelled");
      if (options.allowCompleted) retryable.push("completed");
      if (!retryable.includes(task.state)) {
        throw new Error(`task ${id} cannot retry from ${task.state}`);
      }
      const competing = this.competingActiveTask(task.recordingStem, id);
      if (competing) {
        throw new Error(`recording ${task.recordingStem} already has active Agent task ${competing.id}`);
      }
      if (options.discardArtifacts) {
        this.db.prepare("DELETE FROM artifacts WHERE task_id = ?").run(id);
        this.db.prepare(`
          UPDATE agent_tasks SET summary_input_artifact_id = NULL,
            summary_input_artifact_sha256 = NULL, summary_input_artifact_bytes = NULL
          WHERE id = ?
        `).run(id);
      }
      this.db.prepare(`
        UPDATE agent_tasks SET
          state = CASE
            WHEN EXISTS (SELECT 1 FROM artifacts WHERE task_id = agent_tasks.id AND kind = 'transcript')
              THEN 'transcript_committed'
            ELSE 'queued'
          END,
          phase = CASE
            WHEN EXISTS (SELECT 1 FROM artifacts WHERE task_id = agent_tasks.id AND kind = 'transcript')
              THEN 'summarizing'
            ELSE 'queued'
          END,
          lease_token = NULL,
          native_session_id = NULL, artifact_session_id = NULL, delivery_session_id = NULL,
          attempt = 0, error = NULL, audit_json = NULL, updated_at = ? WHERE id = ?
      `).run(now(), id);
      this.appendEvent(id, "task.retried", {});
      return this.getTask(id)!;
    });
    return retry.immediate();
  }

  replaceSummaryAttempt(
    id: string,
    selection: {
      summaryProvider: string;
      summaryModel: string;
      summaryCredentialSource?: XaiCredentialSource | null;
      summaryConnectionId?: string | null;
      summaryCredentialClass?: SummaryCredentialClass | null;
      summaryCredentialIdentity?: string | null;
      summaryDisclosureVersion?: string | null;
      summaryEndpointIdentity?: string | null;
    },
  ): AgentTask {
    const replace = this.db.transaction(() => {
      const original = this.getTask(id);
      if (!original) throw new Error(`task not found: ${id}`);
      if (!["failed", "awaiting_provider"].includes(original.state)) {
        throw new Error(`task ${id} cannot replace its Summary Provider from ${original.state}`);
      }
      const summaryProvider = selection.summaryProvider.trim().toLowerCase();
      const summaryModel = selection.summaryModel.trim();
      const summaryCredentialSource = selection.summaryCredentialSource ?? null;
      const summaryConnectionId = selection.summaryConnectionId ?? null;
      const summaryCredentialClass = selection.summaryCredentialClass ?? summaryCredentialSource;
      const summaryCredentialIdentity = selection.summaryCredentialIdentity ?? null;
      const summaryDisclosureVersion = selection.summaryDisclosureVersion ?? null;
      const summaryEndpointIdentity = selection.summaryEndpointIdentity ?? null;
      if (!summaryProvider || summaryProvider.length > 100 || !summaryModel || summaryModel.length > 128) {
        throw new Error("replacement Summary Provider identity is invalid");
      }
      if (summaryProvider === "xai" && !summaryCredentialSource) {
        throw new Error("replacement xAI Summary Provider credential source is required");
      }
      if (
          summaryProvider === original.summaryProvider &&
          summaryModel === original.summaryModel &&
          summaryCredentialSource === original.summaryCredentialSource &&
          summaryConnectionId === original.summaryConnectionId &&
          summaryCredentialClass === original.summaryCredentialClass &&
          summaryCredentialIdentity === original.summaryCredentialIdentity &&
          summaryDisclosureVersion === original.summaryDisclosureVersion &&
          summaryEndpointIdentity === original.summaryEndpointIdentity
      ) {
        throw new Error("replacement Summary Provider must differ from the original task snapshot");
      }
      const transcript = this.listArtifacts(id).find((artifact) => artifact.kind === "transcript");
      if (!transcript) throw new Error(`task ${id} has no committed transcript to reuse`);
      const competing = this.competingActiveTask(original.recordingStem, id);
      if (competing) {
        throw new Error(`recording ${original.recordingStem} already has active Agent task ${competing.id}`);
      }

      const replacementId = randomUUID();
      const replacementTranscriptId = randomUUID();
      const timestamp = now();
      if (original.state === "awaiting_provider") {
        this.db.prepare(`
          UPDATE agent_tasks SET state = 'cancelled', phase = 'failed', lease_token = NULL,
            error = 'Superseded by an explicit Summary Provider change', updated_at = ?
          WHERE id = ? AND state = 'awaiting_provider'
        `).run(timestamp, id);
      }
      this.db.prepare(`
        INSERT INTO agent_tasks (
          id, idempotency_key, recording_stem, title, audio_path, transcription_language, trigger,
          state, phase, send_to_notion, destination_hint, agent_provider,
          summary_provider, summary_model, summary_credential_source,
          summary_connection_id, summary_credential_class, summary_credential_identity,
          summary_disclosure_version, summary_endpoint_identity,
          summary_input_artifact_id, summary_input_artifact_sha256, summary_input_artifact_bytes,
          instructions, attempt, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'manual', 'transcript_committed', 'summarizing', 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        replacementId,
        `summary-regeneration:${randomUUID()}`,
        original.recordingStem,
        original.title,
        original.audioPath,
        original.transcriptionLanguage,
        original.destinationHint,
        summaryProvider,
        summaryProvider,
        summaryModel,
        summaryCredentialSource,
        summaryConnectionId,
        summaryCredentialClass,
        summaryCredentialIdentity,
        summaryDisclosureVersion,
        summaryEndpointIdentity,
        replacementTranscriptId,
        transcript.sha256,
        transcript.bytes,
        original.instructions,
        timestamp,
        timestamp,
      );
      this.db.prepare(`
        INSERT INTO artifacts (
          id, task_id, recording_stem, kind, path, sha256, bytes,
          mime_type, provenance_json, created_at
        ) VALUES (?, ?, ?, 'transcript', ?, ?, ?, ?, ?, ?)
      `).run(
        replacementTranscriptId,
        replacementId,
        original.recordingStem,
        transcript.path,
        transcript.sha256,
        transcript.bytes,
        transcript.mimeType,
        JSON.stringify({ ...transcript.provenance, reusedFromTaskId: original.id }),
        timestamp,
      );
      this.db.prepare(`
        UPDATE activation_attempt SET task_id = ?
        WHERE id = 1 AND task_id = ? AND recording_stem = ?
      `).run(replacementId, original.id, original.recordingStem);
      this.appendEvent(id, "task.superseded", {
        replacementTaskId: replacementId,
        summaryProvider,
        summaryModel,
        summaryCredentialSource,
        summaryConnectionId,
        summaryCredentialClass,
        summaryCredentialIdentity,
        summaryDisclosureVersion,
        summaryEndpointIdentity,
      });
      this.appendEvent(replacementId, "task.queued", {
        trigger: "manual",
        summaryProvider,
        summaryModel,
        summaryCredentialSource,
        summaryConnectionId,
        summaryCredentialClass,
        summaryCredentialIdentity,
        summaryDisclosureVersion,
        summaryEndpointIdentity,
        reusedTranscriptFromTaskId: original.id,
      });
      return this.getTask(replacementId)!;
    });
    return replace.immediate();
  }

  private competingActiveTask(recordingStem: string, excludingId: string): AgentTask | null {
    const row = this.db.prepare(`
      SELECT * FROM agent_tasks
      WHERE recording_stem = ? AND id != ?
        AND state IN ('queued', 'awaiting_agent', 'awaiting_provider', 'awaiting_policy', 'running',
                      'transcript_committed', 'artifacts_committed', 'sending', 'delivery_reported', 'delivery_unverified',
                      'execution_unverified')
      ORDER BY updated_at DESC, created_at DESC LIMIT 1
    `).get(recordingStem, excludingId) as TaskRow | undefined;
    return row ? toTask(row) : null;
  }

  private requireLease(id: string, leaseToken: string): AgentTask {
    const task = this.getTask(id);
    if (!task) throw new Error(`task not found: ${id}`);
    if (!task.leaseToken || task.leaseToken !== leaseToken) throw new Error(`stale lease for task ${id}`);
    return task;
  }

  private appendEvent(taskId: string, type: string, payload: Record<string, unknown>): void {
    this.db.prepare(`
      INSERT INTO agent_task_events (id, task_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(randomUUID(), taskId, type, JSON.stringify(payload), now());
  }

  private gatewaySummaryExecutionJournal(id: string): GatewaySummaryExecutionJournal | null {
    const row = this.db.prepare("SELECT audit_json FROM agent_tasks WHERE id = ?")
      .get(id) as { audit_json: string | null } | undefined;
    return gatewaySummaryExecutionJournal(row?.audit_json ?? null);
  }

  private requireGatewaySummarySnapshot(task: AgentTask): ArtifactRecord {
    if (
      task.state !== "transcript_committed" || task.summaryProvider !== "cliproxyapi" ||
      task.summaryCredentialClass !== "api-key" || !task.summaryCredentialIdentity ||
      !task.summaryEndpointIdentity
    ) {
      throw new Error(`task ${task.id} does not have a pinned CLIProxyAPI Summary execution identity`);
    }
    const artifact = this.listArtifacts(task.id).find((record) => record.kind === "transcript");
    if (
      !artifact || task.summaryInputArtifactId !== artifact.id ||
      task.summaryInputArtifactSha256 !== artifact.sha256 || task.summaryInputArtifactBytes !== artifact.bytes
    ) {
      throw new Error("Summary input artifact identity changed before CLIProxyAPI execution");
    }
    return artifact;
  }

  private recoverInterrupted(): void {
    const recover = this.db.transaction(() => {
      const timestamp = now();
      const committedGatewayRows = this.db.prepare(`
        SELECT id, send_to_notion FROM agent_tasks
        WHERE summary_provider = 'cliproxyapi' AND state = 'artifacts_committed'
          AND EXISTS (SELECT 1 FROM artifacts
            WHERE artifacts.task_id = agent_tasks.id AND artifacts.kind = 'summary')
      `).all() as Array<{ id: string; send_to_notion: number }>;
      for (const row of committedGatewayRows) {
        const completed = row.send_to_notion !== 1;
        this.db.prepare(`
          UPDATE agent_tasks SET state = ?, phase = ?, lease_token = NULL,
            error = NULL, audit_json = ?, updated_at = ? WHERE id = ?
        `).run(
          completed ? "completed" : "artifacts_committed",
          completed ? "completed" : "committing_artifacts",
          completed ? JSON.stringify({ recoveredAfterArtifactCommit: true }) : null,
          timestamp,
          row.id,
        );
        this.appendEvent(row.id, completed ? "task.completed" : "gateway.summary_artifacts_recovered", {
          recoveredAfterArtifactCommit: true,
          summaryReplayPrevented: true,
        });
      }
      const gatewayRows = this.db.prepare(`
        SELECT id, state, summary_endpoint_identity, summary_model, audit_json
        FROM agent_tasks
        WHERE summary_provider = 'cliproxyapi'
          AND state = 'transcript_committed'
      `).all() as Array<{
        id: string;
        state: "transcript_committed" | "artifacts_committed";
        summary_endpoint_identity: string | null;
        summary_model: string;
        audit_json: string | null;
      }>;
      for (const row of gatewayRows) {
        const journal = gatewaySummaryExecutionJournal(row.audit_json);
        if (!journal || journal.endpoint !== row.summary_endpoint_identity || journal.model !== row.summary_model) {
          continue;
        }
        const summaryDispatched = journal.stage === "summary";
        const error = summaryDispatched
          ? "Host restarted after CLIProxyAPI Summary dispatch; outcome is unknown"
          : "Host restarted during CLIProxyAPI Summary preflight; no transcript was sent. Verify Gateway state before an authenticated retry";
        this.db.prepare(`
          UPDATE agent_tasks SET state = ?, phase = 'failed', lease_token = NULL,
            native_session_id = ?, artifact_session_id = ?, delivery_session_id = NULL,
            error = ?, audit_json = ?, updated_at = ? WHERE id = ?
        `).run(
          summaryDispatched ? "execution_unverified" : "failed",
          summaryDispatched ? journal.executionId : null,
          summaryDispatched ? journal.executionId : null,
          error,
          JSON.stringify({ gatewayExecution: { ...journal, recoveredAfterRestart: true } }),
          timestamp,
          row.id,
        );
        this.appendEvent(row.id, summaryDispatched
          ? "gateway.summary_unknown_outcome"
          : "gateway.summary_preflight_interrupted", {
          error,
          executionId: journal.executionId,
          stage: journal.stage,
          recoveredAfterRestart: true,
          previousState: row.state,
        });
      }
      this.db.prepare(`
        UPDATE agent_tasks SET state = 'transcript_committed', phase = 'summarizing', lease_token = NULL,
          native_session_id = NULL, artifact_session_id = NULL, delivery_session_id = NULL,
          error = 'Host restarted after transcript commit', audit_json = NULL, updated_at = ?
        WHERE state IN ('running', 'transcript_committed', 'artifacts_committed')
          AND EXISTS (SELECT 1 FROM artifacts WHERE artifacts.task_id = agent_tasks.id AND kind = 'transcript')
          AND NOT (state = 'artifacts_committed' AND summary_provider = 'cliproxyapi'
            AND EXISTS (SELECT 1 FROM artifacts summary_artifact
              WHERE summary_artifact.task_id = agent_tasks.id AND summary_artifact.kind = 'summary'))
      `).run(timestamp);
      this.db.prepare(`
        UPDATE agent_tasks SET state = 'queued', phase = 'queued', lease_token = NULL,
          native_session_id = NULL, artifact_session_id = NULL, delivery_session_id = NULL,
          error = 'Host restarted before Agent task completed', audit_json = NULL,
          updated_at = ?
        WHERE state IN ('running', 'artifacts_committed')
          AND NOT (state = 'artifacts_committed' AND summary_provider = 'cliproxyapi'
            AND EXISTS (SELECT 1 FROM artifacts summary_artifact
              WHERE summary_artifact.task_id = agent_tasks.id AND summary_artifact.kind = 'summary'))
      `).run(timestamp);
      const uncertain = this.db.prepare(`
        SELECT id, state FROM agent_tasks WHERE state IN ('sending', 'delivery_reported')
      `).all() as Array<{ id: string; state: "sending" | "delivery_reported" }>;
      this.db.prepare(`
        UPDATE agent_tasks SET state = 'delivery_unverified', phase = 'failed', lease_token = NULL,
          native_session_id = NULL, artifact_session_id = NULL, delivery_session_id = NULL,
          error = 'Host restarted before the Notion delivery session audit completed', audit_json = NULL, updated_at = ?
        WHERE state IN ('sending', 'delivery_reported')
      `).run(timestamp);
      for (const task of uncertain) {
        this.appendEvent(task.id, "notion.delivery_unverified", {
          error: "Host restarted before the Notion delivery session audit completed",
          previousState: task.state,
        });
      }
    });
    recover.immediate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        recording_stem TEXT NOT NULL,
        title TEXT NOT NULL,
        audio_path TEXT NOT NULL,
        transcription_language TEXT NOT NULL DEFAULT 'zh',
        trigger TEXT NOT NULL DEFAULT 'automatic' CHECK(trigger IN ('automatic', 'manual')),
        state TEXT NOT NULL,
        phase TEXT NOT NULL,
        send_to_notion INTEGER NOT NULL DEFAULT 0,
        destination_hint TEXT NOT NULL DEFAULT '',
        agent_provider TEXT NOT NULL DEFAULT 'hermes',
        summary_provider TEXT NOT NULL,
        summary_model TEXT NOT NULL,
        summary_credential_source TEXT CHECK(summary_credential_source IN ('oauth', 'api-key')),
        summary_connection_id TEXT,
        summary_credential_class TEXT CHECK(summary_credential_class IN ('oauth', 'api-key', 'runtime-oauth')),
        summary_credential_identity TEXT,
        summary_disclosure_version TEXT,
        summary_endpoint_identity TEXT,
        summary_input_artifact_id TEXT,
        summary_input_artifact_sha256 TEXT,
        summary_input_artifact_bytes INTEGER,
        instructions TEXT NOT NULL DEFAULT '',
        native_session_id TEXT,
        artifact_session_id TEXT,
        delivery_session_id TEXT,
        lease_token TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        audit_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_dispatch
        ON agent_tasks(state, created_at);
      CREATE INDEX IF NOT EXISTS idx_agent_tasks_recording
        ON agent_tasks(recording_stem, created_at DESC);

      CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
        recording_stem TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('transcript', 'summary')),
        path TEXT NOT NULL,
        sha256 TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        mime_type TEXT NOT NULL,
        provenance_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(task_id, kind)
      );

      CREATE TABLE IF NOT EXISTS notion_deliveries (
        task_id TEXT PRIMARY KEY REFERENCES agent_tasks(id) ON DELETE CASCADE,
        delivery_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL,
        destination TEXT NOT NULL,
        url TEXT,
        page_id TEXT,
        detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_task_events_task
        ON agent_task_events(task_id, created_at);

      CREATE TABLE IF NOT EXISTS core_activation_evidence (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        recording_stem TEXT NOT NULL,
        task_id TEXT NOT NULL,
        transcription_provider TEXT NOT NULL,
        summary_provider TEXT NOT NULL,
        summary_model TEXT NOT NULL,
        audio_sha256 TEXT NOT NULL,
        audio_bytes INTEGER NOT NULL,
        transcript_sha256 TEXT NOT NULL,
        transcript_bytes INTEGER NOT NULL,
        summary_sha256 TEXT NOT NULL,
        summary_bytes INTEGER NOT NULL,
        completed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS activation_journey_state (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        automatic_entry_acknowledged_at TEXT,
        deferred_at TEXT
      );

      CREATE TABLE IF NOT EXISTS activation_attempt (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        attempt_id TEXT NOT NULL UNIQUE,
        started_at TEXT NOT NULL,
        stop_requested_at TEXT,
        completion_opened_at TEXT,
        handoff_error TEXT,
        task_id TEXT,
        recording_stem TEXT
      );

      CREATE TABLE IF NOT EXISTS cloud_transcription_consent (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        disclosure_version TEXT NOT NULL,
        accepted_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS summary_data_path_disclosures (
        provider TEXT PRIMARY KEY,
        disclosure_version TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('accepted', 'declined')),
        decided_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_connections (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('direct-provider', 'supported-agent', 'gateway', 'legacy-custom')),
        adapter TEXT NOT NULL,
        label TEXT NOT NULL,
        lifecycle TEXT NOT NULL CHECK(lifecycle IN ('available', 'legacy')),
        settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_connection_candidates (
        id TEXT PRIMARY KEY,
        adapter TEXT NOT NULL,
        label TEXT NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('discovered', 'migrated')),
        detected_path TEXT,
        settings_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_connection_migrations (
        id TEXT PRIMARY KEY,
        completed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS agent_connection_readiness_history (
        id TEXT PRIMARY KEY,
        connection_id TEXT NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
        capability TEXT NOT NULL CHECK(capability IN ('transcription', 'summary', 'conversation')),
        status TEXT NOT NULL CHECK(status IN ('ready', 'failed')),
        model TEXT NOT NULL,
        credential_source TEXT CHECK(credential_source IN ('oauth', 'api-key')),
        detail TEXT NOT NULL,
        reason TEXT CHECK(reason IN ('invalid_model', 'readiness_failed')),
        runtime_evidence_json TEXT NOT NULL DEFAULT '{}',
        tested_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_connection_readiness
        ON agent_connection_readiness_history(connection_id, capability, tested_at DESC);

      CREATE TABLE IF NOT EXISTS agent_connection_disclosures (
        connection_id TEXT NOT NULL REFERENCES agent_connections(id) ON DELETE CASCADE,
        capability TEXT NOT NULL CHECK(capability IN ('transcription', 'summary', 'conversation')),
        disclosure_version TEXT NOT NULL,
        decision TEXT NOT NULL CHECK(decision IN ('accepted', 'declined')),
        decided_at TEXT NOT NULL,
        PRIMARY KEY(connection_id, capability)
      );
    `);
    const agentConnectionTable = this.db.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_connections'",
    ).get() as { sql: string } | undefined;
    if (agentConnectionTable && !agentConnectionTable.sql.includes("'gateway'")) {
      this.db.pragma("foreign_keys = OFF");
      try {
        this.db.exec(`
          BEGIN;
          CREATE TABLE agent_connections_v2 (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK(kind IN ('direct-provider', 'supported-agent', 'gateway', 'legacy-custom')),
            adapter TEXT NOT NULL,
            label TEXT NOT NULL,
            lifecycle TEXT NOT NULL CHECK(lifecycle IN ('available', 'legacy')),
            settings_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          INSERT INTO agent_connections_v2
            SELECT id, kind, adapter, label, lifecycle, settings_json, created_at, updated_at
            FROM agent_connections;
          DROP TABLE agent_connections;
          ALTER TABLE agent_connections_v2 RENAME TO agent_connections;
          COMMIT;
        `);
      } catch (error) {
        if (this.db.inTransaction) this.db.exec("ROLLBACK");
        throw error;
      } finally {
        this.db.pragma("foreign_keys = ON");
      }
    }
    const readinessColumns = this.db.prepare("PRAGMA table_info(agent_connection_readiness_history)")
      .all() as Array<{ name: string }>;
    if (!readinessColumns.some((column) => column.name === "runtime_evidence_json")) {
      this.db.exec("ALTER TABLE agent_connection_readiness_history ADD COLUMN runtime_evidence_json TEXT NOT NULL DEFAULT '{}'");
    }
    const columns = this.db.prepare("PRAGMA table_info(agent_tasks)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "instructions")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN instructions TEXT NOT NULL DEFAULT ''");
    }
    if (!columns.some((column) => column.name === "artifact_session_id")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN artifact_session_id TEXT");
    }
    if (!columns.some((column) => column.name === "delivery_session_id")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN delivery_session_id TEXT");
    }
    if (!columns.some((column) => column.name === "trigger")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN trigger TEXT NOT NULL DEFAULT 'automatic' CHECK(trigger IN ('automatic', 'manual'))");
    }
    if (!columns.some((column) => column.name === "transcription_language")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN transcription_language TEXT NOT NULL DEFAULT 'zh'");
    }
    if (!columns.some((column) => column.name === "summary_provider")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN summary_provider TEXT NOT NULL DEFAULT 'agent'");
    }
    if (!columns.some((column) => column.name === "summary_model")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN summary_model TEXT NOT NULL DEFAULT 'runtime-managed'");
    }
    if (!columns.some((column) => column.name === "summary_credential_source")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN summary_credential_source TEXT");
    }
    if (!columns.some((column) => column.name === "summary_connection_id")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN summary_connection_id TEXT");
    }
    if (!columns.some((column) => column.name === "summary_credential_class")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN summary_credential_class TEXT");
    }
    if (!columns.some((column) => column.name === "summary_credential_identity")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN summary_credential_identity TEXT");
    }
    if (!columns.some((column) => column.name === "summary_disclosure_version")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN summary_disclosure_version TEXT");
    }
    if (!columns.some((column) => column.name === "summary_endpoint_identity")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN summary_endpoint_identity TEXT");
    }
    if (!columns.some((column) => column.name === "summary_input_artifact_id")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN summary_input_artifact_id TEXT");
    }
    if (!columns.some((column) => column.name === "summary_input_artifact_sha256")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN summary_input_artifact_sha256 TEXT");
    }
    if (!columns.some((column) => column.name === "summary_input_artifact_bytes")) {
      this.db.exec("ALTER TABLE agent_tasks ADD COLUMN summary_input_artifact_bytes INTEGER");
    }
    this.db.exec(`
      UPDATE agent_tasks SET summary_credential_class = summary_credential_source
      WHERE summary_credential_class IS NULL AND summary_credential_source IS NOT NULL
    `);
    this.db.exec(`
      UPDATE agent_tasks SET summary_provider = agent_provider
      WHERE summary_provider = 'agent'
    `);
  }
}
