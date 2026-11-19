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
