import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, cpSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ConfigManager } from "../../src/config.js";
import { configRouter, type SettingMeta } from "../../src/routers/config.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { SETTINGS } from "../../src/settingsRegistry.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), "yulu_cfgrouter_"));
  const path = join(dir, "config.json");
  cpSync(join(HERE, "../fixtures/config.json"), path);
  const sighup = vi.fn().mockResolvedValue(undefined);
  const start = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);
  const ctx = { config: new ConfigManager(path), launchctl: { sighup, start, stop } } as unknown as AppContext;
  return { ctx, sighup, start, stop, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
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

  it("get() fills effective defaults for thin transcription config", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yulu_cfgrouter_thin_"));
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ audio: { output_dir: "~/Movies/Yulu" }, transcription: {} }));
    const ctx = { config: new ConfigManager(path), launchctl: {} } as unknown as AppContext;
    try {
      const caller = createCaller(configRouter, ctx);
      const cfg = await caller.get();
      expect(cfg.transcription.language).toBe("zh");
      expect(cfg.transcription.dictation.prompt_slug).toBe("dictation-cleanup");
      expect(cfg.agent_pipeline).not.toHaveProperty("auto_send_notion");
      expect(cfg.connectors.feishu.read_calendar).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("audio capture settings need no daemon restart", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(configRouter, ctx);
      const r = await caller.update({ key: "audio.silence_threshold", value: 0.02 });
      expect(r.daemonsNeedingRestart).toEqual([]);
    } finally { cleanup(); }
  });

  it("rejects updates to retired automatic-sharing authorization", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(configRouter, ctx);
      await expect(caller.update({
        key: "agent_pipeline.auto_send_notion",
        value: true,
      })).rejects.toThrow(/manual-only/);
    } finally { cleanup(); }
  });

  it("update(transcription.engine) synchronizes the local model lifecycle", async () => {
    const { ctx, cleanup } = makeCtx();
    const syncSelection = vi.fn().mockResolvedValue(undefined);
    ctx.localCaption = { syncSelection } as never;
    try {
      const caller = createCaller(configRouter, ctx);
      const result = await caller.update({ key: "transcription.engine", value: "xai" });
      expect(result.daemonsNeedingRestart).toEqual([]);
      expect(syncSelection).toHaveBeenCalledOnce();
    } finally { cleanup(); }
  });

  it("invalidates process-scoped readiness when a capability provider or model changes", async () => {
    const { ctx, cleanup } = makeCtx();
    ctx.xaiReadiness = new Map([
      ["summary", {
        capability: "summary",
        status: "ready",
        model: "grok-old",
        testedAt: "2026-08-25T04:00:00.000Z",
        detail: "ready",
        credentialSource: "oauth",
      }],
      ["conversation", {
        capability: "conversation",
        status: "ready",
        model: "grok-conversation",
        testedAt: "2026-08-25T04:00:00.000Z",
        detail: "ready",
        credentialSource: "oauth",
      }],
    ]);
    try {
      const caller = createCaller(configRouter, ctx);
      await caller.update({
        key: "intelligence.summary",
        value: { provider: "xai", model: "grok-new" },
      });
      expect(ctx.xaiReadiness.has("summary")).toBe(false);
      expect(ctx.xaiReadiness.has("conversation")).toBe(true);
    } finally { cleanup(); }
  });

  it("returns an apply error when transcription model synchronization fails", async () => {
    const { ctx, cleanup } = makeCtx();
    ctx.localCaption = { syncSelection: vi.fn().mockRejectedValue(new Error("model warmup failed")) } as never;
    try {
      const caller = createCaller(configRouter, ctx);
      const result = await caller.update({ key: "transcription.engine", value: "xai" });
      expect(result.applyErrors).toEqual(["transcription: model warmup failed"]);
    } finally { cleanup(); }
  });

  it("update(connectors.feishu.read_calendar) restarts calendar scheduler services", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(configRouter, ctx);
      const r = await caller.update({ key: "connectors.feishu.read_calendar", value: true });
      expect(r.daemonsNeedingRestart).toEqual(["calendar", "scheduler"]);
      expect(r.daemonsNeedingSighup).toEqual([]);
    } finally { cleanup(); }
  });

  it("update(status_agent.enabled) applies launchctl start/stop immediately", async () => {
    const { ctx, start, stop, cleanup } = makeCtx();
    try {
      const caller = createCaller(configRouter, ctx);
      const off = await caller.update({ key: "status_agent.enabled", value: false });
      expect(off.daemonsNeedingRestart).toEqual([]);
      expect(off.applyErrors).toEqual([]);
      expect(stop).toHaveBeenCalledWith("com.yulu.statusagent");
      const on = await caller.update({ key: "status_agent.enabled", value: true });
      expect(on.daemonsNeedingRestart).toEqual([]);
      expect(start).toHaveBeenCalledWith("com.yulu.statusagent");
    } finally { cleanup(); }
  });

  it("returns an apply error when a saved preference could not reach launchctl", async () => {
    const { ctx, stop, cleanup } = makeCtx();
    stop.mockRejectedValueOnce(new Error("service not loaded"));
    try {
      const caller = createCaller(configRouter, ctx);
      const result = await caller.update({ key: "status_agent.enabled", value: false });
      expect(result.applyErrors).toEqual(["statusagent: service not loaded"]);
      expect((await caller.get()).status_agent.enabled).toBe(false);
    } finally { cleanup(); }
  });

  it("update(status_agent.hotkeys.*) sighups StatusAgent", async () => {
    const { ctx, sighup, cleanup } = makeCtx();
    try {
      const caller = createCaller(configRouter, ctx);
      const r = await caller.update({ key: "status_agent.hotkeys.dictate.key", value: "F1" });
      expect(r.daemonsNeedingRestart).toEqual([]);
      expect(r.daemonsNeedingSighup).toEqual(["statusagent"]);
      expect(sighup).toHaveBeenCalledWith("com.yulu.statusagent");
    } finally { cleanup(); }
  });

  it("returns an apply error when a daemon SIGHUP fails", async () => {
    const { ctx, sighup, cleanup } = makeCtx();
    sighup.mockRejectedValueOnce(new Error("service unavailable"));
    try {
      const caller = createCaller(configRouter, ctx);
      const result = await caller.update({ key: "status_agent.hotkeys.dictate.key", value: "F1" });
      expect(result.applyErrors).toEqual(["statusagent: service unavailable"]);
    } finally { cleanup(); }
  });

  it("update(transcription.dictation.*) persists without daemon reload", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(configRouter, ctx);
      const r = await caller.update({ key: "transcription.dictation.prompt_slug", value: "dictation-tight" });
      expect(r.daemonsNeedingRestart).toEqual([]);
      expect(r.daemonsNeedingSighup).toEqual([]);
      expect((await caller.get()).transcription.dictation.prompt_slug).toBe("dictation-tight");
    } finally { cleanup(); }
  });
});

