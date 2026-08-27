import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
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
  Keyboard,
  Languages,
  ListChecks,
  Loader2,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Pin,
  Play,
  Radar,
  RefreshCw,
  Send,
  Share2,
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
import { usePersistedSize } from "../hooks/usePersistedSize.js";
import { MarkdownView } from "../components/MarkdownView.js";
import { Logo } from "../components/Logo.js";
import { useT } from "../i18n/LanguageProvider.js";
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
}

type DurableAgentTaskState =
  | "queued"
  | "awaiting_agent"
  | "awaiting_policy"
  | "running"
  | "transcript_committed"
  | "artifacts_committed"
  | "sending"
  | "delivery_reported"
  | "delivery_unverified"
  | "completed"
  | "failed"
  | "cancelled";

interface DurableAgentTask {
  id: string;
  recordingStem: string;
  title: string;
  trigger: "automatic" | "manual";
  state: DurableAgentTaskState;
  phase: string;
  sendToNotion: boolean;
  agentProvider: string;
  attempt: number;
  error: string | null;
  createdAt: string;
  updatedAt: string;
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

interface RecordingAgentStatus {
  available: boolean;
  provider: string;
  reason: string | null;
  paused: boolean;
  policyReason: string | null;
}

interface ConnectorGuide {
  plugin: AgentPluginId;
  label: string;
  agentName: string;
  manageCommand: string;
  message: string;
}

interface MeetingShareTarget {
  channel: "notion" | "zulip";
  label: string;
  destination: string;
}

type MeetingNextAction = "transcribe" | "summarize" | "share";

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
  source: "agent" | "saved" | "default";
  kind?: string;
  target?: string;
  stream?: string;
  topic?: string;
}

interface AskResponse {
  answer: string;
  provider?: string;
  model?: string;
  sessionStatus?: "active" | "paused";
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
  provider?: string;
  model?: string;
  status?: "active" | "paused";
  pausedReason?: string;
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
  provider?: string;
  model?: string;
  status?: "active" | "paused";
  pausedReason?: string;
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

function agentName(id: AgentId): string {
  if (id === "codex") return "Codex CLI";
  if (id === "claude") return "Claude Code";
  if (id === "hermes") return "Hermes";
  return "OpenClaw";
}

function audioProviderName(provider: string): string {
  if (provider === "local" || provider.startsWith("sherpa-onnx")) return "本地转写";
  if (provider === "xai-oauth:yulu") return "xAI · Yulu OAuth";
  if (provider.startsWith("xai")) return "xAI 云端";
  return provider || "正在检测";
}

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

function nextMeetingAction(task: AgentTask): MeetingNextAction {
  if (!task.hasTranscript) return "transcribe";
  if (!task.hasSummary) return "summarize";
  return "share";
}

function configuredMeetingShareTargets(plugins: AgentPluginOverview): MeetingShareTarget[] {
  return plugins.all.flatMap((plugin) => {
    if ((plugin.id !== "notion" && plugin.id !== "zulip") || plugin.status !== "configured") return [];
    const destination = plugin.destination?.value?.trim() ?? "";
    if (!plugin.destination?.configured || !destination) return [];
    return [{ channel: plugin.id, label: plugin.label, destination }];
  });
}

export function AgentConsole() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const floating = location.pathname === "/voice-chat";
  const utils = trpc.useUtils();
  const [mode, setMode] = useState<ConsoleMode>("ask");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [connectorGuide, setConnectorGuide] = useState<ConnectorGuide | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [sharingStem, setSharingStem] = useState<string | null>(null);

  const overview = trpc.agentConsole.overview.useQuery(undefined, { refetchInterval: 5000 });
  const detectAgents = trpc.agentConsole.detectAgents.useQuery(undefined, { enabled: false });
  const agentTasksQuery = trpc.agentTasks.list.useQuery({ limit: 100 }, { refetchInterval: 5000 });
  const schedulerQuery = trpc.scheduler.overview.useQuery(undefined, { refetchInterval: 15_000 });

  const toggleRecording = trpc.recording.toggle.useMutation({
    onSettled: () => void utils.agentConsole.overview.invalidate(),
  });
  const sendSummary = trpc.recordings.sendSummary.useMutation();
  const configurePlugin = trpc.agentConsole.configurePlugin.useMutation({
    onSuccess: (result) => {
      setConnectorGuide({
        plugin: result.plugin as AgentPluginId,
        label: result.label,
        agentName: result.agent ? agentName(result.agent as AgentId) : "当前 Agent",
        manageCommand: result.manageCommand,
        message: result.message,
      });
    },
  });

  useWsChannel("recordings-changed", () => {
    void utils.agentConsole.overview.invalidate();
    void utils.agentTasks.list.invalidate();
  });
  useWsChannel("jobs", () => {
    void utils.agentConsole.overview.invalidate();
    void utils.agentTasks.list.invalidate();
  });
  useWsChannel("recording", () => void utils.agentConsole.overview.invalidate());

