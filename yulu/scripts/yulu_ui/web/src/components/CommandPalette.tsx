// The one place to find anything: jump to any page, or search every recording,
// transcript, summary and setting. Opened from the toolbar or with ⌘K.
import type React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import { FileText, Search as SearchIcon, SlidersHorizontal, type LucideIcon } from "lucide-react";
import { trpc } from "../trpc.js";
import { useDebounced } from "../hooks/useDebounced.js";
import { useSettingsSchema } from "../hooks/useSettingsSchema.js";
import { categoryLabelKey, categoryMeta, settingsTarget } from "./settings/categories.js";
import { ALL_DESTINATIONS } from "../navigation.js";
import { useT, type TFunc } from "../i18n/LanguageProvider.js";
import "./CommandPalette.css";

interface Hit {
  kind: string;
  stem: string;
  meetingTitle: string;
  recordedAt: string;
  sourcePath: string;
  score: number;
  snippet: string;
}

interface SettingHit {
  kind: "setting";
  category: string;
  label: string;
  href: string;
}

interface GoItem {
  t: "go";
  href: string;
  label: string;
  icon: LucideIcon;
}

type Item = GoItem | ({ t: "hit" } & Hit) | ({ t: "setting" } & SettingHit);

const RETIRED_LLM_SETTINGS = new Set([
  "llm.enabled",
  "llm.command",
  "llm.agent.provider",
]);

function buildSettingHits(
  query: string,
  schema: ReadonlyArray<{ path: string; category: string; label: string }> | undefined,
  t: TFunc,
): SettingHit[] {
  const q = query.trim().toLowerCase();
  if (!q || !schema) return [];
  const byCategory = new Map<string, SettingHit>();
  for (const s of schema) {
    if (RETIRED_LLM_SETTINGS.has(s.path)) continue;
    if (!categoryMeta(s.category)) continue;
    const target = settingsTarget(s.category, "", s.path);
    const catLabel = t(categoryLabelKey(target.id));
    const matches =
      s.label.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q) ||
      t(`settings.category.${s.category}.label`).toLowerCase().includes(q) ||
      catLabel.toLowerCase().includes(q);
    if (!matches) continue;
    if (!byCategory.has(target.id)) {
      byCategory.set(target.id, { kind: "setting", category: target.id, label: catLabel, href: `/settings/${target.id}${target.hash}` });
    }
  }
  return Array.from(byCategory.values()).slice(0, 5);
}

function hitTitle(h: Hit): string {
  return h.meetingTitle || h.stem;
}

