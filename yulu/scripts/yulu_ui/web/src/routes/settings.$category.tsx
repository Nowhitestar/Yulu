// web/src/routes/settings.$category.tsx
import { useEffect, useRef, type ReactNode } from "react";
import { Link, Navigate, useLocation, useParams, useOutletContext } from "react-router";
import { ArrowLeft } from "lucide-react";
import { categoryMeta, settingsTarget } from "../components/settings/categories.js";
import { useT } from "../i18n/LanguageProvider.js";
import type { SettingsOutletContext } from "./settings.js";
import type { SettingsRestartTracker } from "../hooks/useSettingsRestartTracker.js";
import { CapabilitiesSection } from "../components/settings/CapabilitiesSection.js";
import { HotkeySection } from "../components/settings/HotkeySection.js";
import { AboutSection } from "../components/settings/AboutSection.js";
import { AudioSection } from "../components/settings/AudioSection.js";
import { StorageSection } from "../components/settings/StorageSection.js";
import { TranscriptionSection } from "../components/settings/TranscriptionSection.js";
import { VoiceInputSection } from "../components/settings/VoiceInputSection.js";
import { AutomationSection, RecordingProcessingSection } from "../components/settings/AutomationSection.js";
import { AgentConnections } from "./agent-connections.js";
import { SharingSettings } from "./sharing.js";
import { CalendarSourceSection } from "../components/settings/CalendarSourceSection.js";
import { AgentCalendarConnectorSection } from "../components/settings/AgentCalendarConnectorSection.js";
import { AdvancedDisclosure } from "../components/settings/AdvancedDisclosure.js";

import { AgentConnectorSettings } from "../components/settings/AgentConnectorSettings.js";

function GeneralSettings() {
  const t = useT();
  return <>
    <HotkeySection />
    <AboutSection />
    <AdvancedDisclosure title={t("settings.diagnostics")} note={t("settings.diagnostics.note")}>
      <CapabilitiesSection />
      <Link className="settings-text-link" to="/health">{t("settings.diagnostics.open")}</Link>
    </AdvancedDisclosure>
  </>;
}

function ConnectionSettings() {
  const t = useT();
  return <>
    <div id="ai-connections"><AgentConnections embedded /></div>
    <AgentConnectorSettings />
    <div id="sharing">
      <AdvancedDisclosure title={t("settings.connections.sharing")} note={t("settings.connections.sharing.note")}>
        <SharingSettings />
      </AdvancedDisclosure>
    </div>
    <div className="settings-connection-disclosure">
      <AdvancedDisclosure title={t("settings.connections.calendar")} note={t("settings.connections.calendar.note")}>
        <AgentCalendarConnectorSection />
      </AdvancedDisclosure>
    </div>
  </>;
}

const CATEGORY_SECTIONS: Record<string, (tracker: SettingsRestartTracker) => ReactNode> = {
  general: () => <GeneralSettings />,
  recording: (tracker) => <>
    <AudioSection tracker={tracker} />
    <TranscriptionSection tracker={tracker} />
    <RecordingProcessingSection tracker={tracker} />
    <StorageSection tracker={tracker} />
  </>,
  meetings: (tracker) => <><CalendarSourceSection /><AutomationSection tracker={tracker} /></>,
  voice: (tracker) => <VoiceInputSection tracker={tracker} />,
  connections: () => <ConnectionSettings />,
};

export function SettingsCategory() {
  const { category = "" } = useParams();
  const location = useLocation();
  const { tracker } = useOutletContext<SettingsOutletContext>();
  const detailRef = useRef<HTMLDivElement>(null);
  const t = useT();
  const target = settingsTarget(category, location.hash);
  const meta = categoryMeta(target.id);

  useEffect(() => {
    const detail = detailRef.current;
    if (!detail) return;
    detail.parentElement?.scrollTo?.({ top: 0 });
    if (!location.hash) return;
    // Wait for query-backed sections before revealing legacy deep links.
    const reveal = () => {
      let id: string;
      try { id = decodeURIComponent(location.hash.slice(1)); } catch { return false; }
      const element = document.getElementById(id);
      if (!element || !detail.contains(element)) return false;
      let parent = element.parentElement;
      while (parent && parent !== detail) {
        if (parent instanceof HTMLDetailsElement) parent.open = true;
        parent = parent.parentElement;
      }
      element.querySelector<HTMLDetailsElement>(":scope > details")?.setAttribute("open", "");
      element.scrollIntoView?.({ block: "start" });
      return true;
    };
    if (reveal()) return;
    const observer = new MutationObserver(() => { if (reveal()) observer.disconnect(); });
    observer.observe(detail, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [category, location.hash]);

  if (category !== target.id) {
    return <Navigate replace to={`/settings/${target.id}${location.search}${target.hash}`} />;
  }

  return (
    <div className="settings-detail" ref={detailRef}>
      <Link className="settings-mobile-back settings-text-link" to="/settings"><ArrowLeft size={16} />{t("settings.allCategories")}</Link>
      {meta ? <>
        <header className="settings-detail-head">
          <h1 className="settings-detail-title">{t(meta.labelKey)}</h1>
          <p className="settings-detail-sub">{t(meta.descKey)}</p>
        </header>
        {CATEGORY_SECTIONS[meta.id]?.(tracker)}
      </> : <p className="settings-detail-empty">{t("settings.detail.unknownCategory")}</p>}
    </div>
  );
}
