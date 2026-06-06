// web/src/components/GlobalSearch.tsx
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { Search as SearchIcon } from "lucide-react";
import { trpc } from "../trpc.js";
import { useDebounced } from "../hooks/useDebounced.js";
import { useSettingsSchema } from "../hooks/useSettingsSchema.js";
import { categoryLabel } from "./settings/categories.js";
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

// A client-side "jump to this setting's category" hit. Synthesised from the
// registry (config.schema) when the query matches a setting's label or its
// category — the backend search index has no notion of settings.
interface SettingHit {
  kind: "setting";
  category: string;
  label: string;
}

type Item = ({ t: "hit" } & Hit) | ({ t: "setting" } & SettingHit);

/**
 * Build setting hits for a query by matching the registry's labels + categories
 * (case-insensitive substring). One hit per matching category (deduped), so the
 * result jumps straight to /settings/:category. Capped to keep the popover tight.
 */
function buildSettingHits(
  query: string,
  schema: ReadonlyArray<{ path: string; category: string; label: string }> | undefined,
): SettingHit[] {
  const q = query.trim().toLowerCase();
  if (!q || !schema) return [];
  const byCategory = new Map<string, SettingHit>();
  for (const s of schema) {
    const catLabel = categoryLabel(s.category);
    const matches =
      s.label.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q) ||
      catLabel.toLowerCase().includes(q);
    if (!matches) continue;
    if (!byCategory.has(s.category)) {
      byCategory.set(s.category, { kind: "setting", category: s.category, label: catLabel });
    }
  }
  return Array.from(byCategory.values()).slice(0, 5);
}

function kindClass(kind: string): string {
  if (kind.startsWith("meeting")) return "gs-kind-meeting";
  if (kind === "summary") return "gs-kind-summary";
  if (kind === "setting") return "gs-kind-setting";
  return "gs-kind-other";
}

function kindLabel(kind: string): string {
  // Backend emits kinds like "meeting_summary", "meeting_transcript".
  // Show only the top-level type ("meeting") in the badge.
  if (kind.startsWith("meeting")) return "meeting";
  return kind;
}

function itemTargetUrl(item: Item): string {
  return item.t === "setting" ? `/settings/${item.category}` : hitTargetUrl(item);
}

function itemKey(item: Item, i: number): string {
  return item.t === "setting" ? `setting-${item.category}-${i}` : `${item.kind}-${item.stem}-${i}`;
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
  const { data: schema } = useSettingsSchema();
  const hits: Hit[] = (data?.hits as Hit[] | undefined) ?? [];

  // Settings hits are synthesised client-side and listed first (they're exact,
  // navigational), then the backend recording/summary hits. Keyboard nav runs
  // over the combined list.
  const items = useMemo<Item[]>(() => {
    const settingItems: Item[] = buildSettingHits(debouncedQ, schema).map((s) => ({ t: "setting", ...s }));
    const hitItems: Item[] = hits.map((h) => ({ t: "hit", ...h }));
    return [...settingItems, ...hitItems];
  }, [debouncedQ, schema, hits]);

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
      if (!open || items.length === 0) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setFocused((i) => Math.min(i + 1, items.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setFocused((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = items[focused];
        if (item) {
          navigate(itemTargetUrl(item));
          setOpen(false);
        }
      }
    },
    [open, items, focused, navigate],
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
          {items.length === 0 && !isFetching && (
            <div className="gs-empty">No matches</div>
          )}
          {items.map((item, i) => (
            <button
              key={itemKey(item, i)}
              type="button"
              role="option"
              aria-selected={i === focused}
              className={"gs-result" + (i === focused ? " focus" : "")}
              onMouseEnter={() => setFocused(i)}
              onClick={() => {
                navigate(itemTargetUrl(item));
                setOpen(false);
              }}
            >
              {item.t === "setting" ? (
                <div className="gs-result-line1">
                  <span className={`gs-kind ${kindClass("setting")}`}>setting</span>
                  <span className="gs-result-title">{item.label}</span>
                  <span className="gs-result-meta">设置</span>
                </div>
              ) : (
                <>
                  <div className="gs-result-line1">
                    <span className={`gs-kind ${kindClass(item.kind)}`}>{kindLabel(item.kind)}</span>
                    <span className="gs-result-title">{hitTitle(item)}</span>
                    <span className="gs-result-meta">{hitTimestamp(item)}</span>
                  </div>
                  <div className="gs-result-snippet">{renderSnippet(item.snippet)}</div>
                </>
              )}
            </button>
          ))}
          <div className="gs-footer">
            <span><kbd>↑↓</kbd> navigate</span>
            <span><kbd>↵</kbd> open</span>
            <span><kbd>esc</kbd> close</span>
            <span className="gs-footer-count">
              {items.length} result{items.length === 1 ? "" : "s"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
