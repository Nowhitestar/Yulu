import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeTmpDb } from "../helpers/tmpDb.js";
import { sidebarRouter } from "../../src/routers/sidebar.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

const PROMPTS = "CREATE TABLE prompts (id TEXT PRIMARY KEY); INSERT INTO prompts VALUES ('a'), ('b');";
const VOCAB   = "CREATE TABLE vocab (id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT NOT NULL UNIQUE); INSERT INTO vocab(term) VALUES ('AgentKey'), ('OpenClaw'), ('Yulu');";

function makeCtx() {
  const moviesDir = mkdtempSync(join(tmpdir(), "yulu_side_"));
  mkdirSync(join(moviesDir, "voicemails"));
  writeFileSync(join(moviesDir, "Standup_20260520_100000.wav"), Buffer.alloc(0));
  writeFileSync(join(moviesDir, "Standup_20260521_100000.wav"), Buffer.alloc(0));
  writeFileSync(join(moviesDir, "voicemails/voicemail_20260526_100000.wav"), Buffer.alloc(0));
  const { db: prompts } = makeTmpDb(PROMPTS);
  const { db: vocab } = makeTmpDb(VOCAB);
  const ctx = {
    paths: { moviesDir, voicemailsDir: join(moviesDir, "voicemails") },
    db: { prompts, vocab, search: null },
  } as unknown as AppContext;
  return { ctx, cleanup: () => { prompts.close(); vocab.close(); rmSync(moviesDir, { recursive: true, force: true }); } };
}

describe("sidebarRouter", () => {
  it("counts() returns the 4 sidebar counts", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(sidebarRouter, ctx);
      expect(await caller.counts()).toEqual({ voicemails: 1, meetings: 2, prompts: 2, glossary: 3 });
    } finally { cleanup(); }
  });
});