  const tasks = (overview.data?.tasks as AgentTask[] | undefined) ?? [];
  const plugins = (overview.data?.plugins as AgentPluginOverview | undefined) ?? { agent: null, current: [], available: [], all: [] };
  const recordingAgent = (overview.data?.recordingAgent as RecordingAgentStatus | undefined) ?? {
    available: false,
    provider: "",
    reason: "正在检测音频引擎",
    paused: false,
    policyReason: null,
  };
  const requestedSessionId = searchParams.get("session");
  const latestAgentTaskByStem = useMemo(() => {
    const latest = new Map<string, DurableAgentTask>();
    for (const task of (agentTasksQuery.data ?? []) as DurableAgentTask[]) {
      if (isActiveDurableTask(task) && !latest.has(task.recordingStem)) latest.set(task.recordingStem, task);
    }
    return latest;
  }, [agentTasksQuery.data]);
  const meetingShareTargets = useMemo(() => configuredMeetingShareTargets(plugins), [plugins]);

  const activeAgent = useMemo(() => {
    const agents = (overview.data?.agents as ConsoleAgent[] | undefined) ?? [];
    return agents.find((agent) => agent.connected) ?? agents.find((agent) => agent.supported && agent.found) ?? null;
  }, [overview.data?.agents]);

  const runConfigurePlugin = (plugin: AgentPluginId) => {
    configurePlugin.mutate({ plugin });
  };

  const runDetectAgents = async () => {
    try {
      await detectAgents.refetch();
      await overview.refetch();
    } catch (err) {
      setNotice((err as Error).message || "探测失败");
    }
  };

  const runMeetingShare = (task: AgentTask, target: MeetingShareTarget) => {
    setNotice(null);
    setSharingStem(task.stem);
    sendSummary.mutate({
      stem: task.stem,
      channel: target.channel,
      label: target.label,
      destination: target.destination,
    }, {
      onSuccess: () => setNotice(`已分享到 ${target.label} · ${target.destination}`),
      onError: (error) => setNotice(error.message),
      onSettled: () => {
        setSharingStem(null);
        void utils.agentConsole.overview.invalidate();
      },
    });
  };

  const taskRail: TaskRailProps = {
    tasks,
    agentTasks: latestAgentTaskByStem,
    isLoading: overview.isPending,
    actionPending: toggleRecording.isPending,
    shareTargets: meetingShareTargets,
    sharingStem,
    onToggleRecording: () => toggleRecording.mutate(),
    onOpenAll: () => navigate("/inbox"),
    onOpenTask: (task) => { if (task.stem) navigate(`/inbox/${task.stem}`); },
    onShare: runMeetingShare,
  };

  return (
    <div className={`agent-console-page${floating ? " voice-chat-popover" : ""}`}>
      <main className="agent-console-center">
        {!floating && <div className="agent-console-modebar" role="tablist" aria-label="Agent Console mode">
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
            Agents
          </button>
        </div>}
        {notice && (
          <div className="agent-console-notice">
            <AlertCircle size={14} strokeWidth={2} />
            <span>{notice}</span>
            <button type="button" onClick={() => setNotice(null)} aria-label="关闭"><X size={13} strokeWidth={2} /></button>
          </div>
        )}
        {floating || mode === "ask" ? (
          <AskMeetings
            agentId={activeAgent?.id ?? "agent"}
            agentName={activeAgent?.name ?? "Agent"}
            initialSessionId={requestedSessionId}
            floating={floating}
            taskRail={floating ? null : taskRail}
          />
        ) : (
          <RunTasks
            agentTasks={agentTasksQuery.data}
            scheduler={schedulerQuery.data}
            tasksLoading={agentTasksQuery.isPending}
            schedulerLoading={schedulerQuery.isPending}
            onOpenTasks={() => navigate("/health#queue")}
            onOpenScheduler={() => navigate("/health#scheduler")}
          />
        )}
      </main>

      {!floating && inspectorOpen && <div className="agent-inspector-scrim" aria-hidden="true" onClick={() => setInspectorOpen(false)} />}
      {!floating && inspectorOpen && <aside className="agent-console-rail agent-console-rail-right open" aria-label="Agents 与 Connectors">
        <div className="agent-rail-drawer-head">
          <span>Agents 与 Connectors</span>
          <button type="button" onClick={() => setInspectorOpen(false)} aria-label="关闭 Agents 与 Connectors"><X size={16} strokeWidth={2} /></button>
        </div>
        <AgentRolesPanel
          activeAgent={activeAgent}
          recordingAgent={recordingAgent}
        />
        <ConnectorsPanel
          plugins={plugins}
          agentName={activeAgent?.name ?? "当前 Agent"}
          configuring={configurePlugin.isPending}
          onManage={runConfigurePlugin}
        />
      </aside>}
      {connectorGuide && (
        <ConnectorGuideModal
          guide={connectorGuide}
          detecting={detectAgents.isFetching || overview.isFetching}
          onDetect={() => void runDetectAgents()}
          onClose={() => setConnectorGuide(null)}
        />
      )}
    </div>
  );
}

