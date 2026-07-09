import { spawn as defaultSpawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { JobRegistry } from "./jobStatus.js";
import type { PubSub, AppChannels } from "./pubsub.js";
import { appendAgentSessionMessage, getAgentSession, updateAgentSessionNativeSession } from "./agentSessionStore.js";
import { runAgentCliCommand } from "./agentCliRunner.js";
import type { AgentRuntime } from "./agentRuntime.js";
import { openDb } from "./db.js";

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
  diarizationNumSpeakers?: number | null;
  pythonBin?: string;
  registry: JobRegistry;
  pubsub: PubSub<AppChannels>;
}

export async function runTranscribe(args: RunTranscribeArgs): Promise<{ jobId: string }> {
  const { stem, wavPath, transcribePy, diarizationNumSpeakers, pythonBin = "python3", registry, pubsub } = args;
  const jobId = randomUUID();
  registry.set({ stem, action: "transcribe", state: "transcribing", startedAt: Date.now(), jobId });
  pubsub.publish("jobs", { stem, jobId, state: "transcribing" });

  return new Promise((resolve) => {
    const procArgs = [transcribePy, wavPath];
    if (typeof diarizationNumSpeakers === "number") {
      procArgs.push("--diarization-num-speakers", String(diarizationNumSpeakers));
    }
    const proc = spawnImpl(pythonBin, procArgs, { stdio: ["ignore", "pipe", "pipe"] });
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
  audioPath?: string;
  title?: string | null;
  prompt?: SummaryPromptSnapshot | null;
  llmCommand: string[] | null;
  agentRuntime?: AgentRuntime;
  agentQueueJson: string;
  vocabDb?: string;
  scriptDir?: string;
  agentSession?: { configDir: string; sessionId: string };
  registry: JobRegistry;
  pubsub: PubSub<AppChannels>;
}

export interface SummaryPromptSnapshot {
  id: string;
  slug: string;
  name: string;
  content: string;
}

export async function runSummarize(args: RunSummarizeArgs): Promise<{ jobId: string; mode: "queue" | "direct" }> {
  const { stem, transcriptPath, summaryPath, audioPath, title, prompt, llmCommand, agentRuntime, agentQueueJson, vocabDb, scriptDir, agentSession, registry, pubsub } = args;
  const jobId = randomUUID();
  if (llmCommand === null) {
    return runSummarizeQueueMode({ stem, jobId, transcriptPath, summaryPath, audioPath, title, prompt, agentQueueJson, registry, pubsub });
  }
  return runSummarizeDirectMode({ stem, jobId, transcriptPath, summaryPath, title, prompt, llmCommand, agentRuntime, vocabDb, scriptDir, agentSession, registry, pubsub });
}

async function runSummarizeQueueMode(args: {
  stem: string; jobId: string; transcriptPath: string; summaryPath: string;
  audioPath?: string; title?: string | null; prompt?: SummaryPromptSnapshot | null;
  agentQueueJson: string; registry: JobRegistry; pubsub: PubSub<AppChannels>;
}): Promise<{ jobId: string; mode: "queue" }> {
  const { stem, jobId, transcriptPath, summaryPath, audioPath, title, prompt, agentQueueJson, registry, pubsub } = args;
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
    title: title ?? stem,
    audio_path: audioPath,
    transcript_path: transcriptPath,
    summary_path: summaryPath,
    transcriptPath,
    summaryPath,
    html_path_hint: summaryPath.replace(/\.md$/, ".html"),
    prompt_id: prompt?.id,
    prompt_slug: prompt?.slug,
    prompt_name: prompt?.name,
    prompt_content_snapshot: prompt?.content,
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
  title?: string | null; prompt?: SummaryPromptSnapshot | null; llmCommand: string[]; agentRuntime?: AgentRuntime; scriptDir?: string;
  vocabDb?: string;
  agentSession?: { configDir: string; sessionId: string };
  registry: JobRegistry; pubsub: PubSub<AppChannels>;
}): Promise<{ jobId: string; mode: "direct" }> {
  const { stem, jobId, transcriptPath, summaryPath, title, prompt, llmCommand, agentRuntime, vocabDb, scriptDir, agentSession, registry, pubsub } = args;
  registry.set({ stem, action: "summarize", state: "summarizing", startedAt: Date.now(), jobId });
  pubsub.publish("jobs", { stem, jobId, state: "summarizing" });

  const complete = (state: "done" | "failed", error?: string) => {
    if (state === "done") {
      registry.clear(stem);
    } else {
      registry.set({ stem, action: "summarize", state: "failed", startedAt: Date.now(), jobId, error });
    }
    pubsub.publish("jobs", { stem, jobId, state, error });
  };

  let renderedPrompt: string;
  try {
    const transcript = readFileSync(transcriptPath, "utf8");
    const taskTitle = title ?? stem;
    renderedPrompt = buildSummaryPrompt(transcript, { title: taskTitle, prompt, glossaryContext: buildGlossaryPromptContext(vocabDb) });
    if (agentSession) {
      appendAgentSessionMessage(agentSession.configDir, agentSession.sessionId, {
        role: "user",
        text: `根据模板生成会议摘要: ${taskTitle}`,
      });
    }
  } catch (exc) {
    const error = `failed to read transcript: ${(exc as Error).message}`;
    complete("failed", error);
    return { jobId, mode: "direct" };
  }

  if (agentRuntime && agentSession) {
    void runAgentCliCommand({
      runtime: agentRuntime,
      scriptDir: scriptDir ?? process.cwd(),
      prompt: renderedPrompt,
      timeoutMs: QUEUE_TIMEOUT_MS * 3,
      nativeSessionId: getAgentSession(agentSession.configDir, agentSession.sessionId)?.nativeSessionId,
      yuluSessionId: agentSession.sessionId,
      configDir: agentSession.configDir,
    }).then((result) => {
      if (result.nativeSessionId) {
        updateAgentSessionNativeSession(agentSession.configDir, agentSession.sessionId, {
          nativeSessionId: result.nativeSessionId,
          runtimeLabel: agentRuntime.label,
        });
      }
      if (result.code === 0 && result.stdout.length > 0) {
        try {
          writeFileSync(summaryPath, result.stdout);
          appendAgentSessionMessage(agentSession.configDir, agentSession.sessionId, {
            role: "assistant",
            text: result.stdout,
          });
          complete("done");
        } catch (exc) {
          complete("failed", `failed to write summary: ${(exc as Error).message}`);
        }
      } else {
        const error = (result.stderr || `summary command exited with code ${result.code}`).slice(0, 200);
        appendAgentSessionMessage(agentSession.configDir, agentSession.sessionId, {
          role: "assistant",
          text: "",
          error,
        });
        complete("failed", error);
      }
    }).catch((exc) => {
      const error = (exc as Error).message;
      appendAgentSessionMessage(agentSession.configDir, agentSession.sessionId, {
        role: "assistant",
        text: "",
        error,
      });
      complete("failed", error);
    });
    return { jobId, mode: "direct" };
  }

  return new Promise((resolve) => {
    const [cmd, ...rest] = resolveBundledScriptArgs(llmCommand, scriptDir);
    const proc = spawnImpl(cmd!, rest, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    proc.on("exit", (code: number | null) => {
      if (code === 0 && stdout.length > 0) {
        try {
          writeFileSync(summaryPath, stdout);
          if (agentSession) {
            appendAgentSessionMessage(agentSession.configDir, agentSession.sessionId, {
              role: "assistant",
              text: stdout,
            });
          }
          complete("done");
        } catch (exc) {
          complete("failed", `failed to write summary: ${(exc as Error).message}`);
        }
      } else {
        const error = (stderr || `summary command exited with code ${code}`).slice(0, 200);
        if (agentSession) {
          appendAgentSessionMessage(agentSession.configDir, agentSession.sessionId, {
            role: "assistant",
            text: "",
            error,
          });
        }
        complete("failed", error);
      }
      resolve({ jobId, mode: "direct" });
    });

    proc.stdin.write(renderedPrompt);
    proc.stdin.end();
  });
}

function resolveBundledScriptArgs(command: string[], scriptDir?: string): string[] {
  if (!scriptDir) return command;
  return command.map((part) => {
    if (!part || part.includes("/")) return part;
    const candidate = join(scriptDir, part);
    return existsSync(candidate) ? candidate : part;
  });
}

function buildSummaryPrompt(
  transcript: string,
  opts: { title?: string | null; prompt?: SummaryPromptSnapshot | null; glossaryContext?: string } = {},
): string {
  const glossaryContext = opts.glossaryContext ?? "";
  if (opts.prompt?.content) {
    const date = new Date().toISOString().slice(0, 10);
    return glossaryContext + opts.prompt.content
      .replaceAll("{{transcript}}", transcript)
      .replaceAll("{{my_transcript}}", "")
      .replaceAll("{{their_transcript}}", "")
      .replaceAll("{{speaker_transcript}}", "")
      .replaceAll("{{speaker_list}}", "")
      .replaceAll("{{meeting_title}}", opts.title ?? "")
      .replaceAll("{{date}}", date);
  }
  return [
    glossaryContext,
    "请根据下面的会议转录生成中文会议摘要。",
    "",
    "要求：",
    "- 提炼关键结论和上下文。",
    "- 列出明确行动项；没有行动项就写“无”。",
    "- 标出风险、分歧或待确认事项；没有就写“无”。",
    "- 不要编造转录中没有的信息。",
    "",
    "会议转录：",
    transcript,
  ].join("\n");
}

function buildGlossaryPromptContext(vocabDb?: string): string {
  if (!vocabDb || !existsSync(vocabDb)) return "";
  try {
    const db = openDb(vocabDb);
    try {
      const rows = db.prepare(`
        SELECT term, canonical
        FROM custom_words
        WHERE enabled = 1 AND scope IN ('prompt', 'both')
        ORDER BY length(term) DESC, term ASC
        LIMIT 120
      `).all() as Array<{ term: string; canonical: string }>;
      const hints = rows
        .map((row) => row.term === row.canonical ? row.term : `${row.term} => ${row.canonical}`)
        .filter(Boolean);
      if (hints.length === 0) return "";
      return [
        `术语表：${hints.join("，")}。`,
        "摘要/清理时，如果转录里出现同音、近形、大小写或别名写法，输出请统一改为术语表里的 canonical 写法；不要发明术语表外的新专名。",
        "",
      ].join("\n");
    } finally {
      db.close();
    }
  } catch {
    return "";
  }
}
