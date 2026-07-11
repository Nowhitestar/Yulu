import { describe, it, expect } from "vitest";
import { makeTmpDb } from "../helpers/tmpDb.js";
import { promptsRouter } from "../../src/routers/prompts.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

const PROMPTS_SCHEMA = `
CREATE TABLE prompts (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK(category IN ('summary','cleanup','voice')),
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
 ('id-2','cleanup','Cleanup','cleanup','Clean noise.',0,'seed',1,NULL,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'),
 ('id-3','dictation-cleanup','Dictation Cleanup','voice','Clean dictation.',0,'seed',2,NULL,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
`;

function makeCtx() {
  const { db } = makeTmpDb(PROMPTS_SCHEMA);
  const ctx = {
    db: { prompts: db, vocab: null, search: null },
  } as unknown as AppContext;
  return { ctx, cleanup: () => db.close() };
}

describe("promptsRouter", () => {
  it("list() returns sorted by sort_order then name", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(promptsRouter, ctx);
      const rows = (await caller.list({})) as Array<{ slug: string }>;
      expect(rows.map((r) => r.slug)).toEqual(["default", "cleanup", "dictation-cleanup"]);
    } finally { cleanup(); }
  });

  it("list() can filter voice prompts", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(promptsRouter, ctx);
      const rows = (await caller.list({ category: "voice" })) as Array<{ slug: string }>;
      expect(rows.map((r) => r.slug)).toEqual(["dictation-cleanup"]);
    } finally { cleanup(); }
  });

  it("update() writes and marks edited seeds manual", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(promptsRouter, ctx);
      await caller.update({ id: "id-1", content: "New body." });
      const row = ctx.db.prompts.prepare("SELECT content, source FROM prompts WHERE id=?").get("id-1") as { content: string; source: string };
      expect(row.content).toBe("New body.");
      expect(row.source).toBe("manual");
    } finally { cleanup(); }
  });

  it("rejects autorun for non-summary templates", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(promptsRouter, ctx);
      await expect(caller.create({
        slug: "auto-cleanup",
        name: "Auto cleanup",
        category: "cleanup",
        content: "Clean it",
        isAutoRun: true,
      })).rejects.toThrow("only for summary templates");
      await expect(caller.update({ id: "id-2", isAutoRun: true }))
        .rejects.toThrow("only for summary templates");
    } finally { cleanup(); }
  });

  it("clears autorun when a summary changes to a non-summary category", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(promptsRouter, ctx);
      await caller.update({ id: "id-1", category: "cleanup" });
      const row = ctx.db.prompts.prepare("SELECT category, is_auto_run FROM prompts WHERE id=?")
        .get("id-1") as { category: string; is_auto_run: number };
      expect(row).toEqual({ category: "cleanup", is_auto_run: 0 });
      await caller.update({ id: "id-1", category: "summary" });
      const restored = ctx.db.prompts.prepare("SELECT category, is_auto_run FROM prompts WHERE id=?")
        .get("id-1") as { category: string; is_auto_run: number };
      expect(restored).toEqual({ category: "summary", is_auto_run: 0 });
    } finally { cleanup(); }
  });
});
