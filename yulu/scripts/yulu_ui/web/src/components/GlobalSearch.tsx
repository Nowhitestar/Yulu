// web/src/components/GlobalSearch.tsx
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router";
import {
  Bot,
  CalendarClock,
  Database,
  Link2,
  Loader2,
  MessageSquare,
  Search as SearchIcon,
  Send,
  Sparkles,
  UserRound,
  X,
} from "lucide-react";
import { trpc } from "../trpc.js";
import { useDebounced } from "../hooks/useDebounced.js";
import { useSettingsSchema } from "../hooks/useSettingsSchema.js";
import { categoryLabelKey } from "./settings/categories.js";
import { useT, type TFunc } from "../i18n/LanguageProvider.js";
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
// category - the backend search index has no notion of settings.
interface SettingHit {
  kind: "setting";
  category: string;
  label: string;
}

type Item = ({ t: "hit" } & Hit) | ({ t: "setting" } & SettingHit);
type SearchMode = "search" | "ask";

interface AskSource {
  kind: string;
  stem: string;
  title: string;
  recordedAt: string;
  sourcePath: string;
  snippet: string;
  url: string;
}

interface AskResponse {
  answer: string;
  sources: AskSource[];
  usedFallback: boolean;
  llmStatus: string;
  llmError?: string | null;
  search?: {
    telemetry?: {
      plannedQueries?: string[];
      mergedHitCount?: number;
    };
  };
  agentRuntime?: {
    provider: string;
    label: string;
    source: string;
    commandPreview: string;
    cwd: string;
    status: string;
  };
  connectorContext: {
    calendar: {
      configured: number;
      enabled: number;
      schedulerMode?: string;
      schedulerProvider?: string;
      schedulerStatus?: string;
      upcomingMeetings: Array<{ title: string; start: string }>;
    };
    outputs: Array<{
      channel: string;
      label: string;
      enabled: boolean;
      destination: string;
      connected?: boolean;
      contextStatus?: string;
    }>;
  };
}

interface AskTurn {
  id: string;
  question: string;
  pending: boolean;
  result?: AskResponse;
  error?: string;
}

/**
 * Build setting hits for a query by matching the registry's labels + categories
 * (case-insensitive substring). One hit per matching category (deduped), so the
 * result jumps straight to /settings/:category. Capped to keep the popover tight.
 */
