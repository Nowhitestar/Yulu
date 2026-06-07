// web/src/i18n/messages.ts
//
// The single source of truth for every user-facing string in the web UI,
// keyed by a stable dotted key (e.g. "nav.recordings",
// "settings.audio.micDevice.label"). Each key has a Chinese (`zh`, the default)
// and English (`en`) value. `t(key)` resolves the active language, falling back
// to `en` then the raw key (see LanguageProvider.translate).
//
// Conventions:
//   - Keys are grouped by area with a leading comment.
//   - `{var}` placeholders are interpolated by t(key, vars).
//   - When a Chinese phrase already reads well it is kept verbatim; English
//     entries are natural equivalents, not literal back-translations.
export type Lang = "zh" | "en";

export type Messages = Record<string, string>;

export const en: Messages = {
  // ---- Language toggle (Settings → General) ----
  "lang.toggle.aria": "Language",
  "lang.zh": "中文",
  "lang.en": "English",
  "settings.general.language.label": "Language",
  "settings.general.language.help": "Display language for the Yulu interface.",

  // ---- App / brand ----
  "app.name": "Yulu",

  // ---- Sidebar ----
  "nav.section.inbox": "Inbox",
  "nav.section.knowledge": "Knowledge",
  "nav.recordings": "Recordings",
  "nav.prompts": "Prompts",
  "nav.glossary": "Glossary",
  "nav.settings": "Settings",
  "nav.health": "Health",
  "nav.health.aria": "Daemon health: {state}",

  // ---- TopBar / GlobalSearch ----
  "search.placeholder": "Search",
  "search.empty": "No matches",
  "search.footer.navigate": "navigate",
  "search.footer.open": "open",
  "search.footer.close": "close",
  "search.footer.count.one": "{n} result",
  "search.footer.count.other": "{n} results",
  "search.kind.setting": "setting",
  "search.kind.meeting": "meeting",
  "search.kind.summary": "summary",
  "search.result.settingMeta": "Settings",

  // ---- Breadcrumbs (route handles) ----
  "breadcrumb.inbox": "Inbox",
  "breadcrumb.recordings": "Recordings",
  "breadcrumb.recording": "Recording",
  "breadcrumb.prompts": "Prompts",
  "breadcrumb.reader": "Reader",
  "breadcrumb.glossary": "Glossary",
  "breadcrumb.settings": "Settings",
  "breadcrumb.health": "Health",

  // ---- Recordings reader (recordings.$stem.tsx) ----
  "reader.title.placeholder": "Title",
  "reader.title.aria": "Recording title",
  "reader.title.rename": "Rename",
  "reader.action.retranscribe": "Re-transcribe",
  "reader.action.regenerate": "Re-generate summary",
  "reader.action.delete": "Delete",
  "reader.delete.aria": "Delete recording",
  "reader.delete.title": "Delete this recording and all of its files",
  "reader.delete.confirm": "Delete \"{label}\" and all of its files? This cannot be undone.",
  "reader.disabled.wavMissing": "Original WAV file missing",
  "reader.disabled.transcriptFirst": "Transcript required first — click Re-transcribe",
  "reader.tab.summary": "Summary",
  "reader.tab.transcript": "Transcript",
  "reader.tab.realtime": "Realtime",
  "reader.tab.raw": "Raw",
  "reader.tab.raw.title": "Pre-cleanup transcript snapshot",
  "reader.empty.summary": "No summary yet.",
  "reader.empty.transcript": "No transcript available.",
  "reader.notFound": "Recording \"{stem}\" not found.",

  // ---- Common ----
  "common.loading": "Loading…",

  // ---- Prompts list (knowledge/prompts.tsx) ----
  "prompts.filter.all": "All",
  "prompts.filter.summary": "Summary",
  "prompts.filter.cleanup": "Cleanup",
  "prompts.new": "+ New prompt",
  "prompts.autorun.aria": "Autorun",
  "prompts.empty": "No prompts yet. Click + New prompt to add one.",
  "prompts.notFound": "Prompt \"{id}\" not found.",

  // ---- Glossary (knowledge/glossary.tsx) ----
  "glossary.col.term": "Term",
  "glossary.col.pinyin": "Pinyin",
  "glossary.col.notes": "Notes",
  "glossary.col.lastEdited": "Last edited",
  "glossary.add": "+ Add term",
  "glossary.empty": "No terms yet. Click + Add term to create one.",

  // ---- Health (routes/health.tsx + components/health/*) ----
  "health.tab.daemons": "Daemons",
  "health.tab.logs": "Logs",
  "health.summary.ok": "All systems nominal",
  "health.summary.warn": "Some daemons not running",
  "health.summary.crit": "Daemon(s) crashed",
  "health.summary.loading": "Loading…",
  "health.summary.polling": "Polling daemons every 5 s",
  "health.counter.running": "{n} running",
  "health.counter.stopped": "{n} stopped",
  "health.counter.crashed": "{n} crashed",
  "health.daemon.status.running": "running",
  "health.daemon.status.stopped": "stopped",
  "health.daemon.status.crashed": "crashed",
  "health.daemon.noLog": "(no log entries yet)",
  "health.daemon.restart": "Restart",
  "health.daemon.stop": "Stop",
  "health.daemon.viewLogs": "View logs →",
  "health.logs.daemon.aria": "Daemon",
  "health.logs.resume": "Resume",
  "health.logs.pause": "Pause auto-scroll",
  "health.logs.clear": "Clear scrollback",

  // ---- RecordingStatusBadge ----
  "status.transcribing": "Transcribing",
  "status.summarizing": "Summarizing",
  "status.failed": "Failed",

  // ---- RestartBanner ----
  "restartBanner.title": "Some changes need a daemon restart to take effect.",
  "restartBanner.restartNow": "Restart now",
  "restartBanner.dismiss": "Dismiss",

  // ---- UndoToast ----
  "undo.saved": "Saved",
  "undo.action": "Undo",

  // ---- DangerConfirm ----
  "danger.aria": "Confirm a risky change",
  "danger.title": "Apply this change?",
  "danger.body.pre": "Changing ",
  "danger.body.post": " affects recording or transcription. Apply it?",
  "danger.cancel": "Cancel",
  "danger.apply": "Apply",

  // ---- Settings category labels + descriptions (categories.ts) ----
  "settings.category.general.label": "General",
  "settings.category.general.desc": "Theme, host capabilities & about",
  "settings.category.audio.label": "Audio & Storage",
  "settings.category.audio.desc": "Recording source, output folder & databases",
  "settings.category.transcription.label": "Transcription",
  "settings.category.transcription.desc": "Whisper / MLX engine & mode",
  "settings.category.llm.label": "Summary LLM",
  "settings.category.llm.desc": "How summaries are generated",
  "settings.category.automation.label": "Automation",
  "settings.category.automation.desc": "Meeting detection & auto-recording",
  "settings.category.integrations.label": "Integrations",
  "settings.category.integrations.desc": "Calendar & external services",
  "settings.category.advanced.label": "Advanced",
  "settings.category.advanced.desc": "Cloud transcription command and other advanced options",

  // ---- Settings detail shell (settings.$category.tsx) ----
  "settings.detail.unknownCategory": "Unknown settings category.",
  "settings.detail.automationComingSoon": "More automation settings coming soon (P2).",

  // ---- Settings: recording guard ----
  "settings.guard.recording": "Recording in progress",
  // The short note shown beside a field that's locked because a recording is in
  // progress (restart-class settings can't change mid-capture).
  "settings.locked.recording": "Locked while recording",

  // ---- Settings: General / Hotkey section ----
  "settings.hotkey.heading": "Hotkey & UI",
  "settings.hotkey.sub": "Global shortcuts and UI behavior",
  "settings.hotkey.statusAgent.label": "Status agent enabled",
  "settings.hotkey.theme.label": "UI theme",
  "settings.hotkey.uiPort.label": "UI port",
  "settings.hotkey.uiPort.help": "Edit com.yulu.ui.plist and `yulu restart yulu_ui` to change",

  // ---- Settings: Capabilities section ----
  "settings.capabilities.heading": "Host capabilities",
  "settings.capabilities.sub": "What your machine supports for recording and transcription.",
  "settings.capabilities.refresh": "Refresh",
  "settings.capabilities.error": "Couldn't read capabilities — Refresh to try again.",
  "settings.capabilities.none": "No capabilities detected yet — Refresh to try again.",
  "settings.capabilities.provenance.hostPath": "reused from your PATH",
  "settings.capabilities.provenance.yuluManaged": "Yulu-managed",
  "settings.capabilities.provenance.absent": "not found",
  "settings.capabilities.status.usable": "usable",
  "settings.capabilities.status.unverified": "present, unverified",
  "settings.capabilities.status.absent": "absent",

  // ---- Settings: About section ----
  "settings.about.heading": "About",
  "settings.about.sub": "Yulu version and install source",
  "settings.about.version": "Version",
  "settings.about.installSource": "Install source",

  // ---- Settings: Audio section ----
  "settings.audio.heading": "Audio",
  "settings.audio.sub": "Recording source, output directory, silence detection",
  "settings.audio.micDevice.label": "Microphone device",
  "settings.audio.micDevice.help": "system default input",
  "settings.audio.micDevice.none": "(no devices found)",
  "settings.audio.systemAudio.label": "System audio device",
  "settings.audio.systemAudio.help": "ScreenCaptureKit channel",
  "settings.audio.systemAudio.none": "(none)",
  "settings.audio.outputDir.label": "Output directory",
  "settings.audio.silenceThreshold.label": "Silence threshold",
  "settings.audio.silenceThreshold.help": "RMS below this counts as silence",
  "settings.audio.silenceDuration.label": "Silence duration",
  "settings.audio.silenceDuration.help": "seconds",
  "settings.audio.backend.label": "Backend",

  // ---- Settings: Storage section ----
  "settings.storage.heading": "Storage",
  "settings.storage.sub": "Database statistics and log paths",
  "settings.storage.databases": "Databases",
  "settings.storage.logs": "Logs",
  "settings.storage.reindex": "Reindex",

  // ---- Settings: Transcription section ----
  "settings.transcription.heading": "Transcription",
  "settings.transcription.sub": "Choose the transcription engine and model",
  "settings.transcription.engine.label": "Engine",
  "settings.transcription.engine.help": "MLX runs on Apple Silicon. Whisper.cpp runs the whisper-cli binary against a local model file.",
  "settings.transcription.engine.aria": "Transcription engine",
  "settings.transcription.mlxModel.label": "MLX model",
  "settings.transcription.mlxModel.help": "HuggingFace repo id (e.g. mlx-community/whisper-large-v3-mlx). Downloaded from HuggingFace on first use.",
  "settings.transcription.realtimeModel.label": "Realtime model",
  "settings.transcription.realtimeModel.help": "Faster model for live captions; default turbo (mlx-community/whisper-large-v3-turbo).",
  "settings.transcription.detectedModel.label": "Detected model",
  "settings.transcription.detectedModel.help": "Whisper models found across your host caches. Choosing one sets the local model path.",
  "settings.transcription.detectedModel.none": "no models detected",
  "settings.transcription.detectedModel.choose": "(choose a model)",
  "settings.transcription.localModelPath.label": "Local model path",
  "settings.transcription.localModelPath.help": "Path to a whisper.cpp .bin model file.",
  "settings.transcription.language.label": "Language",
  "settings.transcription.postRecording.label": "Post-recording",
  "settings.transcription.postRecording.help": "fast_summary: summarize from the live transcript. full_transcribe: re-transcribe the whole recording first.",
  "settings.transcription.realtime.label": "Realtime transcription",
  "settings.transcription.realtime.help": "Transcribe live while recording. Off = transcribe after the recording stops.",
  "settings.transcription.mode.label": "Transcription mode",
  "settings.transcription.mode.help": "local keeps transcription on this machine (default). Cloud modes use your own command in Advanced settings.",
  "settings.transcription.mode.aria": "Transcription mode",
  "settings.transcription.whisperCli.label": "whisper.cpp CLI",
  "settings.transcription.whisperCli.help": "The whisper-cli binary (name on PATH or absolute path). Only used by the Whisper.cpp engine.",
  "settings.transcription.manageGlossary": "Manage glossary →",

  // ---- Settings: LLM section ----
  "settings.llm.heading": "LLM",
  "settings.llm.sub": "Summary generation method",
  "settings.llm.enabled.label": "Enabled",
  "settings.llm.backend.label": "Backend",
  "settings.llm.backend.help": "Agent-queue hands summaries to your own coding agent. Claude / Codex run a known command. Custom = your own command.",
  "settings.llm.backend.aria": "LLM backend",
  "settings.llm.preset.agentQueue": "Agent-queue (your coding agent)",
  "settings.llm.preset.claude": "Claude CLI",
  "settings.llm.preset.codex": "Codex",
  "settings.llm.preset.custom": "Custom command…",
  "settings.llm.command.label": "Command",
  "settings.llm.command.help": "Spawned with stdin = your turn text",
  "settings.llm.test.label": "Test",
  "settings.llm.test.button": "Test command",
  "settings.llm.autorun.title": "Auto-run templates",
  "settings.llm.autorun.help": "These run automatically when a recording is transcribed.",
  "settings.llm.autorun.manage": "Manage all templates →",
  "settings.llm.autorun.empty": "No auto-run templates. Add one from the Prompts page.",
  "settings.llm.autorun.toggleAria": "Auto-run {name}",

  // ---- Settings: Integrations section ----
  "settings.integrations.heading": "Integrations",
  "settings.integrations.sub": "Google Calendar (via gog)",
  "settings.integrations.empty": "No calendar connected.",
  "settings.integrations.google.title": "Google Calendar (via gog)",
  "settings.integrations.remove": "Remove",
  "settings.integrations.removeAria": "Remove Google calendar",
  "settings.integrations.enabled.label": "Enabled",
  "settings.integrations.account.label": "Account",
  "settings.integrations.account.help": "The Google account email you authenticated with `gog auth add`.",
  "settings.integrations.watch.label": "Calendars to watch",
  "settings.integrations.watch.help": "Calendar ids to watch (default: primary).",
  "settings.integrations.connection.label": "Connection",
  "settings.integrations.connection.help": "Checks `gog` can read this account's calendars.",
  "settings.integrations.connection.check": "Check connection",
  "settings.integrations.connection.connected": "Connected",
  "settings.integrations.connection.notAuth": "Not authenticated",
  "settings.integrations.connection.checking": "Checking…",
  "settings.integrations.add.label": "Add calendar",
  "settings.integrations.add.help": "Connect Google Calendar, then fill in your account and enable it.",
  "settings.integrations.add.google": "+ Google",

  // ---- Settings: Output section ----
  "settings.output.heading": "Output",
  "settings.output.sub": "Where a finished summary is delivered",
  "settings.output.channel.label": "Output channel",
  "settings.output.channel.help": "file writes the note to disk. zulip / notion / telegram post it to that service.",
  "settings.output.channel.aria": "Output channel",
  "settings.output.file.note": "Summary is saved next to the recording — no extra setup.",
  "settings.output.zulip.stream": "Zulip stream",
  "settings.output.zulip.topic": "Zulip topic",
  "settings.output.notion.database": "Notion database",
  "settings.output.notion.database.help": "The target Notion database ID.",
  "settings.output.notion.apiKey": "Notion API key env var",
  "settings.output.notion.apiKey.help": "Name of the env var holding your Notion API key (e.g. NOTION_API_KEY). Yulu reads the name, never the secret — export the value in your shell.",
  "settings.output.telegram.chatId": "Telegram chat ID",
  "settings.output.env.present": "set",
  "settings.output.env.missing": "not set",
  "settings.output.env.aria": "Environment variable name",

  // ---- Settings: Automation section ----
  "settings.automation.heading": "Automation",
  "settings.automation.sub": "Meeting detection and auto-record prompts",
  "settings.automation.enabled.label": "Meeting detection",
  "settings.automation.enabled.help": "Watch for meeting windows and offer to record. Off = never auto-prompt.",
  "settings.automation.interval.label": "Poll interval (s)",
  "settings.automation.interval.help": "How often to check the foreground window for a meeting.",
  "settings.automation.stable.label": "Stable window (s)",
  "settings.automation.stable.help": "A meeting window must persist this long before prompting (debounce).",
  "settings.automation.cooldown.label": "Prompt cooldown (s)",
  "settings.automation.cooldown.help": "Wait at least this long before prompting again after a dismissal.",
  "settings.automation.match.heading": "Advanced — match rules",
  "settings.automation.match.note": "change with care",
  "settings.automation.match.windowKeywords.label": "Window title keywords",
  "settings.automation.match.windowKeywords.help": "A window whose title contains any of these is treated as a meeting.",
  "settings.automation.match.appHints.label": "App name hints",
  "settings.automation.match.appHints.help": "App names that hint a meeting is in progress.",
  "settings.automation.match.targetApps.label": "Target app names",
  "settings.automation.match.targetApps.help": "Apps whose windows are scanned for meetings.",
  "settings.automation.match.dedicatedApps.label": "Dedicated meeting apps",
  "settings.automation.match.dedicatedApps.help": "Apps that are always a meeting when frontmost (e.g. Zoom).",
  "settings.automation.match.ignoreKeywords.label": "Ignore window keywords",
  "settings.automation.match.ignoreKeywords.help": "Windows whose title contains any of these are never a meeting.",

  // ---- Settings: Advanced section ----
  "settings.advanced.heading": "Advanced",
  "settings.advanced.sub": "Cloud transcription command and other power-user knobs",
  "settings.advanced.disclosure.title": "Advanced — change with care",
  "settings.advanced.disclosure.note": "power-user knobs",
  "settings.advanced.cloudCommand.label": "Cloud transcription command",
  "settings.advanced.cloudCommand.help": "Your own cloud transcription command — spawned with the audio. Yulu holds no cloud keys.",

  // ---- AdvancedDisclosure defaults ----
  "disclosure.title": "Advanced",
  "disclosure.note": "change with care",

  // ---- Shared value widgets ----
  "value.unset": "(unset)",
  "value.empty": "(empty)",
  "value.on": "On",
  "value.off": "Off",
  "path.choose": "Choose…",
  "path.reveal": "Reveal",
  "cmd.add": "+ Add arg",
  "cmd.removeAria": "Remove arg {i}",
  "test.running": "● running…",
  "test.ok": "✓ ok",
  "test.failed": "✗ failed",
  "test.closeAria": "Close",

  // ---- CloudWarn (InlineEditRow) ----
  "cloudWarn.aria": "Cloud folder warning",
  "cloudWarn.title": "This folder is {where}.",
  "cloudWarn.where.in": "in {reason}",
  "cloudWarn.where.generic": "in a cloud-sync folder",
  "cloudWarn.risk.evict": "macOS may evict (make “dataless”) a recording that hasn't been used recently — if that happens mid-write or before transcription, the file can be lost or corrupted.",
  "cloudWarn.risk.dbs": "Yulu keeps its databases and live files out of this folder, so only your recordings, transcripts, and summaries sync.",
  "cloudWarn.note": "You can use this folder anyway if you understand the trade-off.",
  "cloudWarn.cancel": "Cancel",
  "cloudWarn.useAnyway": "Use anyway",

  // ---- ReprocessButton ----
  "reprocess.running": "Running…",
  "reprocess.done": "Done",

  // ---- DbStatsRow ----
  "db.rows.unknown": "— rows",
  "db.rows": "{n} rows",

  // ---- EditableTable ----
  "table.selectAll": "Select all",
  "table.selectRow": "Select row {id}",
  "table.selected": "{n} selected",
  "table.delete": "Delete",
  "table.clear": "Clear",
  "table.deleteConfirm.one": "Delete {n} item?",
  "table.deleteConfirm.other": "Delete {n} items?",

  // ---- TagEditor ----
  "tag.add": "Add tag",
  "tag.addAria": "Add tag",
  "tag.removeAria": "Remove tag {tag}",
  "tag.placeholder": "tag…",

  // ---- PromptReader ----
  "promptReader.name": "Name",
  "promptReader.slug": "Slug",
  "promptReader.category": "Category",
  "promptReader.autorun": "Autorun",
  "promptReader.content": "Content",
  "promptReader.save": "Save",
  "promptReader.delete": "Delete",
  "promptReader.deleteConfirm": "Delete prompt \"{name}\"?",

  // ---- CategoryChip ----
  "category.summary": "summary",
  "category.cleanup": "cleanup",

  // ---- Pill (record control) ----
  "pill.record": "Record",
  "pill.recordAria": "Record",
  "pill.recordingAria": "Recording",
  "pill.stopAria": "Stop recording",
  "pill.transcribing": "Transcribing… {time}",
  "pill.meeting": "Meeting in progress",
  "pill.daemonDown": "Audio daemon down",

  // ---- LiveTranscript ----
  "live.aria": "Live transcript",
  "live.title": "Live transcript",
  "live.hideAria": "Hide live transcript",
  "live.waiting": "Listening…",
  "live.tag.you": "You",
  "live.tag.them": "Them",

  // ---- Onboarding ----
  "onboarding.aria": "Welcome to Yulu",
  "onboarding.title": "Welcome to Yulu",
  "onboarding.sub": "Here's what Yulu can see on your machine.",
  "onboarding.skip": "Skip",
  "onboarding.done": "Got it",
  "onboarding.unknown": "Couldn't check this right now — you can do it in setup.",
  "onboarding.recordingDir.label": "Recording folder",
  "onboarding.recordingDir.ok": "Recording folder ready — your meetings stay on this machine.",
  "onboarding.recordingDir.missing": "Recording folder not set up yet — Yulu will help in setup.",
  "onboarding.claude.label": "Coding agent (Claude)",
  "onboarding.claude.ok": "Your coding agent is detected — Yulu reuses it to write notes.",
  "onboarding.claude.missing": "Coding agent not detected — install it, then Yulu will use it.",
  "onboarding.whisper.label": "Whisper transcription",
  "onboarding.whisper.ok": "Whisper is ready — transcription runs on-device, no cloud.",
  "onboarding.whisper.missing": "Whisper not detected — Yulu will help set up transcription.",
  "onboarding.models.label": "Transcription model",
  "onboarding.models.ok": "A transcription model is available on this machine.",
  "onboarding.models.missing": "No transcription model yet — Yulu will fetch one in setup.",
};

