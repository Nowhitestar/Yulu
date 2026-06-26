// web/src/components/DaemonCard.tsx
import type { JSX } from "react";
import { Link } from "react-router";
import { Circle, Pause, AlertCircle, Clock3, Play } from "lucide-react";
import { useT } from "../i18n/LanguageProvider.js";
import "./DaemonCard.css";

export interface DaemonHealth {
  name: string;
  status: "running" | "idle" | "stopped" | "crashed";
  pid: number;
  exitStatus: number;
  lastLog: string;
}

export interface DaemonCardProps {
  daemon: DaemonHealth;
  onRestart: (name: string) => void;
  onStop: (name: string) => void;
  onStart?: (name: string) => void;
  restartPending?: boolean;
  stopPending?: boolean;
  startPending?: boolean;
}

const STATUS_GLYPH: Record<DaemonHealth["status"], JSX.Element> = {
  running: <Circle size={9} strokeWidth={3} fill="currentColor" />,
  idle: <Clock3 size={11} strokeWidth={2} />,
  stopped: <Pause size={11} strokeWidth={2} />,
  crashed: <AlertCircle size={11} strokeWidth={2} />,
};

const STATUS_KEY: Record<DaemonHealth["status"], string> = {
  running: "health.daemon.status.running",
  idle: "health.daemon.status.idle",
  stopped: "health.daemon.status.stopped",
  crashed: "health.daemon.status.crashed",
};

export function DaemonCard({ daemon, onRestart, onStop, onStart, restartPending, stopPending, startPending }: DaemonCardProps) {
  const t = useT();
  const shortName = daemon.name.replace(/^com\.yulu\./, "");
  return (
    <div className="daemon-card" data-status={daemon.status}>
      <div className="daemon-card-header">
        <div className="daemon-card-name">{shortName}</div>
        <span className="status-pill" data-status={daemon.status}>
          <span className="status-pill-glyph">{STATUS_GLYPH[daemon.status]}</span>
          <span className="status-pill-label">{t(STATUS_KEY[daemon.status])}</span>
        </span>
      </div>
      <div className="daemon-card-meta">
        <div className="daemon-card-pid">PID {daemon.pid || "—"}</div>
        <div className="daemon-card-lastlog" title={daemon.lastLog}>{daemon.lastLog || t("health.daemon.noLog")}</div>
      </div>
      <div className="daemon-card-actions">
        {daemon.status === "stopped" && onStart && (
          <button
            type="button"
            className="daemon-card-btn restart"
            onClick={() => onStart(daemon.name)}
            disabled={startPending}
          >
            <Play size={12} strokeWidth={2} />
            {t("health.daemon.start")}
          </button>
        )}
        <button
          type="button"
          className="daemon-card-btn restart"
          onClick={() => onRestart(daemon.name)}
          disabled={restartPending}
        >
          {t("health.daemon.restart")}
        </button>
        <button
          type="button"
          className="daemon-card-btn stop"
          onClick={() => onStop(daemon.name)}
          disabled={stopPending || daemon.status === "stopped"}
        >
          {t("health.daemon.stop")}
        </button>
        <Link to={`/health/logs?name=${encodeURIComponent(daemon.name)}`} className="daemon-card-btn link">
          {t("health.daemon.viewLogs")}
        </Link>
      </div>
    </div>
  );
}
