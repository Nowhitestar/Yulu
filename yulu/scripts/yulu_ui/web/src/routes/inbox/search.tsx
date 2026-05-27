// web/src/routes/inbox/search.tsx
import type React from "react";
import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { trpc } from "../../trpc.js";
import { useDebounced } from "../../hooks/useDebounced.js";
import { FilterChips, type ChipDef } from "../../components/FilterChips.js";
import "./search.css";

export const handle = { breadcrumb: "Search", filters: null };

const SINCE_CHIPS: ChipDef[] = [
  { id: "all", label: "All time" },
  { id: "7d", label: "Last 7d" },
  { id: "30d", label: "Last 30d" },
  { id: "90d", label: "Last 90d" },
];

interface Hit {
  kind: string;
  stem: string;
  meetingTitle: string;
  recordedAt: string;
  sourcePath: string;
  score: number;
  snippet: string;
}

export function Search() {
  const [params, setParams] = useSearchParams();
  // Local override lets controlled inputs reflect changes immediately
  // even if the router debounces or rejects setSearchParams (e.g. jsdom in
  // tests). The URL is still updated for shareable deep links.
  const [override, setOverride] = useState<string | null>(null);
  const [typeOverride, setTypeOverride] = useState<string | null>(null);
  const [inOverride, setInOverride] = useState<string | null>(null);
  const [sinceOverride, setSinceOverride] = useState<string | null>(null);
  const urlQ = params.get("q") ?? "";
  const q = override ?? urlQ;
  const debouncedQ = useDebounced(q, 300);

  const setQ = (value: string) => {
    setOverride(value);
    const next = new URLSearchParams(params);
    if (value) next.set("q", value);
    else next.delete("q");
    setParams(next, { replace: true });
  };

  const type = typeOverride ?? params.get("type") ?? "";
  const inLayer = inOverride ?? params.get("in") ?? "";
  const since = sinceOverride ?? params.get("since") ?? "";

  const setParam = (key: string, value: string) => {
    if (key === "type") setTypeOverride(value);
    else if (key === "in") setInOverride(value);
    else if (key === "since") setSinceOverride(value);
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const kinds =
    (type === "voicemail" || type === "meeting") &&
    (inLayer === "summary" || inLayer === "transcript")
      ? ([`${type}_${inLayer}`] as const)
      : undefined;

  const { data, isPending } = trpc.search.run.useQuery(
    { query: debouncedQ, kinds: kinds as never, since: since || undefined },
    { enabled: debouncedQ.length >= 2 },
  );

  return (
    <div className="search-page">
      <div className="search-header">
        <input
          type="search"
          role="searchbox"
          className="search-input"
          placeholder="Search voicemails, meetings, summaries…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <label className="search-select-wrap">
          <span className="search-select-label">Type</span>
          <select
            className="search-select"
            aria-label="Type"
            value={type}
            onChange={(e) => setParam("type", e.target.value)}
          >
            <option value="">Any</option>
            <option value="voicemail">Voicemail</option>
            <option value="meeting">Meeting</option>
          </select>
        </label>
        <label className="search-select-wrap">
          <span className="search-select-label">In</span>
          <select
            className="search-select"
            aria-label="In"
            value={inLayer}
            onChange={(e) => setParam("in", e.target.value)}
          >
            <option value="">Any</option>
            <option value="summary">Summary</option>
            <option value="transcript">Transcript</option>
          </select>
        </label>
        <FilterChips
          chips={SINCE_CHIPS}
          activeIds={since ? [since] : []}
          onChange={(ids) => setParam("since", ids[0] === "all" ? "" : (ids[0] ?? ""))}
        />
      </div>
      <div className="search-results">
        {debouncedQ.length < 2 && (
          <div className="search-empty">Type at least 2 characters to search.</div>
        )}
        {debouncedQ.length >= 2 && isPending && (
          <div className="search-empty">Searching…</div>
        )}
        {debouncedQ.length >= 2 && !isPending && (data?.hits?.length ?? 0) === 0 && (
          <div className="search-empty">No matches for "{debouncedQ}".</div>
        )}
        {(data?.hits as Hit[] | undefined)?.map((h, i) => (
          <SearchResultRow key={`${h.stem}-${i}`} hit={h} />
        ))}
        {data && (
          <div className="search-telemetry">
            {(data.hits as Hit[]).length} hits ({(data.telemetry as { sweepMs: number; queryMs: number; fallbackUsed: boolean }).sweepMs} ms sweep, {(data.telemetry as { sweepMs: number; queryMs: number }).queryMs} ms query, {(data.telemetry as { fallbackUsed: boolean }).fallbackUsed ? "LIKE" : "FTS5"})
          </div>
        )}
      </div>
    </div>
  );
}

function SearchResultRow({ hit }: { hit: Hit }) {
  // Map kind ("voicemail_summary" / "meeting_transcript" / ...) to route + tab
  const [kindType, kindIn] = hit.kind.split("_");
  const basePath = kindType === "voicemail" ? "voicemails" : "meetings";
  const tab = kindIn === "summary" ? "summary" : kindIn === "transcript" ? "transcript" : "raw";
  // Strip [hit] markers so the snippet matcher in the reader can find a clean string
  const cleanSnippet = hit.snippet.replace(/\[\/?hit\]/g, "").trim().slice(0, 80);
  const target = `/inbox/${basePath}/${hit.stem}?tab=${tab}&snippet=${encodeURIComponent(cleanSnippet)}`;

  return (
    <Link to={target} className="search-result">
      <div className="search-result-title">{hit.meetingTitle === "voicemail" ? hit.stem : hit.meetingTitle}</div>
      <div className="search-result-meta">
        <span>{hit.recordedAt}</span>
        <span>·</span>
        <span>score {hit.score.toFixed(2)}</span>
        <span>·</span>
        <span>{hit.kind}</span>
      </div>
      <div className="search-result-snippet">{renderSnippet(hit.snippet)}</div>
    </Link>
  );
}

function renderSnippet(snippet: string): React.ReactNode[] {
  // Tokenize [hit]...[/hit] segments
  const out: React.ReactNode[] = [];
  const re = /\[hit\](.*?)\[\/hit\]/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(snippet)) !== null) {
    if (m.index > lastIdx) out.push(snippet.slice(lastIdx, m.index));
    out.push(<span key={key++} className="search-snippet-hit">{m[1]}</span>);
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < snippet.length) out.push(snippet.slice(lastIdx));
  return out;
}
