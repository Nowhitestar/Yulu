import { describe, it, expect } from "vitest";
import { ConfigManager } from "../src/config.js";
import { cpSync, mkdtempSync, rmSync, utimesSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "fixtures/config.json");

function makeCfg(): { path: string; mgr: ConfigManager; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "yulu_cfg_"));
  const path = join(dir, "config.json");
  cpSync(SRC, path);
  const mgr = new ConfigManager(path);
  return { path, mgr, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("ConfigManager", () => {
  it("reads + caches by mtime", () => {
    const { mgr, cleanup } = makeCfg();
    try {
      const cfg = mgr.read();
      expect(cfg.audio.silence_threshold).toBe(0.01);
      expect(mgr.read()).toBe(cfg);
    } finally { cleanup(); }
  });

  it("update() writes + returns diff with restart targets", () => {
    const { mgr, cleanup } = makeCfg();
    try {
      const result = mgr.update("audio.silence_threshold", 0.02);
      expect(result.daemonsNeedingRestart).toContain("audiodaemon");
      expect(result.daemonsNeedingSighup).toEqual([]);
      const cfg = mgr.read();
      expect(cfg.audio.silence_threshold).toBe(0.02);
    } finally { cleanup(); }
  });

  it("classifies SIGHUP-only changes (hotkey, glossary, llm.command)", () => {
    const { mgr, cleanup } = makeCfg();
    try {
      const r1 = mgr.update("status_agent.hotkey", { key: "F19", modifiers: ["alt"] });
      expect(r1.daemonsNeedingSighup).toEqual(["statusagent"]);
      expect(r1.daemonsNeedingRestart).toEqual([]);

      const r2 = mgr.update("transcription.glossary", ["NewTerm"]);
      expect(r2.daemonsNeedingSighup).toEqual(["sttdaemon"]);

      const r3 = mgr.update("llm.command", ["codex"]);
      expect(r3.daemonsNeedingSighup).toEqual(["agentqueue"]);
    } finally { cleanup(); }
  });

  it("rejects updates when on-disk mtime advanced (external write)", () => {
    const { path, mgr, cleanup } = makeCfg();
    try {
      mgr.read();
      const future = new Date(statSync(path).mtimeMs + 2_000);
      utimesSync(path, future, future);
      expect(() => mgr.update("audio.silence_threshold", 0.05))
        .toThrow(/changed externally/);
    } finally { cleanup(); }
  });
});
