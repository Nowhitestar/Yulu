import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ConfigManager } from "../../src/config.js";
import { configRouter } from "../../src/routers/config.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { SETTINGS } from "../../src/settingsRegistry.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function makeCtx() {
  const dir = mkdtempSync(join(tmpdir(), "yulu_cfgrouter_"));
  const path = join(dir, "config.json");
  cpSync(join(HERE, "../fixtures/config.json"), path);
  const sighup = vi.fn().mockResolvedValue(undefined);
  const ctx = { config: new ConfigManager(path), launchctl: { sighup } } as unknown as AppContext;
  return { ctx, sighup, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function ctxWith(update: any) {
  const sighup = vi.fn().mockResolvedValue(undefined);
  return { ctx: { config: { update }, launchctl: { sighup } }, sighup };
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

  it("update(transcription.realtime_enabled) needs no daemon restart", async () => {
    const { ctx, cleanup } = makeCtx();
    try {
      const caller = createCaller(configRouter, ctx);
      const r = await caller.update({ key: "transcription.realtime_enabled", value: false });
      expect(r.daemonsNeedingRestart).toEqual([]);
      expect(r.daemonsNeedingSighup).toEqual([]);
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
      expect(schema.length).toBe(SETTINGS.length);
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
});

describe("configRouter sighup dispatch", () => {
  it("sighup 类设置 → 服务端调 launchctl.sighup(com.yulu.<daemon>)", async () => {
    const { ctx, sighup } = ctxWith(() => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: ["sttdaemon"] }));
    await configRouter.createCaller(ctx as any).update({ key: "transcription.glossary", value: ["x"] });
    expect(sighup).toHaveBeenCalledWith("com.yulu.sttdaemon");
  });
  it("restart 类不在服务端重启,原样返回给 banner", async () => {
    const { ctx, sighup } = ctxWith(() => ({ daemonsNeedingRestart: ["sttdaemon"], daemonsNeedingSighup: [] }));
    const r = await configRouter.createCaller(ctx as any).update({ key: "transcription.language", value: "en" });
    expect(sighup).not.toHaveBeenCalled();
    expect(r.daemonsNeedingRestart).toEqual(["sttdaemon"]);
  });
});
