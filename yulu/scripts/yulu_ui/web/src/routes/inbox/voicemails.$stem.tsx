// web/src/routes/inbox/voicemails.$stem.tsx
import { useEffect, useRef, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { trpc } from "../../trpc.js";
import { AudioPlayer } from "../../components/AudioPlayer.js";
import { TranscriptView } from "../../components/TranscriptView.js";
import { EmptyState } from "../../components/EmptyState.js";
import "./voicemails.reader.css";

export const handle = {
  breadcrumb: (params: { stem?: string }) => params.stem ?? "Voicemail",
  filters: null,
};

type Tab = "transcript" | "summary" | "raw";

function isTab(v: string | null): v is Tab {
  return v === "transcript" || v === "summary" || v === "raw";
}

export function VoicemailReader() {
  const { stem = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const { data, isPending } = trpc.voicemails.get.useQuery({ stem }, { enabled: stem.length > 0 });

  // Local override lets clicks switch tabs even if the router's navigation
  // is debounced (or rejected in jsdom test environment). URL is still
  // updated via setSearchParams for shareable deep links.
  const [override, setOverride] = useState<Tab | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const tabParam = params.get("tab");
  const defaultTab: Tab = data?.summary ? "summary" : "transcript";
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
  if (!data) return <EmptyState label={`Voicemail "${stem}" not found.`} />;

  const setTab = (t: Tab) => {
    setOverride(t);
    const next = new URLSearchParams(params);
    next.set("tab", t);
    setParams(next, { replace: true });
  };

  const seekParam = params.get("seek");
  const parsedSeek = seekParam !== null ? parseFloat(seekParam) : NaN;
  const initialSeek = Number.isFinite(parsedSeek) ? parsedSeek : undefined;

  return (
    <div className="reader">
      <div className="reader-header">
        <h2 className="reader-title">{data.stem}</h2>
        <div className="reader-meta">
          <span>{new Date(data.mtimeMs).toLocaleString()}</span>
        </div>
      </div>

      <AudioPlayer
        src={`/files/voicemails/${data.stem}.wav`}
        initialSeek={initialSeek}
      />

      <div className="reader-tabs" role="tablist">
        {(["transcript", "summary", "raw"] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            aria-selected={tab === t}
            className={"reader-tab" + (tab === t ? " active" : "")}
            onClick={() => setTab(t)}
          >
            {t === "transcript" ? "Transcript" : t === "summary" ? "Summary" : "Raw"}
          </button>
        ))}
      </div>

      <div className="reader-body" ref={bodyRef}>
        {tab === "transcript" && (
          data.transcript ? <TranscriptView text={data.transcript} /> : <EmptyState label="No transcript available." />
        )}
        {tab === "summary" && (
          data.summary ? <pre className="reader-md">{data.summary}</pre> : <EmptyState label="No summary yet." />
        )}
        {tab === "raw" && (
          <pre className="reader-raw">{data.transcript ?? ""}</pre>
        )}
      </div>
    </div>
  );
}