function formatTimestamp(recordedAt: string): string {
  if (!recordedAt) return "";
  const d = new Date(recordedAt);
  if (Number.isNaN(d.valueOf())) return recordedAt;
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

function hitTab(kind: string): "summary" | "transcript" | null {
  if (kind.endsWith("_summary") || kind === "summary") return "summary";
  if (kind.endsWith("_transcript") || kind === "transcript") return "transcript";
  return null;
}

function firstHitText(snippet: string): string {
  const m = snippet.match(/\[hit\]([\s\S]*?)\[\/hit\]/);
  const marked = m?.[1]?.trim();
  if (marked) return marked;
  return snippet.replace(/\[\/?hit\]/g, "").trim().slice(0, 80);
}

function hitTargetUrl(h: Hit): string {
  const params = new URLSearchParams();
  const tab = hitTab(h.kind);
  const marker = firstHitText(h.snippet);
  if (tab) params.set("tab", tab);
  if (marker) params.set("snippet", marker);
  const qs = params.toString();
  return `/inbox/${h.stem}${qs ? `?${qs}` : ""}`;
}

function itemTargetUrl(item: Item): string {
  return item.t === "hit" ? hitTargetUrl(item) : item.href;
}

function itemKey(item: Item, i: number): string {
  if (item.t === "go") return `go-${item.href}`;
  return item.t === "setting" ? `setting-${item.category}-${i}` : `${item.kind}-${item.stem}-${i}`;
}

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

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const t = useT();

  const debouncedQ = useDebounced(q, 200);
  const { data, isFetching } = trpc.search.run.useQuery(
    { query: debouncedQ, limit: 8 },
    { enabled: debouncedQ.trim().length > 0 },
  );
  const { data: schema } = useSettingsSchema();
  const hits: Hit[] = (data?.hits as Hit[] | undefined) ?? [];
  const searching = q.trim().length > 0;

  const items = useMemo<Item[]>(() => {
    const needle = q.trim().toLowerCase();
    const destinations: Item[] = ALL_DESTINATIONS
      .map((destination) => ({ t: "go" as const, href: destination.to, label: t(destination.labelKey), icon: destination.icon }))
      .filter((destination) => !needle || destination.label.toLowerCase().includes(needle));
    if (!needle) return destinations;
    const listed = new Set(destinations.map((destination) => destination.t === "go" ? destination.href : ""));
    const settingItems: Item[] = buildSettingHits(debouncedQ, schema, t)
      .filter((setting) => !listed.has(`/settings/${setting.category}`))
      .map((setting) => ({ t: "setting", ...setting }));
    const hitItems: Item[] = hits.map((hit) => ({ t: "hit", ...hit }));
    return [...destinations, ...settingItems, ...hitItems];
  }, [q, debouncedQ, schema, hits, t]);

  // Take focus on open, and hand it back to whatever had it on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  useEffect(() => { setFocused(0); }, [q, debouncedQ]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(".gs-result.focus")?.scrollIntoView?.({ block: "nearest" });
  }, [focused]);

  const open = (item: Item) => {
    navigate(itemTargetUrl(item));
    onClose();
  };

  const onInputKey = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setFocused((index) => Math.min(index + 1, items.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setFocused((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      const item = items[focused];
      if (item) open(item);
    }
  };

  return (
    <div className="gs-scrim" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="gs-palette" role="dialog" aria-modal="true" aria-label={t("search.placeholder")}>
        <div className="gs-input-wrap">
          <SearchIcon size={17} strokeWidth={1.8} aria-hidden="true" />
          <input
            ref={inputRef}
            className="gs-input"
            type="text"
            role="combobox"
            autoComplete="off"
            spellCheck={false}
            placeholder={t("search.prompt")}
            aria-label={t("search.placeholder")}
            aria-expanded="true"
            aria-controls="gs-list"
            value={q}
            onChange={(event) => setQ(event.target.value)}
            onKeyDown={onInputKey}
          />
          <kbd className="kbd" aria-hidden="true">esc</kbd>
        </div>
        <div ref={listRef} id="gs-list" className="gs-list" role="listbox" aria-label={t("search.placeholder")}>
          {!searching && <div className="gs-group">{t("search.goTo")}</div>}
          {items.map((item, i) => {
            const Icon = item.t === "go" ? item.icon : item.t === "setting" ? SlidersHorizontal : FileText;
            return (
              <button
                key={itemKey(item, i)}
                type="button"
                role="option"
                aria-selected={i === focused}
                className={"gs-result" + (i === focused ? " focus" : "")}
                onMouseMove={() => setFocused(i)}
                onClick={() => open(item)}
              >
                <Icon size={16} strokeWidth={1.7} aria-hidden="true" />
                <span className="gs-result-title">{item.t === "hit" ? hitTitle(item) : item.label}</span>
                <span className="gs-result-meta">
                  {item.t === "hit" ? formatTimestamp(item.recordedAt) : item.t === "setting" ? t("search.result.settingMeta") : ""}
                </span>
                {item.t === "hit" && <span className="gs-result-snippet">{renderSnippet(item.snippet)}</span>}
              </button>
            );
          })}
          {searching && items.length === 0 && !isFetching && <div className="gs-empty">{t("search.empty")}</div>}
        </div>
      </div>
    </div>
  );
}
