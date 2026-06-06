import { describe, it, expect, vi } from "vitest";
import { ConfigManager } from "../src/config.js";
import * as fs from "node:fs";
import { ZodError } from "zod";
import { cpSync, mkdtempSync, rmSync, utimesSync, statSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "fixtures/config.json");
const CONFIG_TS = join(HERE, "../src/config.ts");

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

  it("read() tolerates a minimal/partial config (fills audio defaults, no throw)", () => {
    const dir = mkdtempSync(join(tmpdir(), "yulu_min_"));
    const path = join(dir, "config.json");
    fs.writeFileSync(path, JSON.stringify({ audio: { output_dir: "~/Movies/Yulu" }, transcription: {} }));
    try {
      const cfg = new ConfigManager(path).read();
      expect(cfg.audio.silence_threshold).toBe(0.01);       // default
      expect(cfg.audio.silence_duration_sec).toBe(300);     // default
      expect(cfg.audio.output_dir).toBe("~/Movies/Yulu");
    } finally { rmSync(dir, { recursive: true, force: true }); }
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

  it("classifies SIGHUP-only changes (glossary)", () => {
    const { mgr, cleanup } = makeCfg();
    try {
      // glossary → sighup sttdaemon (VocabCache reload)
      const r2 = mgr.update("transcription.glossary", ["NewTerm"]);
      expect(r2.daemonsNeedingSighup).toEqual(["sttdaemon"]);
      expect(r2.daemonsNeedingRestart).toEqual([]);

      // llm.command → none (registry corrected: agentqueue re-reads each tick)
      const r3 = mgr.update("llm.command", ["codex"]);
      expect(r3.daemonsNeedingSighup).toEqual([]);
      expect(r3.daemonsNeedingRestart).toEqual([]);
    } finally { cleanup(); }
  });

  it("classifies transcription.mode + transcription.cloud_command as sttdaemon restart (TRANS-01/02)", () => {
    const { mgr, cleanup } = makeCfg();
    try {
      const rMode = mgr.update("transcription.mode", "cloud-fallback");
      expect(rMode.daemonsNeedingRestart).toEqual(["sttdaemon"]);
      expect(rMode.daemonsNeedingSighup).toEqual([]);
      expect(mgr.read().transcription.mode).toBe("cloud-fallback");

      const rCmd = mgr.update("transcription.cloud_command", ["my-cloud-stt", "--stdin"]);
      expect(rCmd.daemonsNeedingRestart).toEqual(["sttdaemon"]);
      expect(rCmd.daemonsNeedingSighup).toEqual([]);
      expect(mgr.read().transcription.cloud_command).toEqual(["my-cloud-stt", "--stdin"]);
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

describe("atomic write", () => {
  it("update 原子写:落盘后不留 .tmp 残file,内容正确", () => {
    const { mgr, path, cleanup } = makeCfg();
    const dir = path.replace(/\/config\.json$/, "");
    try {
      mgr.update("audio.silence_threshold", 0.02);
      const leftovers = fs.readdirSync(dir).filter((f) => f.includes(".tmp"));
      expect(leftovers).toEqual([]);
      expect(mgr.read().audio.silence_threshold).toBe(0.02);
    } finally { cleanup(); }
  });
});

describe("registry-driven classify + per-field validation", () => {
  it("language 改完返回 restart sttdaemon(注册表驱动)", () => {
    const { mgr, cleanup } = makeCfg();
    try {
      expect(mgr.update("transcription.language", "en")).toEqual({ daemonsNeedingRestart: ["sttdaemon"], daemonsNeedingSighup: [] });
    } finally { cleanup(); }
  });
  it("llm.command 改完无需动作", () => {
    const { mgr, cleanup } = makeCfg();
    try {
      expect(mgr.update("llm.command", ["claude","--print"])).toEqual({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] });
    } finally { cleanup(); }
  });
  it("非法值被拒(注册表 Zod 校验)", () => {
    const { mgr, cleanup } = makeCfg();
    try {
      expect(() => mgr.update("audio.silence_threshold", 5)).toThrow(ZodError);  // max 1
    } finally { cleanup(); }
  });
  it("record 子路径(transcription.mlx.model)不被父级 z.record 误拒,reload 仍前缀匹配 sttdaemon", () => {
    const { mgr, cleanup } = makeCfg();
    try {
      expect(() => mgr.update("transcription.mlx.model", "whisper-large-v3-mlx")).not.toThrow();
      expect(mgr.update("transcription.mlx.final_model", "turbo")).toEqual({ daemonsNeedingRestart: ["sttdaemon"], daemonsNeedingSighup: [] });
    } finally { cleanup(); }
  });
  it("post_recording_mode:合法枚举值写入成功且 reload none;非法值被拒(P2-1)", () => {
    const { mgr, cleanup } = makeCfg();
    try {
      expect(mgr.update("transcription.post_recording_mode", "full_transcribe")).toEqual({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] });
      expect(mgr.read().transcription.post_recording_mode).toBe("full_transcribe");
      expect(() => mgr.update("transcription.post_recording_mode", "bogus")).toThrow(ZodError);
    } finally { cleanup(); }
  });
});

describe("cloud transcription holds NO keys (TRANS-02 / T-04-KEY guardrail)", () => {
  it("config.ts declares no cloud API-key / token / secret field", () => {
    const src = readFileSync(CONFIG_TS, "utf8");
    // The cloud path is a COMMAND (transcription.cloud_command), never a held credential.
    expect(/cloud_api_key|api[_-]?key|cloud[_-]?key|\btoken\b|\bsecret\b|password/i.test(src)).toBe(false);
  });
});
