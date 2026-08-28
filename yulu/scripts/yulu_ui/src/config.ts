import { existsSync, readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { z } from "zod";
import {
  TextProviderSelectionSchema,
  XAI_TEXT_MODEL_DEFAULT,
  defFor,
  reloadFor,
} from "./settingsRegistry.js";

export { XAI_TEXT_MODEL_DEFAULT };

const CalendarSchema = z.object({
  type: z.enum(["macos", "system", "feishu", "google"]),
  enabled: z.boolean().optional(),
  credentials_path: z.string().optional(),
  app_id_env: z.string().optional(),
  app_secret_env: z.string().optional(),
  gog_account: z.string().optional(),
  watch_calendars: z.array(z.string()).optional(),
});

const ConnectorsSchema = z.object({
  gog: z.object({
    read_calendar: z.boolean().default(false),
  }).passthrough().default({}),
  feishu: z.object({
    read_calendar: z.boolean().default(false),
    app_id_env: z.string().default("FEISHU_APP_ID"),
    app_secret_env: z.string().default("FEISHU_APP_SECRET"),
  }).passthrough().default({}),
}).passthrough().default({});

const ThemeTokenSchema = z.object({
  wallpaper: z.string().optional(),
  surface: z.string().optional(),
  surfaceStrong: z.string().optional(),
  edge: z.string().optional(),
  text: z.string().optional(),
  muted: z.string().optional(),
  accent: z.string().optional(),
  blue: z.string().optional(),
  green: z.string().optional(),
  red: z.string().optional(),
  purple: z.string().optional(),
}).passthrough().default({});

const ThemeSchema = z.object({
  family: z.enum(["default", "ayu", "paper", "custom"]).default("default"),
  mode: z.enum(["auto", "light", "dark"]).default("auto"),
  custom: z.object({
    light: ThemeTokenSchema,
    dark: ThemeTokenSchema,
  }).passthrough().default({}),
}).passthrough().default({});

const AgentConsoleSchema = z.object({
  plugins: z.object({
    added: z.array(z.enum(["summary", "notion", "zulip", "calendar"])).default(["summary"]),
  }).passthrough().default({}),
  destinations: z.record(z.object({
    notion: z.object({
      target: z.string().default("Yulu Meeting"),
    }).passthrough().default({}),
    zulip: z.object({
      stream: z.string().default(""),
      topic: z.string().default(""),
    }).passthrough().default({}),
  }).passthrough()).default({}),
}).passthrough().default({});

const AgentPipelineSchema = z.object({
  enabled: z.boolean().default(true),
  auto_process_recordings: z.boolean().default(true),
  notion_destination: z.string().default("Yulu Meeting"),
}).passthrough().default({});

const DictationSchema = z.object({
  prompt_slug: z.string().default("dictation-cleanup"),
  translate_prompt_slug: z.string().default("dictation-translate"),
  target_language: z.string().default("English"),
  timeout_sec: z.number().default(30),
  deadline_sec: z.number().default(30),
  translate_timeout_sec: z.number().default(30),
  translate_deadline_sec: z.number().default(30),
  context_limit: z.number().default(240),
}).passthrough().default({});

const StatusAgentHotkeySchema = z.object({
  key: z.string().default(""),
  modifiers: z.array(z.enum(["cmd", "shift", "alt", "ctrl"])).default([]),
  target_language: z.string().optional(),
}).passthrough();

const StatusAgentSchema = z.object({
  enabled: z.boolean().default(true),
  feedback_sounds: z.boolean().default(true),
  hotkeys: z.object({
    dictate: StatusAgentHotkeySchema.default({ key: "Space", modifiers: ["ctrl", "alt"] }),
    translate: StatusAgentHotkeySchema.default({ key: "T", modifiers: ["ctrl", "alt"], target_language: "English" }),
    voice_chat: StatusAgentHotkeySchema.default({ key: "A", modifiers: ["ctrl", "alt"] }),
  }).passthrough().default({}),
}).passthrough().default({});

export const ConfigSchema = z.object({
  // Defaults so a minimal/partial config.json (e.g. only audio.output_dir) still
  // parses — otherwise config.get 500s and the whole settings page breaks.
  audio: z.object({
    mic_device: z.string().optional(),
    system_audio_device: z.string().nullable().optional(),
    output_dir: z.string().default("~/Movies/Yulu"),
    silence_threshold: z.number().default(0.01),
    silence_duration_sec: z.number().default(300),
    backend: z.string().optional(),
  }).default({}),
  transcription: z.object({
    engine: z.enum(["local", "xai"]).default("local"),
    language: z.enum(["zh", "en", "ja", "auto"]).default("zh"),
    glossary: z.array(z.string()).optional(),
    dictation: DictationSchema,
  }).passthrough().default({}),
  llm: z.object({
    enabled: z.boolean().optional(),
    command: z.array(z.string()).nullable().optional(),
    agent: z.object({
      provider: z.enum(["auto", "codex", "claude", "claude-code", "hermes", "openclaw", "gemini", "grok", "custom"]).default("auto"),
    }).passthrough().default({}),
  }).default({}),
  intelligence: z.object({
    summary: TextProviderSelectionSchema,
    conversation: TextProviderSelectionSchema,
  }).strict().default({}),
  status_agent: StatusAgentSchema,
  calendars: z.array(CalendarSchema).default([]),
  connectors: ConnectorsSchema,
  agent_console: AgentConsoleSchema,
  agent_pipeline: AgentPipelineSchema,
  ui: z.object({
    language: z.enum(["zh", "en"]).default("zh"),
    theme: ThemeSchema,
  }).passthrough().default({}),
}).passthrough();

export type YuluConfig = z.infer<typeof ConfigSchema>;

// RESTART_MAP removed — reload classification is now registry-driven via settingsRegistry.ts

export interface UpdateResult {
  daemonsNeedingRestart: string[];
  daemonsNeedingSighup: string[];
}

export interface ConfigUpdate {
  key: string;
  value: unknown;
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

function ensureRecord(parent: JsonRecord, key: string): JsonRecord {
  const current = record(parent[key]);
  parent[key] = current;
  return current;
}

function stringField(parent: JsonRecord, ...keys: string[]): string {
  for (const key of keys) {
    const value = parent[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

export interface AgentNativeConfigMigration {
  changed: boolean;
  archivePath: string | null;
}

const RETIRED_TRANSCRIPTION_KEYS = [
  "xai_credential_source",
  "mode",
  "post_recording_mode",
  "final_engine",
  "local_model_path",
  "whisper_cli",
  "mlx",
  "hermes",
  "realtime",
  "diarization",
  "command",
  "realtime_enabled",
] as const;

const RETIRED_AGENT_AUDIO_KEYS = ["hermes_serve_port", "transcription_chunk_sec"] as const;

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/**
 * Retire Yulu-owned connector configuration without destroying it.
 *
 * Destination preferences move to the Hermes Agent projection, and the removed
 * connector/output blocks are written to a mode-0600 archive before the active
 * config changes. Legacy automatic-sharing authorization is not migrated.
 */
export function migrateAgentNativeConfig(path: string): AgentNativeConfigMigration {
  if (!existsSync(path)) return { changed: false, archivePath: null };
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Yulu config must contain a JSON object");
  }
  const root = raw as JsonRecord;
  const connectors = record(root.connectors);
  const legacyNotion = record(connectors.notion);
  const legacyZulip = record(connectors.zulip);
  const legacyOutput = record(root.output);
  const hasLegacy = Object.keys(legacyNotion).length > 0 ||
    Object.keys(legacyZulip).length > 0 || Object.keys(legacyOutput).length > 0;
  if (!hasLegacy) return { changed: false, archivePath: null };

  const pipeline = ensureRecord(root, "agent_pipeline");

  const consoleConfig = ensureRecord(root, "agent_console");
  const destinations = ensureRecord(consoleConfig, "destinations");
  const hermes = ensureRecord(destinations, "hermes");
  const oldNotionOutput = record(legacyOutput.notion);
  const notionTarget = stringField(
    oldNotionOutput,
    "destination_label",
    "destination_id",
    "database_id",
  ) || stringField(legacyNotion, "database_id");
  const notion = ensureRecord(hermes, "notion");
  if (!stringField(notion, "target") && notionTarget) notion.target = notionTarget;
  if (!hasOwn(pipeline, "notion_destination") && notionTarget) pipeline.notion_destination = notionTarget;

  const oldZulipOutput = record(legacyOutput.zulip);
  const zulip = ensureRecord(hermes, "zulip");
  const stream = stringField(oldZulipOutput, "stream") || stringField(legacyZulip, "stream");
  const topic = stringField(oldZulipOutput, "topic") || stringField(legacyZulip, "topic");
  if (!stringField(zulip, "stream") && stream) zulip.stream = stream;
  if (!stringField(zulip, "topic") && topic) zulip.topic = topic;

  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const archivePath = join(dirname(path), `${basename(path, ".json")}.legacy-connectors.${stamp}.json`);
  const archive = {
    version: 1,
    migratedAt: new Date().toISOString(),
    sourcePath: path,
    connectors: { notion: legacyNotion, zulip: legacyZulip },
    output: legacyOutput,
  };
  const archiveTmp = `${archivePath}.${process.pid}.tmp`;
  writeFileSync(archiveTmp, `${JSON.stringify(archive, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(archiveTmp, archivePath);

  delete connectors.notion;
  delete connectors.zulip;
  root.connectors = connectors;
  delete root.output;
  const configTmp = `${path}.${process.pid}.agent-native.tmp`;
  writeFileSync(configTmp, `${JSON.stringify(root, null, 2)}\n`, { encoding: "utf8", mode: statSync(path).mode });
  renameSync(configTmp, path);
  return { changed: true, archivePath };
}

/** Archive and remove the retired Yulu-owned STT configuration surface. */
export function migrateLegacyTranscriptionConfig(path: string): AgentNativeConfigMigration {
  if (!existsSync(path)) return { changed: false, archivePath: null };
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Yulu config must contain a JSON object");
  }
  const root = raw as JsonRecord;
  const transcription = record(root.transcription);
  const legacy: JsonRecord = {};
  for (const key of RETIRED_TRANSCRIPTION_KEYS) {
    if (!hasOwn(transcription, key)) continue;
    legacy[key] = transcription[key];
  }
  const dictation = record(transcription.dictation);
  const legacyDictation: JsonRecord = {};
  if (hasOwn(dictation, "engine")) {
    legacyDictation.engine = dictation.engine;
  }
  for (const key of ["timeout_sec", "deadline_sec", "translate_timeout_sec", "translate_deadline_sec"] as const) {
    const value = dictation[key];
    if (typeof value !== "number" || value > 3) continue;
    legacyDictation[key] = value;
    dictation[key] = 30;
  }
  if (Object.keys(legacyDictation).length > 0) legacy.dictation = legacyDictation;
  const legacyRealtimeCaptions = record(root.realtime_captions);
  const pipeline = record(root.agent_pipeline);
  const legacyAgentAudio: JsonRecord = {};
  for (const key of RETIRED_AGENT_AUDIO_KEYS) {
    if (hasOwn(pipeline, key)) legacyAgentAudio[key] = pipeline[key];
  }
  if (
    Object.keys(legacy).length === 0 &&
    Object.keys(legacyRealtimeCaptions).length === 0 &&
    Object.keys(legacyAgentAudio).length === 0
  ) return { changed: false, archivePath: null };

  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const archivePath = join(dirname(path), `${basename(path, ".json")}.legacy-transcription.${stamp}.json`);
  const archiveTmp = `${archivePath}.${process.pid}.tmp`;
  writeFileSync(archiveTmp, `${JSON.stringify({
    version: 1,
    migratedAt: new Date().toISOString(),
    sourcePath: path,
    transcription: legacy,
    realtime_captions: legacyRealtimeCaptions,
    agent_pipeline_audio: legacyAgentAudio,
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(archiveTmp, archivePath);

  for (const key of RETIRED_TRANSCRIPTION_KEYS) delete transcription[key];
  delete dictation.engine;
  if (hasOwn(transcription, "dictation")) transcription.dictation = dictation;
  root.transcription = transcription;
  delete root.realtime_captions;
  for (const key of RETIRED_AGENT_AUDIO_KEYS) delete pipeline[key];
  if (hasOwn(root, "agent_pipeline")) root.agent_pipeline = pipeline;
  const configTmp = `${path}.${process.pid}.agent-transcription.tmp`;
  writeFileSync(configTmp, `${JSON.stringify(root, null, 2)}\n`, { encoding: "utf8", mode: statSync(path).mode });
  renameSync(configTmp, path);
  return { changed: true, archivePath };
}

/** Archive and remove the retired automatic-sharing authorization setting. */
export function migrateRetiredAutomaticSharingConfig(path: string): AgentNativeConfigMigration {
  if (!existsSync(path)) return { changed: false, archivePath: null };
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Yulu config must contain a JSON object");
  }
  const root = raw as JsonRecord;
  const pipeline = record(root.agent_pipeline);
  if (!hasOwn(pipeline, "auto_send_notion")) return { changed: false, archivePath: null };

  const stamp = new Date().toISOString().replace(/[-:.]/g, "");
  const archivePath = join(dirname(path), `${basename(path, ".json")}.legacy-automatic-share.${stamp}.json`);
  const archiveTmp = `${archivePath}.${process.pid}.tmp`;
  writeFileSync(archiveTmp, `${JSON.stringify({
    version: 1,
    migratedAt: new Date().toISOString(),
    sourcePath: path,
    agent_pipeline: { auto_send_notion: pipeline.auto_send_notion },
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(archiveTmp, archivePath);

  delete pipeline.auto_send_notion;
  root.agent_pipeline = pipeline;
  const configTmp = `${path}.${process.pid}.retired-automatic-share.tmp`;
  writeFileSync(configTmp, `${JSON.stringify(root, null, 2)}\n`, {
    encoding: "utf8",
    mode: statSync(path).mode,
  });
  renameSync(configTmp, path);
  return { changed: true, archivePath };
}

const RETIRED_GATEWAY_CONNECTION_ID = "cliproxyapi";

/** Clear only selections for the removed Yulu-owned Gateway connection. */
export function migrateRetiredGatewaySelections(path: string): boolean {
  if (!existsSync(path)) return false;
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Yulu config must contain a JSON object");
  }
  const root = raw as JsonRecord;
  const intelligence = record(root.intelligence);
  let changed = false;
  for (const capability of ["summary", "conversation"] as const) {
    const selection = record(intelligence[capability]);
    if (selection.provider !== "agent" || selection.connectionId !== RETIRED_GATEWAY_CONNECTION_ID) continue;
    intelligence[capability] = { provider: "agent", model: "runtime-managed", disabled: true };
    changed = true;
  }
  if (!changed) return false;
  root.intelligence = intelligence;
  const tmp = `${path}.${process.pid}.retired-gateway.tmp`;
  writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, {
    encoding: "utf8",
    mode: statSync(path).mode,
  });
  renameSync(tmp, path);
  return true;
}

export class ConfigManager {
  private cached: YuluConfig | null = null;
  private cachedMtime = 0;

  constructor(private readonly path: string) {
    migrateAgentNativeConfig(path);
    migrateRetiredAutomaticSharingConfig(path);
    migrateLegacyTranscriptionConfig(path);
    migrateRetiredGatewaySelections(path);
  }

  read(): YuluConfig {
    const mtime = statSync(this.path).mtimeMs;
    if (this.cached && this.cachedMtime === mtime) return this.cached;
    const raw = JSON.parse(readFileSync(this.path, "utf8"));
    this.cached = ConfigSchema.parse(raw);
    this.cachedMtime = mtime;
    return this.cached;
  }

  /**
   * Mutate one dotted key (e.g. "audio.silence_threshold"). Writes the
   * file atomically and returns which daemons need restart/sighup per
   * the spec §11 map. Throws if the file's mtime advanced since the
   * last read (someone else wrote to it).
   */
  update(dottedKey: string, value: unknown): UpdateResult {
    return this.updateMany([{ key: dottedKey, value }]);
  }

  /** Preserve retired command-based Agent configuration before clearing it. */
  archiveLegacyAgentConnection(): string {
    const raw = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const archivePath = join(
      dirname(this.path),
      `${basename(this.path, ".json")}.legacy-agent-connection.${stamp}.json`,
    );
    const archiveTmp = `${archivePath}.${process.pid}.tmp`;
    writeFileSync(archiveTmp, `${JSON.stringify({ llm: raw.llm ?? {} }, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(archiveTmp, archivePath);
    return archivePath;
  }

  /** Apply related configuration changes with one validated atomic rename. */
  updateMany(changes: ConfigUpdate[]): UpdateResult {
    if (changes.length === 0) return { daemonsNeedingRestart: [], daemonsNeedingSighup: [] };
    for (const { key } of changes) {
      if (key === "agent_pipeline.auto_send_notion" || key.startsWith("agent_pipeline.auto_send_notion.")) {
        throw new Error(`setting is retired because recording sharing is manual-only: ${key}`);
      }
      if (isRetiredTranscriptionSetting(key)) {
        throw new Error(`setting is retired because Yulu now uses one explicit audio engine: ${key}`);
      }
    }
    const onDiskMtime = statSync(this.path).mtimeMs;
    if (this.cached && onDiskMtime !== this.cachedMtime) {
      throw new Error(`Config file changed externally — reload before writing (${this.path})`);
    }
    const cfg = JSON.parse(readFileSync(this.path, "utf8"));
    for (const { key, value } of changes) {
      setByDottedKey(cfg, key, value);
      const def = defFor(key);
      // 校验只在精确路径做（reload 才前缀匹配），否则更新 record 子字段
      // 会被父级 z.record schema 误拒。
      if (def && def.path === key) def.validate.parse(value);
    }
    const parsed = ConfigSchema.parse(cfg);  // validate before write
    if (
      changes.some(({ key }) => key === "transcription.engine" || key === "transcription.language") &&
      parsed.transcription.engine === "local" && parsed.transcription.language === "ja"
    ) {
      throw new Error("本地 Paraformer 仅支持中英文；日语请使用 xAI 云端引擎");
    }
    const tmp = `${this.path}.tmp.${process.pid}`;
    const currentMode = statSync(this.path).mode & 0o777;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n", { mode: currentMode });
    renameSync(tmp, this.path);   // POSIX 原子,等价 Python os.replace
    this.cached = null;       // invalidate; next read() re-parses
    const restarts = new Set<string>();
    const sighups = new Set<string>();
    for (const { key } of changes) {
      const result = classify(key);
      result.daemonsNeedingRestart.forEach((daemon) => restarts.add(daemon));
      result.daemonsNeedingSighup.forEach((daemon) => sighups.add(daemon));
    }
    return { daemonsNeedingRestart: [...restarts], daemonsNeedingSighup: [...sighups] };
  }
}

function isRetiredTranscriptionSetting(dottedKey: string): boolean {
  if (dottedKey === "realtime_captions" || dottedKey.startsWith("realtime_captions.")) return true;
  if (RETIRED_AGENT_AUDIO_KEYS.some((key) => dottedKey === `agent_pipeline.${key}` || dottedKey.startsWith(`agent_pipeline.${key}.`))) return true;
  if (dottedKey === "transcription.dictation.engine" || dottedKey.startsWith("transcription.dictation.engine.")) return true;
  return RETIRED_TRANSCRIPTION_KEYS.some((key) => {
    const path = `transcription.${key}`;
    return dottedKey === path || dottedKey.startsWith(`${path}.`);
  });
}

function setByDottedKey(obj: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split(".");
  let cursor: Record<string, unknown> = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]!;
    if (cursor[p] === undefined || typeof cursor[p] !== "object" || cursor[p] === null) {
      cursor[p] = {};
    }
    cursor = cursor[p] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]!] = value;
}

function classify(dottedKey: string): UpdateResult {
  const r = reloadFor(dottedKey);
  return {
    daemonsNeedingRestart: r.kind === "restart" ? r.daemons : [],
    daemonsNeedingSighup:  r.kind === "sighup"  ? r.daemons : [],
  };
}
