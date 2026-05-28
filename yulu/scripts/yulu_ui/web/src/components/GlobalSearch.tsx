// web/src/components/GlobalSearch.tsx
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Search as SearchIcon } from "lucide-react";
import { trpc } from "../trpc.js";
import { useDebounced } from "../hooks/useDebounced.js";
import "./GlobalSearch.css";

interface Hit {
  kind: string;
  stem: string;
  meetingTitle: string;
  recordedAt: string;
  sourcePath: string;
  score: number;
  snippet: string;
}

function kindClass(kind: string): string {
  if (kind.startsWith("meeting")) return "gs-kind-meeting";
  if (kind.startsWith("voicemail")) return "gs-kind-voicemail";
  if (kind === "summary") return "gs-kind-summary";
  return "gs-kind-other";
}

function kindLabel(kind: string): string {
  // Backend emits kinds like "voicemail_summary", "meeting_transcript".
  // Show only the top-level type ("voicemail" / "meeting") in the badge.
  if (kind.startsWith("voicemail")) return "voicemail";
  if (kind.startsWith("meeting")) return "meeting";
  return kind;
}

function hitTitle(h: Hit): string {
  return h.meetingTitle || h.stem;
}

function hitTimestamp(h: Hit): string {
  if (!h.recordedAt) return "";
  const d = new Date(h.recordedAt);
  if (Number.isNaN(d.valueOf())) return h.recordedAt;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

function hitTargetUrl(h: Hit): string {
  const cleanSnip = h.snippet.replace(/\[\/?hit\]/g, "").trim().slice(0, 80);
  const snip = encodeURIComponent(cleanSnip);
  return `/inbox/${h.stem}?snippet=${snip}`;
}

/**
 * Snippet rendered with <mark> on each [hit]...[/hit] span.
 */
function renderSnippet(snippet: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /\[hit\](.*?)\[\/hit\]/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(snippet)) !== null) {
    if (m.index > lastIdx) out.push(snippet.slice(lastIdx, m.index));
    out.push(<mark key={key++}>{m[1]}</mark>);
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < snippet.length) out.push(snippet.slice(lastIdx));
  return out;
}

export function GlobalSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [focused, setFocused] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const debouncedQ = useDebounced(q, 200);
  const { data, isFetching } = trpc.search.run.useQuery(
    { query: debouncedQ, limit: 8 },
    { enabled: debouncedQ.trim().length > 0 },
  );
  const hits: Hit[] = (data?.hits as Hit[] | undefined) ?? [];

  // ⌘K / Ctrl+K global focus
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cmdK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k";
      if (cmdK) {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Click-outside close
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as Node | null;
      if (tgt && (popoverRef.current?.contains(tgt) || inputRef.current?.contains(tgt))) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  useEffect(() => {
    setFocused(0);
  }, [debouncedQ]);

  const onInputKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        inputRef.current?.blur();
        return;
      }
      if (!open || hits.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocused((i) => Math.min(i + 1, hits.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocused((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const hit = hits[focused];
        if (hit) {
          navigate(hitTargetUrl(hit));
          setOpen(false);
        }
      }
    },
    [open, hits, focused, navigate],
  );

  return (
    <div className="gs-root">
      <div className="gs-input-wrap">
        <SearchIcon className="gs-icon" size={13} strokeWidth={2} />
        <input
          ref={inputRef}
          className="gs-input"
          type="search"
          placeholder="Search"
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (q.length > 0) setOpen(true);
          }}
          onKeyDown={onInputKey}
          aria-expanded={open}
          aria-controls="gs-popover"
        />
        <span className="gs-kbd" aria-hidden="true">⌘K</span>
      </div>

      {open && q.length > 0 && (
        <div ref={popoverRef} id="gs-popover" className="gs-popover" role="listbox">
          {hits.length === 0 && !isFetching && (
            <div className="gs-empty">No matches</div>
          )}
          {hits.map((h, i) => (
            <button
              key={`${h.kind}-${h.stem}-${i}`}
              type="button"
              role="option"
              aria-selected={i === focused}
              className={"gs-result" + (i === focused ? " focus" : "")}
              onMouseEnter={() => setFocused(i)}
              onClick={() => {
                navigate(hitTargetUrl(h));
                setOpen(false);
              }}
            >
              <div className="gs-result-line1">
                <span className={`gs-kind ${kindClass(h.kind)}`}>{kindLabel(h.kind)}</span>
                <span className="gs-result-title">{hitTitle(h)}</span>
                <span className="gs-result-meta">{hitTimestamp(h)}</span>
              </div>
              <div className="gs-result-snippet">{renderSnippet(h.snippet)}</div>
            </button>
          ))}
          <div className="gs-footer">
            <span><kbd>↑↓</kbd> navigate</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>esc</kbd> close</span>
            <span className="gs-footer-count">
              {hits.length} result{hits.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
