// web/src/components/TopBar.tsx
import { Link, useMatches, useNavigate, useLocation, useNavigationType } from "react-router";
import { useEffect, useState, useRef, type ReactNode, type MouseEvent } from "react";
import { AudioLines, SlidersHorizontal, PanelLeft, ArrowLeft, ArrowRight, Search } from "lucide-react";
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

export function TopBar({ sidebarOpen = true, onToggleSidebar, settingsReturnTo }: { sidebarOpen?: boolean; onToggleSidebar?: () => void; settingsReturnTo?: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const searchRef = useRef<HTMLDivElement>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [history, setHistory] = useState({ keys: [location.key], index: 0 });
  useEffect(() => {
    setHistory((previous) => {
      const known = previous.keys.indexOf(location.key);
      if (known >= 0) return { ...previous, index: known };
      if (navigationType === "REPLACE") {
        const keys = [...previous.keys];
        keys[previous.index] = location.key;
        return { keys, index: previous.index };
      }
      const keys = [...previous.keys.slice(0, previous.index + 1), location.key];
      return { keys, index: keys.length - 1 };
    });
    setSearchOpen(false);
  }, [location.key, navigationType]);
  const focusSearch = () => {
    setSearchOpen(true);
    requestAnimationFrame(() => searchRef.current?.querySelector("input")?.focus());
  };
  useEffect(() => {
    const searchShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") focusSearch();
      if (event.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", searchShortcut);
    return () => window.removeEventListener("keydown", searchShortcut);
  }, []);
  const windowAction = (event: MouseEvent, action: "drag" | "zoom") => {
    if (event.button !== 0 || (event.target as Element).closest("button, a, input, select, [role='group'], .topbar-search, .topbar-controls")) return;
    const bridge = (window as Window & { webkit?: { messageHandlers?: { yuluWindow?: { postMessage: (action: string) => void } } } }).webkit?.messageHandlers?.yuluWindow;
    bridge?.postMessage(action);
  };
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
    <header className={`topbar${settingsReturnTo ? " topbar--settings" : ""}${searchOpen ? " search-open" : ""}`} onMouseDown={(event) => windowAction(event, "drag")} onDoubleClick={(event) => windowAction(event, "zoom")}>
      <div className="topbar-navigation">
        {settingsReturnTo ? <Link className="topbar-return" to={settingsReturnTo}><ArrowLeft size={16} />{t("settings.returnToApp")}</Link> : <button type="button" className="topbar-icon-button" aria-label={t("nav.toggleSidebar")} title={t("nav.toggleSidebar")} aria-expanded={sidebarOpen} aria-controls="app-sidebar" onClick={onToggleSidebar}><PanelLeft size={17} /></button>}
        <button type="button" className="topbar-icon-button" aria-label={t("nav.back")} title={t("nav.back")} disabled={history.index === 0} onClick={() => navigate(-1)}><ArrowLeft size={16} /></button>
        <button type="button" className="topbar-icon-button" aria-label={t("nav.forward")} title={t("nav.forward")} disabled={history.index >= history.keys.length - 1} onClick={() => navigate(1)}><ArrowRight size={16} /></button>
      </div>
      <div className="topbar-breadcrumb">{segments.filter((segment, index) => segment !== segments[index - 1]).join(" / ")}</div>
      {deepestHandle.filters && (
        <div className="topbar-filters" data-testid="topbar-filters">
          {deepestHandle.filters}
        </div>
      )}
      <div className="topbar-search" ref={searchRef} data-testid="topbar-search">
        <GlobalSearch />
      </div>
      <div className="topbar-controls">
        <button type="button" className="topbar-icon-button topbar-search-toggle" aria-label={t("search.placeholder")} title={t("search.placeholder")} onClick={focusSearch}><Search size={16} /></button>
        {!settingsReturnTo && <><Link to="/voice-input" className="topbar-icon-button" aria-label={t("nav.voiceInput")}>
          <AudioLines size={15} strokeWidth={1.85} />
        </Link>
        <Link to="/settings" className="topbar-icon-button" aria-label={t("nav.settings")}>
          <SlidersHorizontal size={15} strokeWidth={1.85} />
        </Link>
        <div className="topbar-theme">
          <ThemeToggle />
        </div>
        </>}
        <div className="topbar-record">
          <CurrentMeetingAction fallback={<Pill />} />
        </div>
      </div>
    </header>
  );
}
