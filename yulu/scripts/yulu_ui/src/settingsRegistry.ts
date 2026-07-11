// src/settingsRegistry.ts
import { z } from "zod";

export type Daemon =
  | "audiodaemon"
  | "detector" | "scheduler" | "calendar" | "statusagent";

export type ReloadAction =
  | { kind: "none" }
  | { kind: "sighup"; daemons: Daemon[] }
  | { kind: "restart"; daemons: Daemon[] };

export type SettingCategory =
  | "transcription" | "audio" | "llm"
  | "automation" | "integrations" | "general" | "voice";

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
  { path: "transcription.language",      category: "transcription", label: "语言",   type: "text",   validate: z.string().min(2).max(20),  reload: R.none },
  { path: "llm.enabled",                 category: "llm", label: "启用 LLM",       type: "toggle",  validate: z.boolean(),                 reload: R.none, hidden: true },
  { path: "llm.command",                 category: "llm", label: "LLM 后端",       type: "preset",  validate: z.array(z.string()).nullable(), reload: R.none, hidden: true },
  { path: "llm.agent.provider",          category: "llm", label: "Agent provider", type: "select",  validate: z.enum(["auto", "codex", "claude", "claude-code", "hermes", "openclaw"]), reload: R.none, hidden: true },
  { path: "calendars",                   category: "integrations", label: "日历",   type: "text",    validate: z.array(z.unknown()),        reload: R.restart("calendar", "scheduler"), hidden: true },
  { path: "connectors.gog.read_calendar", category: "integrations", label: "Read Google calendars", type: "toggle", validate: z.boolean(), reload: R.restart("calendar", "scheduler"), hidden: true },
  { path: "connectors.feishu.read_calendar", category: "integrations", label: "Read Feishu calendars", type: "toggle", validate: z.boolean(), reload: R.restart("calendar", "scheduler"), hidden: true },
  { path: "agent_pipeline.auto_send_notion", category: "integrations", label: "Ask Hermes to send completed notes to Notion", type: "toggle", validate: z.boolean(), reload: R.none, hidden: true },
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
