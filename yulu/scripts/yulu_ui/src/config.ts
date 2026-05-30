import { readFileSync, writeFileSync, statSync } from "node:fs";
import { z } from "zod";

const HotkeySchema = z.object({
  key: z.string(),
  modifiers: z.array(z.enum(["cmd", "shift", "alt", "ctrl"])),
});
const CalendarSchema = z.object({
  type: z.enum(["feishu", "google"]),
  enabled: z.boolean().optional(),
  credentials_path: z.string().optional(),
  account: z.string().optional(),
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
    final_engine: z.enum(["mlx", "whisper-cli"]).optional(),
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

/**
 * Spec §11 — config key → daemon impact.
 * "restart" means launchctl unload+load; "sighup" means kill -HUP <pid>.
 * Anything not listed has no daemon impact.
 */
const RESTART_MAP: Record<string, string> = {
  "audio.mic_device":                "restart:audiodaemon",
  "audio.system_audio_device":       "restart:audiodaemon",
  "audio.silence_threshold":         "restart:audiodaemon",
  "audio.silence_duration_sec":      "restart:audiodaemon",
  "audio.backend":                   "restart:audiodaemon",
  "audio.output_dir":                "none",
  "transcription.mode":              "restart:sttdaemon",
  "transcription.cloud_command":     "restart:sttdaemon",
  "transcription.final_engine":      "restart:sttdaemon",
  "transcription.language":          "sighup:sttdaemon",
  "transcription.glossary":          "sighup:sttdaemon",
  "transcription.command":           "restart:sttdaemon",
  "transcription.local_model_path":  "restart:sttdaemon",
  "transcription.mlx":               "restart:sttdaemon",
  "transcription.realtime_enabled":  "none",
  "llm.enabled":                     "sighup:agentqueue",
  "llm.command":                     "sighup:agentqueue",
  "calendars":                       "restart:calendar,scheduler",
  "status_agent.enabled":            "restart:statusagent",
  "status_agent.hotkey":             "sighup:statusagent",
};

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
    ConfigSchema.parse(cfg);  // validate before write
    writeFileSync(this.path, JSON.stringify(cfg, null, 2) + "\n");
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
  let best: string | null = null;
  for (const k of Object.keys(RESTART_MAP)) {
    if (dottedKey === k || dottedKey.startsWith(k + ".")) {
      if (!best || k.length > best.length) best = k;
    }
  }
  if (!best) return { daemonsNeedingRestart: [], daemonsNeedingSighup: [] };
  const tag = RESTART_MAP[best];
  if (tag === undefined || tag === "none") {
    return { daemonsNeedingRestart: [], daemonsNeedingSighup: [] };
  }
  const [kind, names] = tag.split(":");
  const daemons = names!.split(",");
  return {
    daemonsNeedingRestart: kind === "restart" ? daemons : [],
    daemonsNeedingSighup:  kind === "sighup"  ? daemons : [],
  };
}
