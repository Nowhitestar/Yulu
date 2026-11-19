import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ChevronDown } from "lucide-react";
import { trpc } from "../trpc.js";
import { useWsChannel } from "../ws.js";
import { useT } from "../i18n/LanguageProvider.js";
import { MarkdownView } from "../components/MarkdownView.js";
import { LiveNotesView } from "../components/LiveNotesView.js";
import type { AppChannels } from "../../../src/pubsub.js";
import "./live.css";

type Snapshot = NonNullable<AppChannels["live-notes"]>;

interface PanelBridge { postMessage(message: unknown): void }

/** The native notes panel hosts this page; in a browser it has no bridge. */
function panelBridge(): PanelBridge | null {
  const handlers = (window as { webkit?: { messageHandlers?: { yuluPanel?: PanelBridge } } }).webkit?.messageHandlers;
  return handlers?.yuluPanel ?? null;
}

function elapsed(seconds: number | undefined): string {
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
 * when something needs attention.
 */
export function LivePanel() {
  const t = useT();
  const current = trpc.liveNotes.current.useQuery(undefined, { refetchOnWindowFocus: false });
  const addNote = trpc.liveNotes.addNote.useMutation();
  const setLanguage = trpc.liveNotes.setLanguage.useMutation();
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [seconds, setSeconds] = useState<number | undefined>(undefined);
  const [draft, setDraft] = useState("");
  const [noteError, setNoteError] = useState("");
  const [bridge] = useState(panelBridge);
  const previous = useRef(new Map<string, string>());
  const [fresh, setFresh] = useState<Set<string>>(new Set());

  useEffect(() => { if (current.data !== undefined) setSnapshot(current.data); }, [current.data]);
  useWsChannel("live-notes", (payload) => setSnapshot(payload));
  useWsChannel("recording", (payload) => { if (typeof payload.elapsedSec === "number") setSeconds(payload.elapsedSec); });

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
      <header className="live-head">
        <span className="live-dot" aria-hidden="true" />
        <span className="live-time">{elapsed(seconds)}</span>
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
          <button type="button" className="icon-btn" aria-label={t("live.collapse")} onClick={() => bridge.postMessage({ action: "collapse" })}>
            <ChevronDown size={16} strokeWidth={1.8} />
          </button>
        )}
      </header>

      <div className="live-body">
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
