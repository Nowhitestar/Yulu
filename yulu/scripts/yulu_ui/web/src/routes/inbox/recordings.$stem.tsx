// web/src/routes/inbox/recordings.$stem.tsx
import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Sparkles } from "lucide-react";
import { trpc } from "../../trpc.js";
import { AudioPlayer } from "../../components/AudioPlayer.js";
import { TranscriptView } from "../../components/TranscriptView.js";
import { EmptyState } from "../../components/EmptyState.js";
import { ReprocessButton, type ReprocessButtonState } from "../../components/ReprocessButton.js";
import { useWsChannel } from "../../ws.js";
import "./recordings.reader.css";

export const handle = {
  breadcrumb: (params: { stem?: string }) => params.stem ?? "Recording",
  filters: null,
};

type Tab = "transcript" | "summary" | "realtime" | "raw";

function isTab(v: string | null): v is Tab {
  return v === "transcript" || v === "summary" || v === "realtime" || v === "raw";
}

export function RecordingReader() {
  const { stem = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { data, isPending } = trpc.recordings.get.useQuery({ stem }, { enabled: stem.length > 0 });

  const qc = useQueryClient();
  const [lastAction, setLastAction] = useState<"transcribe" | "summarize" | null>(null);

  const transcribeMut = trpc.recordings.transcribe.useMutation();
  const summarizeMut = trpc.recordings.summarize.useMutation();

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
  const defaultTab: Tab = data?.summary ? "summary" : data?.transcript ? "transcript" : "raw";
  const tab: Tab = override ?? (isTab(tabParam) ? tabParam : defaultTab);

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

  const audioSrc = data.type === "voicemail"
    ? `/files/voicemails/${data.stem}.wav`
    : `/files/meetings/${data.stem}.wav`;

  return (
    <div className="reader">
      <div className="reader-header">
        <span className={`recording-badge ${data.type === "voicemail" ? "v" : "m"}`}>
          {data.type === "voicemail" ? "Voicemail" : "Meeting"}
        </span>
        <h2 className="reader-title">{data.title ?? data.stem}</h2>
        <div className="reader-meta">
          <span>{new Date(data.mtimeMs).toLocaleString()}</span>
        </div>
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
        <button
          key="raw"
          type="button"
          aria-selected={tab === "raw"}
          className={"reader-tab" + (tab === "raw" ? " active" : "")}
          onClick={() => setTab("raw")}
        >
          Raw
        </button>
      </div>

      <div className="reader-body" ref={bodyRef}>
        {tab === "summary" && (
          data.summary ? <pre className="reader-md">{data.summary}</pre> : <EmptyState label="No summary yet." />
        )}
        {tab === "transcript" && (
          data.transcript ? <TranscriptView text={data.transcript} /> : <EmptyState label="No transcript available." />
        )}
        {tab === "realtime" && (
          <pre className="reader-raw">{data.realtime ?? ""}</pre>
        )}
        {tab === "raw" && (
          <pre className="reader-raw">{data.transcript ?? ""}</pre>
        )}
      </div>
    </div>
  );
}