export const zh: Messages = {
  // ---- Language toggle (Settings → General) ----
  "lang.toggle.aria": "语言",
  "lang.zh": "中文",
  "lang.en": "English",
  "settings.general.language.label": "语言",
  "settings.general.language.help": "Yulu 界面的显示语言。",

  // ---- App / brand ----
  "app.name": "Yulu",

  // ---- Sidebar ----
  "nav.section.inbox": "收件箱",
  "nav.section.knowledge": "知识库",
  "nav.recordings": "录音",
  "nav.prompts": "提示词",
  "nav.glossary": "术语表",
  "nav.settings": "设置",
  "nav.health": "健康状态",
  "nav.health.aria": "守护进程健康状态：{state}",

  // ---- TopBar / GlobalSearch ----
  "search.placeholder": "搜索",
  "search.empty": "无匹配结果",
  "search.footer.navigate": "切换",
  "search.footer.open": "打开",
  "search.footer.close": "关闭",
  "search.footer.count.one": "{n} 条结果",
  "search.footer.count.other": "{n} 条结果",
  "search.kind.setting": "设置",
  "search.kind.meeting": "会议",
  "search.kind.summary": "摘要",
  "search.result.settingMeta": "设置",

  // ---- Breadcrumbs (route handles) ----
  "breadcrumb.inbox": "收件箱",
  "breadcrumb.recordings": "录音",
  "breadcrumb.recording": "录音",
  "breadcrumb.prompts": "提示词",
  "breadcrumb.reader": "阅读",
  "breadcrumb.glossary": "术语表",
  "breadcrumb.settings": "设置",
  "breadcrumb.health": "健康状态",

  // ---- Recordings reader (recordings.$stem.tsx) ----
  "reader.title.placeholder": "标题",
  "reader.title.aria": "录音标题",
  "reader.title.rename": "重命名",
  "reader.action.retranscribe": "重新转写",
  "reader.action.regenerate": "重新生成摘要",
  "reader.action.delete": "删除",
  "reader.delete.aria": "删除录音",
  "reader.delete.title": "删除此录音及其所有文件",
  "reader.delete.confirm": "删除“{label}”及其所有文件？此操作无法撤销。",
  "reader.disabled.wavMissing": "原始 WAV 文件缺失",
  "reader.disabled.transcriptFirst": "需先有转写文本 —— 点击“重新转写”",
  "reader.tab.summary": "摘要",
  "reader.tab.transcript": "转写",
  "reader.tab.realtime": "实时",
  "reader.tab.raw": "原始",
  "reader.tab.raw.title": "清理前的转写快照",
  "reader.empty.summary": "暂无摘要。",
  "reader.empty.transcript": "暂无转写文本。",
  "reader.notFound": "未找到录音“{stem}”。",

  // ---- Common ----
  "common.loading": "加载中…",

  // ---- Prompts list (knowledge/prompts.tsx) ----
  "prompts.filter.all": "全部",
  "prompts.filter.summary": "摘要",
  "prompts.filter.cleanup": "清理",
  "prompts.new": "+ 新建提示词",
  "prompts.autorun.aria": "自动运行",
  "prompts.empty": "暂无提示词。点击“+ 新建提示词”添加一个。",
  "prompts.notFound": "未找到提示词“{id}”。",

  // ---- Glossary (knowledge/glossary.tsx) ----
  "glossary.col.term": "术语",
  "glossary.col.pinyin": "拼音",
  "glossary.col.notes": "备注",
  "glossary.col.lastEdited": "最后编辑",
  "glossary.add": "+ 添加术语",
  "glossary.empty": "暂无术语。点击“+ 添加术语”创建一个。",

  // ---- Health (routes/health.tsx + components/health/*) ----
  "health.tab.daemons": "守护进程",
  "health.tab.logs": "日志",
  "health.summary.ok": "一切正常",
  "health.summary.warn": "部分守护进程未运行",
  "health.summary.crit": "守护进程已崩溃",
  "health.summary.loading": "加载中…",
  "health.summary.polling": "每 5 秒轮询一次守护进程",
  "health.counter.running": "{n} 个运行中",
  "health.counter.stopped": "{n} 个已停止",
  "health.counter.crashed": "{n} 个已崩溃",
  "health.daemon.status.running": "运行中",
  "health.daemon.status.stopped": "已停止",
  "health.daemon.status.crashed": "已崩溃",
  "health.daemon.noLog": "（暂无日志）",
  "health.daemon.restart": "重启",
  "health.daemon.stop": "停止",
  "health.daemon.viewLogs": "查看日志 →",
  "health.logs.daemon.aria": "守护进程",
  "health.logs.resume": "恢复",
  "health.logs.pause": "暂停自动滚动",
  "health.logs.clear": "清空回滚",

  // ---- RecordingStatusBadge ----
  "status.transcribing": "转写中",
  "status.summarizing": "生成摘要中",
  "status.failed": "失败",

  // ---- RestartBanner ----
  "restartBanner.title": "部分更改需要重启守护进程才能生效。",
  "restartBanner.restartNow": "立即重启",
  "restartBanner.dismiss": "忽略",

  // ---- UndoToast ----
  "undo.saved": "已保存",
  "undo.action": "撤销",

  // ---- DangerConfirm ----
  "danger.aria": "确认有风险的更改",
  "danger.title": "应用此更改？",
  "danger.body.pre": "更改 ",
  "danger.body.post": " 会影响录音或转写。确认应用？",
  "danger.cancel": "取消",
  "danger.apply": "应用",

  // ---- Settings category labels + descriptions (categories.ts) ----
  "settings.category.general.label": "通用",
  "settings.category.general.desc": "主题、主机能力与关于",
  "settings.category.audio.label": "音频与存储",
  "settings.category.audio.desc": "录音源、输出目录与数据库",
  "settings.category.transcription.label": "转写",
  "settings.category.transcription.desc": "Whisper / MLX 引擎与模式",
  "settings.category.llm.label": "摘要 LLM",
  "settings.category.llm.desc": "摘要生成方式",
  "settings.category.automation.label": "自动化",
  "settings.category.automation.desc": "会议检测与自动录制",
  "settings.category.integrations.label": "集成",
  "settings.category.integrations.desc": "日历与外部服务",
  "settings.category.advanced.label": "高级",
  "settings.category.advanced.desc": "云转写命令等进阶项",

  // ---- Settings detail shell (settings.$category.tsx) ----
  "settings.detail.unknownCategory": "未知设置分类。",
  "settings.detail.automationComingSoon": "更多自动化设置即将到来 (P2)。",

  // ---- Settings: recording guard ----
  "settings.guard.recording": "录音中",
  "settings.locked.recording": "录音中不可改",

  // ---- Settings: General / Hotkey section ----
  "settings.hotkey.heading": "快捷键与界面",
  "settings.hotkey.sub": "全局快捷键与界面行为",
  "settings.hotkey.statusAgent.label": "启用菜单栏 Agent",
  "settings.hotkey.theme.label": "界面主题",
  "settings.hotkey.uiPort.label": "界面端口",
  "settings.hotkey.uiPort.help": "修改 com.yulu.ui.plist 并执行 `yulu restart yulu_ui` 以更改",

  // ---- Settings: Capabilities section ----
  "settings.capabilities.heading": "主机能力",
  "settings.capabilities.sub": "你的设备在录音与转写方面支持哪些能力。",
  "settings.capabilities.refresh": "刷新",
  "settings.capabilities.error": "无法读取主机能力 —— 点击“刷新”重试。",
  "settings.capabilities.none": "尚未检测到任何能力 —— 点击“刷新”重试。",
  "settings.capabilities.provenance.hostPath": "复用自你的 PATH",
  "settings.capabilities.provenance.yuluManaged": "Yulu 托管",
  "settings.capabilities.provenance.absent": "未找到",
  "settings.capabilities.status.usable": "可用",
  "settings.capabilities.status.unverified": "存在，未验证",
  "settings.capabilities.status.absent": "缺失",

  // ---- Settings: About section ----
  "settings.about.heading": "关于",
  "settings.about.sub": "Yulu 版本与安装来源",
  "settings.about.version": "版本",
  "settings.about.installSource": "安装来源",

  // ---- Settings: Audio section ----
  "settings.audio.heading": "音频",
  "settings.audio.sub": "录音源、输出目录、静音检测",
  "settings.audio.micDevice.label": "麦克风设备",
  "settings.audio.micDevice.help": "系统默认输入",
  "settings.audio.micDevice.none": "（未找到设备）",
  "settings.audio.systemAudio.label": "系统音频设备",
  "settings.audio.systemAudio.help": "ScreenCaptureKit 通道",
  "settings.audio.systemAudio.none": "（无）",
  "settings.audio.outputDir.label": "输出目录",
  "settings.audio.silenceThreshold.label": "静音阈值",
  "settings.audio.silenceThreshold.help": "RMS 低于此值视为静音",
  "settings.audio.silenceDuration.label": "静音时长",
  "settings.audio.silenceDuration.help": "秒",
  "settings.audio.backend.label": "后端",

  // ---- Settings: Storage section ----
  "settings.storage.heading": "存储",
  "settings.storage.sub": "数据库统计与日志路径",
  "settings.storage.databases": "数据库",
  "settings.storage.logs": "日志",
  "settings.storage.reindex": "重建索引",

  // ---- Settings: Transcription section ----
  "settings.transcription.heading": "转写",
  "settings.transcription.sub": "选择转写引擎与模型",
  "settings.transcription.engine.label": "引擎",
  "settings.transcription.engine.help": "MLX 运行于 Apple Silicon。Whisper.cpp 使用 whisper-cli 二进制对本地模型文件进行转写。",
  "settings.transcription.engine.aria": "转写引擎",
  "settings.transcription.mlxModel.label": "MLX 模型",
  "settings.transcription.mlxModel.help": "HuggingFace 仓库 id（如 mlx-community/whisper-large-v3-mlx）。首次使用时从 HuggingFace 下载。",
  "settings.transcription.realtimeModel.label": "实时模型",
  "settings.transcription.realtimeModel.help": "用于实时字幕的更快模型；默认 turbo（mlx-community/whisper-large-v3-turbo）。",
  "settings.transcription.detectedModel.label": "已检测到的模型",
  "settings.transcription.detectedModel.help": "在你的主机缓存中找到的 Whisper 模型。选择一个即设置本地模型路径。",
  "settings.transcription.detectedModel.none": "未检测到模型",
  "settings.transcription.detectedModel.choose": "（选择一个模型）",
  "settings.transcription.localModelPath.label": "本地模型路径",
  "settings.transcription.localModelPath.help": "whisper.cpp 的 .bin 模型文件路径。",
  "settings.transcription.language.label": "语言",
  "settings.transcription.postRecording.label": "录音结束后",
  "settings.transcription.postRecording.help": "fast_summary：基于实时转写生成摘要。full_transcribe：先重新转写整段录音。",
  "settings.transcription.realtime.label": "实时转写",
  "settings.transcription.realtime.help": "录音时实时转写。关闭则在录音结束后转写。",
  "settings.transcription.mode.label": "转写模式",
  "settings.transcription.mode.help": "local 将转写保留在本机（默认）。云端模式使用你在“高级”设置中的自定义命令。",
  "settings.transcription.mode.aria": "转写模式",
  "settings.transcription.whisperCli.label": "whisper.cpp CLI",
  "settings.transcription.whisperCli.help": "whisper-cli 二进制（PATH 中的名称或绝对路径）。仅 Whisper.cpp 引擎使用。",
  "settings.transcription.manageGlossary": "管理术语表 →",

  // ---- Settings: LLM section ----
  "settings.llm.heading": "LLM",
  "settings.llm.sub": "摘要生成方式",
  "settings.llm.enabled.label": "启用",
  "settings.llm.backend.label": "后端",
  "settings.llm.backend.help": "Agent-queue 把摘要交给你自己的编码 Agent。Claude / Codex 运行已知命令。Custom 使用你自己的命令。",
  "settings.llm.backend.aria": "LLM 后端",
  "settings.llm.preset.agentQueue": "Agent-queue（你的编码 Agent）",
  "settings.llm.preset.claude": "Claude CLI",
  "settings.llm.preset.codex": "Codex",
  "settings.llm.preset.custom": "自定义命令…",
  "settings.llm.command.label": "命令",
  "settings.llm.command.help": "以 stdin = 你的对话文本启动",
  "settings.llm.test.label": "测试",
  "settings.llm.test.button": "测试命令",
  "settings.llm.autorun.title": "自动运行模板",
  "settings.llm.autorun.help": "录音转写完成后会自动运行这些模板。",
  "settings.llm.autorun.manage": "管理全部模板 →",
  "settings.llm.autorun.empty": "暂无自动运行模板。在“提示词”页添加一个。",
  "settings.llm.autorun.toggleAria": "自动运行 {name}",

  // ---- Settings: Integrations section ----
  "settings.integrations.heading": "集成",
  "settings.integrations.sub": "Google 日历（通过 gog）",
  "settings.integrations.empty": "未连接任何日历。",
  "settings.integrations.google.title": "Google 日历（通过 gog）",
  "settings.integrations.remove": "移除",
  "settings.integrations.removeAria": "移除 Google 日历",
  "settings.integrations.enabled.label": "启用",
  "settings.integrations.account.label": "账户",
  "settings.integrations.account.help": "你通过 `gog auth add` 认证的 Google 账户邮箱。",
  "settings.integrations.watch.label": "要监听的日历",
  "settings.integrations.watch.help": "要监听的日历 id（默认：primary）。",
  "settings.integrations.connection.label": "连接",
  "settings.integrations.connection.help": "检查 `gog` 能否读取此账户的日历。",
  "settings.integrations.connection.check": "检查连接",
  "settings.integrations.connection.connected": "已连接",
  "settings.integrations.connection.notAuth": "未认证",
  "settings.integrations.connection.checking": "检查中…",
  "settings.integrations.add.label": "添加日历",
  "settings.integrations.add.help": "连接 Google 日历，然后填入账户并启用。",
  "settings.integrations.add.google": "+ Google",

  // ---- Settings: Output section ----
  "settings.output.heading": "输出",
  "settings.output.sub": "摘要完成后投递到哪里",
  "settings.output.channel.label": "输出渠道",
  "settings.output.channel.help": "file 将笔记写入磁盘。zulip / notion / telegram 将其发布到对应服务。",
  "settings.output.channel.aria": "输出渠道",
  "settings.output.file.note": "摘要保存在录音旁边 —— 无需额外设置。",
  "settings.output.zulip.stream": "Zulip 频道",
  "settings.output.zulip.topic": "Zulip 话题",
  "settings.output.notion.database": "Notion 数据库",
  "settings.output.notion.database.help": "目标 Notion 数据库 ID。",
  "settings.output.notion.apiKey": "Notion API 密钥环境变量",
  "settings.output.notion.apiKey.help": "存放 Notion API 密钥的环境变量名（如 NOTION_API_KEY）。Yulu 只读取变量名，绝不读取密钥本身 —— 请在 shell 中导出该值。",
  "settings.output.telegram.chatId": "Telegram chat ID",
  "settings.output.env.present": "已设置",
  "settings.output.env.missing": "未设置",
  "settings.output.env.aria": "环境变量名",

  // ---- Settings: Automation section ----
  "settings.automation.heading": "自动化",
  "settings.automation.sub": "会议检测与自动录制提示",
  "settings.automation.enabled.label": "会议检测",
  "settings.automation.enabled.help": "监测会议窗口并提示录制。关闭则永不自动提示。",
  "settings.automation.interval.label": "轮询间隔（秒）",
  "settings.automation.interval.help": "多久检查一次前台窗口是否为会议。",
  "settings.automation.stable.label": "稳定窗口（秒）",
  "settings.automation.stable.help": "会议窗口需持续这么久才会提示（防抖）。",
  "settings.automation.cooldown.label": "提示冷却（秒）",
  "settings.automation.cooldown.help": "一次忽略后，至少等待这么久才会再次提示。",
  "settings.automation.match.heading": "高级 —— 匹配规则",
  "settings.automation.match.note": "谨慎更改",
  "settings.automation.match.windowKeywords.label": "窗口标题关键词",
  "settings.automation.match.windowKeywords.help": "标题包含其中任一关键词的窗口被视为会议。",
  "settings.automation.match.appHints.label": "应用名提示",
  "settings.automation.match.appHints.help": "提示正在进行会议的应用名。",
  "settings.automation.match.targetApps.label": "目标应用名",
  "settings.automation.match.targetApps.help": "会被扫描其窗口以检测会议的应用。",
  "settings.automation.match.dedicatedApps.label": "专用会议应用",
  "settings.automation.match.dedicatedApps.help": "位于前台时始终视为会议的应用（如 Zoom）。",
  "settings.automation.match.ignoreKeywords.label": "忽略的窗口关键词",
  "settings.automation.match.ignoreKeywords.help": "标题包含其中任一关键词的窗口永不视为会议。",

  // ---- Settings: Advanced section ----
  "settings.advanced.heading": "高级",
  "settings.advanced.sub": "云转写命令及其他高阶选项",
  "settings.advanced.disclosure.title": "高级 —— 谨慎更改",
  "settings.advanced.disclosure.note": "高阶选项",
  "settings.advanced.cloudCommand.label": "云转写命令",
  "settings.advanced.cloudCommand.help": "你自己的云转写命令 —— 随音频一起启动。Yulu 不持有任何云端密钥。",

  // ---- AdvancedDisclosure defaults ----
  "disclosure.title": "高级",
  "disclosure.note": "谨慎更改",

  // ---- Shared value widgets ----
  "value.unset": "（未设置）",
  "value.empty": "（空）",
  "value.on": "开",
  "value.off": "关",
  "path.choose": "选择…",
  "path.reveal": "在访达中显示",
  "cmd.add": "+ 添加参数",
  "cmd.removeAria": "移除参数 {i}",
  "test.running": "● 运行中…",
  "test.ok": "✓ 成功",
  "test.failed": "✗ 失败",
  "test.closeAria": "关闭",

  // ---- CloudWarn (InlineEditRow) ----
  "cloudWarn.aria": "云同步文件夹警告",
  "cloudWarn.title": "此文件夹位于{where}。",
  "cloudWarn.where.in": "{reason} 中",
  "cloudWarn.where.generic": "云同步文件夹",
  "cloudWarn.risk.evict": "macOS 可能会逐出（变为“无数据”）近期未使用的录音 —— 若发生在写入过程中或转写之前，文件可能丢失或损坏。",
  "cloudWarn.risk.dbs": "Yulu 会把数据库与运行时文件保留在此文件夹之外，因此只有你的录音、转写和摘要会被同步。",
  "cloudWarn.note": "若你了解此权衡，仍可使用此文件夹。",
  "cloudWarn.cancel": "取消",
  "cloudWarn.useAnyway": "仍然使用",

  // ---- ReprocessButton ----
  "reprocess.running": "运行中…",
  "reprocess.done": "完成",

  // ---- DbStatsRow ----
  "db.rows.unknown": "— 行",
  "db.rows": "{n} 行",

  // ---- EditableTable ----
  "table.selectAll": "全选",
  "table.selectRow": "选择第 {id} 行",
  "table.selected": "已选 {n} 项",
  "table.delete": "删除",
  "table.clear": "清除",
  "table.deleteConfirm.one": "删除 {n} 项？",
  "table.deleteConfirm.other": "删除 {n} 项？",

  // ---- TagEditor ----
  "tag.add": "添加标签",
  "tag.addAria": "添加标签",
  "tag.removeAria": "移除标签 {tag}",
  "tag.placeholder": "标签…",

  // ---- PromptReader ----
  "promptReader.name": "名称",
  "promptReader.slug": "Slug",
  "promptReader.category": "类别",
  "promptReader.autorun": "自动运行",
  "promptReader.content": "内容",
  "promptReader.save": "保存",
  "promptReader.delete": "删除",
  "promptReader.deleteConfirm": "删除提示词“{name}”？",

  // ---- CategoryChip ----
  "category.summary": "摘要",
  "category.cleanup": "清理",

  // ---- Pill (record control) ----
  "pill.record": "录制",
  "pill.recordAria": "录制",
  "pill.recordingAria": "录音中",
  "pill.stopAria": "停止录音",
  "pill.transcribing": "转写中… {time}",
  "pill.meeting": "会议进行中",
  "pill.daemonDown": "音频守护进程已停止",

  // ---- LiveTranscript ----
  "live.aria": "实时转写",
  "live.title": "实时转写",
  "live.hideAria": "隐藏实时转写",
  "live.waiting": "聆听中…",
  "live.tag.you": "你",
  "live.tag.them": "对方",

  // ---- Onboarding ----
  "onboarding.aria": "欢迎使用 Yulu",
  "onboarding.title": "欢迎使用 Yulu",
  "onboarding.sub": "以下是 Yulu 在你设备上能看到的内容。",
  "onboarding.skip": "跳过",
  "onboarding.done": "知道了",
  "onboarding.unknown": "暂时无法检查 —— 你可以在设置中完成。",
  "onboarding.recordingDir.label": "录音文件夹",
  "onboarding.recordingDir.ok": "录音文件夹已就绪 —— 你的会议都保留在本机。",
  "onboarding.recordingDir.missing": "录音文件夹尚未设置 —— Yulu 会在设置中协助。",
  "onboarding.claude.label": "编码 Agent（Claude）",
  "onboarding.claude.ok": "已检测到你的编码 Agent —— Yulu 复用它来撰写笔记。",
  "onboarding.claude.missing": "未检测到编码 Agent —— 安装后 Yulu 即可使用。",
  "onboarding.whisper.label": "Whisper 转写",
  "onboarding.whisper.ok": "Whisper 已就绪 —— 转写在本机运行，不上云。",
  "onboarding.whisper.missing": "未检测到 Whisper —— Yulu 会协助设置转写。",
  "onboarding.models.label": "转写模型",
  "onboarding.models.ok": "本机已有可用的转写模型。",
  "onboarding.models.missing": "尚无转写模型 —— Yulu 会在设置中获取一个。",
};

export const MESSAGES: Record<Lang, Messages> = { zh, en };
