import { HeartPulse } from "lucide-react";
import { trpc } from "../../trpc.js";
import { useDaemonHealthState } from "../../hooks/useDaemonHealthState.js";
import { useT } from "../../i18n/LanguageProvider.js";
import type { DaemonHealth } from "../DaemonCard.js";
import "./HealthSummary.css";

const STATUS_KEY: Record<string, string> = {
  ok: "health.summary.ok",
  warn: "health.summary.warn",
  crit: "health.summary.crit",
  loading: "health.summary.loading",
};

export function HealthSummary() {
  const state = useDaemonHealthState();
  const t = useT();
  const { data } = trpc.daemons.health.useQuery(undefined, { refetchInterval: 5_000 });
  const daemons = (data as DaemonHealth[] | undefined) ?? [];
  const running = daemons.filter((d) => d.status === "running").length;
  const idle = daemons.filter((d) => d.status === "idle").length;
  const stopped = daemons.filter((d) => d.status === "stopped").length;
  const crashed = daemons.filter((d) => d.status === "crashed").length;

  return (
    <div className={`health-summary state-${state}`} data-testid="health-summary">
      <div className="health-summary-pulse">
        <HeartPulse size={22} strokeWidth={2.2} />
      </div>
      <div className="health-summary-text">
        <b>{t(STATUS_KEY[state] ?? "health.summary.loading")}</b>
        <small>{t("health.summary.polling")}</small>
      </div>
      <div className="health-summary-counters">
        <div className="health-counter"><span className="dot dot-ok" />{t("health.counter.running", { n: running })}</div>
        <div className="health-counter"><span className="dot dot-idle" />{t("health.counter.idle", { n: idle })}</div>
        <div className="health-counter"><span className="dot dot-warn" />{t("health.counter.stopped", { n: stopped })}</div>
        <div className="health-counter"><span className="dot dot-crit" />{t("health.counter.crashed", { n: crashed })}</div>
      </div>
    </div>
  );
}
