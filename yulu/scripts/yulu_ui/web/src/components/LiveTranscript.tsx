// web/src/components/LiveTranscript.tsx
import { useEffect, useRef, useState } from "react";
import { Radio, X } from "lucide-react";
import { useWsChannel } from "../ws.js";
import "./LiveTranscript.css";

interface LiveMsg {
  active: boolean;
  stem?: string;
  text?: string;
}

/**
 * Floating live-caption panel. While a recording is in progress the server
 * tails its `.realtime.transcript.txt` and streams the text over the
 * `live-transcript` WS channel; this panel shows it updating in real time and
 * auto-scrolls to the newest line. It hides itself when no recording is active
 * (server publishes `{ active: false }`) and can be dismissed for the current
 * recording. Mounted globally in RootLayout so captions follow you across pages.
 */
export function LiveTranscript() {
  const [active, setActive] = useState(false);
  const [text, setText] = useState("");
  const [stem, setStem] = useState<string | undefined>();
  const [dismissedStem, setDismissedStem] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  useWsChannel("live-transcript", (msg: LiveMsg) => {
    if (!msg.active) {
      setActive(false);
      return;
    }
    setActive(true);
    setStem(msg.stem);
    setText(msg.text ?? "");
  });

  // Auto-scroll to the latest caption as text grows.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [text, active]);

  // A new recording clears any prior dismissal so captions reappear.
  useEffect(() => {
    if (stem && dismissedStem && stem !== dismissedStem) setDismissedStem(null);
  }, [stem, dismissedStem]);

  if (!active) return null;
  if (stem && stem === dismissedStem) return null;

  const lines = formatLines(text);

  return (
    <section className="live-transcript" role="status" aria-label="Live transcript" data-testid="live-transcript">
      <header className="lt-head">
        <span className="lt-dot" aria-hidden="true">
          <Radio size={12} strokeWidth={2} />
        </span>
        <span className="lt-title">
          Live transcript
        </span>
        <button
          className="lt-close"
          type="button"
          aria-label="Hide live transcript"
          onClick={() => setDismissedStem(stem ?? null)}
        >
          <X size={13} strokeWidth={2} />
        </button>
      </header>
      <div className="lt-body" ref={bodyRef}>
        {lines.length === 0 ? (
          <p className="lt-waiting">Listening…</p>
        ) : (
          lines.map((line, i) => (
            <p className="lt-line" key={i}>
              {line.tag ? <span className={`lt-tag lt-tag-${line.tag}`}>{line.tag === "Me" ? "You" : "Them"}</span> : null}
              <span className="lt-text">{line.text}</span>
            </p>
          ))
        )}
      </div>
    </section>
  );
}

interface CaptionLine { tag: "Me" | "Them" | null; text: string; }

const TAG_RE = /^\[(Me|Them)\]\s*/;

export function formatLines(raw: string): CaptionLine[] {
  const out: CaptionLine[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = TAG_RE.exec(trimmed);
    if (m) {
      out.push({ tag: m[1] as "Me" | "Them", text: trimmed.slice(m[0].length) });
    } else {
      out.push({ tag: null, text: trimmed });
    }
  }
  return out;
}
