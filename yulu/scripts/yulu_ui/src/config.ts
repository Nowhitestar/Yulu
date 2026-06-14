import { readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { z } from "zod";
import { defFor, reloadFor } from "./settingsRegistry.js";

const CalendarSchema = z.object({
  type: z.enum(["feishu", "google"]),
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
  notion: z.object({
    send_summary: z.boolean().default(false),
    database_id: z.string().default(""),
    api_key_env: z.string().default("NOTION_API_KEY"),
  }).passthrough().default({}),
  zulip: z.object({
    send_summary: z.boolean().default(false),
    stream: z.string().default("meetings"),
    topic: z.string().default("会议纪要"),
  }).passthrough().default({}),
}).passthrough().default({});

const OutputSchema = z.object({
  // Keep legacy "telegram" readable so older config.json files do not break the UI.
  // New writes are blocked by settingsRegistry and the visible settings UI.
  channel: z.enum(["file", "zulip", "notion", "telegram"]).default("file"),
  notion: z.object({
    destination_id: z.string().default(""),
    destination_type: z.string().default("database"),
    destination_label: z.string().default(""),
    database_id: z.string().default(""),
    api_key_env: z.string().default("NOTION_API_KEY"),
  }).passthrough().default({}),
  zulip: z.object({
    stream_id: z.string().default(""),
    stream: z.string().default("meetings"),
    topic: z.string().default("会议纪要"),
    zuliprc: z.string().default("~/.zuliprc"),
  }).passthrough().default({}),
}).passthrough().default({});

const DEFAULT_MLX_MODEL = "mlx-community/whisper-large-v3-mlx";
const DEFAULT_REALTIME_MLX_MODEL = "mlx-community/whisper-large-v3-turbo";

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
    mode: z.enum(["local", "cloud-fallback", "cloud-priority"]).default("local"),
    post_recording_mode: z.enum(["fast_summary", "full_transcribe"]).default("fast_summary"),
    final_engine: z.enum(["mlx", "whisper"]).default("mlx"),
    language: z.string().default("zh"),
    glossary: z.array(z.string()).optional(),
    local_model_path: z.string().default("~/.config/yulu/models/ggml-large-v3.bin"),
    whisper_cli: z.string().default("whisper-cli"),
    mlx: z.object({
      model: z.string().default(DEFAULT_MLX_MODEL),
    }).passthrough().default({}),
    realtime: z.object({
      engine: z.enum(["mlx", "whisper"]).default("mlx"),
      mlx_model: z.string().default(DEFAULT_REALTIME_MLX_MODEL),
      chunk_sec: z.number().default(15),
      chunk_max_sec: z.number().default(30),
    }).passthrough().default({}),
    diarization: z.object({
      enabled: z.boolean().default(false),
      provider: z.string().default("sherpa-onnx"),
      seg_model: z.string().default(""),
      emb_model: z.string().default(""),
      num_speakers: z.number().nullable().default(null),
      threshold: z.number().default(0.6),
    }).passthrough().default({}),
    command: z.array(z.string()).optional(),
    realtime_enabled: z.boolean().default(true),
  }).passthrough(),
  llm: z.object({
    enabled: z.boolean().optional(),
    command: z.array(z.string()).optional(),
  }).default({}),
  status_agent: z.object({
    enabled: z.boolean().default(true),
  }).default({}),
  calendars: z.array(CalendarSchema).default([]),
  connectors: ConnectorsSchema,
  output: OutputSchema,
}).passthrough();

export type YuluConfig = z.infer<typeof ConfigSchema>;

// RESTART_MAP removed — reload classification is now registry-driven via settingsRegistry.ts

export interface UpdateResult {
  daemonsNeedingRestart: string[];
  daemonsNeedingSighup: string[];
}

export class ConfigManager {
  private cached: YuluConfig | null = null;
  private cachedMtime = 0;

  constructor(private readonly path: string) {}

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
    const onDiskMtime = statSync(this.path).mtimeMs;
    if (this.cached && onDiskMtime !== this.cachedMtime) {
      throw new Error(`Config file changed externally — reload before writing (${this.path})`);
    }
    const cfg = JSON.parse(readFileSync(this.path, "utf8"));
    setByDottedKey(cfg, dottedKey, value);
    const def = defFor(dottedKey);
    // 校验只在精确路径做(reload 才前缀匹配);否则改 record 子字段(如 transcription.mlx.model)
    // 会被父级 z.record schema 误拒。
    if (def && def.path === dottedKey) def.validate.parse(value);
    ConfigSchema.parse(cfg);  // validate before write
    const tmp = `${this.path}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(cfg, null, 2) + "\n");
    renameSync(tmp, this.path);   // POSIX 原子,等价 Python os.replace
    this.cached = null;       // invalidate; next read() re-parses
    return classify(dottedKey);
  }
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
