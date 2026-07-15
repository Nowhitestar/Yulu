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
  elapsedSec?: number;
  level?: number;
  file?: string;
}

type RealtimeMsg = import("../../../src/pubsub.js").AppChannels["realtime-transcript"];

export function Pill() {
  const t = useT();
  const initial = trpc.recording.state.useQuery(undefined, {
    refetchInterval: 500,
    refetchIntervalInBackground: true,
  });
  const [state, setState] = useState<PillState>("unknown");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [realtime, setRealtime] = useState<RealtimeMsg | null>(null);
  const hotkey = (initial.data as { hotkey?: string } | undefined)?.hotkey ?? "⌘⇧V";
  const toggle = trpc.recording.toggle.useMutation();

  // The native menu and the web button both converge on the StatusAgent state.
  // WebSocket events are the fast path; polling repairs missed/cross-process events.
  useEffect(() => {
    const confirmedState = (initial.data as { state?: PillState } | undefined)?.state;
    if (confirmedState) {
      setState((current) => confirmedState === "unknown" && current !== "unknown" ? current : confirmedState);
      if (confirmedState === "idle") {
        setElapsed(0);
        setLevel(0);
        setRealtime(null);
      }
    }
  }, [initial.data, initial.dataUpdatedAt]);

  useEffect(() => {
    if (state !== "recording") return;
    const timer = window.setInterval(() => setElapsed((value) => value + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [state]);

  useWsChannel("recording", (msg: RecordingMsg) => {
    setState(msg.state);
    if (msg.state === "idle") {
      setElapsed(0);
      setLevel(0);
      setRealtime(null);
    }
    if (typeof msg.elapsedSec === "number") setElapsed(msg.elapsedSec);
    if (typeof msg.level === "number")      setLevel(msg.level);
  });

  useWsChannel("daemons", (msg) => {
    if (msg.name === "com.yulu.audiodaemon" && msg.status !== "running") setState("daemonDown");
  });

  useWsChannel("realtime-transcript", (msg) => {
    setRealtime(msg);
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
        <div className="pill-live-stack">
          {realtime?.text && (
            <div className="pill-live-transcript" role="log" aria-live="polite">
              <div className="pill-live-heading">{t("pill.realtime")}</div>
              <div className="pill-live-copy">{tailLines(realtime.text, 6)}</div>
            </div>
          )}
          <div className="pill pill-recording" role="status" aria-label={t("pill.recordingAria")}>
            <span className="pill-dot pulse" />
            <span className="pill-time">{formatElapsed(elapsed)}</span>
            <Meter level={level} />
            <button className="pill-stop" onClick={() => toggle.mutate()} aria-label={t("pill.stopAria")}>■</button>
          </div>
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

function tailLines(text: string, count: number): string {
  return text.split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(-count).join("\n");
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
