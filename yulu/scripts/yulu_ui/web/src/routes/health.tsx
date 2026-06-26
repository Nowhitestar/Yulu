// web/src/routes/health.tsx
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { HealthSummary } from "../components/health/HealthSummary.js";
import { DoctorSection } from "../components/health/DoctorSection.js";
import { AgentQueueSection } from "../components/health/AgentQueueSection.js";
import { SchedulerSection } from "../components/health/SchedulerSection.js";
import { DaemonsSection } from "../components/health/DaemonsSection.js";
import { LogsSection } from "../components/health/LogsSection.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./health.css";

export const handle = { breadcrumb: "breadcrumb.health", filters: null };

type Tab = "doctor" | "queue" | "scheduler" | "daemons" | "logs";
const VALID_TABS: Tab[] = ["doctor", "queue", "scheduler", "daemons", "logs"];

function tabFromHash(hash: string): Tab {
  const h = hash.replace(/^#/, "");
  return VALID_TABS.includes(h as Tab) ? (h as Tab) : "doctor";
}

export function Health() {
  const location = useLocation();
  const navigate = useNavigate();
  const t = useT();
  const [tab, setTab] = useState<Tab>(() => tabFromHash(location.hash));

  useEffect(() => {
    const next = tabFromHash(location.hash);
    if (next !== tab) setTab(next);
  }, [location.hash, tab]);

  const switchTab = (t: Tab) => {
    setTab(t);
    navigate({ pathname: "/health", search: location.search, hash: `#${t}` }, { replace: true });
  };

  return (
    <div className="health-page">
      <HealthSummary />
      <div className="health-tabs" role="tablist">
        {VALID_TABS.map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={tab === item}
            className={"health-tab" + (tab === item ? " active" : "")}
            onClick={() => switchTab(item)}
            data-testid={`tab-${item}`}
          >
            {t(`health.tab.${item}`)}
          </button>
        ))}
      </div>
      <div className="health-tabpanel" role="tabpanel">
        {tab === "doctor" && <DoctorSection />}
        {tab === "queue" && <AgentQueueSection />}
        {tab === "scheduler" && <SchedulerSection />}
        {tab === "daemons" && <DaemonsSection />}
        {tab === "logs" && <LogsSection />}
      </div>
    </div>
  );
}
