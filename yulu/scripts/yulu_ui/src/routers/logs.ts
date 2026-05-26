import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { YULU_DAEMONS } from "./daemons.js";

const DaemonName = z.enum(YULU_DAEMONS);

export const logsRouter = router({
  tail: publicProcedure
    .input(z.object({ name: DaemonName, limit: z.number().int().positive().max(2_000).default(200) }))
    .query(({ ctx, input }) => {
      const short = input.name.replace(/^com\.yulu\./, "");
      const path = join(ctx.paths.configDir, `${short}.log`);
      if (!existsSync(path)) return { lines: [] as string[], path };
      const text = readFileSync(path, "utf8");
      const lines = text.split("\n").filter(Boolean);
      return { lines: lines.slice(-input.limit), path };
    }),
});
