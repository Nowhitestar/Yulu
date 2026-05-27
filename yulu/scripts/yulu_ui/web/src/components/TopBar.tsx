// web/src/components/TopBar.tsx
import { useMatches } from "react-router";
import type { ReactNode } from "react";
import { ThemeToggle } from "./ThemeToggle.js";
import { GlobalSearch } from "./GlobalSearch.js";
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
  const deepest = matches[matches.length - 1];
  const deepestHandle = (deepest?.handle ?? {}) as RouteHandle;

  const segments: string[] = [];
  for (const m of matches) {
    const h = (m.handle ?? {}) as RouteHandle;
    if (h.breadcrumb == null) continue;
    if (typeof h.breadcrumb === "string") {
      segments.push(h.breadcrumb);
    } else if (typeof h.breadcrumb === "function") {
      const v = h.breadcrumb(m.params as Record<string, string | undefined>);
      if (v) segments.push(v);
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
      <div className="topbar-theme">
        <ThemeToggle />
      </div>
    </div>
  );
}
