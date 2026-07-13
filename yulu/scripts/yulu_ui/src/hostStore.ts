import Database, { type Database as DbType } from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { isTrustedNotionUrl, isValidNotionPageId, notionPageIdentityProblem } from "./notionDelivery.js";

export type AgentTaskState =
  | "queued"
  | "awaiting_agent"
  | "awaiting_policy"
  | "running"
  | "artifacts_committed"
  | "sending"
  | "delivery_reported"
  | "delivery_unverified"
  | "completed"
  | "failed"
  | "cancelled";

export type AgentTaskPhase =
  | "queued"
  | "transcribing"
  | "summarizing"
  | "committing_artifacts"
  | "sending_notion"
  | "completed"
  | "failed";

export type AgentTaskTrigger = "automatic" | "manual";

export interface AgentTask {
  id: string;
  idempotencyKey: string;
  recordingStem: string;
  title: string;
  audioPath: string;
  trigger: AgentTaskTrigger;
  state: AgentTaskState;
  phase: AgentTaskPhase;
  sendToNotion: boolean;
  destinationHint: string;
  instructions: string;
  agentProvider: string;
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
  trigger: AgentTaskTrigger;
  state: AgentTaskState;
  phase: AgentTaskPhase;
  send_to_notion: number;
  destination_hint: string;
  instructions: string;
  agent_provider: string;
  native_session_id: string | null;
  artifact_session_id: string | null;
  delivery_session_id: string | null;
  lease_token: string | null;
  attempt: number;
  error: string | null;
  created_at: string;
  updated_at: string;
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
    trigger: row.trigger,
    state: row.state,
    phase: row.phase,
    sendToNotion: row.send_to_notion === 1,
    destinationHint: row.destination_hint,
    instructions: row.instructions,
    agentProvider: row.agent_provider,
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
  "artifacts_committed",
  "sending",
  "delivery_reported",
  "delivery_unverified",
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

