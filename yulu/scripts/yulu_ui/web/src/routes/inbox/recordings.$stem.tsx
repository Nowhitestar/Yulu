// web/src/routes/inbox/recordings.$stem.tsx
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { Check, ChevronLeft, Code, Copy, FileText, RefreshCw, Sparkles, Pencil, Trash2, Users, GitMerge } from "lucide-react";
import { trpc } from "../../trpc.js";
import { AudioPlayer } from "../../components/AudioPlayer.js";
import { TranscriptView, type SpeakerData } from "../../components/TranscriptView.js";
import { MarkdownView } from "../../components/MarkdownView.js";
import { TagEditor } from "../../components/TagEditor.js";
import { EmptyState } from "../../components/EmptyState.js";
import { ReprocessButton, type ReprocessButtonState } from "../../components/ReprocessButton.js";
import { RecordingStatusBadge } from "../../components/RecordingStatusBadge.js";
import { SharePopover, type ShareHistoryEntry, type ShareTarget } from "../../components/SharePopover.js";
import { useConfirm } from "../../hooks/useConfirm.js";
import { useT } from "../../i18n/LanguageProvider.js";
import { useWsChannel } from "../../ws.js";
import "./recordings.reader.css";

const GET_KEY = [["recordings", "get"]] as const;
const LIST_KEY = [["recordings", "list"]] as const;
const SPEAKER_COLORS = [
  "var(--blue)",
  "var(--green)",
  "var(--purple)",
  "var(--accent)",
  "var(--red)",
  "#5CCFE6",
];
const AUDIO_MOUNT_DELAY_MS = 250;

export const handle = {
  breadcrumb: "breadcrumb.reader",
  filters: null,
};

type Tab = "transcript" | "summary" | "raw";
type ManualAction = "transcribe" | "summarize" | "share";
type AgentTaskState =
  | "queued"
  | "awaiting_agent"
  | "awaiting_policy"
  | "running"
  | "artifacts_committed"
  | "sending"
  | "delivery_reported"
  | "delivery_unverified"
  | "completed"
  | "failed"
  | "cancelled";

interface AgentTaskView {
  id: string;
  state: AgentTaskState;
  phase: string;
  trigger: "automatic" | "manual";
  sendToNotion: boolean;
  error: string | null;
}

interface NotionDeliveryView {
  status: "sending" | "reported" | "abandoned";
  url: string | null;
  detail: string | null;
}

interface SummaryTemplateOption {
  id: string;
  slug: string;
  name: string;
  isAutoRun: boolean;
}

const ACTIVE_AGENT_TASK_STATES = new Set<AgentTaskState>([
  "queued",
  "awaiting_agent",
  "awaiting_policy",
  "running",
  "artifacts_committed",
  "sending",
  "delivery_reported",
]);

function allowsManualPolicyOverride(task: AgentTaskView | null | undefined): boolean {
  return task?.state === "awaiting_policy" && task.trigger === "automatic";
}

function AgentTaskStatus({
  task,
  delivery,
}: {
  task?: AgentTaskView | null;
  delivery?: NotionDeliveryView | null;
}) {
  const t = useT();
  if (!task || !ACTIVE_AGENT_TASK_STATES.has(task.state)) return null;

  let key = "reader.agentTask.processing";
  if (task.state === "queued") key = "reader.agentTask.queued";
  else if (task.state === "awaiting_agent") key = "reader.agentTask.awaiting";
  else if (task.state === "awaiting_policy") key = "reader.agentTask.awaitingPolicy";
  else if (task.state === "delivery_unverified") key = "reader.agentTask.deliveryUnverified";
  else if (task.phase === "transcribing") key = "reader.agentTask.transcribing";
  else if (task.phase === "summarizing") key = "reader.agentTask.summarizing";
  else if (task.sendToNotion && (task.state === "sending" || task.state === "delivery_reported")) key = "reader.agentTask.sendingNotion";

  const content = t(key);
  const failed = task.state === "delivery_unverified";
  return (
    <span
      className={`reader-agent-task-status${failed ? " failed" : ""}`}
      data-testid="agent-task-status"
      data-state={task.state}
      title={task.error || delivery?.detail || undefined}
    >
      {content}
    </span>
  );
}
interface SummaryPromptRow {
  id: string;
  slug: string;
  name: string;
  is_auto_run?: number;
}
function mergeSummaryTemplateOptions(
  recordingOptions: SummaryTemplateOption[],
  promptRows: SummaryPromptRow[] | undefined,
): SummaryTemplateOption[] {
  const options = [...recordingOptions];
  const seen = new Set(options.map((option) => option.id));
  for (const prompt of promptRows ?? []) {
    if (!prompt.id || seen.has(prompt.id)) continue;
    seen.add(prompt.id);
    options.push({
      id: prompt.id,
      slug: prompt.slug,
      name: prompt.name,
      isAutoRun: Number(prompt.is_auto_run ?? 0) === 1,
    });
  }
  return options;
}

