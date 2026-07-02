// web/src/components/TopBar.tsx
import { Link, useMatches } from "react-router";
import type { ReactNode } from "react";
import { AudioLines, SlidersHorizontal } from "lucide-react";
import { ThemeToggle } from "./ThemeToggle.js";
import { GlobalSearch } from "./GlobalSearch.js";
import { CurrentMeetingAction } from "./CurrentMeetingAction.js";
import { Pill } from "./Pill.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./TopBar.css";

type CrumbValue =
  | string
  | ((params: Record<string, string | undefined>) => string | null)
  | null;

interface RouteHandle {
  breadcrumb?: CrumbValue;
  filters?: ReactNode;
}

export function TopBar() {
  const matches = useMatches();
  const t = useT();
  const deepest = matches[matches.length - 1];
  const deepestHandle = (deepest?.handle ?? {}) as RouteHandle;

  // Breadcrumb values are i18n keys (or functions returning a key); resolve each
  // through t(). A non-key literal (e.g. a recording stem) falls back to itself
  // since translate() returns the raw key when it isn't in the dictionary.
  const segments: string[] = [];
  for (const m of matches) {
    const h = (m.handle ?? {}) as RouteHandle;
    if (h.breadcrumb == null) continue;
    if (typeof h.breadcrumb === "string") {
      segments.push(t(h.breadcrumb));
    } else if (typeof h.breadcrumb === "function") {
      const v = h.breadcrumb(m.params as Record<string, string | undefined>);
      if (v) segments.push(t(v));
    }
  }

  return (
    <div className="topbar">
      <div className="topbar-breadcrumb">{segments.join(" / ")}</div>
      {deepestHandle.filters && (
        <div className="topbar-filters" data-testid="topbar-filters">
          {deepestHandle.filters}
        </div>
      )}
      <div className="topbar-spacer" />
      <div className="topbar-search" data-testid="topbar-search">
        <GlobalSearch />
      </div>
      <div className="topbar-spacer" />
      <div className="topbar-controls">
        <Link to="/voice-input" className="topbar-icon-button" aria-label={t("nav.voiceInput")}>
          <AudioLines size={15} strokeWidth={1.85} />
        </Link>
        <Link to="/settings" className="topbar-icon-button" aria-label={t("nav.settings")}>
          <SlidersHorizontal size={15} strokeWidth={1.85} />
        </Link>
        <div className="topbar-theme">
          <ThemeToggle />
        </div>
        <div className="topbar-record">
          <CurrentMeetingAction fallback={<Pill />} />
        </div>
      </div>
    </div>
  );
}
