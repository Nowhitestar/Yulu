import { describe, it, expect } from "vitest";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ConfigManager } from "../../src/config.js";
import { configRouter } from "../../src/routers/config.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), "yulu_cfgrouter_"));
  const path = join(dir, "config.json");
  cpSync(join(HERE, "../fixtures/config.json"), path);
  const ctx = { config: new ConfigManager(path) } as unknown as AppContext;
  return { ctx, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("configRouter", () => {
  it("get() returns parsed config", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(configRouter, ctx);
      const cfg = await caller.get();
      expect(cfg.audio.silence_threshold).toBe(0.01);
    } finally { cleanup(); }
  });

  it("update() returns restart targets", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(configRouter, ctx);
      const r = await caller.update({ key: "audio.silence_threshold", value: 0.02 });
      expect(r.daemonsNeedingRestart).toContain("audiodaemon");
    } finally { cleanup(); }
  });
});
