import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

const exec = promisify(execFile) as (cmd: string, args: string[], opts?: object) => Promise<{ stdout: string; stderr: string }>;

const ALLOWED_KINDS = ["meeting_summary", "meeting_transcript", "voicemail_summary", "voicemail_transcript"] as const;

// PYTHONPATH points at the install's scriptDir (resolved by paths.ts) so `search.cli`
// is importable. No hardcoded/personal fallback path — the script dir always comes
// from ctx, mirroring capabilities.ts / system.ts.
function pyEnv(scriptDir: string): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONPATH: scriptDir };
}

export const searchRouter = router({
  run: publicProcedure
    .input(z.object({
      query: z.string().min(1).max(200),
      since: z.string().optional(),
      kinds: z.array(z.enum(ALLOWED_KINDS)).optional(),
      limit: z.number().int().positive().max(100).optional(),
    }))
    .query(async ({ input, ctx }) => {
      const args = ["-m", "search.cli", "--json", input.query];
      if (input.since) args.push("--since", input.since);
      if (input.kinds && input.kinds.length === 1) {
        const [kindOnly] = input.kinds;
        const [t, layer] = kindOnly!.split("_");
        args.push("--type", t!, "--in", layer!);
      }
      if (input.limit !== undefined) args.push("--limit", String(input.limit));
      const { stdout } = await exec("python3", args, {
        env: pyEnv(ctx.paths.scriptDir),
        cwd: process.env.HOME,
      });
      return JSON.parse(stdout) as { hits: unknown[]; telemetry: Record<string, unknown> };
    }),

  reindex: publicProcedure.mutation(async ({ ctx }) => {
    await exec("python3", ["-m", "search.cli", "--reindex"], { env: pyEnv(ctx.paths.scriptDir) });
    return { ok: true };
  }),

  doctor: publicProcedure.query(async ({ ctx }) => {
    const { stdout } = await exec("python3", ["-m", "search.cli", "--doctor"], { env: pyEnv(ctx.paths.scriptDir) });
    return JSON.parse(stdout);
  }),
});