function buildSettingHits(
  query: string,
  schema: ReadonlyArray<{ path: string; category: string; label: string }> | undefined,
  t: TFunc,
): SettingHit[] {
  const q = query.trim().toLowerCase();
  if (!q || !schema) return [];
  const byCategory = new Map<string, SettingHit>();
  for (const s of schema) {
    const catLabel = t(categoryLabelKey(s.category));
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

function kindLabel(kind: string, t: TFunc): string {
  // Backend emits kinds like "meeting_summary", "meeting_transcript".
  // Show only the top-level type ("meeting") in the badge.
  if (kind.startsWith("meeting")) return t("search.kind.meeting");
  if (kind === "summary") return t("search.kind.summary");
  if (kind === "setting") return t("search.kind.setting");
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

function hitTimestamp(h: Hit): string {
  return formatTimestamp(h.recordedAt);
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

function latestAskResult(turns: AskTurn[]): AskResponse | null {
  for (let i = turns.length - 1; i >= 0; i -= 1) {
    const turn = turns[i];
    if (turn?.result) return turn.result;
  }
  return null;
}

function plannedQueries(result: AskResponse | null): string[] {
  return result?.search?.telemetry?.plannedQueries ?? [];
}

function mergedHitCount(result: AskResponse | null): number {
  return result?.search?.telemetry?.mergedHitCount ?? result?.sources.length ?? 0;
}

function agentStatusLabel(status: string | undefined, t: TFunc): string {
  const key = `search.ask.agentStatus.${status || "missing"}`;
  const translated = t(key);
  return translated === key ? status || t("search.ask.agentStatus.missing") : translated;
}

function connectorTone(output: AskResponse["connectorContext"]["outputs"][number]): string {
  if (!output.enabled) return "muted";
  if (output.connected === true) return "ready";
  return "warn";
}

function statusTone(status: string | undefined): string {
  if (status === "ready" || status === "ok") return "ready";
  if (status === "disabled") return "muted";
  return "warn";
}

function AskStatusItem({
  icon,
  title,
  value,
  detail,
  tone = "neutral",
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  detail?: string;
  tone?: string;
}) {
  return (
    <div className={`gs-status-item gs-status-item-${tone}`}>
      <span className="gs-status-icon" aria-hidden="true">{icon}</span>
      <span className="gs-status-copy">
        <span className="gs-status-title">{title}</span>
        <span className="gs-status-value">{value}</span>
        {detail && <span className="gs-status-detail">{detail}</span>}
      </span>
    </div>
  );
}

function AskStatusRail({ result, t }: { result: AskResponse | null; t: TFunc }) {
  const agent = result?.agentRuntime;
  const queries = plannedQueries(result);
  const sourceCount = result?.sources.length ?? 0;
  const hitCount = mergedHitCount(result);
  const calendar = result?.connectorContext.calendar;
  const outputs = result?.connectorContext.outputs ?? [];
  return (
    <aside className="gs-ask-rail" aria-label={t("search.ask.status.aria")}>
      <div className="gs-rail-heading">
        <Bot size={15} strokeWidth={2} />
        <span>{t("search.ask.status.title")}</span>
      </div>
      <AskStatusItem
        icon={<Sparkles size={14} strokeWidth={2} />}
        title={t("search.ask.status.agent")}
        value={agent ? `${agent.label} · ${agentStatusLabel(agent.status, t)}` : t("search.ask.status.waiting")}
        detail={agent?.source ? t("search.ask.status.agentSource", { source: agent.source }) : undefined}
        tone={statusTone(agent?.status)}
      />
      <AskStatusItem
        icon={<Database size={14} strokeWidth={2} />}
        title={t("search.ask.status.local")}
        value={t("search.ask.status.seed", { sources: sourceCount, hits: hitCount })}
        detail={queries.length > 0 ? t("search.ask.status.queries", { n: queries.length }) : t("search.ask.status.noQueries")}
        tone={sourceCount > 0 ? "ready" : result ? "warn" : "neutral"}
      />
      <AskStatusItem
        icon={<CalendarClock size={14} strokeWidth={2} />}
        title={t("search.ask.status.scheduler")}
        value={calendar?.schedulerProvider || t("search.ask.status.native")}
        detail={calendar?.schedulerStatus || t("search.ask.status.waiting")}
        tone={calendar?.enabled ? "ready" : "warn"}
      />
      <div className="gs-rail-section">
        <div className="gs-rail-section-title">
          <Link2 size={13} strokeWidth={2} />
          <span>{t("search.ask.status.connectors")}</span>
        </div>
        {outputs.length === 0 ? (
          <div className="gs-connector-line muted">{t("search.ask.status.noConnectors")}</div>
        ) : outputs.map((output) => (
          <div key={output.channel} className={`gs-connector-line ${connectorTone(output)}`}>
            <span>{output.label}</span>
            <span>
              {output.enabled ? output.destination : t("search.ask.connector.disabled")}
              {output.enabled && output.connected !== true ? ` · ${t("search.ask.connector.localOnly")}` : ""}
            </span>
          </div>
        ))}
      </div>
      {queries.length > 0 && (
        <div className="gs-query-plan">
          <div className="gs-query-plan-title">{t("search.ask.status.queryPlan")}</div>
          {queries.slice(0, 5).map((query) => <span key={query}>{query}</span>)}
        </div>
      )}
    </aside>
  );
}

function AskSourceRows({
  sources,
  onOpenSource,
  t,
}: {
  sources: AskSource[];
  onOpenSource: (source: AskSource) => void;
  t: TFunc;
}) {
  if (sources.length === 0) return null;
  return (
    <div className="gs-ask-sources">
      <div className="gs-ask-sources-title">{t("search.ask.sources")}</div>
      {sources.map((source) => (
        <button
          key={`${source.kind}-${source.sourcePath}-${source.url}`}
          type="button"
          className="gs-ask-source"
          onClick={() => onOpenSource(source)}
        >
          <span className={`gs-kind ${kindClass(source.kind)}`}>{kindLabel(source.kind, t)}</span>
          <span className="gs-ask-source-main">
            <span className="gs-ask-source-title">{source.title}</span>
            <span className="gs-ask-source-snippet">{source.snippet}</span>
          </span>
          <span className="gs-ask-source-meta">{formatTimestamp(source.recordedAt)}</span>
        </button>
      ))}
    </div>
  );
}

function AskTurnView({
  turn,
  onOpenSource,
  t,
}: {
  turn: AskTurn;
  onOpenSource: (source: AskSource) => void;
  t: TFunc;
}) {
  return (
    <div className="gs-turn">
      <div className="gs-chat-row gs-chat-user">
        <div className="gs-chat-avatar" aria-hidden="true"><UserRound size={14} strokeWidth={2} /></div>
        <div className="gs-chat-message">
          <div className="gs-chat-meta"><span>{t("search.ask.user")}</span></div>
          <div className="gs-user-question">{turn.question}</div>
        </div>
      </div>
      <div className="gs-chat-row gs-chat-agent">
        <div className="gs-chat-avatar" aria-hidden="true">
          {turn.pending ? <Loader2 className="gs-spin" size={14} strokeWidth={2} /> : <Sparkles size={14} strokeWidth={2} />}
        </div>
        <div className="gs-chat-message">
          <div className="gs-chat-meta">
            <span>{t("search.ask.agent")}</span>
            {turn.result && <span>{t("search.ask.sourceCount", { n: turn.result.sources.length })}</span>}
            {turn.result?.usedFallback && <span>{t("search.ask.fallback")}</span>}
          </div>
          {turn.pending && <div className="gs-ask-answer pending">{t("search.ask.pendingDetail")}</div>}
          {turn.error && <div className="gs-ask-error">{turn.error}</div>}
          {turn.result && (
            <>
              <div className="gs-ask-answer">{turn.result.answer}</div>
              <AskSourceRows sources={turn.result.sources} onOpenSource={onOpenSource} t={t} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AskEmptyState({ t }: { t: TFunc }) {
  return (
    <div className="gs-ask-empty">
      <MessageSquare size={16} strokeWidth={2} />
      <div>
        <div className="gs-ask-empty-title">{t("search.ask.emptyTitle")}</div>
        <div className="gs-ask-empty-copy">{t("search.ask.ready")}</div>
      </div>
    </div>
  );
}

function AskWorkspace({
  draftQuestion,
  turns,
  isPending,
  latestResult,
  onAsk,
  onOpenSource,
  t,
}: {
  draftQuestion: string;
  turns: AskTurn[];
  isPending: boolean;
  latestResult: AskResponse | null;
  onAsk: () => void;
  onOpenSource: (source: AskSource) => void;
  t: TFunc;
}) {
  return (
    <div className="gs-ask-panel">
      <div className="gs-ask-toolbar">
        <div className="gs-ask-scope">
          <Sparkles size={13} strokeWidth={2} />
          <span>{t("search.ask.scope")}</span>
        </div>
        <button
          type="button"
          className="gs-ask-submit"
          disabled={!draftQuestion || isPending}
          onClick={onAsk}
        >
          {isPending ? <Loader2 className="gs-spin" size={13} strokeWidth={2} /> : <Send size={13} strokeWidth={2} />}
          {isPending ? t("search.ask.pending") : t("search.ask.submit")}
        </button>
      </div>
      <div className="gs-ask-workspace">
        <div className="gs-thread">
          {turns.length === 0 ? (
            <AskEmptyState t={t} />
          ) : turns.map((turn) => (
            <AskTurnView key={turn.id} turn={turn} onOpenSource={onOpenSource} t={t} />
          ))}
        </div>
        <AskStatusRail result={latestResult} t={t} />
      </div>
    </div>
  );
}

export function GlobalSearch() {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<SearchMode>("search");
  const [focused, setFocused] = useState(0);
  const [askTurns, setAskTurns] = useState<AskTurn[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const t = useT();

  const debouncedQ = useDebounced(q, 200);
  const { data, isFetching } = trpc.search.run.useQuery(
    { query: debouncedQ, limit: 8 },
    { enabled: debouncedQ.trim().length > 0 },
  );
  const { data: schema } = useSettingsSchema();
  const askMutation = trpc.ask.ask.useMutation();
  const hits: Hit[] = (data?.hits as Hit[] | undefined) ?? [];
  const trimmedQ = q.trim();
  const latestResult = useMemo(() => latestAskResult(askTurns), [askTurns]);
  const isAskPending = askMutation.isPending || askTurns.some((turn) => turn.pending);
  const shouldShowPopover = open && (q.length > 0 || mode === "ask" || askTurns.length > 0);

  // Settings hits are synthesised client-side and listed first (they're exact,
  // navigational), then the backend recording/summary hits. Keyboard nav runs
  // over the combined list.
  const items = useMemo<Item[]>(() => {
    const settingItems: Item[] = buildSettingHits(debouncedQ, schema, t).map((s) => ({ t: "setting", ...s }));
    const hitItems: Item[] = hits.map((h) => ({ t: "hit", ...h }));
    return [...settingItems, ...hitItems];
  }, [debouncedQ, schema, hits, t]);

  // Cmd/Ctrl+K global focus. Keep this listener stable so typing does not
  // repeatedly unregister/register a global handler.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      const cmdK = (e.metaKey || e.ctrlKey) && (key === "k" || e.code === "KeyK");
      if (cmdK) {
        e.preventDefault();
        setOpen(true);
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
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

  const askQuestion = useCallback(async () => {
    const question = q.trim();
    if (!question || isAskPending) return;
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    setMode("ask");
    setOpen(true);
    setAskTurns((turns) => [...turns, { id, question, pending: true }]);
    setQ("");
    try {
      const result = await askMutation.mutateAsync({ question, limit: 10 });
      setAskTurns((turns) => turns.map((turn) => (
        turn.id === id ? { ...turn, pending: false, result: result as AskResponse } : turn
      )));
    } catch (err) {
      setAskTurns((turns) => turns.map((turn) => (
        turn.id === id
          ? { ...turn, pending: false, error: (err as Error).message || t("search.ask.error") }
          : turn
      )));
    }
  }, [askMutation, isAskPending, q, t]);

  const onInputKey = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        inputRef.current?.blur();
        return;
      }
      if (e.key === "Enter" && mode === "ask") {
        e.preventDefault();
        void askQuestion();
        return;
      }
      if (mode !== "search" || !open || items.length === 0) return;
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
    [askQuestion, focused, items, mode, navigate, open],
  );

  const onOpenSource = useCallback((source: AskSource) => {
    navigate(source.url);
    setOpen(false);
  }, [navigate]);

  return (
    <div className="gs-root">
      <div className="gs-input-wrap">
        <SearchIcon className="gs-icon" size={13} strokeWidth={2} />
        <input
          ref={inputRef}
          className="gs-input"
          type="search"
          placeholder={t("search.placeholder")}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (q.length > 0 || mode === "ask" || askTurns.length > 0) setOpen(true);
          }}
          onKeyDown={onInputKey}
          aria-expanded={open}
          aria-controls="gs-popover"
        />
        {q && (
          <button
            type="button"
            className="gs-clear"
            aria-label={t("search.clear")}
            onClick={() => {
              setQ("");
              if (mode !== "ask") setOpen(false);
              inputRef.current?.focus();
            }}
          >
            <X size={14} strokeWidth={2.3} />
          </button>
        )}
        <span className="gs-kbd" aria-hidden="true">⌘K</span>
      </div>

      {shouldShowPopover && (
        <div ref={popoverRef} id="gs-popover" className={`gs-popover gs-popover-${mode}`}>
          <div className="gs-modebar" role="tablist" aria-label={t("search.mode.aria")}>
            <button
              type="button"
              className={`gs-mode ${mode === "search" ? "active" : ""}`}
              aria-selected={mode === "search"}
              onClick={() => setMode("search")}
            >
              <SearchIcon size={12} strokeWidth={2} />
              {t("search.mode.search")}
            </button>
            <button
              type="button"
              className={`gs-mode ${mode === "ask" ? "active" : ""}`}
              aria-selected={mode === "ask"}
              onClick={() => setMode("ask")}
            >
              <Sparkles size={12} strokeWidth={2} />
              {t("search.mode.ask")}
            </button>
          </div>

          {mode === "search" ? (
            <>
              <div role="listbox">
                {items.length === 0 && !isFetching && (
                  <div className="gs-empty">{t("search.empty")}</div>
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
                        <span className={`gs-kind ${kindClass("setting")}`}>{t("search.kind.setting")}</span>
                        <span className="gs-result-title">{item.label}</span>
                        <span className="gs-result-meta">{t("search.result.settingMeta")}</span>
                      </div>
                    ) : (
                      <>
                        <div className="gs-result-line1">
                          <span className={`gs-kind ${kindClass(item.kind)}`}>{kindLabel(item.kind, t)}</span>
                          <span className="gs-result-title">{hitTitle(item)}</span>
                          <span className="gs-result-meta">{hitTimestamp(item)}</span>
                        </div>
                        <div className="gs-result-snippet">{renderSnippet(item.snippet)}</div>
                      </>
                    )}
                  </button>
                ))}
              </div>
              <div className="gs-footer">
                <span><kbd>↑↓</kbd> {t("search.footer.navigate")}</span>
                <span><kbd>↵</kbd> {t("search.footer.open")}</span>
                <span><kbd>esc</kbd> {t("search.footer.close")}</span>
                <span className="gs-footer-count">
                  {items.length === 1
                    ? t("search.footer.count.one", { n: items.length })
                    : t("search.footer.count.other", { n: items.length })}
                </span>
              </div>
            </>
          ) : (
            <AskWorkspace
              draftQuestion={trimmedQ}
              turns={askTurns}
              isPending={isAskPending}
              latestResult={latestResult}
              onAsk={() => void askQuestion()}
              onOpenSource={onOpenSource}
              t={t}
            />
          )}
        </div>
      )}
    </div>
  );
}
