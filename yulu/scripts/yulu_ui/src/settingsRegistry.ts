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
  | "automation" | "integrations" | "general" | "advanced";

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
}

const R = {
  none: { kind: "none" } as ReloadAction,
  restart: (...d: Daemon[]): ReloadAction => ({ kind: "restart", daemons: d }),
  sighup: (...d: Daemon[]): ReloadAction => ({ kind: "sighup", daemons: d }),
};

// 仅当前已暴露的设置(P2 再补缺失项)。reload 已修正(B3)。
export const SETTINGS: SettingDef[] = [
  { path: "audio.mic_device",            category: "audio", label: "麦克风设备",   type: "select",  validate: z.string(),                  reload: R.restart("audiodaemon") },
  { path: "audio.system_audio_device",   category: "audio", label: "系统音设备",   type: "select",  validate: z.string().nullable(),       reload: R.restart("audiodaemon") },
  { path: "audio.output_dir",            category: "audio", label: "录音输出目录", type: "path",    validate: z.string().min(1),           reload: R.restart("audiodaemon"), danger: true }, // 改录音落盘位置:影响正在/后续录音
  { path: "audio.silence_threshold",     category: "audio", label: "静音阈值",     type: "number",  validate: z.number().min(0).max(1),    reload: R.restart("audiodaemon") },
  { path: "audio.silence_duration_sec",  category: "audio", label: "静音时长(秒)", type: "number", validate: z.number().min(0).max(30),   reload: R.restart("audiodaemon") },
  { path: "audio.backend",               category: "audio", label: "音频后端",     type: "select",  validate: z.enum(["daemon"]),          reload: R.restart("audiodaemon"), danger: true }, // 切换采集后端:可能中断录音
  { path: "transcription.mode",          category: "transcription", label: "转写模式", type: "select", validate: z.string(),               reload: R.restart("sttdaemon") },
  { path: "transcription.post_recording_mode", category: "transcription", label: "Post-recording", type: "select", validate: z.enum(["fast_summary", "full_transcribe"]), reload: R.none }, // transcribe.py 每次跑读取,无需重载

  { path: "transcription.language",      category: "transcription", label: "语言",   type: "text",   validate: z.string().min(2).max(20),  reload: R.restart("sttdaemon") },   // B3 修正:旧为 sighup
  { path: "transcription.final_engine",  category: "transcription", label: "最终引擎", type: "select", validate: z.enum(["mlx", "whisper"]), reload: R.restart("sttdaemon") },
  { path: "transcription.local_model_path", category: "transcription", label: "本地模型", type: "path", validate: z.string(),             reload: R.restart("sttdaemon"), danger: true }, // 换模型路径:影响转写,误改即转写失败
  { path: "transcription.mlx",           category: "transcription", label: "MLX 参数", type: "text", validate: z.record(z.unknown()),      reload: R.restart("sttdaemon"), danger: true }, // MLX 引擎参数:误改影响转写质量/可用性
  { path: "transcription.cloud_command", category: "advanced", label: "云转写命令", type: "command", validate: z.array(z.string()),       reload: R.restart("sttdaemon") },
  { path: "transcription.realtime_enabled", category: "transcription", label: "实时字幕", type: "toggle", validate: z.boolean(),          reload: R.none },
  { path: "transcription.glossary",      category: "transcription", label: "术语表",   type: "text",   validate: z.array(z.string()),        reload: R.sighup("sttdaemon") },  // 术语表走 VocabCache SIGHUP(正确)
  { path: "llm.enabled",                 category: "llm", label: "启用 LLM",       type: "toggle",  validate: z.boolean(),                 reload: R.none },   // B3 修正:旧为 sighup
  { path: "llm.command",                 category: "llm", label: "LLM 后端",       type: "preset",  validate: z.array(z.string()).nullable(), reload: R.none }, // B3 修正:旧为 sighup
  { path: "calendars",                   category: "integrations", label: "日历",   type: "text",    validate: z.array(z.unknown()),        reload: R.restart("calendar", "scheduler") },
  // meeting_detection: the detector daemon reads config at startup, so changes restart it.
  { path: "meeting_detection.enabled",             category: "automation", label: "Meeting detection",  type: "toggle",  validate: z.boolean(),       reload: R.restart("detector") },
  { path: "meeting_detection.interval_sec",        category: "automation", label: "Poll interval (s)",  type: "number",  validate: z.number().min(1), reload: R.restart("detector") },
  { path: "meeting_detection.stable_sec",          category: "automation", label: "Stable window (s)",  type: "number",  validate: z.number().min(1), reload: R.restart("detector") },
  { path: "meeting_detection.prompt_cooldown_sec", category: "automation", label: "Prompt cooldown (s)", type: "number", validate: z.number().min(0), reload: R.restart("detector") },
  // output channels: agent_queue_worker re-reads config each 30s tick, so no reload.
  // api_key_env holds the NAME of an env var (never the secret) — type "env-name".
  { path: "output.channel",            category: "integrations", label: "Output channel",        type: "select",   validate: z.enum(["file", "zulip", "notion", "telegram"]), reload: R.none },
  { path: "output.zulip.stream",       category: "integrations", label: "Zulip stream",          type: "text",     validate: z.string(),               reload: R.none },
  { path: "output.zulip.topic",        category: "integrations", label: "Zulip topic",           type: "text",     validate: z.string(),               reload: R.none },
  { path: "output.notion.database_id", category: "integrations", label: "Notion database",       type: "text",     validate: z.string(),               reload: R.none },
  { path: "output.notion.api_key_env", category: "integrations", label: "Notion API key env var", type: "env-name", validate: z.string(),               reload: R.none },
  { path: "output.telegram.chat_id",   category: "integrations", label: "Telegram chat ID",      type: "text",     validate: z.string(),               reload: R.none },
  { path: "status_agent.enabled",        category: "general", label: "菜单栏 Agent", type: "toggle", validate: z.boolean(),               reload: R.restart("statusagent") },
];
// 注意:status_agent.hotkey 不在表内 —— 随热键移除而删(B3)。

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