function VoiceInputPanel() {
  return (
    <section className="agent-panel agent-voice-input-panel">
      <div className="agent-panel-head">
        <span>语音输入</span>
        <Link to="/voice-input" className="agent-link-btn">打开</Link>
      </div>
      <div className="agent-voice-input-copy">
        <div>
          <Keyboard size={14} strokeWidth={1.9} />
          <span>听写</span>
        </div>
        <div>
          <Languages size={14} strokeWidth={1.9} />
          <span>翻译</span>
        </div>
        <div>
          <Bot size={14} strokeWidth={1.9} />
          <span>问 Agent</span>
        </div>
      </div>
      <div className="agent-voice-input-actions">
        <Link to="/settings/voice" className="agent-action secondary compact">配置快捷键</Link>
      </div>
    </section>
  );
}

interface TaskRailProps {
  tasks: AgentTask[];
  agentTasks: ReadonlyMap<string, DurableAgentTask>;
  isLoading: boolean;
  actionPending: boolean;
  shareTargets: MeetingShareTarget[];
  sharingStem: string | null;
  onToggleRecording: () => void;
  onOpenAll: () => void;
  onOpenTask: (task: AgentTask) => void;
  onShare: (task: AgentTask, target: MeetingShareTarget) => void;
}

function TaskRail({
  tasks,
  agentTasks,
  isLoading,
  actionPending,
  shareTargets,
  sharingStem,
  onToggleRecording,
  onOpenAll,
  onOpenTask,
  onShare,
}: TaskRailProps) {
  return (
    <>
      <div className="agent-rail-head">
        <div>
          <div className="agent-rail-title">最近三天</div>
          <div className="agent-rail-sub">{isLoading ? "同步中" : `${tasks.length} 个会议`}</div>
        </div>
        <button type="button" className="agent-link-btn" onClick={onOpenAll}>全部</button>
      </div>
      <div className="agent-task-list">
        {tasks.length === 0 && !isLoading && (
          <div className="agent-empty">最近三天没有待处理会议。</div>
        )}
        {tasks.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            disabled={actionPending}
            agentTask={agentTasks.get(task.stem)}
            onOpen={() => onOpenTask(task)}
            onStopRecording={onToggleRecording}
            shareTargets={shareTargets}
            sharePending={sharingStem === task.stem}
            onShare={(target) => onShare(task, target)}
          />
        ))}
      </div>
    </>
  );
}

function TaskCard({
  task,
  disabled,
  agentTask,
  onOpen,
  onStopRecording,
  shareTargets,
  sharePending,
  onShare,
}: {
  task: AgentTask;
  disabled: boolean;
  agentTask?: DurableAgentTask;
  onOpen: () => void;
  onStopRecording: () => void;
  shareTargets: MeetingShareTarget[];
  sharePending: boolean;
  onShare: (target: MeetingShareTarget) => void;
}) {
  const failed = agentTask?.state === "delivery_unverified";
  const error = agentTask?.error || (Object.values(task.stages).includes("failed") ? task.error : "");
  return (
    <div className={"agent-task-card" + (failed ? " failed" : "")}>
      <div className="agent-task-head">
        <button type="button" className="agent-task-title" onClick={onOpen}>{task.title}</button>
      </div>
      <div className="agent-task-meta">{dayLabelText(task.dayLabel)} · {formatTime(task.recordedAt)}</div>
      {error && (
        <div className="agent-task-error">
          <AlertCircle size={13} strokeWidth={2} />
          <span>{error}</span>
        </div>
      )}
      <TaskAction
        task={task}
        agentTask={agentTask}
        disabled={disabled}
        onOpen={onOpen}
        onStopRecording={onStopRecording}
        shareTargets={shareTargets}
        sharePending={sharePending}
        onShare={onShare}
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
  agentTask,
  disabled,
  onOpen,
  onStopRecording,
  shareTargets,
  sharePending,
  onShare,
}: {
  task: AgentTask;
  agentTask?: DurableAgentTask;
  disabled: boolean;
  onOpen: () => void;
  onStopRecording: () => void;
  shareTargets: MeetingShareTarget[];
  sharePending: boolean;
  onShare: (target: MeetingShareTarget) => void;
}) {
  const [shareOpen, setShareOpen] = useState(false);
  if (task.stages.record === "running") {
    return (
      <RecordingBar startedAt={task.recordedAt} disabled={disabled} onStop={onStopRecording} />
    );
  }
  if (agentTask && isActiveDurableTask(agentTask)) {
    return <RunningState label={durableTaskLabel(agentTask)} />;
  }
  if (!agentTask && task.stages.transcribe === "running") return <RunningState label="Yulu 转写中" />;
  if (!agentTask && task.stages.summarize === "running") return <RunningState label="摘要 Agent 工作中" />;
  if (!agentTask && task.stages.send === "running") return <RunningState label="正在发送到 Notion" />;
  const nextAction = nextMeetingAction(task);
  if (nextAction === "share") {
    return (
      <div className="agent-task-share">
        <button
          type="button"
          className="agent-action primary"
          disabled={disabled || sharePending}
          aria-expanded={shareOpen}
          onClick={() => setShareOpen((open) => !open)}
        >
          {sharePending ? <Loader2 className="spin" size={14} strokeWidth={2} /> : <Share2 size={14} strokeWidth={2} />}
          {sharePending ? "分享中" : "分享"}
          {!sharePending && <ChevronDown size={13} strokeWidth={2} />}
        </button>
        {shareOpen && !sharePending && (
          <div className="agent-task-share-menu" role="menu" aria-label="选择分享渠道">
            {shareTargets.map((target) => (
              <button key={target.channel} type="button" role="menuitem" onClick={() => {
                setShareOpen(false);
                onShare(target);
              }}>
                <span>分享到 {target.label}</span>
                <small>{target.destination}</small>
              </button>
            ))}
            <button type="button" role="menuitem" onClick={onOpen}>
              <span>更多分享渠道…</span>
              <small>由当前 Agent 支持的渠道决定</small>
            </button>
          </div>
        )}
      </div>
    );
  }
  const actionLabel = nextAction === "transcribe" ? "转录" : "总结";
  return (
    <div className="agent-task-actions">
      <button type="button" className="agent-action primary" disabled={disabled} onClick={onOpen}>
        {nextAction === "transcribe" ? <FileText size={14} strokeWidth={2} /> : <Sparkles size={14} strokeWidth={2} />}
        {actionLabel}
      </button>
    </div>
  );
}

