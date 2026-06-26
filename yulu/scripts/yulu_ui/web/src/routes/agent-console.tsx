import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  AlertCircle,
  Archive,
  ArrowUp,
  Bot,
  Calendar,
  Check,
  CheckCircle2,
  ChevronDown,
  Cpu,
  Database,
  FileText,
  HardDrive,
  ListChecks,
  Loader2,
  MessageSquare,
  Mic,
  MoreHorizontal,
  Pencil,
  Pin,
  Play,
  Radar,
  RefreshCw,
  Send,
  ShieldCheck,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  X,
  Zap,
} from "lucide-react";
import { trpc } from "../trpc.js";
import { useWsChannel } from "../ws.js";
import { MarkdownView } from "../components/MarkdownView.js";
import "./agent-console.css";

export const handle = { breadcrumb: "breadcrumb.agentConsole", filters: null };

type StageState = "idle" | "waiting" | "running" | "done" | "failed";
type SendDest = "notion" | "zulip" | null;
type ConsoleMode = "ask" | "run";
type AgentId = "codex" | "claude" | "hermes" | "openclaw";
type AgentPluginId = "summary" | "notion" | "zulip" | "calendar";
type AgentPluginStatus = "configured" | "unconfigured" | "unsupported";

interface AgentTask {
  id: string;
  stem: string;
  title: string;
  recordedAt: string;
  dayLabel: "today" | "yesterday" | "recent";
  stages: {
    record: StageState;
    transcribe: StageState;
    summarize: StageState;
    send: StageState;
  };
  dest: SendDest;
  error?: string;
  hasTranscript: boolean;
  hasSummary: boolean;
  hasRealtime: boolean;
}

interface ConsoleAgent {
  id: AgentId;
  name: string;
  command: string;
  found: boolean;
  path: string;
  supported: boolean;
  connected: boolean;
  unavailableReason: string;
  runtimePreview: string;
}

interface AgentPluginState {
  id: AgentPluginId;
  label: string;
  added: boolean;
  core: boolean;
  status: AgentPluginStatus;
  statusLabel: string;
  resolvedPath: string;
  detail: string;
  configureLabel: string;
  agent: AgentId | null;
  destination?: AgentDestinationView;
}

interface AgentDestinationView {
  channel: "notion" | "zulip";
  label: string;
  value: string;
  configured: boolean;
  missingReason: string;
  notion?: { target: string };
  zulip?: { stream: string; topic: string };
}

interface AgentPluginOverview {
  agent: AgentId | null;
  current: AgentPluginState[];
  available: AgentPluginState[];
  all: AgentPluginState[];
}

interface AskSource {
  ref?: number;
  kind: string;
  stem: string;
  title: string;
  recordedAt: string;
  sourcePath: string;
  snippet: string;
  url: string;
}

interface RemoteSource {
  channel: string;
  label: string;
  detail: string;
  connected?: boolean;
}

type CalendarType = "macos" | "system" | "google";

interface CalendarEntry {
  type: CalendarType;
  enabled?: boolean;
  gog_account?: string;
  watch_calendars?: string[];
  [key: string]: unknown;
}

interface CalendarOption {
  id: string;
  summary: string;
  primary: boolean;
}

interface GoogleAccount {
  email: string;
  services: string[];
}

interface DestinationOption {
  id: string;
  label: string;
  value: string;
  source: "agent" | "saved" | "legacy" | "default";
  kind?: string;
  target?: string;
  stream?: string;
  topic?: string;
}

interface AskResponse {
  answer: string;
  sources: AskSource[];
  remoteSources?: RemoteSource[];
  usedFallback: boolean;
  llmStatus: string;
  llmError?: string | null;
  agentRuntime?: {
    provider: string;
    label: string;
    source: string;
    commandPreview: string;
    cwd: string;
    status: string;
  };
  connectorContext?: {
    outputs: Array<{ channel: string; label: string; enabled: boolean; connected?: boolean; destination: string }>;
  };
}

interface ChatMessage {
  role: "user" | "assistant";
  text: string;
  pending?: boolean;
  sources?: AskSource[];
  remoteSources?: RemoteSource[];
  error?: string;
}

interface AgentSessionSummary {
  id: string;
  agent: string;
  title: string;
  updatedAt: string;
  pinnedAt?: string;
  archivedAt?: string;
  messageCount: number;
}

interface AgentSessionMessage {
  role: "user" | "assistant";
  text: string;
  sources?: AskSource[];
  remoteSources?: RemoteSource[];
  error?: string;
}

interface AgentSession {
  id: string;
  agent: string;
  title: string;
  updatedAt: string;
  pinnedAt?: string;
  archivedAt?: string;
  messages: AgentSessionMessage[];
}

interface SummaryPrompt {
  id: string;
  slug: string;
  name: string;
  is_auto_run?: number;
  isAutoRun?: boolean;
}

const AGENT_ICONS: Record<AgentId, JSX.Element> = {
  codex: <Terminal size={14} strokeWidth={1.9} />,
  claude: <Bot size={14} strokeWidth={1.9} />,
  hermes: <Cpu size={14} strokeWidth={1.9} />,
  openclaw: <Cpu size={14} strokeWidth={1.9} />,
};

function formatTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.valueOf())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function dayLabelText(label: AgentTask["dayLabel"]): string {
  if (label === "today") return "今天";
  if (label === "yesterday") return "昨天";
  return "近三天";
}

function firstAvailablePrompt(prompts: SummaryPrompt[]): string | null {
  return prompts.find((prompt) => prompt.slug === "summary")?.id ?? prompts[0]?.id ?? null;
}

function promptLabel(prompt: SummaryPrompt): string {
  return prompt.name || prompt.slug || prompt.id;
}

function asConfigRecord(config: unknown): Record<string, unknown> {
  return typeof config === "object" && config !== null && !Array.isArray(config) ? config as Record<string, unknown> : {};
}

