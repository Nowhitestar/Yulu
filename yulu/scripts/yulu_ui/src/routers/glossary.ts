import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";
import { randomUUID } from "node:crypto";
import type { Database as DbType } from "better-sqlite3";

const CUSTOM_WORDS_SCHEMA = `
CREATE TABLE IF NOT EXISTS custom_words (
  id          TEXT PRIMARY KEY,
  term        TEXT NOT NULL,
  canonical   TEXT NOT NULL,
  scope       TEXT NOT NULL CHECK(scope IN ('prompt', 'replace', 'both')),
  source      TEXT NOT NULL DEFAULT 'manual'
              CHECK(source IN ('seed', 'manual', 'learned')),
  enabled     INTEGER NOT NULL DEFAULT 1,
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_custom_words_enabled_scope ON custom_words(enabled, scope);
CREATE INDEX IF NOT EXISTS idx_custom_words_canonical ON custom_words(canonical);
`;

const Scope = z.enum(["prompt", "replace", "both"]);

export const glossaryRouter = router({
  list: publicProcedure.query(({ ctx }) => {
    ensureVocabTable(ctx.db.vocab);
    migrateLegacyVocab(ctx.db.vocab);
    return ctx.db.vocab.prepare(`
      SELECT id, term, canonical, scope, source, enabled, note AS notes, created_at, updated_at
      FROM custom_words
      ORDER BY term
    `).all();
  }),

  add: publicProcedure
    .input(z.object({
      term: z.string().min(1).max(200),
      canonical: z.string().min(1).max(200).optional(),
      scope: Scope.optional(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      ensureVocabTable(ctx.db.vocab);
      const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
      ctx.db.vocab.prepare(
        "INSERT INTO custom_words (id, term, canonical, scope, source, enabled, note, created_at, updated_at) VALUES (?, ?, ?, ?, 'manual', 1, ?, ?, ?)"
      ).run(randomUUID(), input.term, input.canonical ?? input.term, input.scope ?? "both", input.notes ?? null, now, now);
      await hupStt(ctx);
      return { ok: true };
    }),

  update: publicProcedure
    .input(z.object({
      id: z.string().min(1),
      term: z.string().optional(),
      canonical: z.string().optional(),
      scope: Scope.optional(),
      notes: z.string().nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      ensureVocabTable(ctx.db.vocab);
      const fields: string[] = []; const values: unknown[] = [];
      if (input.term !== undefined)   { fields.push("term = ?");   values.push(input.term); }
      if (input.canonical !== undefined) { fields.push("canonical = ?"); values.push(input.canonical); }
      if (input.scope !== undefined) { fields.push("scope = ?"); values.push(input.scope); }
      if (input.notes !== undefined)  { fields.push("note = ?");  values.push(input.notes); }
      if (fields.length === 0) return { updated: 0 };
      fields.push("updated_at = ?"); values.push(new Date().toISOString().replace(/\.\d+Z$/, "Z"));
      values.push(input.id);
      const r = ctx.db.vocab.prepare(`UPDATE custom_words SET ${fields.join(", ")} WHERE id = ?`).run(...values);
      await hupStt(ctx);
      return { updated: r.changes };
    }),

  delete: publicProcedure
    .input(z.object({ id: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      ensureVocabTable(ctx.db.vocab);
      const r = ctx.db.vocab.prepare("DELETE FROM custom_words WHERE id = ?").run(input.id);
      await hupStt(ctx);
      return { deleted: r.changes };
    }),
});

function ensureVocabTable(db: { exec: (sql: string) => unknown }): void {
  db.exec(CUSTOM_WORDS_SCHEMA);
}

function migrateLegacyVocab(db: DbType): void {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='vocab'").get();
  if (!table) return;
  const legacyRows = db.prepare("SELECT term, pinyin, notes, created_at, updated_at FROM vocab").all() as Array<{
    term: string;
    pinyin: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
  }>;
  const exists = db.prepare("SELECT 1 FROM custom_words WHERE term = ? AND canonical = ? LIMIT 1");
  const insert = db.prepare(
    "INSERT INTO custom_words (id, term, canonical, scope, source, enabled, note, created_at, updated_at) VALUES (?, ?, ?, 'both', 'manual', 1, ?, ?, ?)"
  );
  for (const row of legacyRows) {
    const term = String(row.term ?? "").trim();
    if (!term || exists.get(term, term)) continue;
    const note = [row.notes, row.pinyin ? `pinyin: ${row.pinyin}` : ""].filter(Boolean).join("\n") || null;
    insert.run(randomUUID(), term, term, note, row.created_at, row.updated_at);
  }
}

async function hupStt(ctx: { launchctl: { sighup: (l: string) => Promise<void> } }): Promise<void> {
  try { await ctx.launchctl.sighup("com.yulu.sttdaemon"); } catch { /* daemon may be down */ }
}
