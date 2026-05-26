// web/src/routes/inbox/search.tsx
import type React from "react";
import { useState } from "react";
import { useSearchParams } from "react-router";
import { trpc } from "../../trpc.js";
import { useDebounced } from "../../hooks/useDebounced.js";
import "./search.css";

export const handle = { breadcrumb: "Inbox / Search", filters: null };

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
  // Local override lets the controlled input reflect typing immediately
  // even if the router debounces or rejects setSearchParams (e.g. jsdom in
  // tests). The URL is still updated for shareable deep links.
  const [override, setOverride] = useState<string | null>(null);
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

  const type = params.get("type");
  const inLayer = params.get("in");
  const kinds =
    (type === "voicemail" || type === "meeting") &&
    (inLayer === "summary" || inLayer === "transcript")
      ? ([`${type}_${inLayer}`] as const)
      : undefined;

  const since = params.get("since") ?? undefined;

  const { data, isPending } = trpc.search.run.useQuery(
    { query: debouncedQ, kinds: kinds as never, since },
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
  return (
    <div className="search-result">
      <div className="search-result-title">{hit.meetingTitle === "voicemail" ? hit.stem : hit.meetingTitle}</div>
      <div className="search-result-meta">
        <span>{hit.recordedAt}</span>
        <span>·</span>
        <span>score {hit.score.toFixed(2)}</span>
        <span>·</span>
        <span>{hit.kind}</span>
      </div>
      <div className="search-result-snippet">{renderSnippet(hit.snippet)}</div>
    </div>
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
