// web/src/components/Pill.tsx
import { useEffect, useState } from "react";
import { Mic } from "lucide-react";
import { trpc } from "../trpc.js";
import { useWsChannel } from "../ws.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./Pill.css";

export type PillState = "idle" | "recording" | "processing" | "meetingBusy" | "daemonDown" | "unknown";

interface RecordingMsg {
  state: PillState;
  level?: number;
  file?: string;
}

export function Pill() {
  const t = useT();
  const initial = trpc.recording.state.useQuery(undefined, {
    refetchInterval: 500,
    refetchIntervalInBackground: true,
  });
  const [state, setState] = useState<PillState>("unknown");
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [level, setLevel] = useState(0);
  const hotkey = (initial.data as { hotkey?: string } | undefined)?.hotkey ?? "⌘⇧V";
  const toggle = trpc.recording.toggle.useMutation();

  // The native menu and the web button both converge on the StatusAgent state.
  // WebSocket events are the fast path; polling repairs missed/cross-process events.
  useEffect(() => {
    const confirmedState = (initial.data as { state?: PillState } | undefined)?.state;
    if (confirmedState) {
      setState(confirmedState);
      const timestamp = initial.data?.recordingStartedAt;
      const confirmedStart = confirmedState === "recording" && typeof timestamp === "number"
        && Number.isFinite(timestamp) && timestamp > 0 ? timestamp : null;
      setStartedAt(confirmedStart);
      if (confirmedState === "recording") {
        setElapsed(confirmedStart === null ? null : elapsedSince(confirmedStart));
      }
      if (confirmedState === "idle") {
        setElapsed(null);
        setLevel(0);
      }
    }
  }, [initial.data, initial.dataUpdatedAt]);

  useEffect(() => {
    if (state !== "recording" || startedAt === null) return;
    // Recompute from capture time so remounts and delayed background callbacks
    // never restart or slow down the recording clock.
    const timer = window.setInterval(() => setElapsed(elapsedSince(startedAt)), 1_000);
    return () => window.clearInterval(timer);
  }, [state, startedAt]);

  useWsChannel("recording", (msg: RecordingMsg) => {
    setState(msg.state);
    if (msg.state === "idle") {
      setStartedAt(null);
      setElapsed(null);
      setLevel(0);
    }
    if (msg.state === "recording" && state !== "recording") {
      setStartedAt(null);
      setElapsed(null);
    }
    if (typeof msg.level === "number")      setLevel(msg.level);
  });

  useWsChannel("daemons", (msg) => {
    if (msg.name === "com.yulu.audiodaemon" && msg.status !== "running") setState("daemonDown");
  });

  return <>
    {renderState()}
    {toggle.error && <div className="pill-command-error" role="alert">
      {t(toggle.error.message.includes("controls_quiescing") ? "pill.updatePaused" : "pill.commandFailed")}
    </div>}
  </>;

  function renderState() {
    switch (state) {
      case "idle":
        return (
          <button className="pill pill-idle" disabled={toggle.isPending} onClick={() => toggle.mutate()} aria-label={t("pill.recordAria")}>
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
            <button className="pill-stop" disabled={toggle.isPending} onClick={() => toggle.mutate()} aria-label={t("pill.stopAria")}>■</button>
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

      case "unknown":
        return (
          <div className="pill pill-down" role="alert">
            <span className="pill-warn">⚠</span>
            <span>{t("pill.statusUnavailable")}</span>
          </div>
        );
    }
  }
}

function elapsedSince(startedAt: number): number {
  return Math.max(0, Math.floor((Date.now() - startedAt) / 1_000));
}

function formatElapsed(sec: number | null): string {
  if (sec === null) return "--:--";
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
