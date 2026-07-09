// src/settingsRegistry.ts
import { z } from "zod";

export type Daemon =
  | "audiodaemon" | "sttdaemon" | "agentqueue"
  | "detector" | "scheduler" | "calendar" | "statusagent";

export type ReloadAction =
  | { kind: "none" }
  | { kind: "sighup"; daemons: Daemon[] }
  | { kind: "restart"; daemons: Daemon[] };

export type SettingCategory =
  | "transcription" | "audio" | "llm"
  | "automation" | "integrations" | "general" | "voice" | "advanced";

export interface SettingDef {
  path: string;
  category: SettingCategory;
  label: string;
  help?: string;
  type: "text" | "number" | "select" | "toggle" | "path" | "command" | "preset" | "env-name";
  validate: z.ZodTypeAny;
  reload: ReloadAction;
  danger?: boolean;
  advanced?: boolean;
  hidden?: boolean;
}

const R = {
  none: { kind: "none" } as ReloadAction,
  restart: (...d: Daemon[]): ReloadAction => ({ kind: "restart", daemons: d }),
  sighup: (...d: Daemon[]): ReloadAction => ({ kind: "sighup", daemons: d }),
};

const ThemeSettingSchema = z.object({
  family: z.enum(["default", "ayu", "paper", "custom"]).default("default"),
  mode: z.enum(["auto", "light", "dark"]).default("auto"),
  custom: z.unknown().optional(),
}).passthrough();

const HotkeysSchema = z.record(z.object({
  key: z.string(),
  modifiers: z.array(z.enum(["cmd", "shift", "alt", "ctrl"])),
  target_language: z.string().optional(),
}).passthrough());

const DictationSchema = z.object({
  engine: z.enum(["auto", "mlx", "whisper", "hermes"]).optional(),
  prompt_slug: z.string().optional(),
  translate_prompt_slug: z.string().optional(),
  target_language: z.string().optional(),
}).passthrough();

