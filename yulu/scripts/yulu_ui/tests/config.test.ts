import { describe, it, expect, vi } from "vitest";
import { ConfigManager, migrateLegacyTranscriptionConfig } from "../src/config.js";
import * as fs from "node:fs";
import { ZodError } from "zod";
import { cpSync, mkdtempSync, readdirSync, rmSync, utimesSync, statSync, readFileSync } from "node:fs";
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
    fs.writeFileSync(path, JSON.stringify({ audio: { output_dir: "~/Movies/Yulu" } }));
    try {
      const cfg = new ConfigManager(path).read();
      expect(cfg.audio.silence_threshold).toBe(0.01);       // default
      expect(cfg.audio.silence_duration_sec).toBe(300);     // default
      expect(cfg.audio.output_dir).toBe("~/Movies/Yulu");
      expect(cfg.transcription.language).toBe("zh");
      expect(cfg.realtime_captions.strategy).toBe("local-hybrid");
      expect(cfg.transcription.dictation.prompt_slug).toBe("dictation-cleanup");
      expect(cfg.transcription.dictation.timeout_sec).toBe(30);
      expect(cfg.transcription.dictation.deadline_sec).toBe(30);
      expect(cfg.transcription.dictation.translate_timeout_sec).toBe(30);
      expect(cfg.transcription.dictation.translate_deadline_sec).toBe(30);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("read() defaults status_agent.enabled to true when the block is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "yulu_status_agent_default_"));
    const path = join(dir, "config.json");
    fs.writeFileSync(path, JSON.stringify({ audio: { output_dir: "~/Movies/Yulu" }, transcription: {} }));
    try {
      const cfg = new ConfigManager(path).read();
      expect(cfg.status_agent.enabled).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("archives and migrates retired Yulu connector configuration", () => {
    const dir = mkdtempSync(join(tmpdir(), "yulu_connector_migration_"));
    const path = join(dir, "config.json");
    fs.writeFileSync(path, JSON.stringify({
      audio: { output_dir: "~/Movies/Yulu" },
      transcription: {},
      connectors: {
        notion: { send_summary: true, database_id: "notion-db" },
        zulip: { stream: "legacy-stream", topic: "legacy-topic" },
      },
      output: { notion: { destination_label: "Meetings DB" } },
    }));
    try {
      const cfg = new ConfigManager(path).read();
      expect(cfg.agent_pipeline.auto_send_notion).toBe(true);
      expect(cfg.agent_pipeline.notion_destination).toBe("Meetings DB");
      expect(cfg.agent_console.destinations.hermes?.notion.target).toBe("Meetings DB");
      const raw = JSON.parse(readFileSync(path, "utf8"));
      expect(raw.output).toBeUndefined();
      expect(raw.connectors.notion).toBeUndefined();
      expect(raw.connectors.zulip).toBeUndefined();
      const archives = readdirSync(dir).filter((name) => name.includes("legacy-connectors"));
      expect(archives).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(dir, archives[0]!), "utf8"))).toMatchObject({
        connectors: { notion: { database_id: "notion-db" } },
      });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("preserves an explicit durable Notion destination during connector migration", () => {
    const dir = mkdtempSync(join(tmpdir(), "yulu_connector_destination_"));
    const path = join(dir, "config.json");
    fs.writeFileSync(path, JSON.stringify({
      audio: { output_dir: "~/Movies/Yulu" },
      transcription: {},
      agent_pipeline: { notion_destination: "Explicit target" },
      connectors: { notion: { database_id: "legacy-db" } },
    }));
    try {
      expect(new ConfigManager(path).read().agent_pipeline.notion_destination).toBe("Explicit target");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("archives retired local transcription settings before removing them from active config", () => {
    const dir = mkdtempSync(join(tmpdir(), "yulu_transcription_migration_"));
    const path = join(dir, "config.json");
    fs.writeFileSync(path, JSON.stringify({
      audio: { output_dir: "~/Movies/Yulu" },
      transcription: {
        language: "ja",
        glossary: ["AgentKey"],
        mode: "local",
        post_recording_mode: "full_transcribe",
        final_engine: "mlx",
        local_model_path: "/models/legacy.bin",
        whisper_cli: "whisper-cli",
        mlx: { model: "legacy-mlx" },
        hermes: { model: "legacy-hermes" },
        realtime: { mlx_model: "legacy-realtime" },
        diarization: { enabled: true },
        command: ["legacy-stt"],
        realtime_enabled: true,
        dictation: {
          engine: "whisper",
          prompt_slug: "dictation-tight",
          target_language: "English",
          timeout_sec: 3,
          deadline_sec: 45,
          translate_timeout_sec: 2,
          translate_deadline_sec: 3,
        },
      },
    }));
    try {
      const migration = migrateLegacyTranscriptionConfig(path);
      expect(migration.changed).toBe(true);
      expect(migration.archivePath).toBeTruthy();
      expect(statSync(migration.archivePath!).mode & 0o777).toBe(0o600);
      const archive = JSON.parse(readFileSync(migration.archivePath!, "utf8"));
      expect(archive.transcription).toMatchObject({
        final_engine: "mlx",
        local_model_path: "/models/legacy.bin",
        hermes: { model: "legacy-hermes" },
        dictation: { engine: "whisper", timeout_sec: 3, translate_timeout_sec: 2, translate_deadline_sec: 3 },
      });

      const active = JSON.parse(readFileSync(path, "utf8"));
      expect(active.transcription).toEqual({
        language: "ja",
        glossary: ["AgentKey"],
        dictation: {
          prompt_slug: "dictation-tight",
          target_language: "English",
          timeout_sec: 30,
          deadline_sec: 45,
          translate_timeout_sec: 30,
          translate_deadline_sec: 30,
        },
      });
      expect(migrateLegacyTranscriptionConfig(path)).toEqual({ changed: false, archivePath: null });
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

  it("update() preserves restrictive config file permissions", () => {
    const { path, mgr, cleanup } = makeCfg();
    try {
      fs.chmodSync(path, 0o600);
      mgr.update("audio.silence_threshold", 0.02);
      expect(statSync(path).mode & 0o777).toBe(0o600);
    } finally { cleanup(); }
  });

  it("Agent-owned language and LLM settings apply without daemon reload", () => {
    const { mgr, cleanup } = makeCfg();
    try {
      const language = mgr.update("transcription.language", "en");
      expect(language).toEqual({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] });
      const r3 = mgr.update("llm.command", ["codex"]);
      expect(r3.daemonsNeedingSighup).toEqual([]);
      expect(r3.daemonsNeedingRestart).toEqual([]);
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
  it("language is an Agent input and needs no daemon reload", () => {
    const { mgr, cleanup } = makeCfg();
    try {
      expect(mgr.update("transcription.language", "en")).toEqual({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] });
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
  it("rejects retired local transcription settings", () => {
    const { mgr, cleanup } = makeCfg();
    try {
      expect(() => mgr.update("transcription.mlx.model", "legacy-model")).toThrow(/Agent-owned/);
      expect(() => mgr.update("transcription.diarization.enabled", true)).toThrow(/Agent-owned/);
      expect(() => mgr.update("transcription.dictation.engine", "whisper")).toThrow(/Agent-owned/);
    } finally { cleanup(); }
  });
  it("meeting_detection.enabled 改完 restart detector;interval_sec<1 被拒(P2-3)", () => {
    const { mgr, cleanup } = makeCfg();
    try {
      expect(mgr.update("meeting_detection.enabled", false)).toEqual({ daemonsNeedingRestart: ["detector"], daemonsNeedingSighup: [] });
      expect((mgr.read() as { meeting_detection?: { enabled?: boolean } }).meeting_detection?.enabled).toBe(false);
      expect(() => mgr.update("meeting_detection.interval_sec", 0)).toThrow(ZodError);
    } finally { cleanup(); }
  });
  it("agent_pipeline auto-send consent writes without daemon reload", () => {
    const { mgr, cleanup } = makeCfg();
    try {
      expect(mgr.update("agent_pipeline.auto_send_notion", true)).toEqual({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] });
      expect(mgr.read().agent_pipeline.auto_send_notion).toBe(true);
      expect(() => mgr.update("agent_pipeline.auto_send_notion", "yes")).toThrow(ZodError);
    } finally { cleanup(); }
  });
});

describe("Agent-owned transcription holds no provider credentials", () => {
  it("config.ts declares no held transcription API-key / token / secret field", () => {
    let src = readFileSync(CONFIG_TS, "utf8");
    for (const allowedEnvNameRef of [
      "api_key_env",
      "app_secret_env",
      "FEISHU_APP_SECRET",
      "NOTION_API_KEY",
    ]) {
      src = src.replaceAll(allowedEnvNameRef, "");
    }
    expect(/cloud_api_key|api[_-]?key|cloud[_-]?key|\btoken\b|\bsecret\b|password/i.test(src)).toBe(false);
  });
});
