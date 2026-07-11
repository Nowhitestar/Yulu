import { describe, it, expect, vi } from "vitest";
import { makeTmpDb } from "../helpers/tmpDb.js";
import { glossaryRouter } from "../../src/routers/glossary.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

const VOCAB_SCHEMA = `
CREATE TABLE custom_words (
  id TEXT PRIMARY KEY,
  term TEXT NOT NULL,
  canonical TEXT NOT NULL,
  scope TEXT NOT NULL,
  source TEXT NOT NULL,
  enabled INTEGER NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO custom_words (id, term, canonical, scope, source, enabled, note, created_at, updated_at) VALUES
 ('w1', 'AgentKey', 'AgentKey', 'both', 'manual', 1, 'product', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('w2', 'OpenClaw', 'OpenClaw', 'both', 'manual', 1, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
`;

function makeCtx() {
  const { db } = makeTmpDb(VOCAB_SCHEMA);
  const sighup = vi.fn();
  const ctx = {
    db: { vocab: db, prompts: null, search: null },
    launchctl: { sighup },
  } as unknown as AppContext;
  return { ctx, sighup, cleanup: () => db.close() };
}

describe("glossaryRouter", () => {
  it("list() returns rows ordered by term", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(glossaryRouter, ctx);
      const r = await caller.list();
      expect((r as Array<{ term: string }>).map((x) => x.term)).toEqual(["AgentKey", "OpenClaw"]);
    } finally { cleanup(); }
  });

  it("list() initializes an empty vocab table in a fresh DB", async () => {
    const { db } = makeTmpDb("");
    const ctx = {
      db: { vocab: db, prompts: null, search: null },
      launchctl: { sighup: vi.fn() },
    } as unknown as AppContext;
    try {
      const caller = createCaller(glossaryRouter, ctx);
      expect(await caller.list()).toEqual([]);
      const r = db.prepare("SELECT COUNT(*) AS n FROM custom_words").get() as { n: number };
      expect(r.n).toBe(0);
    } finally { db.close(); }
  });

  it("add() inserts + SIGHUPs sttdaemon", async () => {
    const { ctx, sighup, cleanup } = makeCtx();
    try {
      const caller = createCaller(glossaryRouter, ctx);
      await caller.add({ term: "NewTerm" });
      const r = ctx.db.vocab.prepare("SELECT COUNT(*) AS n FROM custom_words").get() as { n: number };
      expect(r.n).toBe(3);
      const row = ctx.db.vocab.prepare("SELECT canonical, scope FROM custom_words WHERE term = ?").get("NewTerm") as { canonical: string; scope: string };
      expect(row).toEqual({ canonical: "NewTerm", scope: "both" });
      expect(sighup).toHaveBeenCalledWith("com.yulu.sttdaemon");
    } finally { cleanup(); }
  });

  it("deleteMany() removes a canonical group atomically and SIGHUPs once", async () => {
    const { ctx, sighup, cleanup } = makeCtx();
    try {
      const caller = createCaller(glossaryRouter, ctx);
      expect(await caller.deleteMany({ ids: ["w1", "w2", "w1"] })).toEqual({ deleted: 2 });
      expect(ctx.db.vocab.prepare("SELECT COUNT(*) AS n FROM custom_words").get()).toEqual({ n: 0 });
      expect(sighup).toHaveBeenCalledTimes(1);
      expect(sighup).toHaveBeenCalledWith("com.yulu.sttdaemon");
    } finally { cleanup(); }
  });

  it("migrates legacy vocab rows into custom_words", async () => {
    const { db } = makeTmpDb(`
      CREATE TABLE vocab (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        term TEXT NOT NULL UNIQUE,
        pinyin TEXT,
        notes TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO vocab (term, pinyin, notes, created_at, updated_at)
      VALUES ('阿尔法学院', NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
    `);
    const ctx = {
      db: { vocab: db, prompts: null, search: null },
      launchctl: { sighup: vi.fn() },
    } as unknown as AppContext;
    try {
      const caller = createCaller(glossaryRouter, ctx);
      const rows = await caller.list() as Array<{ term: string; canonical: string; scope: string }>;
      expect(rows).toMatchObject([{ term: "阿尔法学院", canonical: "阿尔法学院", scope: "both" }]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM custom_words").get()).toEqual({ n: 1 });
    } finally { db.close(); }
  });
});
