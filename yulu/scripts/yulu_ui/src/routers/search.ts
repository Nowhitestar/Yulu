import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

const exec = promisify(execFile) as (cmd: string, args: string[], opts?: object) => Promise<{ stdout: string; stderr: string }>;

const ALLOWED_KINDS = ["meeting_summary", "meeting_transcript", "voicemail_summary", "voicemail_transcript"] as const;

const DEFAULT_SCRIPT_DIR = "/Users/liaoyuxing/.yulu/yulu/scripts";

function pyEnv(): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONPATH: process.env.YULU_SCRIPT_DIR ?? DEFAULT_SCRIPT_DIR };
}

export const searchRouter = router({
  run: publicProcedure
    .input(z.object({
      query: z.string().min(1).max(200),
      since: z.string().optional(),
      kinds: z.array(z.enum(ALLOWED_KINDS)).optional(),
      limit: z.number().int().positive().max(100).optional(),
    }))
    .query(async ({ input }) => {
      const args = ["-m", "search.cli", "--json", input.query];
      if (input.since) args.push("--since", input.since);
      if (input.kinds && input.kinds.length === 1) {
        const [kindOnly] = input.kinds;
        const [t, layer] = kindOnly!.split("_");
        args.push("--type", t!, "--in", layer!);
      }
      if (input.limit !== undefined) args.push("--limit", String(input.limit));
      const { stdout } = await exec("python3", args, {
        env: pyEnv(),
        cwd: process.env.HOME,
      });
      return JSON.parse(stdout) as { hits: unknown[]; telemetry: Record<string, unknown> };
    }),

  reindex: publicProcedure.mutation(async () => {
    await exec("python3", ["-m", "search.cli", "--reindex"], { env: pyEnv() });
    return { ok: true };
  }),

  doctor: publicProcedure.query(async () => {
    const { stdout } = await exec("python3", ["-m", "search.cli", "--doctor"], { env: pyEnv() });
    return JSON.parse(stdout);
  }),
});
