import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";
import { z } from "zod";
import { router, publicProcedure, uiMutationProcedure } from "../trpc.js";
import { envWithFallbackPath } from "../executables.js";
import { resolveAgentRuntime, commandPreview } from "../agentRuntime.js";
import { ipcSend } from "../ipc.js";
import {
  addedPluginIds,
  agentDestinationView,
  agentPluginOverview,
  configurePluginAction,
  normalizeConsoleAgent,
  withAddedPlugin,
  withoutAddedPlugin,
  type AgentPluginId,
} from "../agentPlugins.js";
import { ensureBackgroundAgentSession, updateAgentSessionNativeSession } from "../agentSessionStore.js";
import { runAgentCliCommand } from "../agentCliRunner.js";
import type { HostStore } from "../hostStore.js";

type StageState = "idle" | "waiting" | "running" | "done" | "failed";
type AgentId = "codex" | "claude" | "hermes" | "openclaw";
type SendDest = "notion" | "zulip" | null;

interface StatusReply { ok: boolean; state?: string; hotkey?: string; launcher_pid?: number; }

const REC_FILE_RE = /^(.+?)_(\d{8})_(\d{6})\.wav$/;
const SUPPORTED_AGENTS = ["codex", "claude", "hermes", "openclaw"] as const;
const CONNECT_AGENT_SCHEMA = z.object({ agent: z.enum(SUPPORTED_AGENTS) });
const PLUGIN_SCHEMA = z.object({ plugin: z.enum(["summary", "notion", "zulip", "calendar"]) });
const DESTINATION_CHANNEL_SCHEMA = z.object({ channel: z.enum(["notion", "zulip"]) });
const DESTINATION_SCHEMA = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("notion"),
    target: z.string().trim().min(1).max(500),
  }),
  z.object({
    channel: z.literal("zulip"),
    stream: z.string().trim().max(200),
    topic: z.string().trim().max(300),
  }),
]);
const CALENDAR_CONFIG_SCHEMA = z.object({
  key: z.string().regex(/^calendars(?:\.\d+\.(?:enabled|gog_account|watch_calendars))?$/),
  value: z.unknown(),
});
const RECENT_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
const DESTINATION_DISCOVERY_TIMEOUT_MS = 120_000;

interface DestinationOption {
  id: string;
  label: string;
  value: string;
  source: "agent" | "saved" | "default";
  kind?: string;
  target?: string;
  stream?: string;
  topic?: string;
}

const AGENT_META: Record<AgentId, { command: string; name: string; supported: boolean }> = {
  codex: { command: "codex", name: "Codex CLI", supported: true },
  claude: { command: "claude", name: "Claude Code", supported: true },
  hermes: { command: "hermes", name: "Hermes", supported: true },
  openclaw: { command: "openclaw", name: "OpenClaw", supported: true },
};

