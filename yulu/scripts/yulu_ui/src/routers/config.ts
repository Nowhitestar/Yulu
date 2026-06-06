import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { SETTINGS, type SettingDef } from "../settingsRegistry.js";

// Serializable settings metadata: the registry entry minus the Zod `validate`
// schema (which is not JSON-serializable and must never cross the wire).
export type SettingMeta = Omit<SettingDef, "validate">;

export const configRouter = router({
  get: publicProcedure.query(({ ctx }) => ctx.config.read()),

  // Single source of truth for the SPA settings UI: the registry's metadata,
  // stripped of the server-only Zod validators. The SPA renders categories and
  // field rows from this — it never re-declares the schema.
  schema: publicProcedure.query((): SettingMeta[] =>
    SETTINGS.map(({ validate: _validate, ...meta }) => meta)),

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
