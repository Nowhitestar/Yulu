import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { daemonLogPath, YULU_DAEMONS } from "../daemonLogs.js";

const DaemonName = z.enum(YULU_DAEMONS);

export const logsRouter = router({
  tail: publicProcedure
    .input(z.object({ name: DaemonName, limit: z.number().int().positive().max(2_000).default(200) }))
    .query(({ ctx, input }) => {
      const path = daemonLogPath(input.name, ctx.paths.logsDir, ctx.paths.legacyReadOnlyDataDir);
      if (!existsSync(path)) return { lines: [] as string[], path };
      const text = readFileSync(path, "utf8");
      const lines = text.split("\n").filter(Boolean);
      return { lines: lines.slice(-input.limit), path };
    }),
});
