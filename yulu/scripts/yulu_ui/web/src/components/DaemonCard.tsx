// web/src/components/DaemonCard.tsx
import { Link } from "react-router";
import "./DaemonCard.css";

export interface DaemonHealth {
  name: string;
  status: "running" | "stopped" | "crashed";
  pid: number;
  exitStatus: number;
  lastLog: string;
}

export interface DaemonCardProps {
  daemon: DaemonHealth;
  onRestart: (name: string) => void;
  onStop: (name: string) => void;
  restartPending?: boolean;
  stopPending?: boolean;
}

const STATUS_GLYPH: Record<DaemonHealth["status"], string> = {
  running: "●",
  stopped: "⏸",
  crashed: "⚠",
};

const STATUS_LABEL: Record<DaemonHealth["status"], string> = {
  running: "running",
  stopped: "stopped",
  crashed: "crashed",
};

export function DaemonCard({ daemon, onRestart, onStop, restartPending, stopPending }: DaemonCardProps) {
  const shortName = daemon.name.replace(/^com\.yulu\./, "");
  return (
    <div className="daemon-card" data-status={daemon.status}>
      <div className="daemon-card-header">
        <div className="daemon-card-name">{shortName}</div>
        <span className="status-pill" data-status={daemon.status}>
          <span className="status-pill-glyph">{STATUS_GLYPH[daemon.status]}</span>
          <span className="status-pill-label">{STATUS_LABEL[daemon.status]}</span>
        </span>
      </div>
      <div className="daemon-card-meta">
        <div className="daemon-card-pid">PID {daemon.pid || "—"}</div>
        <div className="daemon-card-lastlog" title={daemon.lastLog}>{daemon.lastLog || "(no log entries yet)"}</div>
      </div>
      <div className="daemon-card-actions">
        <button
          type="button"
          className="daemon-card-btn restart"
          onClick={() => onRestart(daemon.name)}
          disabled={restartPending}
        >
          Restart
        </button>
        <button
          type="button"
          className="daemon-card-btn stop"
          onClick={() => onStop(daemon.name)}
          disabled={stopPending || daemon.status === "stopped"}
        >
          Stop
        </button>
        <Link to={`/health/logs?name=${encodeURIComponent(daemon.name)}`} className="daemon-card-btn link">
          View logs →
        </Link>
      </div>
    </div>
  );
}
