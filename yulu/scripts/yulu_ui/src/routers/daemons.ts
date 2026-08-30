import { readFileSync, existsSync, statSync } from "node:fs";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import {
  daemonLogPath,
  YULU_DAEMONS,
  type YuluDaemon,
} from "../daemonLogs.js";
export {
  daemonLogPath,
  YULU_DAEMON_LOG_FILES,
  YULU_DAEMONS,
} from "../daemonLogs.js";

const DaemonName = z.enum(YULU_DAEMONS);
type HealthStatus = "stopped" | "crashed" | "running" | "idle";
type LaunchStatus = { pid: number; exitStatus: number; label: string } | null;

function classifyStatus(name: YuluDaemon, s: LaunchStatus): HealthStatus {
  if (!s) return "stopped";
  if (s.pid > 0) return "running";
  if (s.exitStatus !== 0) return "crashed";
  return "stopped";
}

export const daemonsRouter = router({
  health: publicProcedure.query(async ({ ctx }) => {
    const out = [];
    for (const name of YULU_DAEMONS) {
      const s = await ctx.launchctl.status(name);
      const log = daemonLogPath(name, ctx.paths.logsDir, ctx.paths.legacyReadOnlyDataDir);
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
        status: classifyStatus(name, s),
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
