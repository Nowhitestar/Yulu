// web/src/routes/inbox/recordings.$stem.tsx
import { useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Sparkles, Pencil, Trash2 } from "lucide-react";
import { trpc } from "../../trpc.js";
import { AudioPlayer } from "../../components/AudioPlayer.js";
import { TranscriptView } from "../../components/TranscriptView.js";
import { MarkdownView } from "../../components/MarkdownView.js";
import { TagEditor } from "../../components/TagEditor.js";
import { EmptyState } from "../../components/EmptyState.js";
import { ReprocessButton, type ReprocessButtonState } from "../../components/ReprocessButton.js";
import { useConfirm } from "../../hooks/useConfirm.js";
import { useWsChannel } from "../../ws.js";
import "./recordings.reader.css";

const GET_KEY = [["recordings", "get"]] as const;
const LIST_KEY = [["recordings", "list"]] as const;

export const handle = {
  // Returns the stem (a literal filename) when present, else the i18n key for
  // "Recording". TopBar resolves both through t(): a real key localizes; a stem
  // falls back to itself since it isn't in the dictionary.
  breadcrumb: (params: { stem?: string }) => params.stem ?? "breadcrumb.recording",
  filters: null,
};

type Tab = "transcript" | "summary" | "realtime" | "raw";

function isTab(v: string | null): v is Tab {
  return v === "transcript" || v === "summary" || v === "realtime" || v === "raw";
}

export function RecordingReader() {
  const { stem = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const { data, isPending } = trpc.recordings.get.useQuery({ stem }, { enabled: stem.length > 0 });

  const qc = useQueryClient();
  const [lastAction, setLastAction] = useState<"transcribe" | "summarize" | null>(null);

  const transcribeMut = trpc.recordings.transcribe.useMutation();
  const summarizeMut = trpc.recordings.summarize.useMutation();
  const renameMut = trpc.recordings.rename.useMutation();
  const setTagsMut = trpc.recordings.setTags.useMutation();
  const deleteMut = trpc.recordings.delete.useMutation();

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

  const handleDelete = () => {
    const label = data?.title ?? stem;
    if (!confirm(`Delete "${label}" and all of its files? This cannot be undone.`)) return;
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

  function deriveButtonState(action: "transcribe" | "summarize"): ReprocessButtonState {
    const status = data?.status ?? "idle";
    const targetRunning = action === "transcribe" ? "transcribing" : "summarizing";
    if (status === targetRunning) return "running";
    if (status === "failed" && lastAction === action) return "failed";
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

  if (isPending) return <EmptyState label="Loading…" />;
  if (!data) return <EmptyState label={`Recording "${stem}" not found.`} />;

  const setTab = (t: Tab) => {
    setOverride(t);
    const next = new URLSearchParams(params);
    next.set("tab", t);
    setParams(next, { replace: true });
  };

  const seekParam = params.get("seek");
  const parsedSeek = seekParam !== null ? parseFloat(seekParam) : NaN;
  const initialSeek = Number.isFinite(parsedSeek) ? parsedSeek : undefined;

  const audioSrc = `/files/meetings/${data.stem}.wav`;

  return (
    <div className="reader">
      <div className="reader-header">
        <div className="reader-titlerow">
          {editingTitle ? (
            <input
              ref={titleInputRef}
              className="reader-title-input"
              value={titleDraft}
              placeholder={data.title ?? "Title"}
              aria-label="Recording title"
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
              title="Rename"
            >
              <span>{data.title ?? data.stem}</span>
              <Pencil size={12} strokeWidth={1.75} className="reader-title-pencil" />
            </button>
          )}
        </div>
        <div className="reader-meta">
          <span>{new Date(data.mtimeMs).toLocaleString()}</span>
        </div>
        <TagEditor tags={data.tags ?? []} onChange={handleTagsChange} />
      </div>

      <div className="reader-actions">
        <ReprocessButton
          label="Re-transcribe"
          icon={<RefreshCw size={14} strokeWidth={1.75} />}
          state={deriveButtonState("transcribe")}
          error={data?.statusError}
          onClick={handleTranscribe}
          disabled={!data?.wavPath}
          disabledReason={!data?.wavPath ? "Original WAV file missing" : undefined}
        />
        <ReprocessButton
          label="Re-generate summary"
          icon={<Sparkles size={14} strokeWidth={1.75} />}
          state={deriveButtonState("summarize")}
          error={data?.statusError}
          onClick={handleSummarize}
          disabled={!data?.transcript}
          disabledReason={!data?.transcript ? "Transcript required first — click Re-transcribe" : undefined}
        />
        <button
          type="button"
          className="reader-delete"
          onClick={handleDelete}
          disabled={deleteMut.isPending}
          aria-label="Delete recording"
          title="Delete this recording and all of its files"
        >
          <Trash2 size={14} strokeWidth={1.75} />
          <span>Delete</span>
        </button>
      </div>

      <AudioPlayer src={audioSrc} initialSeek={initialSeek} />

      <div className="reader-tabs" role="tablist">
        <button
          key="summary"
          type="button"
          aria-selected={tab === "summary"}
          className={"reader-tab" + (tab === "summary" ? " active" : "")}
          onClick={() => setTab("summary")}
        >
          Summary
        </button>
        <button
          key="transcript"
          type="button"
          aria-selected={tab === "transcript"}
          className={"reader-tab" + (tab === "transcript" ? " active" : "")}
          onClick={() => setTab("transcript")}
        >
          Transcript
        </button>
        {data.hasRealtime && (
          <button
            key="realtime"
            type="button"
            aria-selected={tab === "realtime"}
            className={"reader-tab" + (tab === "realtime" ? " active" : "")}
            onClick={() => setTab("realtime")}
          >
            Realtime
          </button>
        )}
        {showRaw && (
          <button
            key="raw"
            type="button"
            aria-selected={tab === "raw"}
            className={"reader-tab" + (tab === "raw" ? " active" : "")}
            onClick={() => setTab("raw")}
            title="Pre-cleanup transcript snapshot"
          >
            Raw
          </button>
        )}
      </div>

      <div className="reader-body" ref={bodyRef}>
        {tab === "summary" && (
          data.summary ? <MarkdownView text={data.summary} /> : <EmptyState label="No summary yet." />
        )}
        {tab === "transcript" && (
          data.transcript ? <TranscriptView text={data.transcript} /> : <EmptyState label="No transcript available." />
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
