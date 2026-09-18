import { useEffect, useRef, useState } from "react";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router";
import { Archive, ArrowUp, Bot, FileText, History, Loader2, MessageSquare, MoreHorizontal, Pencil, Pin, Plus, Settings2, Trash2, X } from "lucide-react";
import { trpc } from "../trpc.js";
import { useWsChannel } from "../ws.js";
import { MarkdownView } from "../components/MarkdownView.js";
import { Logo } from "../components/Logo.js";
import { useT } from "../i18n/LanguageProvider.js";
import { taskActivity } from "../components/health/taskStatus.js";
import "./agent-console.css";

export const handle = { breadcrumb: "breadcrumb.agentConsole", filters: null };

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
  recovery?: ConversationRecovery;
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

interface ConversationRecovery {
  retry: "same_snapshot" | "unavailable_unknown_outcome";
  settingsPath: string;
  newConversation: boolean;
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
  connectionId?: string;
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
  connectionId?: string;
  model?: string;
  status?: "active" | "paused";
  pausedReason?: string;
  retrySnapshot?: { question: string };
  title: string;
  updatedAt: string;
  pinnedAt?: string;
  archivedAt?: string;
  messages: AgentSessionMessage[];
}

function asConfigRecord(config: unknown): Record<string, unknown> {
  return typeof config === "object" && config !== null && !Array.isArray(config) ? config as Record<string, unknown> : {};
}

export function AgentConsole() {
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const floating = location.pathname === "/voice-chat";
  const utils = trpc.useUtils();
  const tasks = trpc.agentTasks.list.useQuery({ limit: 100 }, { refetchInterval: 15_000, enabled: !floating });
  useWsChannel("jobs", () => void utils.agentTasks.list.invalidate());
  return <div className={`agent-console-page${floating ? " voice-chat-popover" : ""}`}>
    <main className="agent-console-center">
      <AskMeetings initialSessionId={searchParams.get("session")} floating={floating} activity={tasks.isError ? null : taskActivity(tasks.data ?? [])} />
    </main>
  </div>;
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
  "总结最近一次会议的决定",
  "有哪些事项还需要跟进？",
];

