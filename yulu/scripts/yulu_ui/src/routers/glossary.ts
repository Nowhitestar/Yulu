import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

export const glossaryRouter = router({
  list: publicProcedure.query(({ ctx }) =>
    ctx.db.vocab.prepare("SELECT * FROM vocab ORDER BY term").all()
  ),

  add: publicProcedure
    .input(z.object({ term: z.string().min(1).max(200), pinyin: z.string().optional(), notes: z.string().optional() }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      ctx.db.vocab.prepare(
        "INSERT INTO vocab (term, pinyin, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).run(input.term, input.pinyin ?? null, input.notes ?? null, now, now);
      await hupStt(ctx);
      return { ok: true };
    }),

  update: publicProcedure
    .input(z.object({ id: z.number().int(), term: z.string().optional(),
                      pinyin: z.string().nullable().optional(), notes: z.string().nullable().optional() }))
    .mutation(async ({ ctx, input }) => {
      const fields: string[] = []; const values: unknown[] = [];
      if (input.term !== undefined)   { fields.push("term = ?");   values.push(input.term); }
      if (input.pinyin !== undefined) { fields.push("pinyin = ?"); values.push(input.pinyin); }
      if (input.notes !== undefined)  { fields.push("notes = ?");  values.push(input.notes); }
      if (fields.length === 0) return { updated: 0 };
      fields.push("updated_at = ?"); values.push(new Date().toISOString().replace(/\.\d+Z$/, "Z"));
      values.push(input.id);
      const r = ctx.db.vocab.prepare(`UPDATE vocab SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      await hupStt(ctx);
      return { updated: r.changes };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.number().int() }))
    .mutation(async ({ ctx, input }) => {
      const r = ctx.db.vocab.prepare("DELETE FROM vocab WHERE id = ?").run(input.id);
      await hupStt(ctx);
      return { deleted: r.changes };
    }),
});

async function hupStt(ctx: { launchctl: { sighup: (l: string) => Promise<void> } }): Promise<void> {
  try { await ctx.launchctl.sighup("com.yulu.sttdaemon"); } catch { /* daemon may be down */ }
}
