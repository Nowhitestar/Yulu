// web/src/components/Pill.tsx
import { useEffect, useRef, useState } from "react";
import { Mic } from "lucide-react";
import { trpc } from "../trpc.js";
import { useWsChannel } from "../ws.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./Pill.css";

export type PillState = "idle" | "recording" | "processing" | "meetingBusy" | "daemonDown";

interface RecordingMsg {
  state: PillState;
  elapsedSec?: number;
  level?: number;
  file?: string;
}

export function Pill() {
  const t = useT();
  const initial = trpc.recording.state.useQuery();
  const [state, setState] = useState<PillState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const hotkey = (initial.data as { hotkey?: string } | undefined)?.hotkey ?? "⌘⇧V";
  const toggle = trpc.recording.toggle.useMutation();
  const hydratedRef = useRef(false);

  // Hydrate from initial fetch — only once. After that, WebSocket events drive
  // state transitions. This avoids the bootstrap query stomping live state
  // every time react-query rebuilds its result object on re-render.
  useEffect(() => {
    if (hydratedRef.current) return;
    const initState = (initial.data as { state?: PillState } | undefined)?.state;
    if (initState) {
      hydratedRef.current = true;
      setState(initState);
    }
  }, [initial.data]);

  useWsChannel("recording", (msg: RecordingMsg) => {
    setState(msg.state);
    if (typeof msg.elapsedSec === "number") setElapsed(msg.elapsedSec);
    if (typeof msg.level === "number")      setLevel(msg.level);
  });

  useWsChannel("daemons", (msg) => {
    if (msg.name === "com.yulu.audiodaemon" && msg.status !== "running") setState("daemonDown");
  });

  switch (state) {
    case "idle":
      return (
        <button className="pill pill-idle" onClick={() => toggle.mutate()} aria-label={t("pill.recordAria")}>
          <span className="pill-mic"><Mic size={12} strokeWidth={1.75} /></span>
          <span className="pill-label">{t("pill.record")}</span>
          <span className="pill-hotkey">{hotkey}</span>
        </button>
      );

    case "recording":
      return (
        <div className="pill pill-recording" role="status" aria-label={t("pill.recordingAria")}>
          <span className="pill-dot pulse" />
          <span className="pill-time">{formatElapsed(elapsed)}</span>
          <Meter level={level} />
          <button className="pill-stop" onClick={() => toggle.mutate()} aria-label={t("pill.stopAria")}>■</button>
        </div>
      );

    case "processing":
      return (
        <div className="pill pill-processing" role="status">
          <span className="pill-spinner" />
          <span>{t("pill.transcribing", { time: formatElapsed(elapsed) })}</span>
        </div>
      );

    case "meetingBusy":
      return (
        <div className="pill pill-meeting" role="status" title={t("pill.meeting")}>
          <span className="pill-dot" />
          <span>{t("pill.meeting")}</span>
        </div>
      );

    case "daemonDown":
      return (
        <a className="pill pill-down" href="/health/daemons" role="alert">
          <span className="pill-warn">⚠</span>
          <span>{t("pill.daemonDown")}</span>
        </a>
      );
  }
}

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

function Meter({ level }: { level: number }) {
  const cells = 6;
  const filled = Math.round(Math.max(0, Math.min(1, level)) * cells);
  return (
    <div className="pill-meter" aria-hidden="true">
      {Array.from({ length: cells }).map((_, i) => (
        <span key={i} className={i < filled ? "cell on" : "cell"} />
      ))}
    </div>
  );
}