function AskMeetings({ initialSessionId, floating, activity }: {
  initialSessionId: string | null;
  floating: boolean;
  activity: ReturnType<typeof taskActivity> | null;
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyToggle = useRef<HTMLButtonElement>(null);
  const closeHistory = () => { setHistoryOpen(false); historyToggle.current?.focus(); };
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [draftSession, setDraftSession] = useState(true);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionStatusOverride, setSessionStatusOverride] = useState<"active" | "paused" | null>(null);
  const [recoveryOverride, setRecoveryOverride] = useState<ConversationRecovery | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
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
  const draftConnectionId = draftXai
    ? "direct-xai"
    : draftSession && typeof configuredConversation.connectionId === "string"
      ? configuredConversation.connectionId
      : undefined;
  const draftProvider = draftXai ? "xai" : draftConnectionId;
  const provider = selectedSession?.provider ?? selectedSessionSummary?.provider ?? draftProvider;
  const model = selectedSession?.model ?? selectedSessionSummary?.model
    ?? (draftSession && typeof configuredConversation.model === "string" ? configuredConversation.model : undefined);
  const sessionStatus = sessionStatusOverride ?? selectedSession?.status ?? selectedSessionSummary?.status ?? "active";
  const pausedReason = selectedSession?.pausedReason ?? selectedSessionSummary?.pausedReason;
  const connectionId = selectedSession?.connectionId ?? selectedSessionSummary?.connectionId ?? draftConnectionId;
  const defaultRepairPath = connectionId
    ? `/settings/llm?connection=${encodeURIComponent(connectionId)}&capability=conversation`
    : provider === "xai"
      ? "/settings/llm?connection=direct-xai&capability=conversation"
      : "/settings/llm?capability=conversation";
  const conversationRecovery = recoveryOverride ?? (sessionStatus === "paused" ? {
    retry: selectedSession?.retrySnapshot ? "same_snapshot" as const : "unavailable_unknown_outcome" as const,
    settingsPath: defaultRepairPath,
    newConversation: true,
  } : null);
  const identity = provider && model ? `${provider === "xai" ? "xAI" : provider} · ${model}` : null;
  const conversationName = provider === "xai"
    ? "xAI"
    : draftSession
      ? provider ?? "Agent"
      : provider ?? selectedSession?.agent ?? selectedSessionSummary?.agent ?? "Agent";
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
  }, [initialSessionId]);

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

  useEffect(() => {
    setSessionStatusOverride(null);
    setRecoveryOverride(null);
  }, [selectedSessionId]);

  useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    if (typeof node.scrollTo === "function") {
      node.scrollTo({
        top: node.scrollHeight,
        behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth",
      });
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
      setRecoveryOverride(result.recovery ?? null);
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
    setCreateError(null);
    let sessionId = selectedSessionId;
    if (!sessionId) {
      try {
        const created = await createSession.mutateAsync({ title: question }) as AgentSession;
        sessionId = created.id;
        setSelectedSessionId(sessionId);
        setDraftSession(false);
      } catch (error) {
        setInput(question);
        setCreateError(error instanceof Error ? error.message : String(error));
        return;
      }
    }
    await runQuestion(sessionId, question, true);
  };

  const retrySameProvider = async () => {
    if (!selectedSessionId || ask.isPending || conversationRecovery?.retry !== "same_snapshot") return;
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
    setRecoveryOverride(null);
    setCreateError(null);
    closeHistory();
  };

  const selectSession = (id: string) => {
    setDraftSession(false);
    setSelectedSessionId(id);
    closeHistory();
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

  return <section className="agent-chat-workspace">
    <header className="assistant-toolbar">
      <button ref={historyToggle} type="button" className="assistant-tool" aria-label={t("assistant.history")} aria-expanded={historyOpen} aria-controls="assistant-history" onClick={() => setHistoryOpen(!historyOpen)}><History size={17} /></button>
      <div className="assistant-heading"><strong>{sessionTitle}</strong><Link to={defaultRepairPath} title={providerHeader + " · " + t("agentConsole.provider.newSessionNote")}>{identity ?? conversationName}<Settings2 size={12} /></Link></div>
      {!floating && activity && (activity.active > 0 || activity.attention > 0) && <Link className="assistant-activity" to="/health#queue">{activity.attention > 0 ? t("assistant.activity.attention", { n: activity.attention }) : t("assistant.activity.active", { n: activity.active })}</Link>}
      <button type="button" className="assistant-tool" onClick={startNewSession} aria-label={t("assistant.new")} title={t("assistant.new")}><Plus size={18} /></button>
    </header>
    <div className={`agent-chat${historyOpen ? " history-open" : ""}`}>
      {historyOpen && <AgentSessionPanel sessions={sessions} selectedSessionId={selectedSessionId} loading={sessionsQuery.isPending}
        onSelect={selectSession} onNew={startNewSession} onRename={renameSelectedSession} onDelete={deleteSelectedSession}
        onArchive={archiveSelectedSession} onPin={pinSelectedSession} onClose={closeHistory} />}
      <div className="agent-chat-main">
        <div ref={scrollRef} className={`agent-chat-thread${messages.length === 0 ? " empty" : ""}`}>
          {messages.length === 0 ? <div className="agent-chat-start">
            <Logo size={48} />
            <div className="agent-chat-title">{t("assistant.title")}</div>
            <div className="agent-chat-sub">{t("assistant.intro")}</div>
            <div className="agent-chat-starters">{ASK_STARTERS.map((starter) => <button key={starter} type="button" onClick={() => setInput(starter)}>{starter}</button>)}</div>
          </div> : <div className="agent-chat-thread-inner">
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

          </div>}
        </div>
        <div className="agent-chat-composer">
          {draftSession && createError && <NewConversationFailure identity={identity ?? conversationName} reason={createError} repairPath={defaultRepairPath} retrying={createSession.isPending} onRetry={() => void submit()} />}
          {sessionStatus === "paused" && <PausedConversation identity={identity ?? conversationName} repairPath={conversationRecovery?.settingsPath ?? defaultRepairPath} reason={pausedReason} retryAvailable={conversationRecovery?.retry === "same_snapshot"} retrying={ask.isPending} onRetry={() => void retrySameProvider()} onNew={startNewSession} />}
          <div className="assistant-composer-tools">
            <MeetingReference onChoose={(title, recordedAt) => setInput((value) => `${value}${value ? "\n" : ""}关于会议「${title}」（${recordedAt.slice(0, 16).replace("T", " ")}）：`)} disabled={sessionStatus === "paused" || ask.isPending} />
            <span title={provider === "xai" ? t("agentConsole.xai.localBoundary") : t("assistant.agentScope.detail")}>{t(provider === "xai" ? "assistant.localScope" : "assistant.agentScope")}</span>
          </div>
          <Composer value={input} onChange={setInput} onSubmit={submit} pending={ask.isPending || createSession.isPending || appendSession.isPending} disabled={sessionStatus === "paused"} placeholder={messages.length ? "继续提问..." : "问会议记录、决策、行动项..."} />
        </div>
      </div>
    </div>
  </section>;
}

