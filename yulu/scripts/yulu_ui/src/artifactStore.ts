import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import type { AgentTask, ArtifactRecord } from "./hostStore.js";

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 2 * 1024 * 1024;
const TASK_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AgentTaskWorkspace {
  dir: string;
  transcriptPath: string;
  summaryPath: string;
  chunkPattern: string;
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith("/");
}

function readRequiredText(path: string, label: string, maxBytes: number): string {
  if (!existsSync(path)) throw new Error(`${label} staging artifact is missing`);
  const content = readFileSync(path);
  if (content.length === 0) throw new Error(`${label} staging artifact is empty`);
  if (content.length > maxBytes) throw new Error(`${label} staging artifact exceeds ${maxBytes} bytes`);
  const text = content.toString("utf8").trim();
  if (!text) throw new Error(`${label} staging artifact contains no text`);
  return text + "\n";
}

function atomicWrite(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(tmp, content, { encoding: "utf8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

export class ArtifactStore {
  constructor(
    private readonly moviesDir: string,
    private readonly tasksDir: string,
  ) {
    mkdirSync(this.moviesDir, { recursive: true });
    mkdirSync(this.tasksDir, { recursive: true, mode: 0o700 });
  }

  workspace(taskId: string): AgentTaskWorkspace {
    const dir = join(this.tasksDir, taskId);
    if (!isInside(this.tasksDir, dir)) throw new Error("invalid Agent task workspace");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return {
      dir,
      transcriptPath: join(dir, "transcript.txt"),
      summaryPath: join(dir, "summary.md"),
      chunkPattern: join(dir, "audio-%03d.wav"),
    };
  }

  writeStagedTranscript(taskId: string, transcript: string): string {
    const text = transcript.trim();
    if (!text) throw new Error("transcription returned an empty transcript");
    const path = this.workspace(taskId).transcriptPath;
    atomicWrite(path, text + "\n");
    return path;
  }

  readStagedTranscript(taskId: string): string {
    return readRequiredText(
      this.workspace(taskId).transcriptPath,
      "transcript",
      MAX_TRANSCRIPT_BYTES,
    ).trimEnd();
  }

  writeStagedSummary(taskId: string, summary: string): string {
    const text = summary.trim();
    if (!text) throw new Error("Hermes returned an empty summary");
    if (Buffer.byteLength(text, "utf8") > MAX_SUMMARY_BYTES) {
      throw new Error(`summary staging artifact exceeds ${MAX_SUMMARY_BYTES} bytes`);
    }
    const path = this.workspace(taskId).summaryPath;
    atomicWrite(path, text + "\n");
    return path;
  }

  readCommittedSummary(task: AgentTask, record: ArtifactRecord): string {
    if (
      record.taskId !== task.id ||
      record.recordingStem !== task.recordingStem ||
      record.kind !== "summary"
    ) {
      throw new Error("summary artifact record does not belong to this task");
    }
    const expectedPath = join(this.moviesDir, `${task.recordingStem}.summary.md`);
    if (!isInside(this.moviesDir, expectedPath) || resolve(record.path) !== resolve(expectedPath)) {
      throw new Error("summary artifact record points outside the committed recording target");
    }
    const content = readFileSync(expectedPath);
    if (content.length !== record.bytes || sha256(content) !== record.sha256) {
      throw new Error("committed summary no longer matches the Host artifact record");
    }
    const text = content.toString("utf8").trim();
    if (!text) throw new Error("committed summary contains no text");
    return text;
  }

  readCommittedTranscript(task: AgentTask, record: ArtifactRecord): string {
    if (record.taskId !== task.id || record.recordingStem !== task.recordingStem || record.kind !== "transcript") {
      throw new Error("transcript artifact record does not belong to this task");
    }
    const expectedPath = join(this.moviesDir, `${task.recordingStem}.transcript.txt`);
    if (!isInside(this.moviesDir, expectedPath) || resolve(record.path) !== resolve(expectedPath)) {
      throw new Error("transcript artifact record points outside the committed recording target");
    }
    const content = readFileSync(expectedPath);
    if (content.length !== record.bytes || sha256(content) !== record.sha256) {
      throw new Error("committed transcript no longer matches the Host artifact record");
    }
    const text = content.toString("utf8").trim();
    if (!text) throw new Error("committed transcript contains no text");
    return text;
  }

  adoptCommittedTranscript(task: AgentTask, provenance: Record<string, unknown>): ArtifactRecord {
    const path = join(this.moviesDir, `${task.recordingStem}.transcript.txt`);
    if (!isInside(this.moviesDir, path)) {
      throw new Error("transcript target escapes the recordings directory");
    }
    const transcript = readRequiredText(path, "transcript", MAX_TRANSCRIPT_BYTES).trimEnd();
    return this.commitTranscript(task, transcript, provenance);
  }

  commitTranscript(
    task: AgentTask,
    transcript: string,
    provenance: Record<string, unknown>,
  ): ArtifactRecord {
    const text = transcript.trim();
    if (!text) throw new Error("transcription returned an empty transcript");
    if (basename(task.audioPath, ".wav") !== task.recordingStem) {
      throw new Error("recording stem does not match the audio artifact");
    }
    const content = `${text}\n`;
    const path = join(this.moviesDir, `${task.recordingStem}.transcript.txt`);
    if (!isInside(this.moviesDir, path)) throw new Error("transcript target escapes the recordings directory");
    this.writeStagedTranscript(task.id, text);
    atomicWrite(path, content);
    return {
      id: randomUUID(),
      taskId: task.id,
      recordingStem: task.recordingStem,
      kind: "transcript",
      path,
      sha256: sha256(content),
      bytes: Buffer.byteLength(content),
      mimeType: "text/plain",
      provenance,
      createdAt: new Date().toISOString(),
    };
  }

  commitFromWorkspace(task: AgentTask, provenance: Record<string, unknown>): ArtifactRecord[] {
    const workspace = this.workspace(task.id);
    const transcript = readRequiredText(workspace.transcriptPath, "transcript", MAX_TRANSCRIPT_BYTES);
    const summary = readRequiredText(workspace.summaryPath, "summary", MAX_SUMMARY_BYTES);
    if (basename(task.audioPath, ".wav") !== task.recordingStem) {
      throw new Error("recording stem does not match the audio artifact");
    }
    const transcriptPath = join(this.moviesDir, `${task.recordingStem}.transcript.txt`);
    const summaryPath = join(this.moviesDir, `${task.recordingStem}.summary.md`);
    if (!isInside(this.moviesDir, transcriptPath) || !isInside(this.moviesDir, summaryPath)) {
      throw new Error("artifact target escapes the recordings directory");
    }
    atomicWrite(transcriptPath, transcript);
    atomicWrite(summaryPath, summary);
    const stalePath = join(this.moviesDir, `${task.recordingStem}.summary.stale`);
    if (existsSync(stalePath)) unlinkSync(stalePath);

    const createdAt = new Date().toISOString();
    return [
      {
        id: randomUUID(),
        taskId: task.id,
        recordingStem: task.recordingStem,
        kind: "transcript",
        path: transcriptPath,
        sha256: sha256(transcript),
        bytes: Buffer.byteLength(transcript),
        mimeType: "text/plain",
        provenance,
        createdAt,
      },
      {
        id: randomUUID(),
        taskId: task.id,
        recordingStem: task.recordingStem,
        kind: "summary",
        path: summaryPath,
        sha256: sha256(summary),
        bytes: Buffer.byteLength(summary),
        mimeType: "text/markdown",
        provenance,
        createdAt,
      },
    ];
  }

  cleanupTransportAudio(taskId: string): void {
    const workspace = this.workspace(taskId);
    for (const name of readdirSync(workspace.dir)) {
      if (/^audio-\d{3}\.wav$/.test(name)) {
        try { unlinkSync(join(workspace.dir, name)); } catch { /* best effort */ }
      }
    }
  }

  cleanupWorkspace(taskId: string): void {
    const dir = join(this.tasksDir, taskId);
    if (!isInside(this.tasksDir, dir) || basename(dir) !== taskId) {
      throw new Error("refusing to clean an invalid Agent task workspace");
    }
    rmSync(dir, { recursive: true, force: true });
  }

  cleanupInactiveWorkspaces(activeTaskIds: Iterable<string>): string[] {
    const active = new Set(activeTaskIds);
    const removed: string[] = [];
    for (const entry of readdirSync(this.tasksDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || !TASK_ID_RE.test(entry.name) || active.has(entry.name)) continue;
      this.cleanupWorkspace(entry.name);
      removed.push(entry.name);
    }
    return removed;
  }
}
