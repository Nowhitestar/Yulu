import { describe, it, expect, vi } from "vitest";
import { makeTmpDb } from "../helpers/tmpDb.js";
import { glossaryRouter } from "../../src/routers/glossary.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

const VOCAB_SCHEMA = `
CREATE TABLE vocab (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL UNIQUE,
  pinyin TEXT,
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO vocab (term, pinyin, notes, created_at, updated_at) VALUES
 ('AgentKey', NULL, 'product', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
 ('OpenClaw', NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
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

  it("add() inserts + SIGHUPs sttdaemon", async () => {
    const { ctx, sighup, cleanup } = makeCtx();
    try {
      const caller = createCaller(glossaryRouter, ctx);
      await caller.add({ term: "NewTerm" });
      const r = ctx.db.vocab.prepare("SELECT COUNT(*) AS n FROM vocab").get() as { n: number };
      expect(r.n).toBe(3);
      expect(sighup).toHaveBeenCalledWith("com.yulu.sttdaemon");
    } finally { cleanup(); }
  });
});
