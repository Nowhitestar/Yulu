import { HeartPulse } from "lucide-react";
import { trpc } from "../../trpc.js";
import { useDaemonHealthState } from "../../hooks/useDaemonHealthState.js";
import type { DaemonHealth } from "../DaemonCard.js";
import "./HealthSummary.css";

const STATUS_LABEL: Record<string, string> = {
  ok: "All systems nominal",
  warn: "Some daemons not running",
  crit: "Daemon(s) crashed",
  loading: "Loading…",
};

export function HealthSummary() {
  const state = useDaemonHealthState();
  const { data } = trpc.daemons.health.useQuery(undefined, { refetchInterval: 5_000 });
  const daemons = (data as DaemonHealth[] | undefined) ?? [];
  const running = daemons.filter((d) => d.status === "running").length;
  const stopped = daemons.filter((d) => d.status === "stopped").length;
  const crashed = daemons.filter((d) => d.status === "crashed").length;

  return (
    <div className={`health-summary state-${state}`} data-testid="health-summary">
      <div className="health-summary-pulse">
        <HeartPulse size={22} strokeWidth={2.2} />
      </div>
      <div className="health-summary-text">
        <b>{STATUS_LABEL[state]}</b>
        <small>Polling daemons every 5 s</small>
      </div>
      <div className="health-summary-counters">
        <div className="health-counter"><span className="dot dot-ok" />{running} running</div>
        <div className="health-counter"><span className="dot dot-warn" />{stopped} stopped</div>
        <div className="health-counter"><span className="dot dot-crit" />{crashed} crashed</div>
      </div>
    </div>
  );
}