  enqueueRecording(input: {
    idempotencyKey: string;
    recordingStem: string;
    title: string;
    audioPath: string;
    sendToNotion: boolean;
    destinationHint: string;
    agentProvider: string;
    instructions?: string;
    trigger?: AgentTaskTrigger;
  }): { task: AgentTask; created: boolean } {
    const id = randomUUID();
    const timestamp = now();
    const insert = this.db.transaction(() => {
      const existing = this.findByIdempotencyKey(input.idempotencyKey);
      if (existing) return { task: existing, created: false };
      const active = this.db.prepare(`
        SELECT * FROM agent_tasks
        WHERE recording_stem = ?
          AND state IN ('queued', 'awaiting_agent', 'awaiting_policy', 'running',
                        'artifacts_committed', 'sending', 'delivery_reported', 'delivery_unverified')
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
          id, idempotency_key, recording_stem, title, audio_path, trigger,
          state, phase, send_to_notion, destination_hint, agent_provider, instructions,
          attempt, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, ?, ?, ?, 0, ?, ?)
      `).run(
        id,
        input.idempotencyKey,
        input.recordingStem,
        input.title,
        input.audioPath,
        input.trigger ?? "automatic",
        input.sendToNotion ? 1 : 0,
        input.destinationHint,
        input.agentProvider,
        input.instructions ?? "",
        timestamp,
        timestamp,
      );
      const task = this.findByIdempotencyKey(input.idempotencyKey);
      if (!task) throw new Error("failed to persist Agent task");
      if (task.id === id) this.appendEvent(task.id, "task.queued", {
        sendToNotion: input.sendToNotion,
        trigger: input.trigger ?? "automatic",
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
          AND state IN ('queued', 'awaiting_agent', 'awaiting_policy', 'running', 'artifacts_committed')
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
        WHERE trigger = 'manual' AND (
          state IN ('queued', 'awaiting_agent', 'awaiting_policy', 'running',
                    'artifacts_committed', 'sending', 'delivery_reported')
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
        if (!['queued', 'awaiting_agent', 'awaiting_policy'].includes(row.state)) continue;
        this.db.prepare(`
          UPDATE agent_tasks SET state = 'cancelled', phase = 'failed', lease_token = NULL,
            error = 'Recording deleted before Agent task started', updated_at = ?
          WHERE id = ? AND state IN ('queued', 'awaiting_agent', 'awaiting_policy')
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

  claimNext(provider: string): AgentTask | null {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(`
        SELECT * FROM agent_tasks
        WHERE state IN ('queued', 'awaiting_agent')
        ORDER BY created_at ASC LIMIT 1
      `).get() as TaskRow | undefined;
      if (!row) return null;
      const lease = randomUUID();
      const timestamp = now();
      const result = this.db.prepare(`
        UPDATE agent_tasks
        SET state = 'running', phase = 'transcribing', agent_provider = ?,
            native_session_id = NULL, artifact_session_id = NULL, delivery_session_id = NULL,
            lease_token = ?, attempt = attempt + 1, error = NULL, audit_json = NULL, updated_at = ?
        WHERE id = ? AND state IN ('queued', 'awaiting_agent')
      `).run(provider, lease, timestamp, row.id);
      if (result.changes !== 1) return null;
      this.appendEvent(row.id, "task.claimed", { provider, attempt: row.attempt + 1 });
      return this.getTask(row.id);
    });
    return claim();
  }

  hasDispatchableTask(): boolean {
    return this.db.prepare(`
      SELECT 1 FROM agent_tasks
      WHERE state IN ('queued', 'awaiting_agent')
      LIMIT 1
    `).get() !== undefined;
  }

  claim(id: string, provider: string): AgentTask | null {
    const claim = this.db.transaction(() => {
      const row = this.db.prepare(
        "SELECT * FROM agent_tasks WHERE id = ? AND state IN ('queued', 'awaiting_agent')",
      ).get(id) as TaskRow | undefined;
      if (!row) return null;
      const lease = randomUUID();
      const result = this.db.prepare(`
        UPDATE agent_tasks
        SET state = 'running', phase = 'transcribing', agent_provider = ?,
            native_session_id = NULL, artifact_session_id = NULL, delivery_session_id = NULL,
            lease_token = ?, attempt = attempt + 1, error = NULL, audit_json = NULL, updated_at = ?
        WHERE id = ? AND state IN ('queued', 'awaiting_agent')
      `).run(provider, lease, now(), id);
      if (result.changes !== 1) return null;
      this.appendEvent(id, "task.claimed", { provider, attempt: row.attempt + 1 });
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
        WHERE state IN ('queued', 'awaiting_agent') AND trigger = ?
        ORDER BY created_at
      `).all(trigger) : this.db.prepare(`
        SELECT * FROM agent_tasks
        WHERE state IN ('queued', 'awaiting_agent')
        ORDER BY created_at
      `).all()) as TaskRow[];
      const timestamp = now();
      for (const row of rows) {
        this.db.prepare(`
          UPDATE agent_tasks SET state = 'awaiting_policy', phase = 'queued', error = ?,
            lease_token = NULL, updated_at = ?
          WHERE id = ? AND state IN ('queued', 'awaiting_agent')
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
          UPDATE agent_tasks SET state = 'queued', phase = 'queued', error = NULL,
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
    if (!["running", "artifacts_committed"].includes(task.state)) {
      throw new Error(`task ${id} cannot await Agent from ${task.state}`);
    }
    const result = this.db.prepare(`
      UPDATE agent_tasks SET state = 'awaiting_agent', phase = 'queued', error = ?,
        lease_token = NULL, updated_at = ?
      WHERE id = ? AND lease_token = ? AND state IN ('running', 'artifacts_committed')
    `).run(reason.slice(0, 1000), now(), id, leaseToken);
    if (result.changes !== 1) throw new Error(`task ${id} changed before it could await Agent`);
    this.appendEvent(id, "task.awaiting_agent", { reason });
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
    if (!["running", "artifacts_committed"].includes(task.state)) {
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
      if (!["running", "artifacts_committed"].includes(task.state)) {
        throw new Error(`task ${id} cannot commit artifacts from ${task.state}`);
      }
      const kinds = new Set(artifacts.map((artifact) => artifact.kind));
      if (!kinds.has("transcript") || !kinds.has("summary")) {
        throw new Error("transcript and summary must be committed together");
      }
      for (const artifact of artifacts) {
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
          JSON.stringify(artifact.provenance),
          artifact.createdAt,
        );
      }
      this.db.prepare(`
        UPDATE agent_tasks SET state = 'artifacts_committed', phase = 'committing_artifacts',
          error = NULL, updated_at = ? WHERE id = ?
      `).run(now(), id);
      this.appendEvent(id, "artifacts.committed", {
        artifacts: artifacts.map((artifact) => ({ kind: artifact.kind, sha256: artifact.sha256, bytes: artifact.bytes })),
      });
      return this.getTask(id)!;
    });
    return commit();
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
    if (["completed", "cancelled", "delivery_unverified"].includes(task.state)) return task;
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

  retry(id: string): AgentTask {
    const retry = this.db.transaction(() => {
      const task = this.getTask(id);
      if (!task) throw new Error(`task not found: ${id}`);
      if (!["failed", "awaiting_agent"].includes(task.state)) {
        throw new Error(`task ${id} cannot retry from ${task.state}`);
      }
      const competing = this.competingActiveTask(task.recordingStem, id);
      if (competing) {
        throw new Error(`recording ${task.recordingStem} already has active Agent task ${competing.id}`);
      }
      this.db.prepare(`
        UPDATE agent_tasks SET state = 'queued', phase = 'queued', lease_token = NULL,
          native_session_id = NULL, artifact_session_id = NULL, delivery_session_id = NULL,
          attempt = 0, error = NULL, audit_json = NULL, updated_at = ? WHERE id = ?
      `).run(now(), id);
      this.appendEvent(id, "task.retried", {});
      return this.getTask(id)!;
    });
    return retry.immediate();
  }

  private competingActiveTask(recordingStem: string, excludingId: string): AgentTask | null {
    const row = this.db.prepare(`
      SELECT * FROM agent_tasks
      WHERE recording_stem = ? AND id != ?
        AND state IN ('queued', 'awaiting_agent', 'awaiting_policy', 'running',
                      'artifacts_committed', 'sending', 'delivery_reported', 'delivery_unverified')
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

  private recoverInterrupted(): void {
    const timestamp = now();
    this.db.prepare(`
      UPDATE agent_tasks SET state = 'queued', phase = 'queued', lease_token = NULL,
        native_session_id = NULL, artifact_session_id = NULL, delivery_session_id = NULL,
        error = 'Host restarted before Agent task completed', audit_json = NULL,
        updated_at = ?
      WHERE state IN ('running', 'artifacts_committed')
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
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        recording_stem TEXT NOT NULL,
        title TEXT NOT NULL,
        audio_path TEXT NOT NULL,
        trigger TEXT NOT NULL DEFAULT 'automatic' CHECK(trigger IN ('automatic', 'manual')),
        state TEXT NOT NULL,
        phase TEXT NOT NULL,
        send_to_notion INTEGER NOT NULL DEFAULT 0,
        destination_hint TEXT NOT NULL DEFAULT '',
        agent_provider TEXT NOT NULL DEFAULT 'hermes',
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
    `);
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
  }
}