export function AgentConsole() {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const [mode, setMode] = useState<ConsoleMode>("ask");
  const [summaryPromptId, setSummaryPromptId] = useState<string | null>(null);
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [destinationPlugin, setDestinationPlugin] = useState<AgentPluginState | null>(null);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [detectMessage, setDetectMessage] = useState<string>("点击后重新扫描本机 CLI 路径");
  const [notice, setNotice] = useState<string | null>(null);

  const overview = trpc.agentConsole.overview.useQuery(undefined, { refetchInterval: 5000 });
  const detectAgents = trpc.agentConsole.detectAgents.useQuery(undefined, { enabled: false });
  const promptsQuery = trpc.prompts.list.useQuery({ category: "summary" });
  const daemonsQuery = trpc.daemons.health.useQuery(undefined, { refetchInterval: 5000 });
  const queueQuery = trpc.queue.list.useQuery(undefined, { refetchInterval: 5000 });
  const schedulerQuery = trpc.scheduler.overview.useQuery(undefined, { refetchInterval: 15_000 });

  const toggleRecording = trpc.recording.toggle.useMutation({
    onSettled: () => void utils.agentConsole.overview.invalidate(),
  });
  const transcribe = trpc.recordings.transcribe.useMutation({
    onSettled: () => void utils.agentConsole.overview.invalidate(),
  });
  const summarize = trpc.recordings.summarize.useMutation({
    onSettled: () => void utils.agentConsole.overview.invalidate(),
  });
  const sendSummary = trpc.recordings.sendSummary.useMutation({
    onSettled: () => void utils.agentConsole.overview.invalidate(),
  });
  const addPlugin = trpc.agentConsole.addPlugin.useMutation({
    onSettled: () => void utils.agentConsole.overview.invalidate(),
  });
  const removePlugin = trpc.agentConsole.removePlugin.useMutation({
    onSettled: () => void utils.agentConsole.overview.invalidate(),
  });
  const configurePlugin = trpc.agentConsole.configurePlugin.useMutation({
    onSuccess: (result) => setNotice(result.message),
    onSettled: () => void utils.agentConsole.overview.invalidate(),
  });
  const setDestination = trpc.agentConsole.setDestination.useMutation({
    onSuccess: (result) => {
      if (result.ok) setNotice("发送目标已保存，会跟随当前底层 Agent 使用。");
      else setNotice(result.error ?? "发送目标保存失败");
    },
    onSettled: () => void utils.agentConsole.overview.invalidate(),
  });

  useWsChannel("recordings-changed", () => void utils.agentConsole.overview.invalidate());
  useWsChannel("jobs", () => void utils.agentConsole.overview.invalidate());
  useWsChannel("recording", () => void utils.agentConsole.overview.invalidate());

  const tasks = (overview.data?.tasks as AgentTask[] | undefined) ?? [];
  const prompts = ((promptsQuery.data as SummaryPrompt[] | undefined) ?? []);
  const plugins = (overview.data?.plugins as AgentPluginOverview | undefined) ?? { agent: null, current: [], available: [], all: [] };

  useEffect(() => {
    if (!summaryPromptId && prompts.length > 0) setSummaryPromptId(firstAvailablePrompt(prompts));
  }, [prompts, summaryPromptId]);

  const activeAgent = useMemo(() => {
    const agents = (overview.data?.agents as ConsoleAgent[] | undefined) ?? [];
    return agents.find((agent) => agent.connected) ?? agents.find((agent) => agent.supported) ?? null;
  }, [overview.data?.agents]);

  const invalidateAfterAction = () => {
    void utils.agentConsole.overview.invalidate();
    void utils.recordings.list.invalidate();
    void utils.queue.list.invalidate();
  };

  const runTranscribe = (task: AgentTask) => {
    if (!task.stem) return;
    transcribe.mutate({ stem: task.stem }, { onSettled: invalidateAfterAction });
  };

  const runSummarize = (task: AgentTask) => {
    if (!task.stem) return;
    summarize.mutate({ stem: task.stem, promptId: summaryPromptId }, { onSettled: invalidateAfterAction });
  };

  const runSend = (task: AgentTask, channel: "notion" | "zulip") => {
    if (!task.stem) return;
    sendSummary.mutate({ stem: task.stem, channel }, {
      onError: (err) => setNotice(err.message),
      onSettled: invalidateAfterAction,
    });
  };

  const runConfigurePlugin = (plugin: AgentPluginId) => {
    configurePlugin.mutate({ plugin });
  };

  const runDetectAgents = async () => {
    setDetectMessage("正在扫描 PATH 和常见安装目录...");
    try {
      const result = await detectAgents.refetch();
      await overview.refetch();
      const agents = (result.data?.agents as ConsoleAgent[] | undefined) ?? [];
      const found = agents.filter((agent) => agent.found).length;
      setDetectMessage(`已找到 ${found}/${agents.length || 4} 个 Agent CLI`);
    } catch (err) {
      setDetectMessage((err as Error).message || "探测失败");
    }
  };

  const runSaveDestination = (input:
    | { channel: "notion"; target: string }
    | { channel: "zulip"; stream: string; topic: string }
  ) => {
    setDestination.mutate(input, {
      onSuccess: (result) => {
        if (result.ok) setDestinationPlugin(null);
      },
    });
  };

  return (
    <div className="agent-console-page">
      <aside className="agent-console-rail agent-console-rail-left" aria-label="最近三天待处理">
        <TaskRail
          tasks={tasks}
          isLoading={overview.isPending}
          isRecording={overview.data?.recording?.state === "recording"}
          actionPending={toggleRecording.isPending || transcribe.isPending || summarize.isPending || sendSummary.isPending}
          onToggleRecording={() => toggleRecording.mutate()}
          onOpenAll={() => navigate("/inbox")}
          onOpenTask={(task) => task.stem ? navigate(`/inbox/${task.stem}`) : undefined}
          onTranscribe={runTranscribe}
          onSummarize={runSummarize}
          onSend={runSend}
          sharePlugins={plugins.current.filter((plugin) => plugin.id === "notion" || plugin.id === "zulip")}
          onConfigurePlugin={runConfigurePlugin}
          onConfigureDestination={setDestinationPlugin}
        />
      </aside>

      <main className="agent-console-center">
        <div className="agent-console-modebar" role="tablist" aria-label="Agent Console mode">
          <button type="button" className={mode === "ask" ? "active" : ""} onClick={() => setMode("ask")}>
            <MessageSquare size={15} strokeWidth={1.9} />
            问会议
          </button>
          <button type="button" className={mode === "run" ? "active" : ""} onClick={() => setMode("run")}>
            <Play size={15} strokeWidth={1.9} />
            跑任务
          </button>
          <button type="button" className="agent-inspector-toggle" onClick={() => setInspectorOpen(true)}>
            <ListChecks size={15} strokeWidth={1.9} />
            能力
          </button>
        </div>
        {notice && (
          <div className="agent-console-notice">
            <AlertCircle size={14} strokeWidth={2} />
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="关闭"><X size={13} strokeWidth={2} /></button>
          </div>
        )}
        {mode === "ask" ? (
          <AskMeetings agentId={activeAgent?.id ?? "agent"} agentName={activeAgent?.name ?? "Agent"} />
        ) : (
          <RunTasks
            queue={queueQuery.data}
            scheduler={schedulerQuery.data}
            queueLoading={queueQuery.isPending}
            schedulerLoading={schedulerQuery.isPending}
            onOpenQueue={() => navigate("/health#queue")}
            onOpenScheduler={() => navigate("/health#scheduler")}
          />
        )}
      </main>

      {inspectorOpen && <button type="button" className="agent-inspector-scrim" aria-label="关闭能力面板" onClick={() => setInspectorOpen(false)} />}
      <aside className={`agent-console-rail agent-console-rail-right${inspectorOpen ? " open" : ""}`} aria-label="Agent 能力">
        <div className="agent-rail-drawer-head">
          <span>Agent 能力</span>
          <button type="button" onClick={() => setInspectorOpen(false)} aria-label="关闭能力面板"><X size={14} strokeWidth={2} /></button>
        </div>
        <AgentSelector
          agents={(overview.data?.agents as ConsoleAgent[] | undefined) ?? []}
          detecting={detectAgents.isFetching}
          detectMessage={detectMessage}
          onDetect={() => void runDetectAgents()}
        />
        <CapabilitiesPanel
          plugins={plugins}
          prompts={prompts}
          selectedPromptId={summaryPromptId}
          onPromptChange={setSummaryPromptId}
          onOpenSummary={() => setSummaryOpen(true)}
          onOpenCalendar={() => setCalendarOpen(true)}
          onAddPlugin={(plugin) => addPlugin.mutate({ plugin })}
          onRemovePlugin={(plugin) => removePlugin.mutate({ plugin })}
          onConfigure={runConfigurePlugin}
          onConfigureDestination={setDestinationPlugin}
        />
        <LocalStatus daemons={daemonsQuery.data} queue={queueQuery.data} onDetails={() => navigate("/health")} />
      </aside>

      {calendarOpen && (
        <CalendarConfigModal
          plugin={plugins.current.find((plugin) => plugin.id === "calendar")}
          agentName={activeAgent?.name ?? "当前 Agent"}
          onConfigure={() => runConfigurePlugin("calendar")}
          onClose={() => setCalendarOpen(false)}
        />
      )}
      {summaryOpen && (
        <SummaryConfigModal
          plugin={plugins.current.find((plugin) => plugin.id === "summary")}
          prompts={prompts}
          selectedPromptId={summaryPromptId}
          onPromptChange={setSummaryPromptId}
          onClose={() => setSummaryOpen(false)}
        />
      )}
      {destinationPlugin && (
        <DestinationConfigModal
          plugin={destinationPlugin}
          saving={setDestination.isPending}
          onSave={runSaveDestination}
          onClose={() => setDestinationPlugin(null)}
        />
      )}
    </div>
  );
}

function TaskRail({
  tasks,
  isLoading,
  isRecording,
  actionPending,
  onToggleRecording,
  onOpenAll,
  onOpenTask,
  onTranscribe,
  onSummarize,
  onSend,
  sharePlugins,
  onConfigurePlugin,
  onConfigureDestination,
}: {
  tasks: AgentTask[];
  isLoading: boolean;
  isRecording: boolean;
  actionPending: boolean;
  onToggleRecording: () => void;
  onOpenAll: () => void;
  onOpenTask: (task: AgentTask) => void;
  onTranscribe: (task: AgentTask) => void;
  onSummarize: (task: AgentTask) => void;
  onSend: (task: AgentTask, channel: "notion" | "zulip") => void;
  sharePlugins: AgentPluginState[];
  onConfigurePlugin: (plugin: AgentPluginId) => void;
  onConfigureDestination: (plugin: AgentPluginState) => void;
}) {
  return (
    <>
      <div className="agent-rail-head">
        <div>
          <div className="agent-rail-title">最近三天</div>
          <div className="agent-rail-sub">{isLoading ? "同步中" : `${tasks.length} 个会议`}</div>
        </div>
        <button type="button" className="agent-link-btn" onClick={onOpenAll}>全部</button>
      </div>
      <button
        type="button"
        className={"agent-record-button" + (isRecording ? " recording" : "")}
        disabled={actionPending}
        onClick={onToggleRecording}
      >
        {isRecording ? <Square size={16} strokeWidth={2} /> : <Mic size={16} strokeWidth={2} />}
        {isRecording ? "停止录制" : "开始录制"}
      </button>
      <div className="agent-task-list">
        {tasks.length === 0 && !isLoading && (
          <div className="agent-empty">最近三天没有待处理会议。</div>
        )}
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            disabled={actionPending}
            onOpen={() => onOpenTask(task)}
            onStopRecording={onToggleRecording}
            onTranscribe={() => onTranscribe(task)}
            onSummarize={() => onSummarize(task)}
            onSend={(channel) => onSend(task, channel)}
            sharePlugins={sharePlugins}
            onConfigurePlugin={onConfigurePlugin}
            onConfigureDestination={onConfigureDestination}
          />
        ))}
      </div>
    </>
  );
}

