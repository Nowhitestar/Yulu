import { Link } from "react-router";
import type { MouseEvent } from "react";
import { ChevronLeft, PanelLeft, Settings } from "lucide-react";
import { CurrentMeetingAction } from "./CurrentMeetingAction.js";
import { Pill } from "./Pill.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./TopBar.css";

type NativeWindow = Window & { webkit?: { messageHandlers?: { yuluWindow?: { postMessage: (action: string) => void } } } };

interface TopBarProps {
  settings?: boolean;
  paneOpen?: boolean;
  onTogglePane?: () => void;
}

/**
 * The only chrome the window has: tuck the list away, step into Settings, and
 * the one thing Yulu is for. Its empty space drags and zooms the native window.
 */
export function TopBar({ settings = false, paneOpen = true, onTogglePane }: TopBarProps) {
  const t = useT();
  const paneLabel = t(paneOpen ? "nav.hideSidebar" : "nav.showSidebar");
  const windowAction = (event: MouseEvent, action: "drag" | "zoom") => {
    if (event.button !== 0 || (event.target as Element).closest("button, a, input, select, [role='group'], .topbar-controls")) return;
    (window as NativeWindow).webkit?.messageHandlers?.yuluWindow?.postMessage(action);
  };
  return (
    <header className="topbar" onMouseDown={(event) => windowAction(event, "drag")} onDoubleClick={(event) => windowAction(event, "zoom")}>
      <Link to={settings ? "/settings" : "/inbox"} className="topbar-back icon-btn" aria-label={t("nav.back")} title={t("nav.back")}>
        <ChevronLeft size={18} strokeWidth={1.8} />
      </Link>
      {!settings && onTogglePane && (
        <button type="button" className="topbar-pane icon-btn" aria-label={paneLabel} title={`${paneLabel} (⌃⌘S)`} aria-expanded={paneOpen} aria-controls="app-pane" onClick={onTogglePane}>
          <PanelLeft size={16} strokeWidth={1.7} />
        </button>
      )}
      <div className="topbar-controls">
        {!settings && (
          <Link to="/settings" className="icon-btn" aria-label={t("nav.settings")} title={t("nav.settings")}>
            <Settings size={16} strokeWidth={1.7} />
          </Link>
        )}
        <div className="topbar-record">
          <CurrentMeetingAction fallback={<Pill />} />
        </div>
      </div>
    </header>
  );
}
