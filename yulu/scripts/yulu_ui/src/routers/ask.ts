import { existsSync, readFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { runLlmCommand } from "../llmCommand.js";
import { runSearchCli, type SearchHit } from "./search.js";
import { notionMcpCredentialStatus } from "../notionMcpOAuth.js";
import { commandPreview, resolveAgentRuntime, type AgentRuntime } from "../agentRuntime.js";

const MAX_QUESTION_CHARS = 2_000;
const DEFAULT_SOURCE_COUNT = 8;
const MAX_SOURCE_COUNT = 12;
const MAX_SOURCE_CHARS = 4_000;
const MAX_TOTAL_CONTEXT_CHARS = 18_000;
const MAX_SEARCH_QUERY_COUNT = 8;
const LLM_TIMEOUT_MS = 120_000;

interface AskSource {
  kind: string;
  stem: string;
  title: string;
  recordedAt: string;
  sourcePath: string;
  snippet: string;
  excerpt: string;
  url: string;
}

interface ConnectorOutputContext {
  channel: "notion" | "zulip";
  label: string;
  enabled: boolean;
  destination: string;
  connected: boolean;
  contextStatus: string;
}

interface CalendarContext {
  configured: number;
  enabled: number;
  schedulerRequired: true;
  schedulerMode: "native";
  schedulerProvider: string;
  schedulerStatus: string;
  calendars: Array<{
    type: string;
    enabled: boolean;
    account: string;
    watchCalendars: string[];
  }>;
  upcomingMeetings: Array<{
    id: string;
    title: string;
    start: string;
    end: string;
  }>;
}

interface ConnectorContext {
  calendar: CalendarContext;
  outputs: ConnectorOutputContext[];
}

interface AskAgentContext {
  provider: AgentRuntime["provider"];
  label: string;
  source: AgentRuntime["source"];
  commandPreview: string;
  cwd: string;
  status: "ready" | "disabled" | "missing";
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function nestedRecord(root: Record<string, unknown>, key: string): Record<string, unknown> {
  return asRecord(root[key]);
}

function stringValue(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value.trim() : "";
}

function boolValue(record: Record<string, unknown>, key: string): boolean {
  return record[key] === true;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
}

function readJson(path: string): unknown {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function stripHitMarkers(value: string): string {
  return value.replace(/\[\/?hit\]/g, "");
}

function uniquePush(out: string[], seen: Set<string>, value: string): void {
  const q = value.replace(/\s+/g, " ").trim();
  const key = q.toLowerCase();
  if (!q || seen.has(key)) return;
  seen.add(key);
  out.push(q);
}

function extractLatinTerms(question: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const matches = question.normalize("NFKC").matchAll(/[@#]?[A-Za-z][A-Za-z0-9_.-]{1,}/g);
  for (const match of matches) {
    const raw = match[0].replace(/^[@#]/, "");
    if (raw.length < 2) continue;
    uniquePush(terms, seen, raw);
    if (terms.length >= 5) break;
  }
  return terms;
}

function extractCjkTerms(question: string): string[] {
  const terms: string[] = [];
  const seen = new Set<string>();
  const cleaned = question
    .normalize("NFKC")
    .replace(/[@#]?[A-Za-z][A-Za-z0-9_.-]{1,}/g, " ")
    .replace(
      /(什么|哪些|怎么|如何|有没有|是否|主要|帮我|请问|一下|总结|归纳|聊了|聊聊|聊天|讨论|提到|说了|关于|相关|会议|内容|资料|记录|历史|还有|以及|或者|和我|我们|我的|我|你|他|她|它|的|了|吗|呢|吧|啊|与|和|及)/g,
      " ",
    )
    .replace(/[^\p{Script=Han}\s]/gu, " ");
  for (const chunk of cleaned.split(/\s+/)) {
    if (chunk.length < 2) continue;
    uniquePush(terms, seen, chunk);
    if (chunk.length > 4) {
      uniquePush(terms, seen, chunk.slice(0, 4));
      uniquePush(terms, seen, chunk.slice(-4));
    }
    if (terms.length >= 5) break;
  }
  return terms;
}

function planSearchQueries(question: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const normalized = question.normalize("NFKC").trim();
  const latinTerms = extractLatinTerms(normalized);
  const cjkTerms = extractCjkTerms(normalized);
  const salientTerms = [...latinTerms, ...cjkTerms];

  uniquePush(out, seen, normalized);
  for (const term of salientTerms) uniquePush(out, seen, term);
  if (latinTerms.length >= 2) uniquePush(out, seen, latinTerms.slice(0, 3).join(" "));
  if (cjkTerms.length >= 2) uniquePush(out, seen, cjkTerms.slice(0, 3).join(" "));
  if (latinTerms.length > 0 && cjkTerms.length > 0) {
    uniquePush(out, seen, [latinTerms[0], cjkTerms[0]].join(" "));
  }
  return out.slice(0, MAX_SEARCH_QUERY_COUNT);
}

function firstHitText(snippet: string): string {
  const m = snippet.match(/\[hit\]([\s\S]*?)\[\/hit\]/);
  const marked = m?.[1]?.trim();
  if (marked) return marked;
  return stripHitMarkers(snippet).trim().slice(0, 80);
}

function hitTab(kind: string): "summary" | "transcript" | null {
  if (kind.endsWith("_summary") || kind === "summary") return "summary";
  if (kind.endsWith("_transcript") || kind === "transcript") return "transcript";
  return null;
}

function sourceUrl(hit: SearchHit): string {
  const params = new URLSearchParams();
  const tab = hitTab(hit.kind);
  const marker = firstHitText(hit.snippet);
  if (tab) params.set("tab", tab);
  if (marker) params.set("snippet", marker);
  const qs = params.toString();
  return `/inbox/${hit.stem}${qs ? `?${qs}` : ""}`;
}

function readSourceExcerpt(hit: SearchHit, moviesDir: string): string {
  if (!hit.sourcePath || !isInside(moviesDir, hit.sourcePath)) return stripHitMarkers(hit.snippet);
  try {
    const raw = readFileSync(hit.sourcePath, "utf8").trim();
    if (!raw) return stripHitMarkers(hit.snippet);
    return raw.length > MAX_SOURCE_CHARS ? `${raw.slice(0, MAX_SOURCE_CHARS)}\n...` : raw;
  } catch {
    return stripHitMarkers(hit.snippet);
  }
}

function buildSources(hits: SearchHit[], moviesDir: string): AskSource[] {
  const seen = new Set<string>();
  const out: AskSource[] = [];
  for (const hit of hits) {
    const key = `${hit.kind}:${hit.sourcePath || hit.stem}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      kind: hit.kind,
      stem: hit.stem,
      title: hit.meetingTitle || hit.stem,
      recordedAt: hit.recordedAt,
      sourcePath: hit.sourcePath,
      snippet: stripHitMarkers(hit.snippet),
      excerpt: readSourceExcerpt(hit, moviesDir),
      url: sourceUrl(hit),
    });
    if (out.length >= MAX_SOURCE_COUNT) break;
  }
  return out;
}

function mergeSearchHits(results: Array<{ query: string; hits: SearchHit[] }>, maxHits: number): SearchHit[] {
  const best = new Map<string, { hit: SearchHit; rank: number; score: number }>();
  for (const [queryIndex, result] of results.entries()) {
    for (const [hitIndex, hit] of result.hits.entries()) {
      const key = `${hit.kind}:${hit.sourcePath || hit.stem}`;
      const score = Number(hit.score ?? 0) + Math.max(0, 20 - queryIndex * 2) - hitIndex * 0.01;
      const current = best.get(key);
      if (!current || score > current.score) {
        best.set(key, { hit, rank: queryIndex, score });
      }
    }
  }
  return Array.from(best.values())
    .sort((a, b) => a.rank - b.rank || b.score - a.score)
    .map((entry) => entry.hit)
    .slice(0, maxHits);
}

async function retrieveMeetingContext(
  question: string,
  limit: number,
  scriptDir: string,
) {
  const plannedQueries = planSearchQueries(question);
  const perQuery: Array<{ query: string; hitCount: number; error?: string }> = [];
  const resultSets: Array<{ query: string; hits: SearchHit[] }> = [];
  let firstSearch: Awaited<ReturnType<typeof runSearchCli>> | null = null;
  for (const query of plannedQueries) {
    try {
      const result = await runSearchCli({ query, limit: Math.min(24, Math.max(limit * 2, 8)) }, scriptDir);
      if (!firstSearch) firstSearch = result;
      perQuery.push({ query, hitCount: result.hits.length });
      resultSets.push({ query, hits: result.hits });
    } catch (exc) {
      perQuery.push({ query, hitCount: 0, error: (exc as Error).message });
    }
  }
  const hits = mergeSearchHits(resultSets, limit);
  return {
    ok: firstSearch?.ok,
    hits,
    elapsedMs: firstSearch?.elapsedMs,
    fallbackUsed: firstSearch?.fallbackUsed ?? false,
    telemetry: {
      ...(firstSearch?.telemetry ?? {}),
      plannedQueries,
      perQuery,
      mergedHitCount: hits.length,
    },
  };
}

function outputDestination(config: unknown, channel: "notion" | "zulip"): string {
  const output = nestedRecord(asRecord(config), "output");
  if (channel === "notion") {
    const notion = nestedRecord(output, "notion");
    return stringValue(notion, "destination_label")
      || stringValue(notion, "destination_id")
      || stringValue(notion, "database_id");
  }
  const zulip = nestedRecord(output, "zulip");
  return [stringValue(zulip, "stream"), stringValue(zulip, "topic")].filter(Boolean).join(" / ");
}

function expandHome(path: string): string {
  if (path === "~") return process.env.HOME || path;
  if (path.startsWith("~/")) return join(process.env.HOME || "", path.slice(2));
  return path;
}

function connectorEnabled(config: unknown, channel: "notion" | "zulip"): boolean {
  const connectors = nestedRecord(asRecord(config), "connectors");
  return boolValue(nestedRecord(connectors, channel), "send_summary");
}

function outputContext(config: unknown, configDir: string, channel: "notion" | "zulip"): ConnectorOutputContext {
  const enabled = connectorEnabled(config, channel);
  const destination = outputDestination(config, channel) || "未设置";
  if (channel === "notion") {
    const status = notionMcpCredentialStatus(configDir);
    return {
      channel,
      label: "Notion",
      enabled,
      destination,
      connected: status.connected,
      contextStatus: status.connected ? "OAuth token stored; remote reads belong to the Agent MCP runtime" : status.detail,
    };
  }

  const output = nestedRecord(asRecord(config), "output");
  const zulip = nestedRecord(output, "zulip");
  const zuliprc = stringValue(zulip, "zuliprc") || "~/.zuliprc";
  const hasZuliprc = existsSync(expandHome(zuliprc));
  return {
    channel,
    label: "Zulip",
    enabled,
    destination,
    connected: hasZuliprc,
    contextStatus: hasZuliprc ? `${zuliprc} found; remote reads belong to the Agent MCP runtime` : `${zuliprc} not found`,
  };
}

function calendarContext(config: unknown, configDir: string): CalendarContext {
  const root = asRecord(config);
  const calendarsRaw = Array.isArray(root.calendars) ? root.calendars : [];
  const calendars = calendarsRaw.map((item) => {
    const cal = asRecord(item);
    const watch = Array.isArray(cal.watch_calendars)
      ? cal.watch_calendars.map(String).filter(Boolean)
      : [];
    return {
      type: String(cal.type ?? ""),
      enabled: cal.enabled === true,
      account: stringValue(cal, "gog_account"),
      watchCalendars: watch,
    };
  });

  const schedule = asRecord(readJson(join(configDir, "schedule.json")));
  const meetingsRaw = Array.isArray(schedule.meetings) ? schedule.meetings : [];
  const upcomingMeetings = meetingsRaw
    .map((item) => {
      const meeting = asRecord(item);
      return {
        id: String(meeting.id ?? ""),
        title: String(meeting.title ?? ""),
        start: String(meeting.start ?? ""),
        end: String(meeting.end ?? ""),
      };
    })
    .filter((meeting) => meeting.title || meeting.start)
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, 12);

  const enabledSystem = calendars.find((cal) => (cal.type === "macos" || cal.type === "system") && cal.enabled);
  const enabledGoogle = calendars.find((cal) => cal.type === "google" && cal.enabled);
  const provider = enabledSystem
    ? "macOS system Calendar"
    : enabledGoogle
      ? "gog legacy provider"
      : "native scheduler pending provider configuration";
  const status = enabledSystem
    ? "watching macOS system Calendar for native scheduling"
    : enabledGoogle
      ? `watching ${enabledGoogle.watchCalendars.length || 1} Google calendar(s) for native scheduling`
      : "native scheduler is required by default, but no calendar provider is enabled";

  return {
    configured: calendars.length,
    enabled: calendars.filter((cal) => cal.enabled).length,
    schedulerRequired: true,
    schedulerMode: "native",
    schedulerProvider: provider,
    schedulerStatus: status,
    calendars,
    upcomingMeetings,
  };
}

function connectorContext(config: unknown, configDir: string): ConnectorContext {
  return {
    calendar: calendarContext(config, configDir),
    outputs: [outputContext(config, configDir, "notion"), outputContext(config, configDir, "zulip")],
  };
}

function sourceContextBlock(sources: AskSource[]): string {
  let used = 0;
  const blocks: string[] = [];
  for (const [idx, source] of sources.entries()) {
    const remaining = MAX_TOTAL_CONTEXT_CHARS - used;
    if (remaining <= 0) break;
    const excerpt = source.excerpt.slice(0, remaining);
    used += excerpt.length;
    blocks.push([
      `[Source ${idx + 1}]`,
      `title: ${source.title}`,
      `kind: ${source.kind}`,
      `recorded_at: ${source.recordedAt || "unknown"}`,
      `url: ${source.url}`,
      "content:",
      excerpt,
    ].join("\n"));
  }
  return blocks.join("\n\n");
}

function connectorContextBlock(context: ConnectorContext): string {
  const lines = [
    "connector_scope: Yulu UI supplies local meeting corpus and local connector status; the selected Agent CLI may use its own MCP connectors for remote read-only context.",
    "remote_connector_query: delegate to Agent MCP connectors when available; Yulu UI must not implement separate Notion/Zulip/Google readers for Ask.",
    "scheduler_boundary: Yulu owns native calendar scheduling by default; Agent owns AI context.",
    `calendar_configured: ${context.calendar.configured}`,
    `calendar_enabled: ${context.calendar.enabled}`,
    `calendar_scheduler: required=${context.calendar.schedulerRequired} mode=${context.calendar.schedulerMode} provider=${context.calendar.schedulerProvider} status=${context.calendar.schedulerStatus}`,
    `calendar_meetings: ${context.calendar.upcomingMeetings.map((m) => `${m.start} ${m.title}`).join(" | ") || "none"}`,
    ...context.outputs.map((output) =>
      `${output.channel}: ${output.enabled ? "enabled" : "disabled"} connected=${output.connected ? "yes" : "no"} destination=${output.destination} status=${output.contextStatus}`,
    ),
  ];
  return lines.join("\n");
}

function agentContext(runtime: AgentRuntime): AskAgentContext {
  const status = runtime.disabledReason
    ? runtime.source === "disabled" ? "disabled" : "missing"
    : "ready";
  return {
    provider: runtime.provider,
    label: runtime.label,
    source: runtime.source,
    commandPreview: commandPreview(runtime),
    cwd: runtime.cwd,
    status,
  };
}

function agentContextBlock(agent: AskAgentContext): string {
  return [
    `agent_label: ${agent.label}`,
    `agent_provider: ${agent.provider}`,
    `agent_source: ${agent.source}`,
    `agent_status: ${agent.status}`,
    `agent_cwd: ${agent.cwd}`,
    `agent_command: ${agent.commandPreview || "none"}`,
  ].join("\n");
}

function buildPrompt(
  question: string,
  sources: AskSource[],
  connectors: ConnectorContext,
  agent: AskAgentContext,
): string {
  return [
    "你是 Yulu 的本地会议资料库助手，运行在用户自己的 Agent CLI 中。",
    "",
    "规则：",
    "- 用用户问题的语言回答。",
    "- 优先根据下方本地会议资料回答；这些资料来自 Yulu 本地索引。",
    "- 如果你的 Agent 已配置 Google Calendar、Notion、Zulip 等 MCP connector，可以只读查询它们补充上下文。",
    "- 不要创建、编辑、发送或删除远端内容；这次是只读问答。",
    "- 不要声称 Yulu UI 已经直接检索了远端 Notion/Zulip/Google；远端上下文只可能来自当前 Agent。",
    "- 如果证据不足，直接说还没有足够会议资料，并指出你能看到的相关来源。",
    "- 回答要紧凑，优先给结论，再列关键证据。",
    "",
    "当前 Agent Runtime：",
    agentContextBlock(agent),
    "",
    "只读 Connector 上下文：",
    connectorContextBlock(connectors),
    "",
    "会议资料来源：",
    sources.length > 0 ? sourceContextBlock(sources) : "none",
    "",
    "用户问题：",
    question,
  ].join("\n");
}

function fallbackAnswer(question: string, sources: AskSource[], reason: string): string {
  const sourceLines = sources.slice(0, 5).map((source, idx) =>
    `${idx + 1}. ${source.title}${source.recordedAt ? ` (${source.recordedAt})` : ""}: ${source.snippet}`,
  );
  if (sources.length === 0) {
    return `暂时不能生成自然语言回答：${reason}\n\n我也没有在本地会议索引里找到和“${question}”直接相关的结果。`;
  }
  return [
    `暂时不能生成自然语言回答：${reason}`,
    "",
    `我已经先从本地会议资料里找到了 ${sources.length} 条相关来源：`,
    ...sourceLines,
  ].join("\n");
}

export const askRouter = router({
  ask: publicProcedure
    .input(z.object({
      question: z.string().trim().min(1).max(MAX_QUESTION_CHARS),
      limit: z.number().int().positive().max(MAX_SOURCE_COUNT).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const startedAt = Date.now();
      const config = ctx.config.read();
      const search = await retrieveMeetingContext(
        input.question,
        input.limit ?? DEFAULT_SOURCE_COUNT,
        ctx.paths.scriptDir,
      );
      const sources = buildSources(search.hits, ctx.paths.moviesDir);
      const connectors = connectorContext(config, ctx.paths.configDir);
      const runtime = resolveAgentRuntime(config, {
        scriptDir: ctx.paths.scriptDir,
        moviesDir: ctx.paths.moviesDir,
      });
      const agent = agentContext(runtime);
      if (runtime.disabledReason) {
        return {
          ok: true,
          answer: fallbackAnswer(input.question, sources, runtime.disabledReason),
          sources,
          connectorContext: connectors,
          agentRuntime: agent,
          usedFallback: true,
          llmStatus: runtime.source === "disabled" ? "disabled" : "not_configured",
          llmError: runtime.disabledReason,
          search,
          elapsedMs: Date.now() - startedAt,
        };
      }

      const prompt = buildPrompt(input.question, sources, connectors, agent);
      const result = await runLlmCommand(runtime.command, ctx.paths.scriptDir, prompt, LLM_TIMEOUT_MS, runtime.cwd);
      const answer = result.stdout.trim();
      if (result.code !== 0 || !answer) {
        const err = (result.stderr || result.stdout || `llm.command exited ${result.code}`).trim();
        return {
          ok: true,
          answer: fallbackAnswer(input.question, sources, err || "llm.command produced empty output"),
          sources,
          connectorContext: connectors,
          agentRuntime: agent,
          usedFallback: true,
          llmStatus: "error",
          llmError: err,
          search,
          elapsedMs: Date.now() - startedAt,
        };
      }

      return {
        ok: true,
        answer,
        sources,
        connectorContext: connectors,
        agentRuntime: agent,
        usedFallback: false,
        llmStatus: "ok",
        llmError: null,
        search,
        elapsedMs: Date.now() - startedAt,
      };
    }),
});
