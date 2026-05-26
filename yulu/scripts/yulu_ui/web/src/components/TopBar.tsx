// web/src/components/TopBar.tsx
import { useMatches } from "react-router";
import type { ReactNode } from "react";
import "./TopBar.css";

interface RouteHandle {
  breadcrumb?: string;
  filters?: ReactNode;
}

export function TopBar() {
  const matches = useMatches();
  const deepest = matches[matches.length - 1];
  const handle = (deepest?.handle ?? {}) as RouteHandle;
  const breadcrumb = handle.breadcrumb ?? "—";

  return (
    <div className="topbar">
      <div className="topbar-breadcrumb">{breadcrumb}</div>
      {handle.filters && (
        <div className="topbar-filters" data-testid="topbar-filters">
          {handle.filters}
        </div>
      )}
    </div>
  );
}
