// web/src/routes/settings.$category.tsx
import { useEffect, useRef, type ReactNode } from "react";
import { Link, Navigate, useLocation, useParams, useOutletContext } from "react-router";
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
import { AdvancedDisclosure } from "../components/settings/AdvancedDisclosure.js";

import { McpAgentsSection } from "../components/settings/McpAgentsSection.js";
import { VoiceHistory } from "../components/settings/VoiceHistory.js";

function GeneralSettings({ tracker }: { tracker: SettingsRestartTracker }) {
  const t = useT();
  return <>
    <HotkeySection tracker={tracker} />
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
    <McpAgentsSection />
    <div id="ai-connections"><AgentConnections /></div>
    <div id="sharing">
      <AdvancedDisclosure title={t("settings.connections.sharing")} note={t("settings.connections.sharing.note")}>
        <SharingSettings />
      </AdvancedDisclosure>
    </div>
  </>;
}

const CATEGORY_SECTIONS: Record<string, (tracker: SettingsRestartTracker) => ReactNode> = {
  general: (tracker) => <GeneralSettings tracker={tracker} />,
  recording: (tracker) => <>
    <AudioSection tracker={tracker} />
    <TranscriptionSection tracker={tracker} />
    <RecordingProcessingSection tracker={tracker} />
    <StorageSection tracker={tracker} />
  </>,
  meetings: (tracker) => <><CalendarSourceSection /><AutomationSection tracker={tracker} /></>,
  voice: (tracker) => <><VoiceInputSection tracker={tracker} /><VoiceHistory /></>,
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
    detail.closest(".root-body")?.scrollTo?.({ top: 0 });
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
      {meta ? <>
        <h1 className="page-title">{t(meta.labelKey)}</h1>
        {CATEGORY_SECTIONS[meta.id]?.(tracker)}
      </> : <p className="settings-detail-empty">{t("settings.detail.unknownCategory")}</p>}
    </div>
  );
}
