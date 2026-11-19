import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ChevronDown, Square } from "lucide-react";
import { trpc } from "../trpc.js";
import { useWsChannel } from "../ws.js";
import { useT } from "../i18n/LanguageProvider.js";
import { MarkdownView } from "../components/MarkdownView.js";
import { LiveNotesView } from "../components/LiveNotesView.js";
import type { AppChannels } from "../../../src/pubsub.js";
import "./live.css";

type Snapshot = NonNullable<AppChannels["live-notes"]>;

interface PanelBridge { postMessage(message: unknown): void }

/** What the native panel reports about the recording itself. */
interface PanelState { stopping: boolean; warning: string | null }

/** The native notes panel hosts this page; in a browser it has no bridge. */
function panelBridge(): PanelBridge | null {
  const handlers = (window as { webkit?: { messageHandlers?: { yuluPanel?: PanelBridge } } }).webkit?.messageHandlers;
  return handlers?.yuluPanel ?? null;
}

/** Seconds since the recording started, ticking once a second. */
function useElapsed(startedAt: string | undefined, running: boolean): number | undefined {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  const start = startedAt ? Date.parse(startedAt) : Number.NaN;
  return Number.isFinite(start) ? Math.max(0, (now - start) / 1_000) : undefined;
}

/** The native panel paints its glass to match the page's light or dark theme. */
function useAppearanceForPanel(bridge: PanelBridge | null) {
  useEffect(() => {
    if (!bridge) return;
    const root = document.documentElement;
    const post = () => bridge.postMessage({ action: "appearance", dark: root.getAttribute("data-theme") === "dark" });
    post();
    const observer = new MutationObserver(post);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, [bridge]);
}

function panelStateFrom(value: unknown): PanelState {
  const detail = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof PanelState, unknown>>;
  return {
    stopping: detail.stopping === true,
    warning: typeof detail.warning === "string" && detail.warning ? detail.warning : null,
  };
}

export function elapsed(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "";
  const whole = Math.floor(seconds);
  const pad = (value: number) => String(value).padStart(2, "0");
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  return hours ? `${hours}:${pad(minutes)}:${pad(whole % 60)}` : `${pad(minutes)}:${pad(whole % 60)}`;
}

/** Split notes at `## ` headings so each section can show it just changed. */
function sections(markdown: string): Array<{ key: string; text: string }> {
  const parts = markdown.split(/\n(?=## )/).map((part) => part.trim()).filter(Boolean);
  const seen = new Map<string, number>();
  return parts.map((text) => {
    const heading = text.split("\n", 1)[0] ?? "";
    const count = seen.get(heading) ?? 0;
    seen.set(heading, count + 1);
    return { key: `${heading}#${count}`, text };
  });
}

/**
 * Live notes for the meeting being recorded: what Yulu has written so far,
 * the attendee's own notes, and one line to add another. Status appears only
 * when something needs attention. In the native floating panel the header also
 * stops the recording and collapses the panel to Yulu's icon.
 */
export function LivePanel() {
  const t = useT();
  const current = trpc.liveNotes.current.useQuery(undefined, { refetchOnWindowFocus: false });
  const addNote = trpc.liveNotes.addNote.useMutation();
  const setLanguage = trpc.liveNotes.setLanguage.useMutation();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [draft, setDraft] = useState("");
  const [noteError, setNoteError] = useState("");
  const [bridge] = useState(panelBridge);
  const [panel, setPanel] = useState<PanelState>({ stopping: false, warning: null });
  const seconds = useElapsed(snapshot?.startedAt, Boolean(snapshot) && snapshot?.status !== "finished");
  useAppearanceForPanel(bridge);
  const previous = useRef(new Map<string, string>());
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!bridge) return;
    const onState = (event: Event) => setPanel(panelStateFrom((event as CustomEvent<unknown>).detail));
    // The panel may have reported before this page mounted.
    setPanel(panelStateFrom((window as { __yuluPanelState?: unknown }).__yuluPanelState));
    window.addEventListener("yulu-panel", onState);
    return () => window.removeEventListener("yulu-panel", onState);
  }, [bridge]);
  useEffect(() => { if (current.data !== undefined) setSnapshot(current.data); }, [current.data]);
  useWsChannel("live-notes", (payload) => setSnapshot(payload));

  const parts = useMemo(() => sections(snapshot?.markdown ?? ""), [snapshot?.markdown]);
  useEffect(() => {
    const before = previous.current;
    const changed = new Set(parts.filter((part) => before.size > 0 && before.get(part.key) !== part.text).map((part) => part.key));
    previous.current = new Map(parts.map((part) => [part.key, part.text]));
    if (!changed.size) return;
    setFresh(changed);
    const timer = window.setTimeout(() => setFresh(new Set()), 5_000);
    return () => window.clearTimeout(timer);
  }, [parts]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text || !snapshot) return;
    setNoteError("");
    addNote.mutate({ stem: snapshot.stem, text }, {
      onSuccess: (next) => { setDraft(""); setSnapshot(next); },
      onError: (error) => setNoteError(error.message),
    });
  };
  const openSettings = () => {
    if (bridge) bridge.postMessage({ action: "open", route: "/settings/recording#live-notes" });
    else window.open("/settings/recording#live-notes", "_blank", "noopener");
  };

  if (!snapshot) {
    return (
      <main className="live-panel">
        <p className="live-quiet">{current.isPending ? "" : t("live.noRecording")}</p>
      </main>
    );
  }

  const unavailable = snapshot.status === "unavailable";
  const empty = !unavailable && !snapshot.markdown;
  return (
    <main className="live-panel" aria-label={t("live.title")}>
      <header
        className="live-head"
        onMouseDown={(event) => {
          // The header's empty space moves the floating panel.
          if (!bridge || event.button !== 0 || (event.target as Element).closest("button, a, input, [role='group']")) return;
          bridge.postMessage({ action: "drag" });
        }}
      >
        <span className="live-dot" aria-hidden="true" />
        <span className="live-time">{panel.stopping ? t("live.stopping") : elapsed(seconds)}</span>
        <span className="live-title">{snapshot.title}</span>
        <div className="seg live-lang" role="group" aria-label={t("settings.liveNotes.language")}>
          {(["zh", "en"] as const).map((language) => (
            <button
              key={language}
              type="button"
              aria-pressed={snapshot.language === language}
              onClick={() => setLanguage.mutate({ stem: snapshot.stem, language }, { onSuccess: setSnapshot })}
            >
              {language === "zh" ? "中" : "EN"}
            </button>
          ))}
        </div>
        {bridge && (
          <button
            type="button"
            className="icon-btn live-stop"
            aria-label={t("live.stop")}
            title={t("live.stop")}
            disabled={panel.stopping}
            onClick={() => bridge.postMessage({ action: "stop" })}
          >
            <Square size={11} strokeWidth={0} fill="currentColor" />
          </button>
        )}
        {bridge && (
          <button type="button" className="icon-btn" aria-label={t("live.collapse")} onClick={() => bridge.postMessage({ action: "collapse" })}>
            <ChevronDown size={16} strokeWidth={1.8} />
          </button>
        )}
      </header>

      <div className="live-body">
        {panel.warning && <p className="live-warning" role="alert">{panel.warning}</p>}
        {unavailable && (
          <div className="live-notice">
            <p className="live-notice-title">{t("live.unavailable.title")}</p>
            <p>{t(`live.unavailable.${snapshot.reason ?? "provider_off"}`)}</p>
            <button type="button" className="live-link" onClick={openSettings}>{t("live.openSettings")}</button>
          </div>
        )}
        {empty && (
          <div className="live-empty">
            <p>{t("live.empty")}</p>
            <p className="live-quiet">{t("live.emptyMine")}</p>
          </div>
        )}
        {snapshot.status === "failed" && <p className="live-quiet">{t("live.failed")}</p>}
        {parts.map((part) => (
          <div key={part.key} className={"live-section" + (fresh.has(part.key) ? " live-section--fresh" : "")}>
            <MarkdownView text={part.text} />
          </div>
        ))}
        {snapshot.myNotes.length > 0 && <LiveNotesView markdown={null} myNotes={snapshot.myNotes} />}
      </div>

      <form className="live-input" onSubmit={submit}>
        <label htmlFor="live-note" className="sr-only">{t("live.notePlaceholder")}</label>
        <input
          id="live-note"
          type="text"
          value={draft}
          maxLength={500}
          autoComplete="off"
          placeholder={t("live.notePlaceholder")}
          onChange={(event) => setDraft(event.target.value)}
        />
        <kbd aria-hidden="true">↵</kbd>
      </form>
      {noteError && <p className="live-error" role="alert">{noteError}</p>}
    </main>
  );
}