interface AgentConsoleTask {
  id: string;
  stem: string;
  title: string;
  recordedAt: string;
  mtimeMs: number;
  dayLabel: "today" | "yesterday" | "recent";
  stages: {
    record: StageState;
    transcribe: StageState;
    summarize: StageState;
    send: StageState;
  };
  dest: SendDest;
  error: string;
  hasTranscript: boolean;
  hasSummary: boolean;
  hasRealtime: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nestedRecord(root: unknown, key: string): Record<string, unknown> {
  return asRecord(asRecord(root)[key]);
}

function isoFromStem(date: string, time: string): string {
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`;
}

function executablePath(cmd: string): string | null {
  const pathEnv = envWithFallbackPath(process.env).PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep scanning PATH.
    }
  }
  return null;
}

function configuredProvider(config: unknown): string {
  const llm = nestedRecord(config, "llm");
  const command = Array.isArray(llm.command) ? llm.command.map(String).join(" ") : "";
  if (command.includes("codex")) return "codex";
  if (command.includes("claude")) return "claude";
  if (command.includes("hermes")) return "hermes";
  if (command.includes("openclaw")) return "openclaw";
  const agent = asRecord(llm.agent);
  return String(agent.provider ?? "auto").trim().toLowerCase() || "auto";
}

function activeAgent(config: unknown, scriptDir: string, moviesDir: string): AgentId | "auto" | "custom" | "none" {
  const requested = configuredProvider(config);
  if (requested === "codex" || requested === "claude" || requested === "hermes" || requested === "openclaw") return requested;
  const runtime = resolveAgentRuntime(config, { scriptDir, moviesDir });
  if (runtime.provider === "codex" || runtime.provider === "claude" || runtime.provider === "hermes" || runtime.provider === "openclaw") return runtime.provider;
  if (runtime.provider === "custom") return "custom";
  if (runtime.provider === "none") return requested === "auto" ? "auto" : "none";
  return "auto";
}

function detectAgents(config: unknown, scriptDir: string, moviesDir: string) {
  const active = activeAgent(config, scriptDir, moviesDir);
  const runtime = resolveAgentRuntime(config, { scriptDir, moviesDir });
  const runtimePreview = commandPreview(runtime);
  return (Object.keys(AGENT_META) as AgentId[]).map((id) => {
    const meta = AGENT_META[id];
    const path = executablePath(meta.command);
    const connected = active === id || (active === "auto" && runtime.provider === id);
    return {
      id,
      name: meta.name,
      command: meta.command,
      found: path !== null,
      path: path ?? "",
      supported: meta.supported,
      connected,
      unavailableReason: meta.supported ? "" : "coming_soon",
      runtimePreview: connected ? runtimePreview : "",
    };
  });
}

function selectedConsoleAgent(config: unknown, scriptDir: string, moviesDir: string): AgentId | null {
  const active = activeAgent(config, scriptDir, moviesDir);
  if (active === "codex" || active === "claude" || active === "hermes" || active === "openclaw") return active;
  const runtime = resolveAgentRuntime(config, { scriptDir, moviesDir });
  return normalizeConsoleAgent(runtime.provider);
}

function stringValue(root: Record<string, unknown>, key: string): string {
  return typeof root[key] === "string" ? String(root[key]).trim() : "";
}

function destinationOptionRoot(config: unknown, agent: AgentId | null, channel: "notion" | "zulip"): unknown[] {
  if (!agent) return [];
  const root = asRecord(config);
  const consoleConfig = asRecord(root.agent_console);
  const destinationOptions = asRecord(consoleConfig.destination_options);
  const agentOptions = asRecord(destinationOptions[agent]);
  const raw = agentOptions[channel];
  return Array.isArray(raw) ? raw : [];
}

function optionKey(option: DestinationOption): string {
  if (option.stream || option.topic) return `zulip:${option.stream ?? ""}:${option.topic ?? ""}`;
  return `notion:${option.value}`;
}

function addOption(out: DestinationOption[], option: DestinationOption) {
  const key = optionKey(option);
  if (!key || out.some((item) => optionKey(item) === key)) return;
  out.push(option);
}

function normalizeCachedOption(channel: "notion" | "zulip", raw: unknown): DestinationOption | null {
  const item = asRecord(raw);
  if (channel === "notion") {
    const target = stringValue(item, "target") || stringValue(item, "value") || stringValue(item, "url") || stringValue(item, "name");
    if (!target) return null;
    const label = stringValue(item, "label") || stringValue(item, "name") || target;
    return {
      id: `notion:${target}`,
      label,
      value: target,
      target,
      kind: stringValue(item, "kind") || stringValue(item, "type") || undefined,
      source: item.source === "agent" ? "agent" : "saved",
    };
  }
  const stream = stringValue(item, "stream") || stringValue(item, "channel");
  const topic = stringValue(item, "topic");
  if (!stream || !topic) return null;
  return {
    id: `zulip:${stream}:${topic}`,
    label: stringValue(item, "label") || `${stream} / ${topic}`,
    value: `${stream} / ${topic}`,
    stream,
    topic,
    source: item.source === "agent" ? "agent" : "saved",
  };
}

function destinationOptions(config: unknown, agent: AgentId | null, channel: "notion" | "zulip") {
  const out: DestinationOption[] = [];
  const saved = agentDestinationView(config, agent, channel);
  if (channel === "notion") {
    const target = saved.notion?.target || "Yulu Meeting";
    addOption(out, {
      id: `notion:${target}`,
      label: target,
      value: target,
      target,
      source: saved.configured ? "saved" : "default",
    });
  } else if (saved.zulip?.stream && saved.zulip.topic) {
    addOption(out, {
      id: `zulip:${saved.zulip.stream}:${saved.zulip.topic}`,
      label: `${saved.zulip.stream} / ${saved.zulip.topic}`,
      value: `${saved.zulip.stream} / ${saved.zulip.topic}`,
      stream: saved.zulip.stream,
      topic: saved.zulip.topic,
      source: "saved",
    });
  }
  for (const raw of destinationOptionRoot(config, agent, channel)) {
    const option = normalizeCachedOption(channel, raw);
    if (option) addOption(out, option);
  }
  return out;
}

function discoveryPrompt(channel: "notion" | "zulip"): string {
  if (channel === "notion") {
    return [
      "You are Yulu's selected local Agent. Read-only task: list available Notion destinations for sending Yulu meeting summaries.",
      "Use your configured Notion connector/plugin if available.",
      "Return ONLY compact JSON with this exact shape:",
      "{\"options\":[{\"label\":\"Human name\",\"target\":\"page/database name or URL\",\"kind\":\"page|database\"}],\"error\":\"\"}",
      "If you cannot access Notion, return {\"options\":[],\"error\":\"reason\"}.",
    ].join("\n");
  }
  return [
    "You are Yulu's selected local Agent. Read-only task: list available Zulip destinations for sending Yulu meeting summaries.",
    "Use your configured Zulip connector/plugin if available.",
    "Return ONLY compact JSON with this exact shape:",
    "{\"options\":[{\"label\":\"stream / topic\",\"stream\":\"stream name\",\"topic\":\"topic name\"}],\"error\":\"\"}",
    "If you can list streams but not topics, include useful default topics such as 会议纪要.",
    "If you cannot access Zulip, return {\"options\":[],\"error\":\"reason\"}.",
  ].join("\n");
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return asRecord(parsed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start < 0 || end <= start) return null;
    try {
      return asRecord(JSON.parse(trimmed.slice(start, end + 1)));
    } catch {
      return null;
    }
  }
}

function normalizeAgentOptions(channel: "notion" | "zulip", value: unknown): DestinationOption[] {
  const root = asRecord(value);
  const rawOptions = Array.isArray(root.options) ? root.options : [];
  const out: DestinationOption[] = [];
  for (const raw of rawOptions) {
    const option = normalizeCachedOption(channel, { ...asRecord(raw), source: "agent" });
    if (option) addOption(out, option);
  }
  return out;
}

function titleFromSidecar(dir: string, stem: string, fallback: string): string {
  const path = join(dir, `${stem}.title`);
  if (!existsSync(path)) return fallback;
  try {
    const title = readFileSync(path, "utf8").trim();
    return title || fallback;
  } catch {
    return fallback;
  }
}

function dayLabel(recordedAt: string): "today" | "yesterday" | "recent" {
  const then = new Date(recordedAt);
  if (Number.isNaN(then.valueOf())) return "recent";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();
  const day = new Date(then.getFullYear(), then.getMonth(), then.getDate()).valueOf();
  const delta = Math.round((today - day) / (24 * 60 * 60 * 1000));
  if (delta <= 0) return "today";
  if (delta === 1) return "yesterday";
  return "recent";
}

function stageForRecording(
  stem: string,
  dir: string,
  hasTranscript: boolean,
  hasSummary: boolean,
  host: Pick<HostStore, "latestForRecording">,
) {
  const latestTask = host.latestForRecording(stem);
  const task = latestTask && !["cancelled", "failed"].includes(latestTask.state) ? latestTask : null;
  const taskActive = !!task && !["completed", "delivery_unverified", "execution_unverified"].includes(task.state);
  const transcribe: StageState =
    hasSummary || hasTranscript ? "done" :
    taskActive ? "running" :
    "idle";
  const summarize: StageState =
    hasSummary ? "done" :
    taskActive && task.phase !== "transcribing" && task.phase !== "queued" ? "running" :
    transcribe === "done" ? "idle" : "waiting";
  const send: StageState =
    task?.sendToNotion && task.state === "completed" ? "done" :
    task?.sendToNotion && ["sending", "delivery_reported"].includes(task.state) ? "running" :
    task?.sendToNotion && task.state === "delivery_unverified" ? "failed" :
    hasSummary ? "idle" : "waiting";
  const dest = task?.sendToNotion ? "notion" : null;
  const error = task?.error ?? "";
  return {
    stages: { record: "done" as StageState, transcribe, summarize, send },
    dest: dest as SendDest,
    error,
    hasTranscript,
    hasSummary,
    hasRealtime: existsSync(join(dir, `${stem}.realtime.transcript.txt`)),
  };
}

function recentTasks(dir: string, host: Pick<HostStore, "latestForRecording">): AgentConsoleTask[] {
  if (!existsSync(dir)) return [];
  const cutoff = Date.now() - RECENT_DAYS_MS;
  const tasks: AgentConsoleTask[] = [];
  for (const file of readdirSync(dir)) {
    const match = file.match(REC_FILE_RE);
    if (!match) continue;
    const [, rawTitle, date, time] = match;
    const stem = file.slice(0, -4);
    const wavPath = join(dir, file);
    const stat = statSync(wavPath);
    if (stat.mtimeMs < cutoff) continue;
    const recordedAt = isoFromStem(date!, time!);
    tasks.push({
      id: stem,
      stem,
      title: titleFromSidecar(dir, stem, rawTitle!),
      recordedAt,
      mtimeMs: stat.mtimeMs,
      dayLabel: dayLabel(recordedAt),
      ...stageForRecording(
        stem,
        dir,
        existsSync(join(dir, `${stem}.transcript.txt`)),
        existsSync(join(dir, `${stem}.summary.md`)) && !existsSync(join(dir, `${stem}.summary.stale`)),
        host,
      ),
    });
  }
  tasks.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return tasks;
}

async function recordingState(statusAgentSock: string) {
  try {
    const r = await ipcSend<StatusReply>(statusAgentSock, { action: "status" });
    return { state: r.state ?? "unknown", hotkey: r.hotkey ?? "?", launcherPid: r.launcher_pid };
  } catch {
    return { state: "idle", hotkey: "?", launcherPid: undefined };
  }
}

export const agentConsoleRouter = router({
  overview: publicProcedure.query(async ({ ctx }) => {
    const config = ctx.config.read();
    const runtime = resolveAgentRuntime(config, { scriptDir: ctx.paths.scriptDir, moviesDir: ctx.paths.moviesDir });
    const active = activeAgent(config, ctx.paths.scriptDir, ctx.paths.moviesDir);
    const backgroundSession = runtime.provider !== "none"
      ? ensureBackgroundAgentSession(ctx.paths.configDir, { agent: runtime.provider, runtimeLabel: runtime.label })
      : null;
    const recState = await recordingState(ctx.paths.statusAgentSock);
    const tasks = recentTasks(ctx.paths.moviesDir, ctx.host);
    if (recState.state === "recording") {
      tasks.unshift({
        id: "__active_recording__",
        stem: "",
        title: "正在录制",
        recordedAt: new Date().toISOString(),
        mtimeMs: Date.now(),
        dayLabel: "today" as const,
        stages: {
          record: "running" as StageState,
          transcribe: "idle" as StageState,
          summarize: "waiting" as StageState,
          send: "waiting" as StageState,
        },
        dest: null as SendDest,
        error: "",
        hasTranscript: false,
        hasSummary: false,
        hasRealtime: true,
      });
    }
    return {
      tasks,
      recording: recState,
      recordingAgent: ctx.recordingPipeline.transcriptionHealth(),
      activeAgent: active,
      agents: detectAgents(config, ctx.paths.scriptDir, ctx.paths.moviesDir),
      backgroundSession: backgroundSession ? {
        id: backgroundSession.id,
        agent: backgroundSession.agent,
        title: backgroundSession.title,
        updatedAt: backgroundSession.updatedAt,
      } : null,
      plugins: agentPluginOverview(config, {
        agent: active === "auto" ? runtime.provider : active,
        agentReady: !runtime.disabledReason,
      }),
      destinations: {
        notion: agentDestinationView(config, selectedConsoleAgent(config, ctx.paths.scriptDir, ctx.paths.moviesDir), "notion"),
        zulip: agentDestinationView(config, selectedConsoleAgent(config, ctx.paths.scriptDir, ctx.paths.moviesDir), "zulip"),
      },
    };
  }),

  detectAgents: publicProcedure.query(({ ctx }) => {
    const config = ctx.config.read();
    return {
      activeAgent: activeAgent(config, ctx.paths.scriptDir, ctx.paths.moviesDir),
      agents: detectAgents(config, ctx.paths.scriptDir, ctx.paths.moviesDir),
    };
  }),

  destinationOptions: publicProcedure
    .input(DESTINATION_CHANNEL_SCHEMA)
    .query(({ ctx, input }) => {
      const config = ctx.config.read();
      const agent = selectedConsoleAgent(config, ctx.paths.scriptDir, ctx.paths.moviesDir);
      return {
        agent,
        channel: input.channel,
        options: destinationOptions(config, agent, input.channel),
      };
    }),

  refreshDestinationOptions: publicProcedure
    .input(DESTINATION_CHANNEL_SCHEMA)
    .mutation(async ({ ctx, input }) => {
      const config = ctx.config.read();
      const runtime = resolveAgentRuntime(config, { scriptDir: ctx.paths.scriptDir, moviesDir: ctx.paths.moviesDir });
      const agent = selectedConsoleAgent(config, ctx.paths.scriptDir, ctx.paths.moviesDir);
      if (!agent || runtime.disabledReason) {
        return {
          ok: false as const,
          agent,
          channel: input.channel,
          error: runtime.disabledReason ?? "当前底层 Agent 不支持目标枚举",
          options: destinationOptions(config, agent, input.channel),
        };
      }
      const session = ensureBackgroundAgentSession(ctx.paths.configDir, {
        agent: runtime.provider,
        runtimeLabel: runtime.label,
      });
      const result = await runAgentCliCommand({
        runtime,
        scriptDir: ctx.paths.scriptDir,
        prompt: discoveryPrompt(input.channel),
        timeoutMs: DESTINATION_DISCOVERY_TIMEOUT_MS,
        configDir: ctx.paths.configDir,
        nativeSessionId: session.nativeSessionId,
        yuluSessionId: session.id,
      });
      if (result.nativeSessionId && result.nativeSessionId !== session.nativeSessionId) {
        updateAgentSessionNativeSession(ctx.paths.configDir, session.id, {
          nativeSessionId: result.nativeSessionId,
          runtimeLabel: runtime.label,
        });
      }
      const parsed = parseJsonObject(result.stdout || result.stderr);
      const options = normalizeAgentOptions(input.channel, parsed);
      const error = stringValue(asRecord(parsed), "error") || (result.code === 0 ? "" : (result.stderr || result.stdout || "Agent 目标枚举失败").trim());
      if (result.code === 0 && options.length > 0) {
        ctx.config.update(`agent_console.destination_options.${agent}.${input.channel}`, options.map((option) => ({
          label: option.label,
          value: option.value,
          target: option.target,
          stream: option.stream,
          topic: option.topic,
          kind: option.kind,
          source: "agent",
        })));
      }
      const nextConfig = ctx.config.read();
      return {
        ok: result.code === 0 && options.length > 0,
        agent,
        channel: input.channel,
        error,
        options: destinationOptions(nextConfig, agent, input.channel),
      };
    }),

  updateCalendarConfig: publicProcedure
    .input(CALENDAR_CONFIG_SCHEMA)
    .mutation(async ({ ctx, input }) => {
      const result = ctx.config.update(input.key, input.value);
      const restartErrors: string[] = [];
      for (const daemon of result.daemonsNeedingRestart) {
        if (daemon !== "calendar" && daemon !== "scheduler") continue;
        try {
          await ctx.launchctl.restart(`com.yulu.${daemon}`);
        } catch (exc) {
          restartErrors.push(`${daemon}: ${(exc as Error).message}`);
        }
      }
      return {
        ...result,
        restartErrors,
      };
    }),

  connectAgent: uiMutationProcedure
    .input(CONNECT_AGENT_SCHEMA)
    .mutation(({ ctx, input }) => {
      const current = ctx.config.read();
      return {
        ok: false as const,
        error: `${AGENT_META[input.agent].name} is a Connection Candidate. Use Agent Connection Center after a supported production adapter is available.`,
        activeAgent: activeAgent(current, ctx.paths.scriptDir, ctx.paths.moviesDir),
        agents: detectAgents(current, ctx.paths.scriptDir, ctx.paths.moviesDir),
      };
    }),

  addPlugin: publicProcedure
    .input(PLUGIN_SCHEMA)
    .mutation(({ ctx, input }) => {
      const next = withAddedPlugin(ctx.config.read(), input.plugin as AgentPluginId);
      ctx.config.update("agent_console.plugins.added", next);
      return { ok: true, added: next };
    }),

  removePlugin: publicProcedure
    .input(PLUGIN_SCHEMA)
    .mutation(({ ctx, input }) => {
      const current = addedPluginIds(ctx.config.read());
      const next = withoutAddedPlugin(ctx.config.read(), input.plugin as AgentPluginId);
      if (input.plugin === "summary") return { ok: false, added: current, error: "summary is a core capability" };
      ctx.config.update("agent_console.plugins.added", next);
      return { ok: true, added: next };
    }),

  configurePlugin: publicProcedure
    .input(PLUGIN_SCHEMA)
    .mutation(({ ctx, input }) => {
      const config = ctx.config.read();
      const active = activeAgent(config, ctx.paths.scriptDir, ctx.paths.moviesDir);
      const runtime = resolveAgentRuntime(config, { scriptDir: ctx.paths.scriptDir, moviesDir: ctx.paths.moviesDir });
      return configurePluginAction(active === "auto" ? runtime.provider : active, input.plugin as AgentPluginId);
    }),

  setDestination: publicProcedure
    .input(DESTINATION_SCHEMA)
    .mutation(({ ctx, input }) => {
      const config = ctx.config.read();
      const agent = selectedConsoleAgent(config, ctx.paths.scriptDir, ctx.paths.moviesDir);
      if (!agent) return { ok: false as const, error: "当前底层 Agent 不支持保存发送目标" };
      if (input.channel === "notion") {
        ctx.config.update(`agent_console.destinations.${agent}.notion.target`, input.target);
        if (agent === "hermes") {
          ctx.config.update("agent_pipeline.notion_destination", input.target);
        }
      } else {
        ctx.config.update(`agent_console.destinations.${agent}.zulip.stream`, input.stream);
        ctx.config.update(`agent_console.destinations.${agent}.zulip.topic`, input.topic);
      }
      const next = ctx.config.read();
      return {
        ok: true as const,
        agent,
        destinations: {
          notion: agentDestinationView(next, agent, "notion"),
          zulip: agentDestinationView(next, agent, "zulip"),
        },
      };
    }),
});
