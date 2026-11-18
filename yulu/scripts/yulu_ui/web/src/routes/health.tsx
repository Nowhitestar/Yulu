import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { ChevronDown } from "lucide-react";
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
const TABS: Tab[] = ["doctor", "queue", "scheduler", "daemons", "logs"];
function tabFromHash(hash: string): Tab | null { const value = hash.slice(1) as Tab; return TABS.includes(value) ? value : null; }

export function Health() {
  const location = useLocation();
  const navigate = useNavigate();
  const t = useT();
  const tab = tabFromHash(location.hash);
  const [expanded, setExpanded] = useState(Boolean(tab));
  useEffect(() => { setExpanded(Boolean(tab)); }, [location.hash]);
  const switchTab = (next: Tab) => navigate({ pathname: "/health", search: location.search, hash: `#${next}` }, { replace: true });
  const selected = tab ?? "doctor";
  return <div className="health-page">
    <HealthSummary />
    <section className="runtime-diagnostics">
      <button type="button" className="runtime-diagnostics-toggle" aria-expanded={expanded} aria-controls="runtime-diagnostics" onClick={() => { if (expanded) { navigate({ pathname: "/health", search: location.search }, { replace: true }); setExpanded(false); } else { setExpanded(true); switchTab("doctor"); } }}>
        <span><strong>{t("runtime.advanced")}</strong><small>{t("runtime.advanced.note")}</small></span><ChevronDown size={17} />
      </button>
      {expanded && <div id="runtime-diagnostics">
        <div className="health-tabs" role="tablist" aria-label={t("runtime.advanced")}>
          {TABS.map((item) => <button key={item} type="button" role="tab" id={`runtime-tab-${item}`} aria-controls="runtime-diagnostic-panel" aria-selected={selected === item} tabIndex={selected === item ? 0 : -1} className={`health-tab${selected === item ? " active" : ""}`} onClick={() => switchTab(item)} onKeyDown={(event) => {
            if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const index = event.key === "Home" ? 0 : event.key === "End" ? TABS.length - 1 : (TABS.indexOf(item) + (event.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length;
            const next = TABS[index]!; switchTab(next); document.getElementById(`runtime-tab-${next}`)?.focus();
          }} data-testid={`tab-${item}`}>{t(`runtime.tab.${item}`)}</button>)}
        </div>
        <div className="health-tabpanel" id="runtime-diagnostic-panel" role="tabpanel" aria-labelledby={`runtime-tab-${selected}`}>
          {selected === "doctor" && <DoctorSection />}{selected === "queue" && <AgentQueueSection />}{selected === "scheduler" && <SchedulerSection />}{selected === "daemons" && <DaemonsSection />}{selected === "logs" && <LogsSection />}
        </div>
      </div>}
    </section>
  </div>;
}