describe("configRouter.schema", () => {
  it("returns one serializable metadata entry per registered setting", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(configRouter, ctx);
      const schema = await caller.schema();
      expect(Array.isArray(schema)).toBe(true);
      expect(schema.length).toBe(SETTINGS.filter((setting) => !setting.hidden).length);
      expect(schema.some((setting: { path: string }) => setting.path === "llm.command")).toBe(false);
      expect(schema.some((setting: { path: string }) => setting.path === "output.channel")).toBe(false);
      expect(schema.some((setting: { path: string }) => setting.path === "calendars")).toBe(false);
      expect(schema.length).toBeGreaterThan(0);
    } finally { cleanup(); }
  });

  it("strips the Zod validate field but keeps reload + path/category/label/type", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(configRouter, ctx);
      const schema = await caller.schema();
      for (const meta of schema) {
        expect(meta).not.toHaveProperty("validate");
        expect(typeof meta.path).toBe("string");
        expect(typeof meta.category).toBe("string");
        expect(typeof meta.label).toBe("string");
        expect(typeof meta.type).toBe("string");
        expect(meta.reload).toBeDefined();
        expect(typeof meta.reload.kind).toBe("string");
      }
    } finally { cleanup(); }
  });

  it("is JSON-serializable (no functions / Zod objects leak through)", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(configRouter, ctx);
      const schema = await caller.schema();
      const roundTrip = JSON.parse(JSON.stringify(schema));
      expect(roundTrip).toEqual(schema);
    } finally { cleanup(); }
  });

  it("serializes the danger flag so the SPA can gate risky fields (P3-3)", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(configRouter, ctx);
      const schema = await caller.schema();
      const outputDir = schema.find((m: SettingMeta) => m.path === "audio.output_dir")!;
      expect(outputDir.danger).toBe(true);
      // A non-danger field must NOT carry a truthy danger flag.
      const lang = schema.find((m: SettingMeta) => m.path === "transcription.language")!;
      expect(lang.danger).toBeFalsy();
    } finally { cleanup(); }
  });
});

describe("configRouter.envPresent (P2-4 secret-safe presence)", () => {
  it("returns present=true for a set env var and never leaks the value", async () => {
    const { ctx, cleanup } = makeCtx();
    process.env.YULU_TEST_ENVPRESENT = "super-secret-value";
    try {
      const caller = createCaller(configRouter, ctx);
      const r = await caller.envPresent({ name: "YULU_TEST_ENVPRESENT" });
      expect(r).toEqual({ present: true });
      // The shape is ONLY a boolean — the secret value must not appear anywhere.
      expect(JSON.stringify(r)).not.toContain("super-secret-value");
    } finally { delete process.env.YULU_TEST_ENVPRESENT; cleanup(); }
  });
  it("returns present=false for an unset or empty env var name", async () => {
    const { ctx, cleanup } = makeCtx();
    delete process.env.YULU_TEST_UNSET_ENV;
    try {
      const caller = createCaller(configRouter, ctx);
      expect(await caller.envPresent({ name: "YULU_TEST_UNSET_ENV" })).toEqual({ present: false });
      expect(await caller.envPresent({ name: "" })).toEqual({ present: false });
      expect(await caller.envPresent({ name: "   " })).toEqual({ present: false });
    } finally { cleanup(); }
  });
});
