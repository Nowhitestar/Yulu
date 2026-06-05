import { readFileSync, writeFileSync, renameSync, statSync } from "node:fs";
import { z } from "zod";
import { defFor, reloadFor } from "./settingsRegistry.js";

const HotkeySchema = z.object({
  key: z.string(),
  modifiers: z.array(z.enum(["cmd", "shift", "alt", "ctrl"])),
});
const CalendarSchema = z.object({
  type: z.enum(["feishu", "google"]),
  enabled: z.boolean().optional(),
  credentials_path: z.string().optional(),
  app_id_env: z.string().optional(),
  app_secret_env: z.string().optional(),
  gog_account: z.string().optional(),
  watch_calendars: z.array(z.string()).optional(),
});

export const ConfigSchema = z.object({
  audio: z.object({
    mic_device: z.string().optional(),
    system_audio_device: z.string().nullable().optional(),
    output_dir: z.string(),
    silence_threshold: z.number(),
    silence_duration_sec: z.number(),
    backend: z.string().optional(),
  }),
  transcription: z.object({
    final_engine: z.enum(["mlx", "whisper"]).optional(),
    language: z.string().optional(),
    glossary: z.array(z.string()).optional(),
    local_model_path: z.string().optional(),
    mlx: z.record(z.unknown()).optional(),
    command: z.array(z.string()).optional(),
    realtime_enabled: z.boolean().optional(),
  }).passthrough(),
  llm: z.object({
    enabled: z.boolean().optional(),
    command: z.array(z.string()).optional(),
  }).default({}),
  status_agent: z.object({
    enabled: z.boolean().optional(),
    hotkey: HotkeySchema.optional(),
  }).default({}),
  calendars: z.array(CalendarSchema).default([]),
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
    if (def) def.validate.parse(value);   // 单项校验,非法抛 ZodError
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
