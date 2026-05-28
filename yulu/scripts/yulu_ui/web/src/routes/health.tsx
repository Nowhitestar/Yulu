// web/src/routes/health.tsx
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { HealthSummary } from "../components/health/HealthSummary.js";
import { DaemonsSection } from "../components/health/DaemonsSection.js";
import { LogsSection } from "../components/health/LogsSection.js";
import "./health.css";

export const handle = { breadcrumb: "Health", filters: null };

type Tab = "daemons" | "logs";
const VALID_TABS: Tab[] = ["daemons", "logs"];

function tabFromHash(hash: string): Tab {
  const h = hash.replace(/^#/, "");
  return VALID_TABS.includes(h as Tab) ? (h as Tab) : "daemons";
}

export function Health() {
  const location = useLocation();
  const navigate = useNavigate();
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
        <button
          type="button"
          role="tab"
          aria-selected={tab === "daemons"}
          className={"health-tab" + (tab === "daemons" ? " active" : "")}
          onClick={() => switchTab("daemons")}
          data-testid="tab-daemons"
        >
          Daemons
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "logs"}
          className={"health-tab" + (tab === "logs" ? " active" : "")}
          onClick={() => switchTab("logs")}
          data-testid="tab-logs"
        >
          Logs
        </button>
      </div>
      <div className="health-tabpanel" role="tabpanel">
        {tab === "daemons" ? <DaemonsSection /> : <LogsSection />}
      </div>
    </div>
  );
}
