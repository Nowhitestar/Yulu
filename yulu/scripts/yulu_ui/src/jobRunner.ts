import { spawn as defaultSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { randomUUID } from "node:crypto";
import type { JobRegistry } from "./jobStatus.js";
import type { PubSub, AppChannels } from "./pubsub.js";

type SpawnFn = (cmd: string, args: string[], opts?: { stdio?: unknown }) => ChildProcessWithoutNullStreams;

let spawnImpl: SpawnFn = defaultSpawn as unknown as SpawnFn;

/** Test hook: replace spawn with a stub. Pass `undefined` to restore. */
export function __setSpawnForTesting(s: SpawnFn | undefined): void {
  spawnImpl = (s ?? (defaultSpawn as unknown as SpawnFn));
}

const QUEUE_TIMEOUT_MS = 60_000;

export interface RunTranscribeArgs {
  stem: string;
  wavPath: string;
  transcribePy: string;
  pythonBin?: string;
  registry: JobRegistry;
  pubsub: PubSub<AppChannels>;
}

export async function runTranscribe(args: RunTranscribeArgs): Promise<{ jobId: string }> {
  const { stem, wavPath, transcribePy, pythonBin = "python3", registry, pubsub } = args;
  const jobId = randomUUID();
  registry.set({ stem, action: "transcribe", state: "transcribing", startedAt: Date.now(), jobId });
  pubsub.publish("jobs", { stem, jobId, state: "transcribing" });

  return new Promise((resolve) => {
    const proc = spawnImpl(pythonBin, [transcribePy, wavPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("exit", (code: number | null) => {
      if (code === 0) {
        registry.clear(stem);
        pubsub.publish("jobs", { stem, jobId, state: "done" });
      } else {
        const error = (stderr || `transcribe.py exited with code ${code}`).slice(0, 200);
        registry.set({ stem, action: "transcribe", state: "failed", startedAt: Date.now(), jobId, error });
        pubsub.publish("jobs", { stem, jobId, state: "failed", error });
      }
      resolve({ jobId });
    });
  });
}

export interface RunSummarizeArgs {
  stem: string;
  transcriptPath: string;
  summaryPath: string;
  llmCommand: string[] | null;
  agentQueueJson: string;
  registry: JobRegistry;
  pubsub: PubSub<AppChannels>;
}

export async function runSummarize(args: RunSummarizeArgs): Promise<{ jobId: string; mode: "queue" | "direct" }> {
  const { stem, transcriptPath, summaryPath, llmCommand, agentQueueJson, registry, pubsub } = args;
  const jobId = randomUUID();
  if (llmCommand === null) {
    return runSummarizeQueueMode({ stem, jobId, transcriptPath, summaryPath, agentQueueJson, registry, pubsub });
  }
  return runSummarizeDirectMode({ stem, jobId, transcriptPath, summaryPath, llmCommand, registry, pubsub });
}

async function runSummarizeQueueMode(args: {
  stem: string; jobId: string; transcriptPath: string; summaryPath: string;
  agentQueueJson: string; registry: JobRegistry; pubsub: PubSub<AppChannels>;
}): Promise<{ jobId: string; mode: "queue" }> {
  const { stem, jobId, transcriptPath, summaryPath, agentQueueJson, registry, pubsub } = args;
  const queueEntryId = randomUUID();
  registry.set({ stem, action: "summarize", state: "summarizing", startedAt: Date.now(), jobId, queueEntryId });
  pubsub.publish("jobs", { stem, jobId, state: "summarizing" });

  let queue: Array<Record<string, unknown>> = [];
  if (existsSync(agentQueueJson)) {
    try { queue = JSON.parse(readFileSync(agentQueueJson, "utf8")); } catch { queue = []; }
  }
  queue.push({
    id: queueEntryId,
    type: "summary_request",
    stem,
    transcriptPath,
    summaryPath,
    requestedAt: Date.now(),
  });
  writeFileSync(agentQueueJson, JSON.stringify(queue, null, 2));

  void watchForQueueCompletion({ stem, jobId, queueEntryId, agentQueueJson, summaryPath, registry, pubsub });
  return { jobId, mode: "queue" };
}

function watchForQueueCompletion(args: {
  stem: string; jobId: string; queueEntryId: string;
  agentQueueJson: string; summaryPath: string;
  registry: JobRegistry; pubsub: PubSub<AppChannels>;
}): Promise<void> {
  const { stem, jobId, queueEntryId, agentQueueJson, summaryPath, registry, pubsub } = args;
  return new Promise((resolve) => {
    let settled = false;
    let watcher: FSWatcher | undefined;
    const finish = (state: "done" | "failed", error?: string) => {
      if (settled) return;
      settled = true;
      watcher?.close();
      if (state === "done") {
        registry.clear(stem);
      } else {
        registry.set({ stem, action: "summarize", state: "failed", startedAt: Date.now(), jobId, error });
      }
      pubsub.publish("jobs", { stem, jobId, state, error });
      resolve();
    };

    const timer = setTimeout(() => finish("failed", "agent queue worker did not process within 60s"), QUEUE_TIMEOUT_MS);

    try {
      watcher = fsWatch(agentQueueJson, { persistent: false }, () => {
        try {
          const list = JSON.parse(readFileSync(agentQueueJson, "utf8")) as Array<{ id?: string }>;
          const stillThere = list.some((e) => e.id === queueEntryId);
          if (!stillThere) {
            clearTimeout(timer);
            if (existsSync(summaryPath)) finish("done");
            else finish("failed", "worker removed queue entry but no summary written");
          }
        } catch { /* mid-write JSON; ignore */ }
      });
    } catch (exc) {
      clearTimeout(timer);
      finish("failed", `agent-queue watcher failed: ${(exc as Error).message}`);
    }
  });
}

async function runSummarizeDirectMode(args: {
  stem: string; jobId: string; transcriptPath: string; summaryPath: string;
  llmCommand: string[]; registry: JobRegistry; pubsub: PubSub<AppChannels>;
}): Promise<{ jobId: string; mode: "direct" }> {
  const { stem, jobId, transcriptPath, summaryPath, llmCommand, registry, pubsub } = args;
  registry.set({ stem, action: "summarize", state: "summarizing", startedAt: Date.now(), jobId });
  pubsub.publish("jobs", { stem, jobId, state: "summarizing" });

  return new Promise((resolve) => {
    const [cmd, ...rest] = llmCommand;
    const proc = spawnImpl(cmd!, rest, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("exit", (code: number | null) => {
      if (code === 0 && stdout.length > 0) {
        try {
          writeFileSync(summaryPath, stdout);
          registry.clear(stem);
          pubsub.publish("jobs", { stem, jobId, state: "done" });
        } catch (exc) {
          const error = `failed to write summary: ${(exc as Error).message}`;
          registry.set({ stem, action: "summarize", state: "failed", startedAt: Date.now(), jobId, error });
          pubsub.publish("jobs", { stem, jobId, state: "failed", error });
        }
      } else {
        const error = (stderr || `summary command exited with code ${code}`).slice(0, 200);
        registry.set({ stem, action: "summarize", state: "failed", startedAt: Date.now(), jobId, error });
        pubsub.publish("jobs", { stem, jobId, state: "failed", error });
      }
      resolve({ jobId, mode: "direct" });
    });

    try {
      const transcript = readFileSync(transcriptPath, "utf8");
      proc.stdin.write(transcript);
      proc.stdin.end();
    } catch (exc) {
      proc.stdin.end();
      const error = `failed to read transcript: ${(exc as Error).message}`;
      registry.set({ stem, action: "summarize", state: "failed", startedAt: Date.now(), jobId, error });
      pubsub.publish("jobs", { stem, jobId, state: "failed", error });
    }
  });
}
