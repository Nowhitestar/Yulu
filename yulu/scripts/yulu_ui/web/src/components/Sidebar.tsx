// web/src/components/Sidebar.tsx
import { NavLink } from "react-router";
import { Settings as SettingsIcon, HeartPulse, Mic, FileText, BookOpen } from "lucide-react";
import type { ReactNode } from "react";
import { Logo } from "./Logo.js";
import { useDaemonHealthState } from "../hooks/useDaemonHealthState.js";
import "./Sidebar.css";

interface NavItem { to: string; label: string; icon: ReactNode; }

const TOP_SECTIONS: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Inbox",
    items: [
      { to: "/inbox", label: "Recordings", icon: <Mic size={15} strokeWidth={1.8} /> },
    ],
  },
  {
    heading: "Knowledge",
    items: [
      { to: "/knowledge/prompts",  label: "Prompts",  icon: <FileText size={15} strokeWidth={1.8} /> },
      { to: "/knowledge/glossary", label: "Glossary", icon: <BookOpen size={15} strokeWidth={1.8} /> },
    ],
  },
];

export function Sidebar() {
  const health = useDaemonHealthState();
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <Logo size={26} />
        <span className="sidebar-brand-text">Yulu</span>
      </div>

      {TOP_SECTIONS.map((section) => (
        <div key={section.heading} className="sidebar-section">
          <div className="sidebar-heading">{section.heading.toUpperCase()}</div>
          {section.items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              className={({ isActive }) => "sidebar-item" + (isActive ? " active" : "")}
            >
              {it.icon}
              <span className="sidebar-item-label">{it.label}</span>
            </NavLink>
          ))}
        </div>
      ))}

      <div className="sidebar-spacer" />

      <div className="sidebar-bottom" data-testid="sidebar-bottom">
        <NavLink
          to="/settings"
          className={({ isActive }) => "sidebar-bottom-item" + (isActive ? " active" : "")}
        >
          <SettingsIcon size={16} strokeWidth={1.75} />
          <span>Settings</span>
        </NavLink>
        <NavLink
          to="/health"
          className={({ isActive }) => "sidebar-bottom-item" + (isActive ? " active" : "")}
        >
          <HeartPulse size={16} strokeWidth={1.75} />
          <span>Health</span>
          <span
            className={`sidebar-health-dot health-${health}`}
            data-testid="health-dot"
            data-state={health}
            aria-label={`Daemon health: ${health}`}
          />
        </NavLink>
      </div>
    </aside>
  );
}
