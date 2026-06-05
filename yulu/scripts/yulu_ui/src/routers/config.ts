import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

export const configRouter = router({
  get: publicProcedure.query(({ ctx }) => ctx.config.read()),

  update: publicProcedure
    .input(z.object({
      key: z.string().regex(/^[a-z0-9_]+(\.[a-z0-9_]+)*$/i),
      value: z.unknown(),
    }))
    .mutation(async ({ ctx, input }) => {
      const result = ctx.config.update(input.key, input.value);
      // 服务端即时下发 SIGHUP(便宜、不打断录音);restart 仍由前端 banner 用户触发
      for (const d of result.daemonsNeedingSighup) {
        try { await ctx.launchctl.sighup("com.yulu." + d); } catch { /* daemon 可能没起 */ }
      }
      return result;
    }),
});