function MeetingReference({ onChoose, disabled }: { onChoose: (title: string, recordedAt: string) => void; disabled: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const overview = trpc.agentConsole.meetings.useQuery(undefined, { enabled: open, staleTime: 15_000 });
  useEffect(() => { if (open) panel.current?.querySelector("input")?.focus(); }, [open]);
  const close = () => { setOpen(false); button.current?.focus(); };
  const meetings = (overview.data ?? []).filter((task) => task.stem && task.hasTranscript && task.title.toLowerCase().includes(query.toLowerCase()));
  return <div className="assistant-reference" onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
    <button ref={button} type="button" disabled={disabled} className="assistant-reference-toggle" aria-expanded={open} aria-controls="assistant-meetings" onClick={() => setOpen(!open)}><FileText size={14} />{t("assistant.reference")}</button>
    {open && <div ref={panel} id="assistant-meetings" className="assistant-meeting-picker" role="region" aria-label={t("assistant.reference")}>
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("assistant.reference.search")} aria-label={t("assistant.reference.search")} />
      <p>{t("assistant.reference.hint")}</p>
      <div className="assistant-meeting-list">
        {meetings.map((meeting) => <button type="button" key={meeting.stem} onClick={() => { onChoose(meeting.title, meeting.recordedAt); close(); }}><strong>{meeting.title}</strong><span>{meeting.recordedAt.slice(0, 10)}</span></button>)}
        {meetings.length === 0 && <p role="status">{t(overview.isPending ? "common.loading" : overview.isError ? "assistant.reference.error" : "assistant.reference.empty")}</p>}
      </div>
      <Link to="/inbox">{t("assistant.recordings")}</Link>
    </div>}
  </div>;
}

function PausedConversation({
  identity,
  repairPath,
  reason,
  retryAvailable,
  retrying,
  onRetry,
  onNew,
}: {
  identity: string;
  repairPath: string;
  reason?: string;
  retryAvailable: boolean;
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
        {retryAvailable && <button type="button" disabled={retrying} onClick={onRetry}>{t("agentConsole.provider.paused.retry")}</button>}
        <Link to={repairPath}>{t("settings.providers.open")}</Link>
        <button type="button" onClick={onNew}>{t("agentConsole.provider.paused.newConversation")}</button>
      </div>
      <small>{t("agentConsole.provider.newSessionNote")}</small>
    </div>
  );
}

function NewConversationFailure({
  identity,
  reason,
  repairPath,
  retrying,
  onRetry,
}: {
  identity: string;
  reason: string;
  repairPath: string;
  retrying: boolean;
  onRetry: () => void;
}) {
  const t = useT();
  return (
    <div className="agent-conversation-paused">
      <strong role="alert">{t("agentConsole.provider.createFailed.heading")}</strong>
      <span>{t("agentConsole.provider.createFailed.body", { identity })}</span>
      <em>{reason}</em>
      <div>
        <button type="button" disabled={retrying} onClick={onRetry}>
          {t("agentConsole.provider.createFailed.retry")}
        </button>
        <Link to={repairPath}>{t("settings.providers.open")}</Link>
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
  onClose,
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
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const panelRef = useRef<HTMLElement>(null);
  const groups = groupedSessions(sessions, query);
  useEffect(() => { panelRef.current?.querySelector("input")?.focus(); }, []);
  return (
    <aside ref={panelRef} id="assistant-history" className="agent-session-panel" aria-label="对话历史" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }}>
      <div className="agent-session-pane agent-session-history">
        <div className="agent-session-panel-head">
          <span>历史</span>
          <button type="button" className="assistant-tool" onClick={onClose} aria-label="收起对话历史"><X size={16} /></button>
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
          if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
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