function isActiveDurableTask(task: DurableAgentTask): boolean {
  if (task.state === "awaiting_policy" && task.trigger === "automatic") return false;
  return ["queued", "awaiting_agent", "awaiting_policy", "running", "transcript_committed", "artifacts_committed", "sending", "delivery_reported", "delivery_unverified"].includes(task.state);
}

function durableTaskLabel(task: DurableAgentTask): string {
  if (task.state === "queued") return "已排队等待处理";
  if (task.state === "awaiting_agent") return "等待摘要 Agent";
  if (task.state === "awaiting_policy") return "Agent 自动处理已暂停";
  if (task.state === "transcript_committed") return "转写已保存，等待摘要 Agent";
  if (task.state === "failed") return "处理失败";
  if (task.state === "delivery_unverified") return "请核实 Notion 发送结果";
  if (task.state === "cancelled") return "任务已取消";
  if (task.state === "completed") return task.sendToNotion ? "已发送到 Notion" : "已处理";
  if (task.phase === "transcribing") return "Yulu 转写中";
  if (task.phase === "summarizing") return "摘要 Agent 工作中";
  if (task.sendToNotion && (task.state === "sending" || task.state === "delivery_reported")) return "正在发送到 Notion";
  return "处理中";
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

function displayedLocalSources(message: ChatMessage, provider?: string): AskSource[] {
  if (!message.sources || message.sources.length === 0) return [];
  if (provider === "xai") return message.sources;
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

function AskMeetings({
  agentId,
  agentName,
  initialSessionId,
  floating,
  taskRail,
}: {
  agentId: string;
  agentName: string;
  initialSessionId: string | null;
  floating: boolean;
  taskRail: TaskRailProps | null;
}) {
  const navigate = useNavigate();
  const t = useT();
  const utils = trpc.useUtils();
  const ask = trpc.ask.ask.useMutation();
  const createSession = trpc.agentSessions.create.useMutation();
  const appendSession = trpc.agentSessions.append.useMutation();
  const renameSession = trpc.agentSessions.rename.useMutation();
  const deleteSession = trpc.agentSessions.delete.useMutation();
  const pinSession = trpc.agentSessions.pin.useMutation();
  const archiveSession = trpc.agentSessions.archive.useMutation();
  const sessionsQuery = trpc.agentSessions.list.useQuery();
  const configQuery = trpc.config.get.useQuery();
  const [input, setInput] = useState("");
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [draftSession, setDraftSession] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionStatusOverride, setSessionStatusOverride] = useState<"active" | "paused" | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sessionQuery = trpc.agentSessions.get.useQuery(
    { id: selectedSessionId ?? "__none__" },
    { enabled: selectedSessionId !== null, refetchInterval: floating ? 1000 : false },
  );

  const sessions = (sessionsQuery.data?.sessions as AgentSessionSummary[] | undefined) ?? [];
  const selectedSession = (sessionQuery.data as AgentSession | null | undefined) ?? null;
  const selectedSessionSummary = selectedSessionId ? sessions.find((session) => session.id === selectedSessionId) : null;
  const configuredConversation = asConfigRecord(
    asConfigRecord(configQuery.data?.intelligence).conversation,
  );
  const draftXai = draftSession && configuredConversation.provider === "xai";
  const provider = selectedSession?.provider ?? selectedSessionSummary?.provider ?? (draftXai ? "xai" : undefined);
  const model = selectedSession?.model ?? selectedSessionSummary?.model
    ?? (draftXai && typeof configuredConversation.model === "string" ? configuredConversation.model : undefined);
  const sessionStatus = sessionStatusOverride ?? selectedSession?.status ?? selectedSessionSummary?.status ?? "active";
  const pausedReason = selectedSession?.pausedReason ?? selectedSessionSummary?.pausedReason;
  const identity = provider && model ? `${provider === "xai" ? "xAI" : provider} · ${model}` : null;
  const conversationName = provider === "xai"
    ? "xAI"
    : draftSession
      ? agentName
      : provider ?? selectedSession?.agent ?? selectedSessionSummary?.agent ?? agentName;
  const sessionTitle = selectedSession?.title || selectedSessionSummary?.title || (draftSession ? "新对话" : "问本地会议");
  const sessionSub = selectedSessionSummary
    ? t("agentConsole.provider.session.messages", {
        count: selectedSessionSummary.messageCount,
        time: formatSessionTime(selectedSessionSummary.updatedAt),
      })
    : draftSession
      ? t("agentConsole.provider.session.draft")
      : t("agentConsole.provider.session.default");
  const providerHeader = t(draftSession
    ? "agentConsole.provider.draftHeader"
    : "agentConsole.provider.header", {
    provider: conversationName,
    session: sessionSub,
  });

  useEffect(() => {
    if (initialSessionId) return;
    setSelectedSessionId(null);
    setMessages([]);
    setDraftSession(true);
  }, [agentId, initialSessionId]);

  useEffect(() => {
    if (!initialSessionId) return;
    setSelectedSessionId(initialSessionId);
    setDraftSession(false);
  }, [initialSessionId]);

  useEffect(() => {
    if (draftSession || selectedSessionId || sessions.length === 0) return;
    setSelectedSessionId(sessions[0]!.id);
  }, [draftSession, selectedSessionId, sessions]);

  useEffect(() => {
    if (!selectedSession || ask.isPending) return;
    setMessages(sessionMessages(selectedSession));
  }, [selectedSession, ask.isPending]);

  useEffect(() => setSessionStatusOverride(null), [selectedSessionId]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (typeof node.scrollTo === "function") {
      node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
    } else {
      node.scrollTop = node.scrollHeight;
    }
  }, [messages]);

  const runQuestion = async (sessionId: string, question: string, appendQuestion: boolean, retry = false) => {
    setMessages((prev) => [
      ...prev,
      ...(appendQuestion ? [{ role: "user" as const, text: question }] : []),
      { role: "assistant" as const, text: "", pending: true },
    ]);
    try {
      if (appendQuestion) {
        await appendSession.mutateAsync({ sessionId, message: { role: "user", text: question } });
      }
      const result = await ask.mutateAsync({
        question,
        limit: 8,
        sessionId,
        ...(retry ? { retry: true as const } : {}),
      }) as AskResponse;
      if (result.sessionStatus) setSessionStatusOverride(result.sessionStatus);
      const assistantMessage: ChatMessage = {
        role: "assistant",
        text: result.llmStatus === "empty" ? t("agentConsole.xai.empty") : result.answer,
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
      void utils.agentSessions.list.invalidate();
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
        void utils.agentSessions.list.invalidate();
        void utils.agentSessions.get.invalidate({ id: sessionId });
      }
    }
  };

  const submit = async () => {
    const question = input.trim();
    if (!question || sessionStatus === "paused" || ask.isPending || createSession.isPending || appendSession.isPending) return;
    setInput("");
    let sessionId = selectedSessionId;
    if (!sessionId) {
      const created = await createSession.mutateAsync({ title: question }) as AgentSession;
      sessionId = created.id;
      setSelectedSessionId(sessionId);
      setDraftSession(false);
    }
    await runQuestion(sessionId, question, true);
  };

  const retrySameProvider = async () => {
    if (!selectedSessionId || ask.isPending) return;
    const question = messages.slice().reverse().find((message) => message.role === "user")?.text.trim();
    if (!question) return;
    await runQuestion(selectedSessionId, question, false, true);
  };

  const startNewSession = () => {
    setDraftSession(true);
    setSelectedSessionId(null);
    setMessages([]);
    setInput("");
    setSessionStatusOverride(null);
  };

  const selectSession = (id: string) => {
    setDraftSession(false);
    setSelectedSessionId(id);
  };

  const refreshSessions = (id?: string) => {
    void utils.agentSessions.list.invalidate();
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
          taskRail={taskRail}
        />
        <div className="agent-chat-main">
          <ChatHeader title={sessionTitle} identity={identity} sub={providerHeader} />
          <div className="agent-chat-thread empty">
            <div className="agent-chat-start">
              <span className="agent-chat-start-icon"><Logo size={52} /></span>
              <div className="agent-chat-title">问本地会议</div>
              <div className="agent-chat-sub">
                {provider === "xai"
                  ? t("agentConsole.xai.localBoundary")
                  : "本地记录、Notion、Zulip 会自动进入上下文。"}
              </div>
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
            {sessionStatus === "paused" && identity && (
              <PausedConversation
                identity={identity}
                repairPath={provider === "xai"
                  ? "/agent-connections?connection=direct-xai&capability=conversation"
                  : "/agent-connections?capability=conversation"}
                reason={pausedReason}
                retrying={ask.isPending}
                onRetry={() => void retrySameProvider()}
                onNew={startNewSession}
              />
            )}
            <Composer
              value={input}
              onChange={setInput}
              onSubmit={submit}
              pending={ask.isPending || createSession.isPending || appendSession.isPending}
              disabled={sessionStatus === "paused"}
              placeholder="问会议记录、决策、行动项..."
            />
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
        taskRail={taskRail}
      />
      <div className="agent-chat-main">
        <ChatHeader title={sessionTitle} identity={identity} sub={providerHeader} />
        <div ref={scrollRef} className="agent-chat-thread">
          <div className="agent-chat-thread-inner">
            {messages.map((message, index) => {
              const localSources = displayedLocalSources(message, provider);
              return (
                <div key={index} className={`agent-chat-row ${message.role}`}>
                  {message.role === "assistant" && <span className="agent-avatar"><Bot size={15} strokeWidth={2} /></span>}
                  <div className="agent-message">
                    {message.pending ? (
                      <span className="agent-message-pending"><Loader2 className="spin" size={14} strokeWidth={2} />正在询问 {conversationName}...</span>
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
          {sessionStatus === "paused" && identity && (
            <PausedConversation
              identity={identity}
              repairPath={provider === "xai"
                ? "/agent-connections?connection=direct-xai&capability=conversation"
                : "/agent-connections?capability=conversation"}
              reason={pausedReason}
              retrying={ask.isPending}
              onRetry={() => void retrySameProvider()}
              onNew={startNewSession}
            />
          )}
          <Composer
            value={input}
            onChange={setInput}
            onSubmit={submit}
            pending={ask.isPending || createSession.isPending || appendSession.isPending}
            disabled={sessionStatus === "paused"}
            placeholder="继续提问..."
          />
        </div>
      </div>
    </section>
  );
}

function ChatHeader({ title, identity, sub }: { title: string; identity: string | null; sub: string }) {
  const t = useT();
  return (
    <div className="agent-chat-head">
      <div>
        <strong>{title}</strong>
        {identity && <span className="agent-chat-identity">{identity}</span>}
        <span>{sub}</span>
        {identity && <span>{t("agentConsole.provider.newSessionNote")}</span>}
      </div>
    </div>
  );
}

function PausedConversation({
  identity,
  repairPath,
  reason,
  retrying,
  onRetry,
  onNew,
}: {
  identity: string;
  repairPath: string;
  reason?: string;
  retrying: boolean;
  onRetry: () => void;
  onNew: () => void;
}) {
  const t = useT();
  return (
    <div className="agent-conversation-paused">
      <strong role="alert">{t("agentConsole.provider.paused.heading")}</strong>
      <span>{t("agentConsole.provider.paused.body", { identity })}</span>
      {reason && <em>{reason}</em>}
      <div>
        <button type="button" disabled={retrying} onClick={onRetry}>{t("agentConsole.provider.paused.retry")}</button>
        <Link to={repairPath}>{t("settings.providers.open")}</Link>
        <button type="button" onClick={onNew}>{t("agentConsole.provider.paused.newConversation")}</button>
      </div>
      <small>{t("agentConsole.provider.newSessionNote")}</small>
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
  taskRail,
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
  taskRail: TaskRailProps | null;
}) {
  const [query, setQuery] = useState("");
  const [historyHeight, setHistoryHeight] = usePersistedSize("yulu_ui.agent.history_height", 300);
  const renderedHistoryHeight = Math.min(600, Math.max(140, historyHeight));
  const panelRef = useRef<HTMLElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  const groups = groupedSessions(sessions, query);

  useEffect(() => () => resizeCleanupRef.current?.(), []);
  useEffect(() => {
    if (historyHeight !== renderedHistoryHeight) setHistoryHeight(renderedHistoryHeight);
  }, [historyHeight, renderedHistoryHeight, setHistoryHeight]);

  const clampHistoryHeight = (next: number) => {
    const panelHeight = panelRef.current?.getBoundingClientRect().height ?? 0;
    const max = panelHeight > 0 ? Math.min(600, Math.max(140, panelHeight - 170)) : 600;
    return Math.min(max, Math.max(140, next));
  };

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (!panel) return;
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = renderedHistoryHeight;
    const onMove = (moveEvent: PointerEvent) => {
      setHistoryHeight(clampHistoryHeight(startHeight + moveEvent.clientY - startY));
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      window.removeEventListener("blur", cleanup);
      resizeCleanupRef.current = null;
    };
    resizeCleanupRef.current?.();
    resizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
    window.addEventListener("blur", cleanup);
  };

  const resizeWithKeyboard = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowUp" ? -20 : event.key === "ArrowDown" ? 20 : 0;
    if (delta === 0 && event.key !== "Home" && event.key !== "End") return;
    event.preventDefault();
    if (event.key === "Home") setHistoryHeight(140);
    else if (event.key === "End") setHistoryHeight(clampHistoryHeight(Number.POSITIVE_INFINITY));
    else setHistoryHeight(clampHistoryHeight(renderedHistoryHeight + delta));
  };

  return (
    <aside ref={panelRef} className="agent-session-panel" aria-label="Agent 会话与最近会议">
      <div className="agent-session-pane agent-session-history" style={taskRail ? { height: renderedHistoryHeight } : undefined}>
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
      </div>
      {taskRail && (
        <>
          <div
            className="agent-session-resizer"
            role="separator"
            tabIndex={0}
            aria-label="调整历史和最近会议的高度"
            aria-orientation="horizontal"
            aria-valuemin={140}
            aria-valuemax={600}
            aria-valuenow={Math.round(renderedHistoryHeight)}
            onPointerDown={startResize}
            onKeyDown={resizeWithKeyboard}
            onDoubleClick={() => setHistoryHeight(300)}
          ><span /></div>
          <div className="agent-session-pane agent-session-recent">
            <TaskRail {...taskRail} />
          </div>
        </>
      )}
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
              <em>{source.recordedAt ? `${source.recordedAt.slice(0, 10)} · ${source.snippet}` : source.snippet}</em>
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
  disabled,
  placeholder,
  large,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  pending?: boolean;
  disabled?: boolean;
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
        disabled={disabled}
        placeholder={placeholder}
      />
      <button type="button" disabled={disabled || !value.trim() || pending} onClick={onSubmit} aria-label="发送">
        {pending ? <Loader2 className="spin" size={15} strokeWidth={2} /> : <ArrowUp size={15} strokeWidth={2} />}
      </button>
    </div>
  );
}

function RunTasks({
  agentTasks,
  scheduler,
  tasksLoading,
  schedulerLoading,
  onOpenTasks,
  onOpenScheduler,
}: {
  agentTasks: unknown;
  scheduler: unknown;
  tasksLoading: boolean;
  schedulerLoading: boolean;
  onOpenTasks: () => void;
  onOpenScheduler: () => void;
}) {
  const tasks = Array.isArray(agentTasks) ? agentTasks as DurableAgentTask[] : [];
  const schedulerRecord = asConfigRecord(scheduler);
  const events = Array.isArray(schedulerRecord.events) ? schedulerRecord.events as Array<Record<string, unknown>> : [];
  const meetings = Array.isArray(schedulerRecord.meetings) ? schedulerRecord.meetings as Array<Record<string, unknown>> : [];
  const waiting = tasks.filter((task) => ["queued", "awaiting_agent", "awaiting_policy", "transcript_committed"].includes(task.state)).length;
  const running = tasks.filter((task) => ["running", "artifacts_committed", "sending", "delivery_reported"].includes(task.state)).length;
  const failed = tasks.filter((task) => task.state === "failed" || task.state === "delivery_unverified").length;
  return (
    <section className="agent-run-panel">
      <div className="agent-run-card">
        <div className="agent-run-head">
          <div>
            <h2>Agent 任务</h2>
            <p>{tasksLoading ? "同步任务中" : `最近 ${tasks.length} 个任务`}</p>
          </div>
          <button type="button" className="agent-action secondary compact" onClick={onOpenTasks}>管理</button>
        </div>
        <div className="agent-stat-row">
          <span>等待 {waiting}</span>
          <span>运行 {running}</span>
          <span>失败 {failed}</span>
        </div>
        <div className="agent-mini-list">
          {tasks.slice(0, 4).map((task) => (
            <div key={task.id} className="agent-mini-row">
              <span>{task.title || task.recordingStem || "Agent task"}</span>
              <em>{task.state}</em>
            </div>
          ))}
          {tasks.length === 0 && <div className="agent-mini-empty">当前没有 Agent 任务。</div>}
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

function AgentRolesPanel({
  activeAgent,
  recordingAgent,
}: {
  activeAgent: ConsoleAgent | null;
  recordingAgent: RecordingAgentStatus;
}) {
  return (
    <section className="agent-panel agent-role-panel">
      <div className="agent-panel-head"><span>Agent 角色</span></div>
      <div className="agent-role-list">
        <div className="agent-role-row">
          <span className="agent-role-icon"><Bot size={17} strokeWidth={1.9} /></span>
          <span className="agent-role-copy">
            <strong>对话与手动操作</strong>
            <em>{activeAgent?.name ?? "未选择 Agent"}</em>
          </span>
          <Link className="agent-cap-action" to="/agent-connections?capability=conversation">管理 Agent 连接</Link>
        </div>
        <div className="agent-role-row">
          <span className="agent-role-icon"><Cpu size={17} strokeWidth={1.9} /></span>
          <span className="agent-role-copy">
            <strong>实时字幕、转写与听写</strong>
            <em>{audioProviderName(recordingAgent.provider)}</em>
          </span>
          <span
            className={`agent-role-state ${recordingAgent.available ? "ready" : "unavailable"}`}
            title={recordingAgent.reason ?? undefined}
          >
            <span />已选择 · {recordingAgent.available ? "可用" : "不可用"}
          </span>
        </div>
      </div>
      <p className="agent-role-note">
        实时字幕、最终转写和听写由 Yulu 使用所选音频引擎执行；摘要与 Connector 由 Agent 执行
        {!recordingAgent.available && recordingAgent.reason ? `：${recordingAgent.reason}` : ""}
      </p>
    </section>
  );
}

function ConnectorsPanel({
  plugins,
  agentName,
  configuring,
  onManage,
}: {
  plugins: AgentPluginOverview;
  agentName: string;
  configuring: boolean;
  onManage: (plugin: AgentPluginId) => void;
}) {
  const connectors = plugins.all.filter((plugin) => plugin.id !== "summary");
  return (
    <section className="agent-panel agent-connectors-panel">
      <div className="agent-connectors-head">
        <strong>当前 Agent 的 Connectors</strong>
        <span>{agentName} 管理授权，Yulu 只读取配置状态</span>
      </div>
      <div className="agent-connector-list">
        {connectors.map((plugin) => (
          <div className="agent-connector-row" key={plugin.id}>
            <span className="agent-connector-icon">{connectorIcon(plugin.id)}</span>
            <span className="agent-connector-name">{plugin.label}</span>
            <span className={`agent-connector-status ${plugin.status}`} title={plugin.detail}>
              <span />{plugin.status === "configured" ? "已配置" : plugin.status === "unsupported" ? "不可用" : "未配置"}
            </span>
            <button
              type="button"
              className="agent-cap-action"
              disabled={configuring || plugin.status === "unsupported"}
              onClick={() => onManage(plugin.id)}
            >
              {plugin.status === "configured" ? "管理" : plugin.status === "unsupported" ? "不可用" : "去配置"}
            </button>
          </div>
        ))}
        {connectors.length === 0 && <div className="agent-connector-empty">正在读取 Connector 状态…</div>}
      </div>
      <div className="agent-connector-privacy">
        <ShieldCheck size={15} strokeWidth={1.8} />
        <span>Connector 凭据保存在 Agent 内，不由 Yulu 保存。</span>
      </div>
    </section>
  );
}

function connectorIcon(id: AgentPluginId) {
  if (id === "calendar") return <Calendar size={16} strokeWidth={1.9} />;
  if (id === "notion") return <Database size={16} strokeWidth={1.9} />;
  return <Send size={16} strokeWidth={1.9} />;
}

function ConnectorGuideModal({
  guide,
  detecting,
  onDetect,
  onClose,
}: {
  guide: ConnectorGuide;
  detecting: boolean;
  onDetect: () => void;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copyCommand = async () => {
    if (!guide.manageCommand) return;
    try {
      await navigator.clipboard.writeText(guide.manageCommand);
      setCopied(true);
    } catch {
      window.prompt("复制管理命令：", guide.manageCommand);
    }
  };
  return (
    <div className="agent-modal-backdrop" onMouseDown={onClose}>
      <div className="agent-modal" onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-label={`${guide.label} Connector 管理`}>
        <div className="agent-modal-head">
          <div>
            <strong>{connectorIcon(guide.plugin)}在 {guide.agentName} 中管理 {guide.label}</strong>
            <span>{guide.message}</span>
          </div>
          <button type="button" onClick={onClose} aria-label="关闭"><X size={16} strokeWidth={2} /></button>
        </div>
        {guide.manageCommand && <code className="agent-connector-command">{guide.manageCommand}</code>}
        <div className="agent-modal-actions">
          <button type="button" className="agent-action secondary compact" onClick={() => void copyCommand()} disabled={!guide.manageCommand}>
            {copied ? <Check size={13} strokeWidth={2} /> : null}{copied ? "已复制" : "复制管理命令"}
          </button>
          <button type="button" className="agent-action primary compact" onClick={onDetect} disabled={detecting}>
            {detecting ? <Loader2 className="spin" size={13} strokeWidth={2} /> : <RefreshCw size={13} strokeWidth={2} />}
            {detecting ? "检测中" : "重新检测"}
          </button>
        </div>
      </div>
    </div>
  );
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

function LocalStatus({ agentTasks, onDetails }: { agentTasks: unknown; onDetails: () => void }) {
  const tasks = Array.isArray(agentTasks) ? agentTasks as DurableAgentTask[] : [];
  const activeTasks = tasks.filter((task) => !["completed", "failed", "cancelled", "delivery_unverified"].includes(task.state));
  return (
    <section className="agent-panel agent-local-status">
      <div className="agent-panel-head">
        <span>本地状态</span>
        <button type="button" className="agent-link-btn" onClick={onDetails}>详情</button>
      </div>
      <StatusRow icon={<ListChecks size={16} strokeWidth={1.9} />} title="Agent Tasks" sub={`${activeTasks.length} 个进行中`} state={activeTasks.length > 0 ? "running" : "idle"} />
      <StatusRow icon={<HardDrive size={16} strokeWidth={1.9} />} title="Storage" sub="本地记录目录" state="本机" />
      <StatusRow icon={<ShieldCheck size={16} strokeWidth={1.9} />} title="Privacy" sub="音频处理遵循当前 Agent 的隐私配置" state="Agent" />
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
