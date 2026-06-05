import { describe, it, expect, vi } from "vitest";
import { makeTmpDb } from "../helpers/tmpDb.js";
import { promptsRouter } from "../../src/routers/prompts.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

const PROMPTS_SCHEMA = `
CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('summary','cleanup')),
  content TEXT NOT NULL,
  is_auto_run INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  sort_order INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
INSERT INTO prompts VALUES
 ('id-1','default','Default Summary','summary','Summarize the meeting.',1,'seed',0,NULL,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
 ('id-2','cleanup','Cleanup','cleanup','Clean noise.',0,'seed',1,NULL,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
`;

function makeCtx() {
  const { db } = makeTmpDb(PROMPTS_SCHEMA);
  const sighup = vi.fn();
  const ctx = {
    db: { prompts: db, vocab: null, search: null },
    launchctl: { sighup },
  } as unknown as AppContext;
  return { ctx, sighup, cleanup: () => db.close() };
}

describe("promptsRouter", () => {
  it("list() returns sorted by sort_order then name", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(promptsRouter, ctx);
      const rows = (await caller.list({})) as Array<{ slug: string }>;
      expect(rows.map((r) => r.slug)).toEqual(["default", "cleanup"]);
    } finally { cleanup(); }
  });

  it("update() writes + SIGHUPs agentqueue", async () => {
    const { ctx, sighup, cleanup } = makeCtx();
    try {
      const caller = createCaller(promptsRouter, ctx);
      await caller.update({ id: "id-1", content: "New body." });
      const row = ctx.db.prompts.prepare("SELECT content FROM prompts WHERE id=?").get("id-1") as { content: string };
      expect(row.content).toBe("New body.");
      expect(sighup).toHaveBeenCalledWith("com.yulu.agentqueue");
    } finally { cleanup(); }
  });
});
