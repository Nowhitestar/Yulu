import { readFileSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

export const YULU_DAEMONS = [
  "com.yulu.audiodaemon",
  "com.yulu.sttdaemon",
  "com.yulu.agentqueue",
  "com.yulu.statusagent",
  "com.yulu.scheduler",
  "com.yulu.detector",
  "com.yulu.calendar",
  "com.yulu.ui",
] as const;

type YuluDaemon = typeof YULU_DAEMONS[number];
const DaemonName = z.enum(YULU_DAEMONS);

function logPath(name: YuluDaemon, configDir: string): string {
  const short = name.replace(/^com\.yulu\./, "");
  return join(configDir, `${short === "ui" ? "ui" : short}.log`);
}

export const daemonsRouter = router({
  health: publicProcedure.query(async ({ ctx }) => {
    const out = [];
    for (const name of YULU_DAEMONS) {
      const s = await ctx.launchctl.status(name);
      const log = logPath(name, ctx.paths.configDir);
      let lastLog = "";
      if (existsSync(log)) {
        const stat = statSync(log);
        if (stat.size > 0) {
          const buf = readFileSync(log, "utf8");
          lastLog = buf.split("\n").filter(Boolean).slice(-1)[0] ?? "";
        }
      }
      out.push({
        name,
        status: (!s || s.pid === 0 ? "stopped" : s.exitStatus !== 0 ? "crashed" : "running") as "stopped" | "crashed" | "running",
        pid: s?.pid ?? 0,
        exitStatus: s?.exitStatus ?? 0,
        lastLog,
      });
    }
    return out;
  }),

  restart: publicProcedure
    .input(z.object({ name: DaemonName }))
    .mutation(async ({ ctx, input }) => {
      await ctx.launchctl.restart(input.name);
      ctx.pubsub.publish("daemons", { name: input.name, status: "running", pid: 0 });
      return { ok: true };
    }),

  stop: publicProcedure
    .input(z.object({ name: DaemonName }))
    .mutation(async ({ ctx, input }) => {
      await ctx.launchctl.stop(input.name);
      ctx.pubsub.publish("daemons", { name: input.name, status: "stopped", pid: 0 });
      return { ok: true };
    }),

  start: publicProcedure
    .input(z.object({ name: DaemonName }))
    .mutation(async ({ ctx, input }) => {
      await ctx.launchctl.start(input.name);
      ctx.pubsub.publish("daemons", { name: input.name, status: "running", pid: 0 });
      return { ok: true };
    }),
});