function TaskCard({
  task,
  disabled,
  onOpen,
  onStopRecording,
  onTranscribe,
  onSummarize,
  onSend,
  sharePlugins,
  onConfigurePlugin,
  onConfigureDestination,
}: {
  task: AgentTask;
  disabled: boolean;
  onOpen: () => void;
  onStopRecording: () => void;
  onTranscribe: () => void;
  onSummarize: () => void;
  onSend: (channel: "notion" | "zulip") => void;
  sharePlugins: AgentPluginState[];
  onConfigurePlugin: (plugin: AgentPluginId) => void;
  onConfigureDestination: (plugin: AgentPluginState) => void;
}) {
  const failed = Object.values(task.stages).includes("failed");
  const complete = task.stages.send === "done";
  return (
    <div className={"agent-task-card" + (failed ? " failed" : complete ? " complete" : "")}>
      <div className="agent-task-head">
        <button type="button" className="agent-task-title" onClick={onOpen}>{task.title}</button>
        {complete && <span className="agent-task-done"><CheckCircle2 size={13} strokeWidth={2} />已完成</span>}
      </div>
      <div className="agent-task-meta">{dayLabelText(task.dayLabel)} · {formatTime(task.recordedAt)}</div>
      {task.error && (
        <div className="agent-task-error">
          <AlertCircle size={13} strokeWidth={2} />
          <span>{task.error}</span>
        </div>
      )}
      <TaskAction
        task={task}
        disabled={disabled}
        onOpen={onOpen}
        onStopRecording={onStopRecording}
        onTranscribe={onTranscribe}
        onSummarize={onSummarize}
        onSend={onSend}
        sharePlugins={sharePlugins}
        onConfigurePlugin={onConfigurePlugin}
        onConfigureDestination={onConfigureDestination}
      />
    </div>
  );
}

function RunningState({ label }: { label: string }) {
  return (
    <div className="agent-task-running">
      <Loader2 className="spin" size={15} strokeWidth={2} />
      {label}
    </div>
  );
}

function TaskAction({
  task,
  disabled,
  onOpen,
  onStopRecording,
  onTranscribe,
  onSummarize,
  onSend,
  sharePlugins,
  onConfigurePlugin,
  onConfigureDestination,
}: {
  task: AgentTask;
  disabled: boolean;
  onOpen: () => void;
  onStopRecording: () => void;
  onTranscribe: () => void;
  onSummarize: () => void;
  onSend: (channel: "notion" | "zulip") => void;
  sharePlugins: AgentPluginState[];
  onConfigurePlugin: (plugin: AgentPluginId) => void;
  onConfigureDestination: (plugin: AgentPluginState) => void;
}) {
  if (task.stages.record === "running") {
    return (
      <RecordingBar startedAt={task.recordedAt} disabled={disabled} onStop={onStopRecording} />
    );
  }
  if (task.stages.transcribe === "running") return <RunningState label="生成转写中" />;
  if (task.stages.transcribe === "idle" || task.stages.transcribe === "failed") {
    return (
      <button type="button" className="agent-action primary" disabled={disabled} onClick={onTranscribe}>
        <FileText size={14} strokeWidth={2} />
        {task.stages.transcribe === "failed" ? "重试转写" : "生成转写"}
      </button>
    );
  }
  if (task.stages.summarize === "running") return <RunningState label="生成摘要中" />;
  if (task.stages.summarize === "idle" || task.stages.summarize === "failed") {
    return (
      <button type="button" className="agent-action primary" disabled={disabled} onClick={onSummarize}>
        {task.stages.summarize === "failed" ? <RefreshCw size={14} strokeWidth={2} /> : <Zap size={14} strokeWidth={2} />}
        {task.stages.summarize === "failed" ? "重试摘要" : "生成摘要"}
      </button>
    );
  }
  if (task.stages.send === "running") return <RunningState label={`发送到 ${task.dest === "zulip" ? "Zulip" : "Notion"} 中`} />;
  if (task.stages.send === "done") {
    return (
      <button type="button" className="agent-action success" onClick={onOpen}>
        <CheckCircle2 size={14} strokeWidth={2} />
        已发送到 {task.dest === "zulip" ? "Zulip" : "Notion"} · 打开
      </button>
    );
  }
  const sendPlugins = sharePlugins.filter((plugin) => plugin.id === "notion" || plugin.id === "zulip");
  if (sendPlugins.length === 0) {
    return <div className="agent-task-running">先在当前能力里添加 Notion 或 Zulip</div>;
  }
  return (
    <div className="agent-send-row">
      {sendPlugins.map((plugin) => {
        const configured = plugin.status === "configured";
        const destinationReady = plugin.destination?.configured ?? true;
        const channel = plugin.id as "notion" | "zulip";
        const readyToSend = configured && destinationReady;
        const label = !configured
          ? plugin.label
          : !destinationReady
            ? "选择路径"
            : plugin.id === "notion" ? "发送 Notion" : plugin.label;
        return (
          <button
            key={plugin.id}
            type="button"
            className={"agent-action " + (readyToSend ? "primary" : "secondary")}
            disabled={disabled}
            onClick={() => {
              if (!configured) onConfigurePlugin(plugin.id);
              else if (!destinationReady) onConfigureDestination(plugin);
              else onSend(channel);
            }}
            title={!configured ? plugin.detail : plugin.destination?.missingReason || plugin.destination?.value || plugin.detail}
          >
            <Send size={14} strokeWidth={2} />
            {label}
          </button>
        );
      })}
    </div>
  );
}

const WAVE_BARS = [12, 18, 24, 16, 22, 14, 20, 13];

