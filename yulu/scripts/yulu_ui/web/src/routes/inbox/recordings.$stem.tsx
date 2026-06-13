// web/src/routes/inbox/recordings.$stem.tsx
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, RefreshCw, Sparkles, Pencil, Trash2, Users, GitMerge, Send } from "lucide-react";
import { trpc } from "../../trpc.js";
import { AudioPlayer } from "../../components/AudioPlayer.js";
import { TranscriptView, type SpeakerData } from "../../components/TranscriptView.js";
import { MarkdownView } from "../../components/MarkdownView.js";
import { TagEditor } from "../../components/TagEditor.js";
import { EmptyState } from "../../components/EmptyState.js";
import { ReprocessButton, type ReprocessButtonState } from "../../components/ReprocessButton.js";
import { RecordingStatusBadge } from "../../components/RecordingStatusBadge.js";
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
  // Returns the stem (a literal filename) when present, else the i18n key for
  // "Recording". TopBar resolves both through t(): a real key localizes; a stem
  // falls back to itself since it isn't in the dictionary.
  breadcrumb: (params: { stem?: string }) => params.stem ?? "breadcrumb.recording",
  filters: null,
};

type Tab = "transcript" | "summary" | "realtime" | "raw";
type SummaryChannel = "notion" | "zulip";
interface EnabledSummaryTarget {
  channel: SummaryChannel;
  label: string;
  destination: string;
}

