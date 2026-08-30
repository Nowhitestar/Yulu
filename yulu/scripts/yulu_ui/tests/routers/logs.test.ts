import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { logsRouter } from "../../src/routers/logs.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), "yulu_logs_"));
  writeFileSync(join(dir, "audio_daemon.log"),
    Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  return {
    ctx: { paths: {
      configDir: "/wrong/durable-root",
      logsDir: dir,
      legacyReadOnlyDataDir: join(dir, "legacy"),
    } } as unknown as AppContext,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("logsRouter", () => {
  it("tail() returns last N lines", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(logsRouter, ctx);
      const r = await caller.tail({ name: "com.yulu.audiodaemon", limit: 5 });
      expect(r.lines).toEqual(["line 16", "line 17", "line 18", "line 19", "line 20"]);
    } finally { cleanup(); }
  });

  it("tail() returns empty when log missing", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(logsRouter, ctx);
      const r = await caller.tail({ name: "com.yulu.statusagent", limit: 5 });
      expect(r.lines).toEqual([]);
    } finally { cleanup(); }
  });

  it("tail() reads a legacy log only when the standard log is missing", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu_logs_legacy_"));
    const logsDir = join(root, "logs");
    const legacyDir = join(root, "legacy");
    mkdirSync(logsDir);
    mkdirSync(legacyDir);
    writeFileSync(join(legacyDir, "status_agent.log"), "rollback line\n", "utf8");
    const ctx = { paths: { logsDir, legacyReadOnlyDataDir: legacyDir } } as unknown as AppContext;
    try {
      const r = await createCaller(logsRouter, ctx).tail({ name: "com.yulu.statusagent", limit: 5 });
      expect(r.lines).toEqual(["rollback line"]);
      expect(r.path).toBe(join(legacyDir, "status_agent.log"));
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