// 仅当前已暴露的设置(P2 再补缺失项)。reload 已修正(B3)。
export const SETTINGS: SettingDef[] = [
  { path: "ui.theme",                    category: "general", label: "Theme", type: "preset", validate: ThemeSettingSchema, reload: R.none },
  { path: "audio.mic_device",            category: "audio", label: "麦克风设备",   type: "select",  validate: z.string(),                  reload: R.restart("audiodaemon") },
  { path: "audio.system_audio_device",   category: "audio", label: "系统音设备",   type: "select",  validate: z.string().nullable(),       reload: R.restart("audiodaemon") },
  { path: "audio.output_dir",            category: "audio", label: "录音输出目录", type: "path",    validate: z.string().min(1),           reload: R.restart("audiodaemon"), danger: true }, // 改录音落盘位置:影响正在/后续录音
  { path: "audio.silence_threshold",     category: "audio", label: "静音阈值",     type: "number",  validate: z.number().min(0).max(1),    reload: R.restart("audiodaemon") },
  { path: "audio.silence_duration_sec",  category: "audio", label: "静音时长(秒)", type: "number", validate: z.number().min(1).max(3600),   reload: R.restart("audiodaemon") },
  { path: "audio.backend",               category: "audio", label: "音频后端",     type: "select",  validate: z.enum(["daemon"]),          reload: R.restart("audiodaemon"), danger: true }, // 切换采集后端:可能中断录音
  // transcription.mode is now behind an Advanced disclosure in the transcription
  // section (P4a-1); it stays a registry field (restart sttdaemon) but is flagged
  // advanced so the section can group it.
  { path: "transcription.mode",          category: "transcription", label: "转写模式", type: "select", validate: z.string(),               reload: R.restart("sttdaemon"), advanced: true },
  { path: "transcription.post_recording_mode", category: "transcription", label: "Post-recording", type: "select", validate: z.enum(["fast_summary", "full_transcribe"]), reload: R.none }, // transcribe.py 每次跑读取,无需重载

  { path: "transcription.language",      category: "transcription", label: "语言",   type: "text",   validate: z.string().min(2).max(20),  reload: R.restart("sttdaemon") },   // B3 修正:旧为 sighup
  { path: "transcription.final_engine",  category: "transcription", label: "最终引擎", type: "select", validate: z.enum(["mlx", "whisper", "hermes"]), reload: R.restart("sttdaemon") },
  { path: "transcription.local_model_path", category: "transcription", label: "本地模型", type: "path", validate: z.string(),             reload: R.restart("sttdaemon"), danger: true }, // 换模型路径:影响转写,误改即转写失败
  // transcription.mlx is a record; its only daemon-read sub-key is .model
  // (stt_daemon/config.py reads transcription.mlx.model). The other historical
  // mlx.* keys (preprocess_audio/passthrough_max_*/final_model) are NOT read by
  // any daemon and were removed from the UI (P4a-1).
  { path: "transcription.mlx",           category: "transcription", label: "MLX 参数", type: "text", validate: z.record(z.unknown()),      reload: R.restart("sttdaemon"), danger: true }, // MLX 引擎参数:误改影响转写质量/可用性
  { path: "transcription.hermes",        category: "transcription", label: "Hermes 参数", type: "text", validate: z.record(z.unknown()),   reload: R.restart("sttdaemon"), danger: true },
  // Realtime/live-caption model (transcription.realtime.mlx_model) — a faster
  // model than the final pass. Read at daemon startup, so restart-class.
  { path: "transcription.realtime.mlx_model", category: "transcription", label: "实时字幕模型", type: "text", validate: z.string(),         reload: R.restart("sttdaemon") },
  // whisper.cpp CLI binary (transcription.whisper_cli) — only used on the
  // whisper engine path; advanced, read at startup → restart sttdaemon.
  { path: "transcription.whisper_cli",   category: "transcription", label: "whisper.cpp CLI", type: "text", validate: z.string().min(1),   reload: R.restart("sttdaemon"), advanced: true },
  { path: "transcription.cloud_command", category: "advanced", label: "云转写命令", type: "command", validate: z.array(z.string()),       reload: R.restart("sttdaemon") },
  { path: "transcription.realtime_enabled", category: "transcription", label: "实时字幕", type: "toggle", validate: z.boolean(),          reload: R.none },
  { path: "transcription.diarization.enabled", category: "transcription", label: "说话人分离", type: "toggle", validate: z.boolean(),     reload: R.restart("sttdaemon") },
  { path: "transcription.diarization.provider", category: "transcription", label: "说话人分离 Provider", type: "select", validate: z.enum(["sherpa-onnx"]), reload: R.restart("sttdaemon"), advanced: true },
  { path: "transcription.diarization.num_speakers", category: "transcription", label: "说话人数", type: "number", validate: z.number().int().min(1).max(8).nullable(), reload: R.restart("sttdaemon") },
  { path: "transcription.diarization.threshold", category: "transcription", label: "聚类阈值", type: "number", validate: z.number().min(0).max(1), reload: R.restart("sttdaemon") },
  { path: "transcription.diarization.seg_model", category: "transcription", label: "Diarization segmentation model", type: "text", validate: z.string(), reload: R.restart("sttdaemon"), danger: true, advanced: true },
  { path: "transcription.diarization.emb_model", category: "transcription", label: "Diarization embedding model", type: "text", validate: z.string(), reload: R.restart("sttdaemon"), danger: true, advanced: true },
  { path: "transcription.glossary",      category: "transcription", label: "术语表",   type: "text",   validate: z.array(z.string()),        reload: R.sighup("sttdaemon") },  // 术语表走 VocabCache SIGHUP(正确)
  { path: "llm.enabled",                 category: "llm", label: "启用 LLM",       type: "toggle",  validate: z.boolean(),                 reload: R.none, hidden: true },
  { path: "llm.command",                 category: "llm", label: "LLM 后端",       type: "preset",  validate: z.array(z.string()).nullable(), reload: R.none, hidden: true },
  { path: "llm.agent.provider",          category: "llm", label: "Agent provider", type: "select",  validate: z.enum(["auto", "codex", "claude", "claude-code", "hermes", "openclaw"]), reload: R.none, hidden: true },
  { path: "calendars",                   category: "integrations", label: "日历",   type: "text",    validate: z.array(z.unknown()),        reload: R.restart("calendar", "scheduler"), hidden: true },
  { path: "connectors.gog.read_calendar", category: "integrations", label: "Read Google calendars", type: "toggle", validate: z.boolean(), reload: R.restart("calendar", "scheduler"), hidden: true },
  { path: "connectors.feishu.read_calendar", category: "integrations", label: "Read Feishu calendars", type: "toggle", validate: z.boolean(), reload: R.restart("calendar", "scheduler"), hidden: true },
  { path: "connectors.notion.send_summary", category: "integrations", label: "Send summaries to Notion", type: "toggle", validate: z.boolean(), reload: R.none, hidden: true },
  { path: "connectors.zulip.send_summary", category: "integrations", label: "Send summaries to Zulip", type: "toggle", validate: z.boolean(), reload: R.none, hidden: true },
  // meeting_detection: the detector daemon reads config at startup, so changes restart it.
  { path: "meeting_detection.enabled",             category: "automation", label: "Meeting detection",  type: "toggle",  validate: z.boolean(),       reload: R.restart("detector") },
  { path: "meeting_detection.interval_sec",        category: "automation", label: "Poll interval (s)",  type: "number",  validate: z.number().min(1), reload: R.restart("detector") },
  { path: "meeting_detection.stable_sec",          category: "automation", label: "Stable window (s)",  type: "number",  validate: z.number().min(1), reload: R.restart("detector") },
  { path: "meeting_detection.prompt_cooldown_sec", category: "automation", label: "Prompt cooldown (s)", type: "number", validate: z.number().min(0), reload: R.restart("detector") },
  // The large keyword/app match arrays — advanced, edited as string-array chips
  // behind the automation "Advanced" disclosure (P3-2). All restart-class
  // (detector reads them at startup).
  { path: "meeting_detection.window_keywords",        category: "automation", label: "Window title keywords",     type: "command", validate: z.array(z.string()), reload: R.restart("detector"), advanced: true },
  { path: "meeting_detection.app_name_hints",         category: "automation", label: "App name hints",           type: "command", validate: z.array(z.string()), reload: R.restart("detector"), advanced: true },
  { path: "meeting_detection.target_app_names",       category: "automation", label: "Target app names",         type: "command", validate: z.array(z.string()), reload: R.restart("detector"), advanced: true },
  { path: "meeting_detection.dedicated_meeting_apps", category: "automation", label: "Dedicated meeting apps",    type: "command", validate: z.array(z.string()), reload: R.restart("detector"), advanced: true },
  { path: "meeting_detection.ignore_window_keywords", category: "automation", label: "Ignore window keywords",    type: "command", validate: z.array(z.string()), reload: R.restart("detector"), advanced: true },
  // output channels: agent_queue_worker re-reads config each 30s tick, so no reload.
  // api_key_env holds the NAME of an env var (never the secret) — type "env-name".
  { path: "output.channel",            category: "integrations", label: "Output channel",        type: "select",   validate: z.enum(["file", "zulip", "notion"]), reload: R.none, hidden: true },
  { path: "output.notion.destination_id", category: "integrations", label: "Notion destination", type: "text", validate: z.string(), reload: R.none, hidden: true },
  { path: "output.notion.destination_type", category: "integrations", label: "Notion destination type", type: "text", validate: z.string(), reload: R.none, hidden: true },
  { path: "output.notion.destination_label", category: "integrations", label: "Notion destination label", type: "text", validate: z.string(), reload: R.none, hidden: true },
  { path: "output.zulip.stream_id",     category: "integrations", label: "Zulip stream ID",       type: "text",     validate: z.string(),               reload: R.none, hidden: true },
  { path: "output.zulip.stream",       category: "integrations", label: "Zulip stream",          type: "text",     validate: z.string(),               reload: R.none, hidden: true },
  { path: "output.zulip.topic",        category: "integrations", label: "Zulip topic",           type: "text",     validate: z.string(),               reload: R.none, hidden: true },
  { path: "output.notion.database_id", category: "integrations", label: "Notion database",       type: "text",     validate: z.string(),               reload: R.none, hidden: true },
  { path: "output.notion.api_key_env", category: "integrations", label: "Notion API key env var", type: "env-name", validate: z.string(),               reload: R.none, hidden: true },
  { path: "status_agent.enabled",        category: "general", label: "菜单栏 Agent", type: "toggle", validate: z.boolean(),               reload: R.none },
  { path: "status_agent.hotkeys",        category: "voice", label: "语音输入快捷键", type: "text", validate: HotkeysSchema,              reload: R.sighup("statusagent") },
  { path: "transcription.dictation",     category: "voice", label: "语音输入模板", type: "text", validate: DictationSchema,             reload: R.none },
];

export function defFor(path: string): SettingDef | undefined {
  let best: SettingDef | undefined;
  for (const d of SETTINGS) {
    if (path === d.path || path.startsWith(d.path + ".")) {
      if (!best || d.path.length > best.path.length) best = d;
    }
  }
  return best;
}
export function reloadFor(path: string): ReloadAction {
  return defFor(path)?.reload ?? { kind: "none" };
}
