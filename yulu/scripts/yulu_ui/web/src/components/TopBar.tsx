import { useLocation, useNavigate, useNavigationType } from "react-router";
import { useEffect, useState, type MouseEvent } from "react";
import { ArrowLeft, ArrowRight, PanelLeft, Search } from "lucide-react";
import { CommandPalette } from "./CommandPalette.js";
import { CurrentMeetingAction } from "./CurrentMeetingAction.js";
import { Pill } from "./Pill.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./TopBar.css";

type NativeWindow = Window & { webkit?: { messageHandlers?: { yuluWindow?: { postMessage: (action: string) => void } } } };

/**
 * The window toolbar: where you are going (sidebar, history), one way to find
 * anything (⌘K), and the one thing Yulu is for (record).
 */
export function TopBar({ sidebarOpen = true, onToggleSidebar }: { sidebarOpen?: boolean; onToggleSidebar?: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const t = useT();
  const [paletteOpen, setPaletteOpen] = useState(false);
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
    setPaletteOpen(false);
  }, [location.key, navigationType]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && (event.key.toLowerCase() === "k" || event.code === "KeyK")) {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // The native shell has no title bar: empty toolbar space drags and zooms the window.
  const windowAction = (event: MouseEvent, action: "drag" | "zoom") => {
    if (event.button !== 0 || (event.target as Element).closest("button, a, input, select, [role='group'], [role='dialog'], .topbar-controls")) return;
    (window as NativeWindow).webkit?.messageHandlers?.yuluWindow?.postMessage(action);
  };

  return (
    <header className="topbar" onMouseDown={(event) => windowAction(event, "drag")} onDoubleClick={(event) => windowAction(event, "zoom")}>
      <div className="topbar-navigation">
        <button type="button" className="icon-btn" aria-label={t("nav.toggleSidebar")} title={t("nav.toggleSidebar")} aria-expanded={sidebarOpen} aria-controls="app-sidebar" onClick={onToggleSidebar}><PanelLeft size={17} strokeWidth={1.7} /></button>
        <button type="button" className="icon-btn" aria-label={t("nav.back")} title={t("nav.back")} disabled={history.index === 0} onClick={() => navigate(-1)}><ArrowLeft size={16} strokeWidth={1.7} /></button>
        <button type="button" className="icon-btn" aria-label={t("nav.forward")} title={t("nav.forward")} disabled={history.index >= history.keys.length - 1} onClick={() => navigate(1)}><ArrowRight size={16} strokeWidth={1.7} /></button>
      </div>
      <div className="topbar-controls">
        <button type="button" className="topbar-search" aria-label={t("search.placeholder")} aria-haspopup="dialog" aria-expanded={paletteOpen} onClick={() => setPaletteOpen(true)}>
          <Search size={14} strokeWidth={1.9} aria-hidden="true" />
          <span>{t("search.placeholder")}</span>
          <kbd aria-hidden="true">⌘K</kbd>
        </button>
        <div className="topbar-record">
          <CurrentMeetingAction fallback={<Pill />} />
        </div>
      </div>
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} />}
    </header>
  );
}
