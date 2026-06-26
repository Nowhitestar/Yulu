// web/src/components/Sidebar.tsx
import { NavLink } from "react-router";
import { Settings as SettingsIcon, HeartPulse, Mic, FileText, BookOpen, Bot } from "lucide-react";
import type { ReactNode } from "react";
import type { CSSProperties } from "react";
import { Logo } from "./Logo.js";
import { useDaemonHealthState } from "../hooks/useDaemonHealthState.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./Sidebar.css";

interface NavItem { to: string; labelKey: string; icon: ReactNode; showHealth?: boolean; depth?: number; }

const TOP_SECTIONS: { headingKey: string; items: NavItem[] }[] = [
  {
    headingKey: "nav.section.workspace",
    items: [
      { to: "/agent-console", labelKey: "nav.agentConsole", icon: <Bot size={15} strokeWidth={1.8} />, depth: 1 },
      { to: "/inbox", labelKey: "nav.recordings", icon: <Mic size={15} strokeWidth={1.8} />, depth: 1 },
      { to: "/knowledge/prompts",  labelKey: "nav.prompts",  icon: <FileText size={15} strokeWidth={1.8} />, depth: 1 },
      { to: "/knowledge/glossary", labelKey: "nav.glossary", icon: <BookOpen size={15} strokeWidth={1.8} />, depth: 1 },
    ],
  },
  {
    headingKey: "nav.section.system",
    items: [
      { to: "/settings", labelKey: "nav.settings", icon: <SettingsIcon size={15} strokeWidth={1.8} />, depth: 1 },
      { to: "/health", labelKey: "nav.health", icon: <HeartPulse size={15} strokeWidth={1.8} />, showHealth: true, depth: 1 },
    ],
  },
];

export function Sidebar() {
  const health = useDaemonHealthState();
  const t = useT();
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <Logo size={26} />
        <span className="sidebar-brand-text">{t("app.name")}</span>
      </div>

      {TOP_SECTIONS.map((section) => (
        <div key={section.headingKey} className="sidebar-section">
          <div className="sidebar-heading">{t(section.headingKey).toUpperCase()}</div>
          {section.items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              data-depth={it.depth ?? 0}
              style={{ "--sidebar-indent": `${(it.depth ?? 0) * 12}px` } as CSSProperties}
              className={({ isActive }) => "sidebar-item" + (isActive ? " active" : "")}
            >
              {it.icon}
              <span className="sidebar-item-label">{t(it.labelKey)}</span>
              {it.showHealth && (
                <span
                  className={`sidebar-health-dot health-${health}`}
                  data-testid="health-dot"
                  data-state={health}
                  aria-label={t("nav.health.aria", { state: health })}
                />
              )}
            </NavLink>
          ))}
        </div>
      ))}

      <div className="sidebar-spacer" />

      <div className="sidebar-bottom" data-testid="sidebar-bottom">
        <div className="sidebar-engine-card">
          <span className={`sidebar-engine-dot health-${health}`} />
          <div>
            <strong>{t("sidebar.localEngine")}</strong>
            <span>{t("sidebar.localEngine.sub")}</span>
          </div>
        </div>
      </div>
    </aside>
  );
}
