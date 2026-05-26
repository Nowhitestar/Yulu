// web/src/components/Sidebar.tsx
import { NavLink } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../trpc.js";
import { useWsChannel } from "../ws.js";
import { ThemeToggle } from "./ThemeToggle.js";
import "./Sidebar.css";

interface NavItem {
  to: string;
  label: string;
  countKey?: "voicemails" | "meetings" | "prompts" | "glossary";
  staticCount?: number;
}

const SECTIONS: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Inbox",
    items: [
      { to: "/inbox/voicemails", label: "Voicemails", countKey: "voicemails" },
      { to: "/inbox/meetings",   label: "Meetings",   countKey: "meetings" },
      { to: "/inbox/search",     label: "Search" },
    ],
  },
  {
    heading: "Knowledge",
    items: [
      { to: "/knowledge/prompts",  label: "Prompts",  countKey: "prompts" },
      { to: "/knowledge/glossary", label: "Glossary", countKey: "glossary" },
    ],
  },
  {
    heading: "Settings",
    items: [
      { to: "/settings/audio",         label: "Audio" },
      { to: "/settings/transcription", label: "Transcription" },
      { to: "/settings/llm",           label: "LLM" },
      { to: "/settings/hotkey",        label: "Hotkey & UI" },
      { to: "/settings/integrations",  label: "Integrations" },
      { to: "/settings/storage",       label: "Storage" },
    ],
  },
  {
    heading: "Health",
    items: [
      { to: "/health/daemons", label: "Daemons", staticCount: 7 },
      { to: "/health/logs",    label: "Logs" },
    ],
  },
];

export function Sidebar() {
  const { data: counts } = trpc.sidebar.counts.useQuery();
  const qc = useQueryClient();
  useWsChannel("sidebar-counts", () => {
    qc.invalidateQueries({ queryKey: [["sidebar", "counts"]] });
  });

  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <span className="sidebar-logo">语</span>
        <span className="sidebar-brand-text">yulu</span>
        <div className="sidebar-brand-spacer" />
        <ThemeToggle />
      </div>

      {SECTIONS.map((section) => (
        <div key={section.heading} className="sidebar-section">
          <div className="sidebar-heading">{section.heading.toUpperCase()}</div>
          {section.items.map((it) => (
            <NavLink
              key={it.to}
              to={it.to}
              className={({ isActive }) => "sidebar-item" + (isActive ? " active" : "")}
            >
              <span className="sidebar-item-label">{it.label}</span>
              {it.countKey && (
                <span className="sidebar-count" data-testid={`count-${it.countKey}`}>
                  {counts?.[it.countKey] ?? "?"}
                </span>
              )}
              {it.staticCount !== undefined && (
                <span className="sidebar-count" data-testid="count-daemons">
                  {it.staticCount}
                </span>
              )}
            </NavLink>
          ))}
        </div>
      ))}
    </aside>
  );
}