function RecordingBar({ startedAt, disabled, onStop }: { startedAt: string; disabled: boolean; onStop: () => void }) {
  const [seconds, setSeconds] = useState(() => elapsedSeconds(startedAt));
  useEffect(() => {
    const timer = window.setInterval(() => setSeconds(elapsedSeconds(startedAt)), 1000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const minutes = Math.floor(seconds / 60);
  const secs = String(seconds % 60).padStart(2, "0");
  return (
    <div className="agent-recording-bar">
      <span className="agent-recording-dot" />
      <span className="agent-recording-time">{minutes}:{secs}</span>
      <span className="agent-recording-wave" aria-hidden="true">
        {WAVE_BARS.map((height, index) => (
          <span key={index} style={{ height, animationDelay: `${index * 80}ms` }} />
        ))}
      </span>
      <button type="button" disabled={disabled} onClick={onStop} aria-label="停止录制">
        <Square size={13} strokeWidth={2.3} />
      </button>
    </div>
  );
}

function elapsedSeconds(startedAt: string): number {
  const start = new Date(startedAt).valueOf();
  if (!Number.isFinite(start)) return 0;
  return Math.max(0, Math.floor((Date.now() - start) / 1000));
}

function sessionMessages(session: AgentSession | null | undefined): ChatMessage[] {
  return (session?.messages ?? []).map((message) => ({
    role: message.role,
    text: message.text,
    sources: message.sources,
    remoteSources: message.remoteSources,
    error: message.error,
  }));
}

function citedLocalSources(message: ChatMessage): AskSource[] {
  if (!message.sources || message.sources.length === 0) return [];
  const refs = new Set<number>();
  for (const match of message.text.matchAll(/\[(\d{1,2})\]/g)) {
    const ref = Number(match[1]);
    if (Number.isInteger(ref)) refs.add(ref);
  }
  if (refs.size === 0) return [];
  return message.sources.filter((source, index) => refs.has(source.ref ?? index + 1));
}

const ASK_STARTERS = [
  "最近三天有哪些待办？",
  "Bruce 最近忙什么？",
  "哪些会议提到了 Zulip？",
];

function AskMeetings({ agentId, agentName }: { agentId: string; agentName: string }) {
  const navigate = useNavigate();
  const utils = trpc.useUtils();
  const ask = trpc.ask.ask.useMutation();
  const createSession = trpc.agentSessions.create.useMutation();
  const appendSession = trpc.agentSessions.append.useMutation();
  const renameSession = trpc.agentSessions.rename.useMutation();
  const deleteSession = trpc.agentSessions.delete.useMutation();
  const pinSession = trpc.agentSessions.pin.useMutation();
  const archiveSession = trpc.agentSessions.archive.useMutation();
  const sessionsQuery = trpc.agentSessions.list.useQuery({ agent: agentId });
  const [input, setInput] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [draftSession, setDraftSession] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionQuery = trpc.agentSessions.get.useQuery(
    { id: selectedSessionId ?? "__none__" },
    { enabled: selectedSessionId !== null },
  );

  const sessions = (sessionsQuery.data?.sessions as AgentSessionSummary[] | undefined) ?? [];
  const selectedSession = (sessionQuery.data as AgentSession | null | undefined) ?? null;
  const selectedSessionSummary = selectedSessionId ? sessions.find((session) => session.id === selectedSessionId) : null;
  const sessionTitle = selectedSession?.title || selectedSessionSummary?.title || (draftSession ? "新对话" : "问本地会议");
  const sessionSub = selectedSessionSummary
    ? `${selectedSessionSummary.messageCount} 条消息 · ${formatSessionTime(selectedSessionSummary.updatedAt)}`
    : draftSession ? "尚未创建 session" : "默认读取所有本地记录";

  useEffect(() => {
    setSelectedSessionId(null);
    setMessages([]);
    setDraftSession(true);
  }, [agentId]);

  useEffect(() => {
    if (draftSession || selectedSessionId || sessions.length === 0) return;
    setSelectedSessionId(sessions[0]!.id);
  }, [draftSession, selectedSessionId, sessions]);

  useEffect(() => {
    if (!selectedSession || ask.isPending) return;
    setMessages(sessionMessages(selectedSession));
  }, [selectedSession, ask.isPending]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (typeof node.scrollTo === "function") {
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    } else {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages]);

  const submit = async () => {
    const question = input.trim();
    if (!question || ask.isPending || createSession.isPending || appendSession.isPending) return;
    setInput("");
    let sessionId = selectedSessionId;
    if (!sessionId) {
      const created = await createSession.mutateAsync({ agent: agentId, title: question }) as AgentSession;
      sessionId = created.id;
      setSelectedSessionId(sessionId);
      setDraftSession(false);
    }
    setMessages((prev) => [...prev, { role: "user", text: question }, { role: "assistant", text: "", pending: true }]);
    try {
      await appendSession.mutateAsync({ sessionId, message: { role: "user", text: question } });
      const result = await ask.mutateAsync({ question, limit: 10, sessionId }) as AskResponse;
      const assistantMessage: ChatMessage = {
        role: "assistant",
        text: result.answer,
        sources: result.sources,
        remoteSources: result.remoteSources,
        error: result.llmStatus === "error" ? result.llmError ?? undefined : undefined,
      };
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = assistantMessage;
        return next;
      });
      await appendSession.mutateAsync({ sessionId, message: assistantMessage });
      void utils.agentSessions.list.invalidate({ agent: agentId });
      void utils.agentSessions.get.invalidate({ id: sessionId });
    } catch (err) {
      const errorMessage = (err as Error).message;
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = {
          role: "assistant",
          text: "",
          error: errorMessage,
        };
        return next;
      });
      if (sessionId) {
        await appendSession.mutateAsync({
          sessionId,
          message: { role: "assistant", text: "", error: errorMessage },
        });
        void utils.agentSessions.list.invalidate({ agent: agentId });
        void utils.agentSessions.get.invalidate({ id: sessionId });
      }
    }
  };

  const startNewSession = () => {
    setDraftSession(true);
    setSelectedSessionId(null);
    setMessages([]);
    setInput("");
  };

  const selectSession = (id: string) => {
    setDraftSession(false);
    setSelectedSessionId(id);
  };

  const refreshSessions = (id?: string) => {
    void utils.agentSessions.list.invalidate({ agent: agentId });
    if (id) void utils.agentSessions.get.invalidate({ id });
  };

  const renameSelectedSession = async (session: AgentSessionSummary) => {
    const title = window.prompt("重命名对话", session.title)?.trim();
    if (!title || title === session.title) return;
    await renameSession.mutateAsync({ id: session.id, title });
    refreshSessions(session.id);
  };

  const deleteSelectedSession = async (session: AgentSessionSummary) => {
    if (!window.confirm(`删除「${session.title}」？`)) return;
    await deleteSession.mutateAsync({ id: session.id });
    if (selectedSessionId === session.id) startNewSession();
    refreshSessions(session.id);
  };

  const archiveSelectedSession = async (session: AgentSessionSummary) => {
    await archiveSession.mutateAsync({ id: session.id, archived: true });
    if (selectedSessionId === session.id) startNewSession();
    refreshSessions(session.id);
  };

  const pinSelectedSession = async (session: AgentSessionSummary) => {
    await pinSession.mutateAsync({ id: session.id, pinned: !session.pinnedAt });
    refreshSessions(session.id);
  };

  if (messages.length === 0) {
    return (
      <section className="agent-chat">
        <AgentSessionPanel
          sessions={sessions}
          selectedSessionId={selectedSessionId}
          loading={sessionsQuery.isPending}
          onSelect={selectSession}
          onNew={startNewSession}
          onRename={renameSelectedSession}
          onDelete={deleteSelectedSession}
          onArchive={archiveSelectedSession}
          onPin={pinSelectedSession}
        />
        <div className="agent-chat-main">
          <ChatHeader title={sessionTitle} sub={`由 ${agentName} 处理 · ${sessionSub}`} />
          <div className="agent-chat-thread empty">
            <div className="agent-chat-start">
              <span className="agent-chat-start-icon"><Bot size={17} strokeWidth={2} /></span>
              <div className="agent-chat-title">问本地会议</div>
              <div className="agent-chat-sub">本地记录、Notion、Zulip 会自动进入上下文。</div>
              <div className="agent-chat-starters">
                {ASK_STARTERS.map((starter) => (
                  <button key={starter} type="button" onClick={() => setInput(starter)}>
                    {starter}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="agent-chat-composer">
            <Composer value={input} onChange={setInput} onSubmit={submit} pending={ask.isPending || createSession.isPending || appendSession.isPending} placeholder="问会议记录、决策、行动项..." />
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="agent-chat">
      <AgentSessionPanel
        sessions={sessions}
        selectedSessionId={selectedSessionId}
        loading={sessionsQuery.isPending}
        onSelect={selectSession}
        onNew={startNewSession}
        onRename={renameSelectedSession}
        onDelete={deleteSelectedSession}
        onArchive={archiveSelectedSession}
        onPin={pinSelectedSession}
      />
      <div className="agent-chat-main">
        <ChatHeader title={sessionTitle} sub={`由 ${agentName} 处理 · ${sessionSub}`} />
        <div ref={scrollRef} className="agent-chat-thread">
          <div className="agent-chat-thread-inner">
            {messages.map((message, index) => {
              const localSources = citedLocalSources(message);
              return (
                <div key={index} className={`agent-chat-row ${message.role}`}>
                  {message.role === "assistant" && <span className="agent-avatar"><Bot size={15} strokeWidth={2} /></span>}
                  <div className="agent-message">
                    {message.pending ? (
                      <span className="agent-message-pending"><Loader2 className="spin" size={14} strokeWidth={2} />正在询问 {agentName}...</span>
                    ) : message.error ? (
                      <span className="agent-message-error">{message.error}</span>
                    ) : (
                      <>
                        <div className="agent-message-text"><MarkdownView text={message.text} /></div>
                        <SourceSummary
                          localSources={localSources}
                          remoteSources={message.remoteSources ?? []}
                          onOpenLocalSource={(source) => navigate(source.url)}
                        />
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
        <div className="agent-chat-composer">
          <Composer value={input} onChange={setInput} onSubmit={submit} pending={ask.isPending || createSession.isPending || appendSession.isPending} placeholder="继续提问..." />
        </div>
      </div>
    </section>
  );
}

function ChatHeader({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="agent-chat-head">
      <div>
        <strong>{title}</strong>
        <span>{sub}</span>
      </div>
    </div>
  );
}

function formatSessionTime(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.valueOf())) return "";
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function sessionGroupLabel(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.valueOf())) return "更早";
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).valueOf();
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate()).valueOf();
  const delta = Math.round((today - day) / (24 * 60 * 60 * 1000));
  if (delta <= 0) return "今天";
  if (delta === 1) return "昨天";
  if (delta < 7) return "近 7 天";
  return "更早";
}

function groupedSessions(sessions: AgentSessionSummary[], query: string) {
  const needle = query.trim().toLowerCase();
  const groups: Array<{ label: string; sessions: AgentSessionSummary[] }> = [];
  for (const session of sessions) {
    if (needle && !session.title.toLowerCase().includes(needle)) continue;
    const label = session.pinnedAt ? "置顶" : sessionGroupLabel(session.updatedAt);
    let group = groups.find((item) => item.label === label);
    if (!group) {
      group = { label, sessions: [] };
      groups.push(group);
    }
    group.sessions.push(session);
  }
  return groups;
}

function AgentSessionPanel({
  sessions,
  selectedSessionId,
  loading,
  onSelect,
  onNew,
  onRename,
  onDelete,
  onArchive,
  onPin,
}: {
  sessions: AgentSessionSummary[];
  selectedSessionId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRename: (session: AgentSessionSummary) => void;
  onDelete: (session: AgentSessionSummary) => void;
  onArchive: (session: AgentSessionSummary) => void;
  onPin: (session: AgentSessionSummary) => void;
}) {
  const [query, setQuery] = useState("");
  const groups = groupedSessions(sessions, query);
  return (
    <aside className="agent-session-panel" aria-label="Agent 会话历史">
      <div className="agent-session-panel-head">
        <span>历史</span>
        <button type="button" className="agent-session-new" onClick={onNew}>新对话</button>
      </div>
      <input
        className="agent-session-search"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="搜索对话"
      />
      <div className="agent-session-groups">
        {groups.map((group) => (
          <div key={group.label} className="agent-session-group">
            <div className="agent-session-group-label">{group.label}</div>
            {group.sessions.map((session) => (
              <div
                key={session.id}
                className={`agent-session-item ${session.id === selectedSessionId ? "active" : ""}`}
              >
                <button
                  type="button"
                  className="agent-session-select"
                  onClick={() => onSelect(session.id)}
                  title={session.title}
                >
                  <MessageSquare size={13} strokeWidth={2} />
                  <span>
                    <strong>{session.title}</strong>
                    <em>{session.messageCount} 条 · {formatSessionTime(session.updatedAt)}</em>
                  </span>
                </button>
                <details className="agent-session-menu">
                  <summary aria-label={`${session.title} 操作`}>
                    <MoreHorizontal size={14} strokeWidth={2} />
                  </summary>
                  <div>
                    <button type="button" onClick={() => onRename(session)}><Pencil size={13} />重命名</button>
                    <button type="button" onClick={() => onPin(session)}><Pin size={13} />{session.pinnedAt ? "取消置顶" : "置顶"}</button>
                    <button type="button" onClick={() => onArchive(session)}><Archive size={13} />归档</button>
                    <button type="button" className="danger" onClick={() => onDelete(session)}><Trash2 size={13} />删除</button>
                  </div>
                </details>
              </div>
            ))}
          </div>
        ))}
        {groups.length === 0 && <span className="agent-session-empty">{loading ? "读取历史..." : "暂无历史会话"}</span>}
      </div>
    </aside>
  );
}

function SourceSummary({
  localSources,
  remoteSources,
  onOpenLocalSource,
}: {
  localSources: AskSource[];
  remoteSources: RemoteSource[];
  onOpenLocalSource: (source: AskSource) => void;
}) {
  if (localSources.length === 0 && remoteSources.length === 0) return null;
  return (
    <details className="agent-source-summary">
      <summary>
        <span>来源</span>
        {localSources.length > 0 && <em>本地 {localSources.length}</em>}
        {remoteSources.length > 0 && <em>远端 {remoteSources.length}</em>}
      </summary>
      {localSources.length > 0 && (
        <div className="agent-citations">
          {localSources.map((source, sourceIndex) => (
            <button key={`${source.url}-${sourceIndex}`} type="button" className="agent-citation" onClick={() => onOpenLocalSource(source)}>
              <span>[{source.ref ?? sourceIndex + 1}]</span>
              <strong>{source.title}</strong>
              <em>{source.snippet}</em>
            </button>
          ))}
        </div>
      )}
      {remoteSources.length > 0 && (
        <div className="agent-remote-sources">
          {remoteSources.map((source) => (
            <span key={source.channel} title={source.detail}>
              {source.label}
            </span>
          ))}
        </div>
      )}
    </details>
  );
}

function Composer({
  value,
  onChange,
  onSubmit,
  pending,
  placeholder,
  large,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  pending?: boolean;
  placeholder: string;
  large?: boolean;
}) {
  return (
    <div className="agent-composer">
      <textarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            onSubmit();
          }
        }}
        rows={large ? 2 : 1}
        placeholder={placeholder}
      />
      <button type="button" disabled={!value.trim() || pending} onClick={onSubmit} aria-label="发送">
        {pending ? <Loader2 className="spin" size={15} strokeWidth={2} /> : <ArrowUp size={15} strokeWidth={2} />}
      </button>
    </div>
  );
}

function RunTasks({
  queue,
  scheduler,
  queueLoading,
  schedulerLoading,
  onOpenQueue,
  onOpenScheduler,
}: {
  queue: unknown;
  scheduler: unknown;
  queueLoading: boolean;
  schedulerLoading: boolean;
  onOpenQueue: () => void;
  onOpenScheduler: () => void;
}) {
  const queueRecord = asConfigRecord(queue);
  const schedulerRecord = asConfigRecord(scheduler);
  const entries = Array.isArray(queueRecord.entries) ? queueRecord.entries as Array<Record<string, unknown>> : [];
  const events = Array.isArray(schedulerRecord.events) ? schedulerRecord.events as Array<Record<string, unknown>> : [];
  const meetings = Array.isArray(schedulerRecord.meetings) ? schedulerRecord.meetings as Array<Record<string, unknown>> : [];
  const stats = asConfigRecord(queueRecord.stats);
  return (
    <section className="agent-run-panel">
      <div className="agent-run-card">
        <div className="agent-run-head">
          <div>
            <h2>Agent 队列</h2>
            <p>{queueLoading ? "同步队列中" : `${Number(queueRecord.total ?? entries.length)} 个任务`}</p>
          </div>
          <button type="button" className="agent-action secondary compact" onClick={onOpenQueue}>管理</button>
        </div>
        <div className="agent-stat-row">
          <span>等待 {Number(stats.pending ?? 0)}</span>
          <span>运行 {Number(stats.processing ?? 0)}</span>
          <span>失败 {Number(stats.error ?? 0)}</span>
        </div>
        <div className="agent-mini-list">
          {entries.slice(0, 4).map((entry) => (
            <div key={String(entry.id)} className="agent-mini-row">
              <span>{String(entry.title || entry.promptName || entry.type || "Agent task")}</span>
              <em>{String(entry.status || "pending")}</em>
            </div>
          ))}
          {entries.length === 0 && <div className="agent-mini-empty">当前没有 Agent 任务。</div>}
        </div>
      </div>

      <div className="agent-run-card">
        <div className="agent-run-head">
          <div>
            <h2>Agent 调度器</h2>
            <p>{schedulerLoading ? "同步日程中" : `${events.length} 个事件 · ${meetings.length} 个会议`}</p>
          </div>
          <button type="button" className="agent-action secondary compact" onClick={onOpenScheduler}>管理</button>
        </div>
        <div className="agent-mini-list">
          {[...meetings, ...events].slice(0, 5).map((event, index) => (
            <div key={`${String(event.title ?? event.name ?? "event")}-${index}`} className="agent-mini-row">
              <span>{String(event.title ?? event.name ?? "Calendar event")}</span>
              <em>{String(event.start ?? event.ts ?? "")}</em>
            </div>
          ))}
          {meetings.length + events.length === 0 && <div className="agent-mini-empty">暂无即将触发的调度。</div>}
        </div>
      </div>
    </section>
  );
}

function AgentSelector({
  agents,
  detecting,
  detectMessage,
  onDetect,
}: {
  agents: ConsoleAgent[];
  detecting: boolean;
  detectMessage: string;
  onDetect: () => void;
}) {
  const connect = trpc.agentConsole.connectAgent.useMutation();
  const utils = trpc.useUtils();
  const ordered = agents.length > 0 ? agents : (["codex", "claude", "hermes", "openclaw"] as AgentId[]).map((id) => ({
    id,
    name: id,
    command: id,
    found: false,
    path: "",
    supported: true,
    connected: false,
    unavailableReason: "",
    runtimePreview: "",
  }));
  return (
    <section className="agent-panel">
      <div className="agent-panel-head">
        <span>底层 Agent</span>
        <button type="button" className="agent-link-btn" disabled={detecting} onClick={onDetect}>
          {detecting ? <Loader2 className="spin" size={13} strokeWidth={2} /> : <Radar size={13} strokeWidth={2} />}
          {detecting ? "探测中" : "探测"}
        </button>
      </div>
      <div className={"agent-detect-state" + (detecting ? " running" : "")}>{detectMessage}</div>
      <div className="agent-selector-list">
        {ordered.map((agent) => (
          <button
            key={agent.id}
            type="button"
            className={"agent-selector-row" + (agent.connected ? " active" : "") + (!agent.supported ? " disabled" : "")}
            disabled={!agent.supported || connect.isPending}
            onClick={() => {
              if (!agent.supported) return;
              connect.mutate({ agent: agent.id }, {
                onSettled: () => void utils.agentConsole.overview.invalidate(),
              });
            }}
          >
            <span className="agent-selector-main">
              {AGENT_ICONS[agent.id]}
              <span>{agent.name}</span>
            </span>
            <span className="agent-selector-state">
              {agent.connected ? "已连接" : agent.supported ? (agent.found ? "可连接" : "未找到") : "未启用"}
            </span>
            {agent.path && <code>{agent.path}</code>}
          </button>
        ))}
      </div>
    </section>
  );
}

function CapabilitiesPanel({
  plugins,
  prompts,
  selectedPromptId,
  onPromptChange,
  onOpenSummary,
  onOpenCalendar,
  onAddPlugin,
  onRemovePlugin,
  onConfigure,
  onConfigureDestination,
}: {
  plugins: AgentPluginOverview;
  prompts: SummaryPrompt[];
  selectedPromptId: string | null;
  onPromptChange: (id: string) => void;
  onOpenSummary: () => void;
  onOpenCalendar: () => void;
  onAddPlugin: (plugin: AgentPluginId) => void;
  onRemovePlugin: (plugin: AgentPluginId) => void;
  onConfigure: (plugin: AgentPluginId) => void;
  onConfigureDestination: (plugin: AgentPluginState) => void;
}) {
  const current = plugins.current.length > 0 ? plugins.current : plugins.all.filter((plugin) => plugin.id === "summary");
  return (
    <section className="agent-panel">
      <div className="agent-panel-head"><span>当前能力</span></div>
      <div className="agent-cap-list">
        {current.map((plugin) => plugin.id === "summary" ? (
          <SummaryCapabilityRow
            key={plugin.id}
            plugin={plugin}
            prompts={prompts}
            selectedPromptId={selectedPromptId}
            onPromptChange={onPromptChange}
            onOpenSummary={onOpenSummary}
          />
        ) : (
          <PluginCapabilityRow
            key={plugin.id}
            plugin={plugin}
            onOpenCalendar={onOpenCalendar}
            onConfigure={() => onConfigure(plugin.id)}
            onConfigureDestination={() => onConfigureDestination(plugin)}
            onRemove={() => onRemovePlugin(plugin.id)}
          />
        ))}
      </div>
      {plugins.available.length > 0 && (
        <div className="agent-plugin-add">
          <div className="agent-plugin-add-title">添加能力</div>
          {plugins.available.map((plugin) => (
            <button key={plugin.id} type="button" className="agent-plugin-add-row" onClick={() => onAddPlugin(plugin.id)}>
              <span>{pluginIcon(plugin.id)}{plugin.label}</span>
              <em>{plugin.status === "configured" ? "已在 Agent 配好" : plugin.statusLabel}</em>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function SummaryCapabilityRow({
  plugin,
  prompts,
  selectedPromptId,
  onPromptChange,
  onOpenSummary,
}: {
  plugin: AgentPluginState;
  prompts: SummaryPrompt[];
  selectedPromptId: string | null;
  onPromptChange: (id: string) => void;
  onOpenSummary: () => void;
}) {
  const selectedPrompt = prompts.find((prompt) => prompt.id === selectedPromptId);
  return (
    <div className="agent-cap-row stacked">
      <div className="agent-cap-topline">
        <span className="agent-cap-title"><FileText size={14} strokeWidth={1.9} />{plugin.label}</span>
        <CapabilityStatus plugin={plugin} />
      </div>
      <div className="agent-cap-destination">
        <span title={selectedPrompt ? promptLabel(selectedPrompt) : ""}>{selectedPrompt ? promptLabel(selectedPrompt) : "暂无总结模板"}</span>
        <button type="button" className="agent-cap-action" disabled={prompts.length === 0 || plugin.status !== "configured"} onClick={() => {
          if (prompts.length > 0 && plugin.status === "configured") onOpenSummary();
          else onPromptChange(selectedPromptId ?? "");
        }}>更改</button>
      </div>
    </div>
  );
}

function PluginCapabilityRow({
  plugin,
  onOpenCalendar,
  onConfigure,
  onConfigureDestination,
  onRemove,
}: {
  plugin: AgentPluginState;
  onOpenCalendar: () => void;
  onConfigure: () => void;
  onConfigureDestination: () => void;
  onRemove: () => void;
}) {
  const configured = plugin.status === "configured";
  const isCalendar = plugin.id === "calendar";
  const isDestination = plugin.id === "notion" || plugin.id === "zulip";
  const value =
    isCalendar ? "账户与订阅日历" :
    isDestination ? plugin.destination?.value || "未选择发送目标" :
    plugin.detail || plugin.statusLabel;
  return (
    <div className="agent-cap-row stacked">
      <div className="agent-cap-topline">
        <span className="agent-cap-title">{pluginIcon(plugin.id)}{plugin.label}</span>
        <span className="agent-cap-actions">
          <CapabilityStatus plugin={plugin} />
          {!plugin.core && (
            <button type="button" className="agent-cap-remove" onClick={onRemove} aria-label={`移除 ${plugin.label}`}>
              <X size={12} strokeWidth={2} />
            </button>
          )}
        </span>
      </div>
      <div className="agent-cap-destination">
        <span title={value}>{value}</span>
        <button
          type="button"
          className={"agent-cap-action" + (!configured ? " warn" : "")}
          onClick={() => {
            if (!configured) onConfigure();
            else if (isCalendar) onOpenCalendar();
            else if (isDestination) onConfigureDestination();
          }}
          disabled={plugin.status === "unsupported"}
        >
          {!configured ? (plugin.status === "unsupported" ? "不可用" : "去配置") : "更改"}
        </button>
      </div>
    </div>
  );
}

function CapabilityStatus({ plugin }: { plugin: AgentPluginState }) {
  return (
    <span className={"agent-cap-status " + plugin.status} title={plugin.detail}>
      <span />{plugin.statusLabel}
    </span>
  );
}

function pluginIcon(id: AgentPluginId) {
  if (id === "calendar") return <Calendar size={14} strokeWidth={1.9} />;
  if (id === "summary") return <FileText size={14} strokeWidth={1.9} />;
  return <Send size={14} strokeWidth={1.9} />;
}

function SummaryConfigModal({
  plugin,
  prompts,
  selectedPromptId,
  onPromptChange,
  onClose,
}: {
  plugin: AgentPluginState | undefined;
  prompts: SummaryPrompt[];
  selectedPromptId: string | null;
  onPromptChange: (id: string) => void;
  onClose: () => void;
}) {
  const [draftPromptId, setDraftPromptId] = useState(selectedPromptId ?? firstAvailablePrompt(prompts) ?? "");
  const selectedPrompt = prompts.find((prompt) => prompt.id === draftPromptId);
  const save = () => {
    if (draftPromptId) onPromptChange(draftPromptId);
    onClose();
  };
  return (
    <div className="agent-modal-backdrop" onMouseDown={onClose}>
      <div className="agent-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-label="总结配置">
        <div className="agent-modal-head">
          <div>
            <strong><FileText size={15} strokeWidth={2} />总结</strong>
            <span>{plugin?.status === "configured" ? "由当前底层 Agent 执行。" : plugin?.detail ?? "当前 Agent 未就绪。"}</span>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭"><X size={16} strokeWidth={2} /></button>
        </div>
        <label className="agent-field">
          <span>默认总结模板</span>
          <span className="agent-select-wrap">
            <select value={draftPromptId} onChange={(event) => setDraftPromptId(event.currentTarget.value)} disabled={prompts.length === 0}>
              {prompts.length === 0 ? (
                <option value="">暂无总结模板</option>
              ) : prompts.map((prompt) => (
                <option key={prompt.id} value={prompt.id}>{promptLabel(prompt)}</option>
              ))}
            </select>
            <ChevronDown size={14} strokeWidth={2} />
          </span>
          <em>{selectedPrompt ? selectedPrompt.slug : "在模板页添加后会显示在这里。"}</em>
        </label>
        <div className="agent-modal-actions">
          <button type="button" className="agent-action secondary compact" onClick={onClose}>取消</button>
          <button type="button" className="agent-action primary compact" disabled={!draftPromptId} onClick={save}>保存</button>
        </div>
      </div>
    </div>
  );
}

function DestinationConfigModal({
  plugin,
  saving,
  onSave,
  onClose,
}: {
  plugin: AgentPluginState;
  saving: boolean;
  onSave: (input:
    | { channel: "notion"; target: string }
    | { channel: "zulip"; stream: string; topic: string }
  ) => void;
  onClose: () => void;
}) {
  const [notionTarget, setNotionTarget] = useState(plugin.destination?.notion?.target || "Yulu Meeting");
  const [zulipStream, setZulipStream] = useState(plugin.destination?.zulip?.stream ?? "");
  const [zulipTopic, setZulipTopic] = useState(plugin.destination?.zulip?.topic ?? "");
  const isNotion = plugin.id === "notion";
  const channel = isNotion ? "notion" : "zulip";
  const utils = trpc.useUtils();
  const [autoRefreshStarted, setAutoRefreshStarted] = useState(false);
  const optionsQuery = trpc.agentConsole.destinationOptions.useQuery({ channel });
  const refreshOptions = trpc.agentConsole.refreshDestinationOptions.useMutation({
    onSuccess: () => {
      void utils.agentConsole.destinationOptions.invalidate({ channel });
      void utils.agentConsole.overview.invalidate();
    },
  });
  const options = (optionsQuery.data?.options as DestinationOption[] | undefined) ?? [];
  const canSave = isNotion ? notionTarget.trim().length > 0 : zulipStream.trim().length > 0 && zulipTopic.trim().length > 0;
  useEffect(() => {
    if (autoRefreshStarted || plugin.status !== "configured" || !optionsQuery.isSuccess) return;
    setAutoRefreshStarted(true);
    if (options.length <= 1) refreshOptions.mutate({ channel });
  }, [autoRefreshStarted, channel, options.length, optionsQuery.isSuccess, plugin.status, refreshOptions]);
  const save = () => {
    if (!canSave || saving) return;
    if (isNotion) onSave({ channel: "notion", target: notionTarget.trim() });
    else onSave({ channel: "zulip", stream: zulipStream.trim(), topic: zulipTopic.trim() });
  };
  const applyOption = (id: string) => {
    const option = options.find((item) => item.id === id);
    if (!option) return;
    if (isNotion) {
      setNotionTarget(option.target || option.value);
    } else {
      setZulipStream(option.stream ?? "");
      setZulipTopic(option.topic ?? "");
    }
  };
  const selectedOptionId = isNotion
    ? options.find((option) => (option.target || option.value) === notionTarget.trim())?.id ?? ""
    : options.find((option) => option.stream === zulipStream.trim() && option.topic === zulipTopic.trim())?.id ?? "";
  const optionStatus =
    refreshOptions.isPending ? "正在从 Agent connector 读取目标..." :
    refreshOptions.data?.error ? refreshOptions.data.error :
    options.length > 0 ? `已读取 ${options.length} 个候选目标` :
    "没有读取到候选目标，可手动填写。";
  return (
    <div className="agent-modal-backdrop" onMouseDown={onClose}>
      <div className="agent-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-label={`${plugin.label} 发送目标`}>
        <div className="agent-modal-head">
          <div>
            <strong><Database size={15} strokeWidth={2} />{plugin.label} 发送目标</strong>
            <span>只保存路径偏好；连接和权限仍由 {plugin.agent ?? "当前"} Agent 管理。</span>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭"><X size={16} strokeWidth={2} /></button>
        </div>
        <div className="agent-option-row">
          <select value={selectedOptionId} onChange={(event) => applyOption(event.currentTarget.value)} aria-label={`${plugin.label} 候选目标`}>
            <option value="">选择 Agent 读取到的目标...</option>
            {options.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}{option.source === "agent" ? "" : ` · ${option.source}`}
              </option>
            ))}
          </select>
          <button type="button" className="agent-action secondary compact" disabled={refreshOptions.isPending || plugin.status !== "configured"} onClick={() => refreshOptions.mutate({ channel })}>
            {refreshOptions.isPending ? <Loader2 className="spin" size={13} strokeWidth={2} /> : <RefreshCw size={13} strokeWidth={2} />}
            刷新
          </button>
        </div>
        <div className={"agent-option-status" + (refreshOptions.data?.error ? " warn" : "")}>{optionStatus}</div>
        {isNotion ? (
          <label className="agent-field">
            <span>页面/数据库名称或 URL</span>
            <input value={notionTarget} onChange={(event) => setNotionTarget(event.target.value)} placeholder="Yulu Meeting" />
            <em>默认发送到 Yulu Meeting；如果 Agent connector 支持创建，未找到时会尝试新建。</em>
          </label>
        ) : (
          <div className="agent-field-grid">
            <label className="agent-field">
              <span>Channel / Stream</span>
              <input value={zulipStream} onChange={(event) => setZulipStream(event.target.value)} placeholder="meetings" />
            </label>
            <label className="agent-field">
              <span>Topic</span>
              <input value={zulipTopic} onChange={(event) => setZulipTopic(event.target.value)} placeholder="会议纪要" />
            </label>
          </div>
        )}
        <div className="agent-modal-actions">
          <button type="button" className="agent-action secondary compact" onClick={onClose}>取消</button>
          <button type="button" className="agent-action primary compact" disabled={!canSave || saving} onClick={save}>
            {saving ? <Loader2 className="spin" size={13} strokeWidth={2} /> : null}
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function LocalStatus({ daemons, queue, onDetails }: { daemons: unknown; queue: unknown; onDetails: () => void }) {
  const rows = Array.isArray(daemons) ? daemons as Array<Record<string, unknown>> : [];
  const queueRecord = asConfigRecord(queue);
  const stt = rows.find((row) => row.name === "com.yulu.sttdaemon");
  const agentQueue = rows.find((row) => row.name === "com.yulu.agentqueue");
  return (
    <section className="agent-panel agent-local-status">
      <div className="agent-panel-head">
        <span>本地状态</span>
        <button type="button" className="agent-link-btn" onClick={onDetails}>详情</button>
      </div>
      <StatusRow icon={<Cpu size={16} strokeWidth={1.9} />} title="STT" sub="Whisper · 本地" state={String(stt?.status ?? "unknown")} />
      <StatusRow icon={<ListChecks size={16} strokeWidth={1.9} />} title="Agent Queue" sub={`${Number(queueRecord.total ?? 0)} 个任务`} state={String(agentQueue?.status ?? "unknown")} />
      <StatusRow icon={<HardDrive size={16} strokeWidth={1.9} />} title="Storage" sub="本地记录目录" state="本机" />
      <StatusRow icon={<ShieldCheck size={16} strokeWidth={1.9} />} title="Privacy" sub="音频与转写默认不离开电脑" state="本地" />
    </section>
  );
}

function StatusRow({ icon, title, sub, state }: { icon: JSX.Element; title: string; sub: string; state: string }) {
  const ready = state === "running" || state === "本机" || state === "本地";
  return (
    <div className="agent-status-row">
      <span className={"agent-status-icon" + (ready ? " ready" : "")}>{icon}</span>
      <span className="agent-status-copy">
        <strong>{title}</strong>
        <em>{sub}</em>
      </span>
      <span className="agent-status-state">{state}</span>
    </div>
  );
}

function selectedWatchCalendars(cal: CalendarEntry): string[] {
  if (cal.type === "macos" || cal.type === "system") return cal.watch_calendars ?? [];
  const current = cal.watch_calendars;
  return current && current.length > 0 ? current : ["primary"];
}

function calendarTitle(cal: CalendarEntry): string {
  return cal.type === "macos" || cal.type === "system" ? "macOS 日历" : "Google 日历";
}

function CalendarAccountPicker({
  cal,
  idx,
  accounts,
  onCommit,
}: {
  cal: CalendarEntry;
  idx: number;
  accounts: GoogleAccount[];
  onCommit: (idx: number, key: string, value: unknown) => void;
}) {
  const current = (cal.gog_account ?? "").trim();
  if (accounts.length === 0) {
    return (
      <label className="agent-field">
        <span>账户</span>
        <input
          defaultValue={current}
          placeholder="name@example.com"
          onBlur={(event) => onCommit(idx, "gog_account", event.currentTarget.value.trim())}
        />
        <em>从 gog auth list 自动读取；没有读取到时可手动填写。</em>
      </label>
    );
  }
  const options = current && !accounts.some((account) => account.email === current)
    ? [{ email: current, services: [] }, ...accounts]
    : accounts;
  return (
    <label className="agent-field">
      <span>账户</span>
      <select value={current} onChange={(event) => onCommit(idx, "gog_account", event.currentTarget.value)}>
        <option value="">选择账户...</option>
        {options.map((account) => (
          <option key={account.email} value={account.email}>{account.email}</option>
        ))}
      </select>
      <em>选择 Yulu 本地 scheduler 要监听的 Google 账户。</em>
    </label>
  );
}

function CalendarWatchSelector({
  cal,
  idx,
  onCommit,
}: {
  cal: CalendarEntry;
  idx: number;
  onCommit: (idx: number, key: string, value: unknown) => void;
}) {
  const account = (cal.gog_account ?? "").trim();
  const selected = new Set(selectedWatchCalendars(cal));
  const calendarsQuery = trpc.integrations.calendarList.useQuery(
    { account },
    { enabled: account.length > 0 },
  );
  if (!account) return <div className="agent-option-status">请先选择账户。</div>;
  if (calendarsQuery.isPending && !calendarsQuery.data) return <div className="agent-option-status">正在读取日历...</div>;
  if (!calendarsQuery.data?.ok) {
    return <div className="agent-option-status warn">{calendarsQuery.data?.stderr || "无法读取日历列表。"}</div>;
  }
  const calendars = calendarsQuery.data.calendars as CalendarOption[];
  if (calendars.length === 0) return <div className="agent-option-status">没有读取到日历。</div>;
  const toggleCalendar = (id: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    const ordered = calendars.map((calendar) => calendar.id).filter((calendarId) => next.has(calendarId));
    for (const calendarId of next) {
      if (!ordered.includes(calendarId)) ordered.push(calendarId);
    }
    onCommit(idx, "watch_calendars", ordered);
  };
  return (
    <div className="agent-calendar-checklist">
      {calendars.map((calendar) => (
        <label key={calendar.id} className="agent-calendar-check">
          <input
            type="checkbox"
            checked={selected.has(calendar.id)}
            onChange={(event) => toggleCalendar(calendar.id, event.currentTarget.checked)}
          />
          <span>
            <strong>{calendar.summary}</strong>
            <em>{calendar.id}</em>
          </span>
        </label>
      ))}
    </div>
  );
}

function CalendarConfigModal({
  plugin,
  agentName,
  onConfigure,
  onClose,
}: {
  plugin: AgentPluginState | undefined;
  agentName: string;
  onConfigure: () => void;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const configQuery = trpc.config.get.useQuery();
  const accountListQuery = trpc.integrations.accountList.useQuery();
  const testConnection = trpc.integrations.test.useMutation();
  const updateCalendar = trpc.agentConsole.updateCalendarConfig.useMutation({
    onSuccess: () => {
      void utils.config.get.invalidate();
      void utils.scheduler.overview.invalidate();
      void utils.agentConsole.overview.invalidate();
    },
  });
  const [checkingIdx, setCheckingIdx] = useState<number | null>(null);
  const calendars = ((configQuery.data?.calendars ?? []) as CalendarEntry[]);
  const accounts = accountListQuery.data?.ok ? accountListQuery.data.accounts as GoogleAccount[] : [];
  const configured = plugin?.status === "configured";

  useEffect(() => {
    if (accounts.length !== 1) return;
    calendars.forEach((cal, idx) => {
      if (cal.type !== "google" || (cal.gog_account ?? "").trim()) return;
      updateCalendar.mutate({ key: `calendars.${idx}.gog_account`, value: accounts[0]!.email });
    });
  }, [accounts, calendars, updateCalendar]);

  const commitCalendar = (key: string, value: unknown) => {
    updateCalendar.mutate({ key, value });
  };
  const commitCalendarField = (idx: number, key: string, value: unknown) => {
    commitCalendar(`calendars.${idx}.${key}`, value);
  };
  const addCalendar = (type: CalendarType) => {
    const hasSystem = calendars.some((cal) => cal.type === "macos" || cal.type === "system");
    if ((type === "macos" && hasSystem) || calendars.some((cal) => cal.type === type)) return;
    const entry = type === "google"
      ? { type, enabled: true, watch_calendars: ["primary"], gog_account: accounts[0]?.email ?? "" }
      : { type, enabled: true, watch_calendars: [] };
    commitCalendar("calendars", [...calendars, entry]);
  };
  const removeCalendar = (idx: number) => {
    commitCalendar("calendars", calendars.filter((_, itemIdx) => itemIdx !== idx));
  };
  const runTest = async (idx: number) => {
    const provider = calendars[idx]?.type === "macos" || calendars[idx]?.type === "system" ? "macos" : "google";
    setCheckingIdx(idx);
    try {
      await testConnection.mutateAsync({ provider });
    } finally {
      // Keep the last status visible until another check starts.
    }
  };

  return (
    <div className="agent-modal-backdrop" onMouseDown={onClose}>
      <div className="agent-modal agent-modal-wide" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-label="日历配置">
        <div className="agent-modal-head">
          <div>
            <strong><Calendar size={15} strokeWidth={2} />日历</strong>
            <span>Console 管理账户与订阅日历；Yulu 本地 scheduler 继续负责提醒和自动录制。</span>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭"><X size={16} strokeWidth={2} /></button>
        </div>
        <div className="agent-calendar-list">
          <div className="agent-calendar-row">
            <span className={"agent-check" + (configured ? " checked" : "")}>
              {configured ? <Check size={12} strokeWidth={2.2} /> : <Calendar size={12} strokeWidth={2.2} />}
            </span>
            <span>
              <strong>Agent 日历上下文</strong>
              <em>{configured ? (plugin?.resolvedPath || `${agentName} 已配置日历插件`) : (plugin?.detail ?? "还没有在 Console 添加日历插件。")}</em>
            </span>
            {!configured && <button type="button" className="agent-action secondary compact" onClick={onConfigure}>去配置</button>}
          </div>
          <div className="agent-calendar-actions">
            <button type="button" className="agent-action secondary compact" onClick={() => addCalendar("macos")}>+ macOS 日历</button>
            <button type="button" className="agent-action secondary compact" onClick={() => addCalendar("google")}>+ Google</button>
          </div>
          {calendars.length === 0 && <div className="agent-empty">还没有添加本地调度日历来源。</div>}
          {calendars.map((cal, idx) => {
            const checking = checkingIdx === idx;
            const connectionOk = checking && testConnection.data?.ok;
            const connectionError = checking && testConnection.data && !testConnection.data.ok;
            return (
              <article key={`${cal.type}-${idx}`} className="agent-calendar-source">
                <div className="agent-calendar-source-head">
                  <div>
                    <strong>{calendarTitle(cal)}</strong>
                    <span>{cal.enabled === false ? "未启用" : "已启用"} · scheduler 来源</span>
                  </div>
                  <div className="agent-calendar-source-actions">
                    <button type="button" className={"agent-toggle" + (cal.enabled === false ? "" : " on")} onClick={() => commitCalendarField(idx, "enabled", cal.enabled === false)} aria-label={`启用 ${calendarTitle(cal)}`}>
                      <span />
                    </button>
                    <button type="button" className="agent-cap-remove" onClick={() => removeCalendar(idx)} aria-label={`移除 ${calendarTitle(cal)}`}>
                      <X size={12} strokeWidth={2} />
                    </button>
                  </div>
                </div>
                {cal.type === "google" ? (
                  <>
                    <CalendarAccountPicker cal={cal} idx={idx} accounts={accounts} onCommit={commitCalendarField} />
                    <CalendarWatchSelector cal={cal} idx={idx} onCommit={commitCalendarField} />
                  </>
                ) : (
                  <div className="agent-option-status">使用系统 Calendar 已连接的日历。</div>
                )}
                <div className="agent-calendar-test-row">
                  <button type="button" className="agent-action secondary compact" disabled={testConnection.isPending} onClick={() => void runTest(idx)}>
                    {checking && testConnection.isPending ? <Loader2 className="spin" size={13} strokeWidth={2} /> : null}
                    检查连接
                  </button>
                  {connectionOk && <span className="agent-option-status ok">已连接</span>}
                  {connectionError && <span className="agent-option-status warn">{testConnection.data?.stderr || "未认证"}</span>}
                </div>
              </article>
            );
          })}
          {updateCalendar.data?.restartErrors && updateCalendar.data.restartErrors.length > 0 && (
            <div className="agent-option-status warn">配置已保存，但刷新守护进程失败：{updateCalendar.data.restartErrors.join("; ")}</div>
          )}
        </div>
        <div className="agent-modal-actions">
          <button type="button" className="agent-action primary compact" onClick={onClose}>完成</button>
        </div>
      </div>
    </div>
  );
}
