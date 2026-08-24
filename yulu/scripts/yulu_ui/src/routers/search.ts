import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

const exec = promisify(execFile) as (cmd: string, args: string[], opts?: object) => Promise<{ stdout: string; stderr: string }>;

export const ALLOWED_KINDS = ["meeting_summary", "meeting_transcript"] as const;
type SearchKind = typeof ALLOWED_KINDS[number];

export interface SearchHit {
  kind: SearchKind | string;
  stem: string;
  meetingTitle: string;
  recordedAt: string;
  sourcePath: string;
  score: number;
  snippet: string;
}

export interface SearchResponse {
  ok?: boolean;
  hits: SearchHit[];
  elapsedMs?: number;
  fallbackUsed?: boolean;
  telemetry: Record<string, unknown>;
}

export interface ConversationSource {
  ref: number;
  kind: SearchKind;
  stem: string;
  title: string;
  recordedAt: string;
  sourcePath: string;
  snippet: string;
  url: string;
}

const MAX_CONVERSATION_SOURCES = 8;
const MAX_CONVERSATION_EXCERPT_CHARS = 1_200;
const MAX_CONVERSATION_CONTEXT_CHARS = 6_000;
const MAX_CONVERSATION_TITLE_CHARS = 200;
const MAX_CONVERSATION_RECORDED_AT_CHARS = 64;

function boundedText(value: string, maxChars: number): string {
  let text = value.slice(0, maxChars);
  if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
  return text.trim();
}

function cleanedText(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function formatConversationSource(source: ConversationSource): string {
  return [
    `[${source.ref}]`,
    `Meeting: ${source.title}`,
    `Recorded: ${source.recordedAt || "unknown"}`,
    `Kind: ${source.kind}`,
    `Excerpt: ${source.snippet}`,
  ].join("\n");
}

export function formatConversationSources(sources: ConversationSource[]): string {
  return sources.map(formatConversationSource).join("\n\n");
}

export function normalizeConversationSources(hits: SearchHit[]): ConversationSource[] {
  const sources: ConversationSource[] = [];
  const seen = new Set<string>();
  let remainingChars = MAX_CONVERSATION_CONTEXT_CHARS;
  for (const hit of hits) {
    if (sources.length >= MAX_CONVERSATION_SOURCES || remainingChars === 0) break;
    if (!ALLOWED_KINDS.includes(hit.kind as SearchKind)) continue;
    const kind = hit.kind as SearchKind;
    const stem = hit.stem.trim();
    const key = `${stem}\u0000${kind}`;
    if (!stem || seen.has(key)) continue;
    const title = boundedText(
      cleanedText(hit.meetingTitle) || stem,
      MAX_CONVERSATION_TITLE_CHARS,
    );
    const recordedAt = boundedText(cleanedText(hit.recordedAt), MAX_CONVERSATION_RECORDED_AT_CHARS);
    const ref = sources.length + 1;
    const sourceFrameChars = formatConversationSource({
      ref,
      kind,
      stem,
      title,
      recordedAt,
      sourcePath: hit.sourcePath,
      snippet: "",
      url: `/inbox/${encodeURIComponent(stem)}`,
    }).length + (sources.length > 0 ? 2 : 0);
    const snippetBudget = Math.min(MAX_CONVERSATION_EXCERPT_CHARS, remainingChars - sourceFrameChars);
    if (snippetBudget <= 0) continue;
    const cleaned = cleanedText(hit.snippet.replace(/\[\/?hit\]/gi, ""));
    const snippet = boundedText(cleaned, snippetBudget);
    if (!snippet) continue;
    seen.add(key);
    remainingChars -= sourceFrameChars + snippet.length;
    sources.push({
      ref,
      kind,
      stem,
      title,
      recordedAt,
      sourcePath: hit.sourcePath,
      snippet,
      url: `/inbox/${encodeURIComponent(stem)}`,
    });
  }
  return sources;
}

function normalizeHit(raw: Record<string, unknown>): SearchHit {
  return {
    kind: String(raw.kind ?? ""),
    stem: String(raw.stem ?? ""),
    meetingTitle: String(raw.meetingTitle ?? raw.meeting_title ?? ""),
    recordedAt: String(raw.recordedAt ?? raw.recorded_at ?? ""),
    sourcePath: String(raw.sourcePath ?? raw.source_path ?? ""),
    score: Number(raw.score ?? 0),
    snippet: String(raw.snippet ?? ""),
  };
}

function normalizeTelemetry(raw: Record<string, unknown> | undefined): Record<string, unknown> {
  const t = raw ?? {};
  return {
    ...t,
    sweepMs: t.sweepMs ?? t.sweep_ms,
    queryMs: t.queryMs ?? t.query_ms,
    fallbackUsed: t.fallbackUsed ?? t.fallback_used,
    hitCount: t.hitCount ?? t.hit_count,
  };
}

function normalizeSearchResponse(raw: unknown): SearchResponse {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const hits = Array.isArray(obj.hits)
    ? obj.hits.map((hit) => normalizeHit((hit && typeof hit === "object" ? hit : {}) as Record<string, unknown>))
    : [];
  return {
    ok: typeof obj.ok === "boolean" ? obj.ok : undefined,
    hits,
    elapsedMs: Number(obj.elapsedMs ?? obj.elapsed_ms ?? 0),
    fallbackUsed: Boolean(obj.fallbackUsed ?? obj.fallback_used ?? false),
    telemetry: normalizeTelemetry(obj.telemetry as Record<string, unknown> | undefined),
  };
}

// PYTHONPATH points at the install's scriptDir (resolved by paths.ts) so `search.cli`
// is importable. No hardcoded/personal fallback path — the script dir always comes
// from ctx, mirroring capabilities.ts / system.ts.
function pyEnv(scriptDir: string): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONPATH: scriptDir };
}

export async function runSearchCli(
  input: {
    query: string;
    since?: string;
    kinds?: SearchKind[];
    limit?: number;
  },
  scriptDir: string,
): Promise<SearchResponse> {
  const args = ["-m", "search.cli", "--json", input.query];
  if (input.since) args.push("--since", input.since);
  if (input.kinds && input.kinds.length === 1) {
    const [kindOnly] = input.kinds;
    const [t, layer] = kindOnly!.split("_");
    args.push("--type", t!, "--in", layer!);
  }
  if (input.limit !== undefined) args.push("--limit", String(input.limit));
  const { stdout } = await exec("python3", args, {
    env: pyEnv(scriptDir),
    cwd: process.env.HOME,
  });
  return normalizeSearchResponse(JSON.parse(stdout));
}

export const searchRouter = router({
  run: publicProcedure
    .input(z.object({
      query: z.string().min(1).max(200),
      since: z.string().optional(),
      kinds: z.array(z.enum(ALLOWED_KINDS)).optional(),
      limit: z.number().int().positive().max(100).optional(),
    }))
    .query(async ({ input, ctx }) => runSearchCli(input, ctx.paths.scriptDir)),

  reindex: publicProcedure.mutation(async ({ ctx }) => {
    await exec("python3", ["-m", "search.cli", "--reindex"], { env: pyEnv(ctx.paths.scriptDir) });
    return { ok: true };
  }),

  doctor: publicProcedure.query(async ({ ctx }) => {
    const { stdout } = await exec("python3", ["-m", "search.cli", "--doctor"], { env: pyEnv(ctx.paths.scriptDir) });
    return JSON.parse(stdout);
  }),
});