function defaultSummaryTemplateIdFor(
  options: SummaryTemplateOption[],
  configuredDefault: unknown,
): string {
  const configured = typeof configuredDefault === "string" ? configuredDefault : "";
  if (configured && options.some((option) => option.id === configured)) return configured;
  return options.find((option) => option.slug === "summary")?.id ?? options[0]?.id ?? "";
}

function isTab(v: string | null): v is Tab {
  return v === "transcript" || v === "summary" || v === "raw";
}

function audioSrcFor(data: { stem: string; audioFile?: string | null; audioMtimeMs?: number | null }): string {
  const audioVersion = typeof data.audioMtimeMs === "number" ? `?v=${Math.trunc(data.audioMtimeMs)}` : "";
  return `/files/meetings/${data.audioFile ?? `${data.stem}.wav`}${audioVersion}`;
}

interface SpeakerRow {
  id: string;
  name: string;
  count: number;
  color: string;
}

function SpeakerPanel({
  speakerData,
  onRename,
  onMerge,
}: {
  speakerData?: SpeakerData | null;
  onRename: (speakerId: string, displayName: string) => void;
  onMerge: (fromSpeakerId: string, toSpeakerId: string) => void;
}) {
  const t = useT();
  const rows = speakerRows(speakerData);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [mergeTargets, setMergeTargets] = useState<Record<string, string>>({});

  useEffect(() => {
    const next: Record<string, string> = {};
    for (const row of rows) next[row.id] = row.name;
    setDrafts(next);
  }, [speakerData]);

  if (!speakerData || rows.length === 0) return null;

  const lowConfidenceCount = (speakerData.segments ?? []).filter((seg) => seg.confident === false).length;
  const provider = typeof (speakerData as { provider?: unknown }).provider === "string"
    ? String((speakerData as { provider?: string }).provider)
    : "diarization";
  const detected = typeof (speakerData as { num_speakers_detected?: unknown }).num_speakers_detected === "number"
    ? Number((speakerData as { num_speakers_detected?: number }).num_speakers_detected)
    : rows.length;

  const commitName = (row: SpeakerRow) => {
    const next = (drafts[row.id] ?? row.name).trim();
    if (!next || next === row.name) {
      setDrafts((prev) => ({ ...prev, [row.id]: row.name }));
      return;
    }
    onRename(row.id, next);
  };

  return (
    <div className="speaker-panel">
      <div className="speaker-panel-head">
        <div className="speaker-panel-title">
          <Users size={14} strokeWidth={1.75} />
          <span>{t("reader.speakers.heading")}</span>
        </div>
        <div className="speaker-panel-meta">
          <span>{t("reader.speakers.meta", { provider, n: detected })}</span>
          {lowConfidenceCount > 0 && (
            <span>{t("reader.speakers.lowConfidence", { n: lowConfidenceCount })}</span>
          )}
        </div>
      </div>
      <div className="speaker-panel-list">
        {rows.map((row) => {
          const targetRows = rows.filter((candidate) => candidate.id !== row.id);
          const savedTarget = mergeTargets[row.id];
          const mergeTarget = targetRows.some((candidate) => candidate.id === savedTarget)
            ? savedTarget!
            : targetRows[0]?.id ?? "";
          return (
            <div
              key={row.id}
              className="speaker-row"
              style={{ "--speaker-color": row.color } as CSSProperties}
            >
              <span className="speaker-row-swatch" />
              <input
                className="speaker-row-name"
                value={drafts[row.id] ?? row.name}
                aria-label={t("reader.speakers.name.aria", { name: row.name })}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [row.id]: e.target.value }))}
                onBlur={() => commitName(row)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") e.currentTarget.blur();
                  if (e.key === "Escape") {
                    setDrafts((prev) => ({ ...prev, [row.id]: row.name }));
                    e.currentTarget.blur();
                  }
                }}
              />
              <span className="speaker-row-count">{t("reader.speakers.count", { n: row.count })}</span>
              {rows.length > 1 && (
                <div className="speaker-row-merge">
                  <select
                    value={mergeTarget}
                    aria-label={t("reader.speakers.mergeTarget.aria", { name: row.name })}
                    onChange={(e) => setMergeTargets((prev) => ({ ...prev, [row.id]: e.target.value }))}
                  >
                    {targetRows.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>{candidate.name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="speaker-row-merge-btn"
                    disabled={!mergeTarget}
                    onClick={() => onMerge(row.id, mergeTarget)}
                    aria-label={t("reader.speakers.merge.aria", { from: row.name })}
                    title={t("reader.speakers.merge.aria", { from: row.name })}
                  >
                    <GitMerge size={13} strokeWidth={1.75} />
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function speakerRows(speakerData?: SpeakerData | null): SpeakerRow[] {
  if (!speakerData) return [];
  const counts = new Map<string, number>();
  for (const seg of speakerData.segments ?? []) {
    const id = resolveSpeakerId(speakerData, seg.speaker_id || "unknown");
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }
  const ids = new Set<string>(Object.keys(speakerData.speakers ?? {}).map((id) => resolveSpeakerId(speakerData, id)));
  for (const id of counts.keys()) ids.add(id);
  return [...ids]
    .sort((a, b) => a.localeCompare(b))
    .filter((id) => id && !(speakerData.speakers?.[id]?.merged_into))
    .map((id, index) => ({
      id,
      name: speakerDisplayName(speakerData, id),
      count: counts.get(id) ?? 0,
      color: SPEAKER_COLORS[index % SPEAKER_COLORS.length]!,
    }))
    .filter((row) => row.count > 0);
}

function resolveSpeakerId(speakerData: SpeakerData, speakerId: string): string {
  let cur = speakerId;
  const seen = new Set<string>();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const next = speakerData.speakers?.[cur]?.merged_into;
    if (!next) break;
    cur = next;
  }
  return cur;
}

function speakerDisplayName(speakerData: SpeakerData, speakerId: string): string {
  const resolved = resolveSpeakerId(speakerData, speakerId);
  const name = speakerData.speakers?.[resolved]?.display_name;
  if (name && name.trim()) return name;
  if (resolved === "unknown") return "Unknown";
  const m = resolved.match(/^spk-(\d+)$/);
  if (m?.[1]) return `Speaker ${Number(m[1]) + 1}`;
  return resolved;
}

export function RecordingReader() {
  const { stem = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const t = useT();
  const { data, error, isPending } = trpc.recordings.get.useQuery({ stem }, { enabled: stem.length > 0 });
  const { data: summaryPrompts } = trpc.prompts.list.useQuery({ category: "summary" });

  const qc = useQueryClient();
  const [completedAction, setCompletedAction] = useState<ManualAction | null>(null);
  const [actionError, setActionError] = useState<{ action: ManualAction; message: string } | null>(null);
  const [pendingShareChannel, setPendingShareChannel] = useState<string | null>(null);
  const [summaryTemplateId, setSummaryTemplateId] = useState("");
  const targetAudioSrc = data ? audioSrcFor(data) : null;

  useEffect(() => {
    setCompletedAction(null);
    setActionError(null);
    setPendingShareChannel(null);
  }, [stem]);
  const [mountedAudioSrc, setMountedAudioSrc] = useState<string | null>(null);
  const [copiedSummary, setCopiedSummary] = useState(false);
  const copyResetRef = useRef<number | null>(null);

  const transcribeMut = trpc.recordings.transcribe.useMutation();
  const summarizeMut = trpc.recordings.summarize.useMutation();
  const sendSummaryMut = trpc.recordings.sendSummary.useMutation();
  const renameMut = trpc.recordings.rename.useMutation();
  const setTagsMut = trpc.recordings.setTags.useMutation();
  const deleteMut = trpc.recordings.delete.useMutation();
  const confirmDeliveryMut = trpc.agentTasks.confirmNotionDelivery.useMutation();
  const abandonDeliveryMut = trpc.agentTasks.abandonNotionDelivery.useMutation();
  const renameSpeakerMut = trpc.recordings.renameSpeaker.useMutation();
  const mergeSpeakersMut = trpc.recordings.mergeSpeakers.useMutation();
  const assignSegmentSpeakerMut = trpc.recordings.assignSegmentSpeaker.useMutation();

  // Optimistically patch the cached `get` result for this stem so the UI
  // reflects the edit immediately; invalidate on settle to reconcile with disk.
  const patchGet = (partial: Record<string, unknown>) => {
    qc.setQueryData?.([["recordings", "get"], { input: { stem }, type: "query" }], (prev: unknown) =>
      prev && typeof prev === "object" ? { ...(prev as object), ...partial } : prev,
    );
  };
  const invalidateBoth = () => {
    qc.invalidateQueries({ queryKey: GET_KEY });
    qc.invalidateQueries({ queryKey: LIST_KEY });
  };

  // ---- Rename (inline title edit) ----
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const titleInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editingTitle) titleInputRef.current?.select(); }, [editingTitle]);

  const startRename = () => {
    setTitleDraft(data?.title ?? "");
    setEditingTitle(true);
  };
  const commitRename = () => {
    setEditingTitle(false);
    const next = titleDraft.trim();
    if (next === (data?.title ?? "")) return;
    patchGet({ title: next || data?.title || null });
    renameMut.mutate({ stem, title: next }, {
      onError: (err) => console.error("rename failed:", err.message),
      onSettled: invalidateBoth,
    });
  };

  const handleTagsChange = (tags: string[]) => {
    patchGet({ tags });
    setTagsMut.mutate({ stem, tags }, {
      onError: (err) => console.error("setTags failed:", err.message),
      onSettled: invalidateBoth,
    });
  };

  const handleRenameSpeaker = (speakerId: string, displayName: string) => {
    renameSpeakerMut.mutate({ stem, speakerId, displayName }, {
      onSuccess: (res) => patchGet({ speakerData: res.speakerData }),
      onError: (err) => console.error("renameSpeaker failed:", err.message),
      onSettled: invalidateBoth,
    });
  };

  const handleMergeSpeakers = (fromSpeakerId: string, toSpeakerId: string) => {
    mergeSpeakersMut.mutate({ stem, fromSpeakerId, toSpeakerId }, {
      onSuccess: (res) => patchGet({ speakerData: res.speakerData }),
      onError: (err) => console.error("mergeSpeakers failed:", err.message),
      onSettled: invalidateBoth,
    });
  };

  const handleAssignSegmentSpeaker = (segmentIndex: number, speakerId: string) => {
    assignSegmentSpeakerMut.mutate({ stem, segmentIndex, speakerId }, {
      onSuccess: (res) => patchGet({ speakerData: res.speakerData }),
      onError: (err) => console.error("assignSegmentSpeaker failed:", err.message),
      onSettled: invalidateBoth,
    });
  };

  const handleDelete = () => {
    const task = data?.agentTask as AgentTaskView | null | undefined;
    if (task && (ACTIVE_AGENT_TASK_STATES.has(task.state) || task.state === "delivery_unverified")) return;
    const label = data?.title ?? stem;
    if (!confirm(t("reader.delete.confirm", { label }))) return;
    deleteMut.mutate({ stem }, {
      onError: (err) => console.error("delete failed:", err.message),
      onSuccess: () => {
        qc.invalidateQueries({ queryKey: LIST_KEY });
        navigate("/inbox", { replace: true });
      },
    });
  };

  useWsChannel("jobs", (msg) => {
    if (msg.stem !== stem) return;
    qc.invalidateQueries({ queryKey: [["recordings", "get"]] });
    qc.invalidateQueries({ queryKey: [["recordings", "list"]] });
  });

  useEffect(() => {
    setMountedAudioSrc(null);
    if (!targetAudioSrc) return;
    const timer = window.setTimeout(() => setMountedAudioSrc(targetAudioSrc), AUDIO_MOUNT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [targetAudioSrc]);

  useEffect(() => {
    if (!data) return;
    const templateOptions = mergeSummaryTemplateOptions(
      (data.summaryTemplateOptions ?? []) as SummaryTemplateOption[],
      summaryPrompts as SummaryPromptRow[] | undefined,
    );
    const defaultTemplateId = defaultSummaryTemplateIdFor(templateOptions, data.defaultSummaryTemplateId);
    setSummaryTemplateId((current) =>
      templateOptions.some((option) => option.id === current) ? current : defaultTemplateId
    );
  }, [data?.stem, data?.defaultSummaryTemplateId, data?.summaryTemplateOptions, summaryPrompts]);

  function deriveButtonState(action: Exclude<ManualAction, "share">): ReprocessButtonState {
    if (actionError?.action === action) return "failed";
    if (action === "transcribe" && transcribeMut.isPending) return "running";
    if (action === "summarize" && summarizeMut.isPending) return "running";
    if (completedAction === action) return "done";
    return "idle";
  }

  function buttonError(action: Exclude<ManualAction, "share">): string | undefined {
    if (actionError?.action === action) return actionError.message;
    return undefined;
  }

  const handleTranscribe = () => {
    setCompletedAction(null);
    setActionError(null);
    transcribeMut.mutate({ stem }, {
      onSuccess: () => setCompletedAction("transcribe"),
      onError: (err) => setActionError({ action: "transcribe", message: err.message }),
      onSettled: invalidateBoth,
    });
  };

  const handleSummarize = () => {
    setCompletedAction(null);
    setActionError(null);
    const templateOptions = mergeSummaryTemplateOptions(
      (data?.summaryTemplateOptions ?? []) as SummaryTemplateOption[],
      summaryPrompts as SummaryPromptRow[] | undefined,
    );
    const promptId = summaryTemplateId || defaultSummaryTemplateIdFor(templateOptions, data?.defaultSummaryTemplateId);
    summarizeMut.mutate({ stem, promptId: promptId || null }, {
      onSuccess: () => setCompletedAction("summarize"),
      onError: (err) => setActionError({ action: "summarize", message: err.message }),
      onSettled: invalidateBoth,
    });
  };

  const handleShare = (target: { channel: string; label: string; destination: string }) => {
    if (!confirm(t("reader.send.confirm", { label: target.label, destination: target.destination || t("value.unset") }))) return;
    setCompletedAction(null);
    setActionError(null);
    setPendingShareChannel(target.channel);
    sendSummaryMut.mutate({
      stem,
      channel: target.channel,
      label: target.label,
      destination: target.destination,
    }, {
      onSuccess: () => setCompletedAction("share"),
      onError: (err) => setActionError({ action: "share", message: err.message }),
      onSettled: () => {
        setPendingShareChannel(null);
        invalidateBoth();
      },
    });
  };

  const handleConfirmDelivery = () => {
    const task = data?.agentTask as AgentTaskView | null | undefined;
    const delivery = data?.notionDelivery as NotionDeliveryView | null | undefined;
    if (!task || task.state !== "delivery_unverified") return;
    const url = window.prompt(t("reader.reconciliation.confirmPrompt"), delivery?.url ?? "");
    if (url === null) return;
    confirmDeliveryMut.mutate({ id: task.id, url: url.trim() || undefined }, {
      onError: (err) => setActionError({ action: "share", message: err.message }),
      onSettled: invalidateBoth,
    });
  };

  const handleAbandonDelivery = () => {
    const task = data?.agentTask as AgentTaskView | null | undefined;
    if (!task || task.state !== "delivery_unverified") return;
    if (!confirm(t("reader.reconciliation.abandonConfirm"))) return;
    abandonDeliveryMut.mutate({ id: task.id }, {
      onError: (err) => setActionError({ action: "share", message: err.message }),
      onSettled: invalidateBoth,
    });
  };

  const handleCopySummary = async () => {
    const summary = data?.summary ?? "";
    if (!summary) return;
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(summary);
      setCopiedSummary(true);
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => {
        setCopiedSummary(false);
        copyResetRef.current = null;
      }, 1500);
    } catch {
      window.prompt(t("reader.copySummary.prompt"), summary);
    }
  };

  // Local override lets clicks switch tabs even if the router's navigation
  // is debounced (or rejected in jsdom test environment). URL is still
  // updated via setSearchParams for shareable deep links.
  const [override, setOverride] = useState<Tab | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => {
    if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
  }, []);

  const tabParam = params.get("tab");
  // Raw is only a real, separate view when the preserved pre-cleanup snapshot
  // differs from the (possibly cleaned) transcript. When identical we drop the
  // duplicate tab — and coerce a stale ?tab=raw deep link back to transcript.
  const showRaw = data?.rawDiffers === true;
  const defaultTab: Tab = data?.summary ? "summary" : "transcript";
  let tab: Tab = override ?? (isTab(tabParam) ? tabParam : defaultTab);
  if (tab === "raw" && !showRaw) tab = "transcript";

  const snippet = (params.get("snippet") ?? "").replace(/\[\/?hit\]/g, "").trim();

  useEffect(() => {
    if (!snippet || !bodyRef.current) return;
    const body = bodyRef.current;
    const text = body.textContent ?? "";
    const idx = text.toLowerCase().indexOf(snippet.toLowerCase());
    if (idx < 0) return;
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let acc = 0;
    while (true) {
      const node = walker.nextNode() as Text | null;
      if (!node) break;
      const nodeLen = node.data.length;
      if (acc + nodeLen > idx) {
        const start = idx - acc;
        const span = document.createElement("span");
        span.className = "search-highlight";
        const matched = node.splitText(start);
        const remainder = matched.splitText(Math.min(snippet.length, matched.data.length));
        void remainder;
        span.textContent = matched.data;
        matched.replaceWith(span);
        if (typeof span.scrollIntoView === "function") {
          span.scrollIntoView({ block: "center" });
        }
        const t = setTimeout(() => span.classList.add("fade"), 50);
        const t2 = setTimeout(() => span.classList.remove("search-highlight", "fade"), 2050);
        return () => { clearTimeout(t); clearTimeout(t2); };
      }
      acc += nodeLen;
    }
  }, [snippet, tab, data]);

  if (isPending) return <EmptyState label={t("common.loading")} />;
  if (error) return <EmptyState label={t("reader.loadFailed", { message: error.message })} />;
  if (!data) return <EmptyState label={t("reader.notFound", { stem })} />;

  const setTab = (t: Tab) => {
    setOverride(t);
    const next = new URLSearchParams(params);
    next.set("tab", t);
    setParams(next, { replace: true });
  };

  const seekParam = params.get("seek");
  const parsedSeek = seekParam !== null ? parseFloat(seekParam) : NaN;
  const initialSeek = Number.isFinite(parsedSeek) ? parsedSeek : undefined;

  const audioSrc = audioSrcFor(data);
  const agentTask = data.agentTask as AgentTaskView | null | undefined;
  const notionDelivery = data.notionDelivery as NotionDeliveryView | null | undefined;
  const taskActive = agentTask ? ACTIVE_AGENT_TASK_STATES.has(agentTask.state) : false;
  const manualPolicyOverrideAllowed = allowsManualPolicyOverride(agentTask);
  const taskBlocksManualActions = taskActive && !manualPolicyOverrideAllowed;
  const taskDeleteBlocked = taskActive || agentTask?.state === "delivery_unverified";
  const manualActionPending = transcribeMut.isPending || summarizeMut.isPending || sendSummaryMut.isPending;
  const taskActionBlocked = taskBlocksManualActions || agentTask?.state === "delivery_unverified";
  const actionsDisabledReason = taskActionBlocked
      ? t("reader.disabled.agentTaskActive")
      : undefined;
  const shareTargets = (data.shareTargets ?? []) as ShareTarget[];
  const shareHistory = (data.shareHistory ?? []) as ShareHistoryEntry[];
  const summaryTemplateOptions = mergeSummaryTemplateOptions(
    (data.summaryTemplateOptions ?? []) as SummaryTemplateOption[],
    summaryPrompts as SummaryPromptRow[] | undefined,
  );
  const handleSeek = (time: number) => {
    const next = new URLSearchParams(params);
    next.set("seek", Math.max(0, time).toFixed(2));
    setParams(next, { replace: true });
  };

  return (
    <div className="reader">
      <div className="reader-workspace">
        <div className="reader-header">
          <button type="button" className="reader-mobile-back" onClick={() => navigate("/inbox")}>
            <ChevronLeft size={14} strokeWidth={1.8} />
            <span>{t("nav.recordings")}</span>
          </button>
          <div className="reader-heading">
            <div className="reader-heading-copy">
              <div className="reader-titlerow">
                {editingTitle ? (
                  <input
                    ref={titleInputRef}
                    className="reader-title-input"
                    value={titleDraft}
                    placeholder={data.title ?? t("reader.title.placeholder")}
                    aria-label={t("reader.title.aria")}
                    onChange={(e) => setTitleDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") { e.preventDefault(); commitRename(); }
                      else if (e.key === "Escape") { e.preventDefault(); setEditingTitle(false); }
                    }}
                  />
                ) : (
                  <button
                    type="button"
                    className="reader-title reader-title-edit"
                    onClick={startRename}
                    title={t("reader.title.rename")}
                  >
                    <span>{data.title ?? data.stem}</span>
                    <Pencil size={12} strokeWidth={1.75} className="reader-title-pencil" />
                  </button>
                )}
              </div>
              <div className="reader-meta">
                <span>{new Date(data.mtimeMs).toLocaleDateString()}</span>
                <span>•</span>
                {!agentTask && <RecordingStatusBadge state={data.status} error={data.statusError} />}
                <AgentTaskStatus task={agentTask} delivery={notionDelivery} />
                <TagEditor tags={data.tags ?? []} onChange={handleTagsChange} />
              </div>
            </div>
            <div className="reader-header-actions">
              {summaryTemplateOptions.length > 0 && (
                <label className="reader-action-select reader-action-select--summary" title={t("reader.summaryTemplate.title")}>
                  <span>{t("reader.summaryTemplate.label")}</span>
                  <select
                    value={summaryTemplateId}
                    aria-label={t("reader.summaryTemplate.aria")}
                    onChange={(e) => setSummaryTemplateId(e.target.value)}
                  >
                    {summaryTemplateOptions.map((option) => (
                      <option key={option.id} value={option.id}>
                        {option.isAutoRun ? `${option.name} · ${t("reader.summaryTemplate.autorun")}` : option.name}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <button
                type="button"
                className="reader-header-icon reader-header-delete"
                onClick={handleDelete}
                disabled={deleteMut.isPending || taskDeleteBlocked}
                aria-label={t("reader.delete.aria")}
                title={taskDeleteBlocked ? t("reader.disabled.agentTaskActive") : t("reader.delete.title")}
              >
                <Trash2 size={15} strokeWidth={1.75} />
              </button>
            </div>
          </div>

          <div className="reader-actions">
          <ReprocessButton
            label={t("reader.action.retranscribe")}
            icon={<RefreshCw size={14} strokeWidth={1.75} />}
            state={deriveButtonState("transcribe")}
            error={buttonError("transcribe")}
            onClick={handleTranscribe}
            disabled={!data.wavPath || taskActionBlocked || manualActionPending}
            disabledReason={!data.wavPath ? t("reader.disabled.wavMissing") : actionsDisabledReason}
          />
          <ReprocessButton
            label={t("reader.action.regenerate")}
            icon={<Sparkles size={14} strokeWidth={1.75} />}
            state={deriveButtonState("summarize")}
            error={buttonError("summarize")}
            onClick={handleSummarize}
            disabled={!(data.transcript || data.realtime) || taskActionBlocked || manualActionPending}
            disabledReason={!(data.transcript || data.realtime) ? t("reader.disabled.transcriptFirst") : actionsDisabledReason}
          />
          <SharePopover
            className="reader-action-share"
            targets={shareTargets}
            history={shareHistory}
            pendingChannel={pendingShareChannel}
            onSend={handleShare}
            disabled={!data.summary || data.summaryStale || taskActionBlocked || manualActionPending}
          />
          </div>

          {actionError?.action === "share" && <div className="reader-action-error" role="alert">{actionError.message}</div>}

          {agentTask?.state === "delivery_unverified" && (
            <div className="reader-reconciliation" role="alert">
              <div>
                <strong>{t("reader.reconciliation.heading")}</strong>
                <p>{t("reader.reconciliation.description")}</p>
              </div>
              <div className="reader-reconciliation-actions">
                <button
                  type="button"
                  onClick={handleConfirmDelivery}
                  disabled={confirmDeliveryMut.isPending || abandonDeliveryMut.isPending}
                >
                  {t("reader.reconciliation.confirmDelivered")}
                </button>
                <button
                  type="button"
                  onClick={handleAbandonDelivery}
                  disabled={confirmDeliveryMut.isPending || abandonDeliveryMut.isPending}
                >
                  {t("reader.reconciliation.abandon")}
                </button>
              </div>
            </div>
          )}

          {mountedAudioSrc === audioSrc ? (
            <AudioPlayer src={audioSrc} initialSeek={initialSeek} />
          ) : (
            <div className="audioplayer audioplayer-deferred" aria-hidden="true">
              <button type="button" className="audioplayer-play" disabled />
              <div className="audioplayer-wave" />
              <div className="audioplayer-time">0:00 / 0:00</div>
            </div>
          )}

          <div className="reader-tabs" role="tablist">
          <button
            key="summary"
            type="button"
            aria-selected={tab === "summary"}
            className={"reader-tab" + (tab === "summary" ? " active" : "")}
            onClick={() => setTab("summary")}
          >
            <Sparkles size={14} strokeWidth={1.75} />
            {t("reader.tab.summary")}
          </button>
          <button
            key="transcript"
            type="button"
            aria-selected={tab === "transcript"}
            className={"reader-tab" + (tab === "transcript" ? " active" : "")}
            onClick={() => setTab("transcript")}
          >
            <FileText size={14} strokeWidth={1.75} />
            {t("reader.tab.transcript")}
          </button>
          {showRaw && (
            <button
              key="raw"
              type="button"
              aria-selected={tab === "raw"}
              className={"reader-tab" + (tab === "raw" ? " active" : "")}
              onClick={() => setTab("raw")}
              title={t("reader.tab.raw.title")}
            >
              <Code size={14} strokeWidth={1.75} />
              {t("reader.tab.raw")}
            </button>
          )}
          </div>
        </div>

        <div className="reader-body" ref={bodyRef}>
          {tab === "summary" && (
            data.summary ? (
              <div className="reader-summary">
                <div className="reader-summary-actions">
                  <button
                    type="button"
                    className="reader-copy-summary"
                    onClick={handleCopySummary}
                    aria-label={t("reader.copySummary.aria")}
                    title={t("reader.copySummary.title")}
                  >
                    {copiedSummary ? <Check size={14} strokeWidth={2} /> : <Copy size={14} strokeWidth={1.75} />}
                    <span>{copiedSummary ? t("reader.copySummary.done") : t("reader.copySummary")}</span>
                  </button>
                </div>
                <MarkdownView text={data.summary} />
              </div>
            ) : <EmptyState label={t("reader.empty.summary")} />
          )}
          {tab === "transcript" && (
            data.transcript
              ? (
                <TranscriptView
                  text={data.transcript}
                  speakerData={data.speakerData}
                  onSeek={handleSeek}
                  onAssignSpeaker={handleAssignSegmentSpeaker}
                />
              )
              : <EmptyState label={t("reader.empty.transcript")} />
          )}
          {tab === "raw" && showRaw && (
            <pre className="reader-raw">{data.raw ?? data.transcript ?? ""}</pre>
          )}
        </div>

        <SpeakerPanel
          speakerData={data.speakerData}
          onRename={handleRenameSpeaker}
          onMerge={handleMergeSpeakers}
        />
      </div>

    </div>
  );
}
