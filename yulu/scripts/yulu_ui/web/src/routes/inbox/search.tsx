// web/src/routes/inbox/search.tsx
import { useState } from "react";
import { useSearchParams } from "react-router";
import { trpc } from "../../trpc.js";
import { useDebounced } from "../../hooks/useDebounced.js";
import "./search.css";

export const handle = { breadcrumb: "Inbox / Search", filters: null };

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

  const { isPending } = trpc.search.run.useQuery(
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
        {/* results rendered in C.18 */}
        {debouncedQ.length >= 2 && isPending && (
          <div className="search-empty">Searching…</div>
        )}
      </div>
    </div>
  );
}