function isTab(v: string | null): v is Tab {
  return v === "transcript" || v === "summary" || v === "realtime" || v === "raw";
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
  const { data, isPending } = trpc.recordings.get.useQuery({ stem }, { enabled: stem.length > 0 });

  const qc = useQueryClient();
  const [lastAction, setLastAction] = useState<"transcribe" | "summarize" | null>(null);
  const targetAudioSrc = data ? audioSrcFor(data) : null;
  const [mountedAudioSrc, setMountedAudioSrc] = useState<string | null>(null);

  const transcribeMut = trpc.recordings.transcribe.useMutation();
  const summarizeMut = trpc.recordings.summarize.useMutation();
  const renameMut = trpc.recordings.rename.useMutation();
  const setTagsMut = trpc.recordings.setTags.useMutation();
  const deleteMut = trpc.recordings.delete.useMutation();
  const sendSummaryMut = trpc.recordings.sendSummary.useMutation();
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
    if (msg.state === "done" || msg.state === "failed") {
      qc.invalidateQueries({ queryKey: [["recordings", "get"]] });
      qc.invalidateQueries({ queryKey: [["recordings", "list"]] });
    }
  });

  useEffect(() => {
    setMountedAudioSrc(null);
    if (!targetAudioSrc) return;
    const timer = window.setTimeout(() => setMountedAudioSrc(targetAudioSrc), AUDIO_MOUNT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [targetAudioSrc]);

  function deriveButtonState(action: "transcribe" | "summarize"): ReprocessButtonState {
    const status = data?.status ?? "idle";
    const targetRunning = action === "transcribe" ? "transcribing" : "summarizing";
    const targetFailed = action === "transcribe" ? "transcription_failed" : "summary_failed";
    if (status === targetRunning) return "running";
    if ((status === targetFailed || status === "failed") && lastAction === action) return "failed";
    if (status === "idle" && lastAction === action) return "done";
    return "idle";
  }

  const handleTranscribe = () => {
    setLastAction("transcribe");
    transcribeMut.mutate({ stem }, {
      onError: (err) => console.error("transcribe failed:", err.message),
    });
  };
  const handleSummarize = () => {
    setLastAction("summarize");
    summarizeMut.mutate({ stem }, {
      onError: (err) => console.error("summarize failed:", err.message),
    });
  };

  const handleSendSummary = (target: EnabledSummaryTarget) => {
    if (!confirm(t("reader.send.confirm", { label: target.label, destination: target.destination }))) return;
    sendSummaryMut.mutate({ stem, channel: target.channel }, {
      onError: (err) => console.error("sendSummary failed:", err.message),
      onSettled: invalidateBoth,
    });
  };

  // Local override lets clicks switch tabs even if the router's navigation
  // is debounced (or rejected in jsdom test environment). URL is still
  // updated via setSearchParams for shareable deep links.
  const [override, setOverride] = useState<Tab | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

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
  const summaryTargets = data.summary
    ? ((data.enabledSummaryTargets ?? []) as EnabledSummaryTarget[])
    : [];
  const handleSeek = (time: number) => {
    const next = new URLSearchParams(params);
    next.set("seek", Math.max(0, time).toFixed(2));
    setParams(next, { replace: true });
  };

  return (
    <div className="reader">
      <div className="reader-header">
        <button type="button" className="reader-mobile-back" onClick={() => navigate("/inbox")}>
          <ChevronLeft size={14} strokeWidth={1.8} />
          <span>{t("nav.recordings")}</span>
        </button>
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
          <span>{new Date(data.mtimeMs).toLocaleString()}</span>
          <RecordingStatusBadge state={data.status} error={data.statusError} />
        </div>
        <TagEditor tags={data.tags ?? []} onChange={handleTagsChange} />
      </div>

      <div className="reader-actions">
        <ReprocessButton
          label={t("reader.action.retranscribe")}
          icon={<RefreshCw size={14} strokeWidth={1.75} />}
          state={deriveButtonState("transcribe")}
          error={data?.statusError}
          onClick={handleTranscribe}
          disabled={!data?.wavPath}
          disabledReason={!data?.wavPath ? t("reader.disabled.wavMissing") : undefined}
        />
        <ReprocessButton
          label={t("reader.action.regenerate")}
          icon={<Sparkles size={14} strokeWidth={1.75} />}
          state={deriveButtonState("summarize")}
          error={data?.statusError}
          onClick={handleSummarize}
          disabled={!data?.transcript}
          disabledReason={!data?.transcript ? t("reader.disabled.transcriptFirst") : undefined}
        />
        {summaryTargets.map((target) => (
          <button
            key={target.channel}
            type="button"
            className="reader-send"
            onClick={() => handleSendSummary(target)}
            disabled={sendSummaryMut.isPending}
            aria-label={t("reader.action.sendTo", { label: target.label })}
            title={t("reader.action.sendTo", { label: target.label })}
          >
            <Send size={14} strokeWidth={1.75} />
            <span>{t("reader.action.sendTo", { label: target.label })}</span>
          </button>
        ))}
        <button
          type="button"
          className="reader-delete"
          onClick={handleDelete}
          disabled={deleteMut.isPending}
          aria-label={t("reader.delete.aria")}
          title={t("reader.delete.title")}
        >
          <Trash2 size={14} strokeWidth={1.75} />
          <span>{t("reader.action.delete")}</span>
        </button>
      </div>

      {mountedAudioSrc === audioSrc ? (
        <AudioPlayer src={audioSrc} initialSeek={initialSeek} />
      ) : (
        <div className="audioplayer audioplayer-deferred" aria-hidden="true">
          <button type="button" className="audioplayer-play" disabled />
          <div className="audioplayer-wave" />
          <div className="audioplayer-time">0:00 / 0:00</div>
        </div>
      )}

      <SpeakerPanel
        speakerData={data.speakerData}
        onRename={handleRenameSpeaker}
        onMerge={handleMergeSpeakers}
      />

      <div className="reader-tabs" role="tablist">
        <button
          key="summary"
          type="button"
          aria-selected={tab === "summary"}
          className={"reader-tab" + (tab === "summary" ? " active" : "")}
          onClick={() => setTab("summary")}
        >
          {t("reader.tab.summary")}
        </button>
        <button
          key="transcript"
          type="button"
          aria-selected={tab === "transcript"}
          className={"reader-tab" + (tab === "transcript" ? " active" : "")}
          onClick={() => setTab("transcript")}
        >
          {t("reader.tab.transcript")}
        </button>
        {data.hasRealtime && (
          <button
            key="realtime"
            type="button"
            aria-selected={tab === "realtime"}
            className={"reader-tab" + (tab === "realtime" ? " active" : "")}
            onClick={() => setTab("realtime")}
          >
            {t("reader.tab.realtime")}
          </button>
        )}
        {showRaw && (
          <button
            key="raw"
            type="button"
            aria-selected={tab === "raw"}
            className={"reader-tab" + (tab === "raw" ? " active" : "")}
            onClick={() => setTab("raw")}
            title={t("reader.tab.raw.title")}
          >
            {t("reader.tab.raw")}
          </button>
        )}
      </div>

      <div className="reader-body" ref={bodyRef}>
        {tab === "summary" && (
          data.summary ? <MarkdownView text={data.summary} /> : <EmptyState label={t("reader.empty.summary")} />
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
        {tab === "realtime" && (
          <pre className="reader-raw">{data.realtime ?? ""}</pre>
        )}
        {tab === "raw" && showRaw && (
          <pre className="reader-raw">{data.raw ?? data.transcript ?? ""}</pre>
        )}
      </div>
    </div>
  );
}
