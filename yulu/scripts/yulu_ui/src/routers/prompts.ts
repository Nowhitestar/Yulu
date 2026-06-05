import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

const CATEGORY = z.enum(["summary", "cleanup"]);

export const promptsRouter = router({
  list: publicProcedure
    .input(z.object({ category: CATEGORY.optional() }))
    .query(({ ctx, input }) => {
      const sql = input.category
        ? "SELECT * FROM prompts WHERE category = ? ORDER BY sort_order, name"
        : "SELECT * FROM prompts ORDER BY sort_order, name";
      return ctx.db.prompts.prepare(sql).all(...(input.category ? [input.category] : []));
    }),

  get: publicProcedure
    .input(z.object({ id: z.string() }))
    .query(({ ctx, input }) =>
      ctx.db.prompts.prepare("SELECT * FROM prompts WHERE id = ?").get(input.id) ?? null
    ),

  create: publicProcedure
    .input(z.object({
      slug: z.string().regex(/^[a-z][a-z0-9-]{0,62}[a-z0-9]?$/),
      name: z.string().min(1),
      category: CATEGORY,
      content: z.string().min(1),
      isAutoRun: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      const id = `id-${Date.now().toString(36)}`;
      ctx.db.prompts.prepare(
        `INSERT INTO prompts (id, slug, name, category, content, is_auto_run, source, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'manual', 0, ?, ?)`
      ).run(id, input.slug, input.name, input.category, input.content,
            input.isAutoRun ? 1 : 0, now, now);
      await tryHup(ctx);
      return { id };
    }),

  update: publicProcedure
    .input(z.object({
      id: z.string(),
      name: z.string().optional(),
      category: CATEGORY.optional(),
      content: z.string().optional(),
      isAutoRun: z.boolean().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const fields: string[] = [];
      const values: unknown[] = [];
      if (input.name !== undefined)      { fields.push("name = ?");        values.push(input.name); }
      if (input.category !== undefined)  { fields.push("category = ?");    values.push(input.category); }
      if (input.content !== undefined)   { fields.push("content = ?");     values.push(input.content); }
      if (input.isAutoRun !== undefined) { fields.push("is_auto_run = ?"); values.push(input.isAutoRun ? 1 : 0); }
      if (fields.length === 0) return { updated: 0 };
      fields.push("updated_at = ?"); values.push(new Date().toISOString().replace(/\.\d+Z$/, "Z"));
      values.push(input.id);
      const r = ctx.db.prompts.prepare(`UPDATE prompts SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      await tryHup(ctx);
      return { updated: r.changes };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const r = ctx.db.prompts.prepare("DELETE FROM prompts WHERE id = ?").run(input.id);
      await tryHup(ctx);
      return { deleted: r.changes };
    }),
});

async function tryHup(ctx: { launchctl: { sighup: (l: string) => Promise<void> } }): Promise<void> {
  try { await ctx.launchctl.sighup("com.yulu.agentqueue"); }
  catch { /* worker may be down; the change is persisted */ }
}
