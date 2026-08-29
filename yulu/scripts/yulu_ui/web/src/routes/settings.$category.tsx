// web/src/routes/settings.$category.tsx
import type { ReactNode } from "react";
import { useParams, useOutletContext } from "react-router";
import { categoryMeta } from "../components/settings/categories.js";
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
import { AutomationSection } from "../components/settings/AutomationSection.js";
import { AgentConnections } from "./agent-connections.js";
import { SharingSettings } from "./sharing.js";
import { CalendarSourceSection } from "../components/settings/CalendarSourceSection.js";
import { AgentCalendarConnectorSection } from "../components/settings/AgentCalendarConnectorSection.js";

/**
 * Maps a settings category to the rich section components that render its
 * fields. The sections own the per-field queries, capability report, and DB
 * stats — re-homing here keeps
 * all that behaviour intact while the registry-driven categories decide *where*
 * each block lives (P1 category→content map). The generic InlineEditRow rows are
 * rendered inside these sections; their input type/label/help already match the
 * registry.
 */
const CATEGORY_SECTIONS: Record<string, (tracker: SettingsRestartTracker) => ReactNode> = {
  general: (tracker) => (
    <>
      <CapabilitiesSection />
      <HotkeySection />
      <AboutSection />
    </>
  ),
  audio: (tracker) => (
    <>
      <AudioSection tracker={tracker} />
      <StorageSection tracker={tracker} />
    </>
  ),
  transcription: (tracker) => <TranscriptionSection tracker={tracker} />,
  llm: () => <AgentConnections embedded />,
  sharing: () => <SharingSettings />,
  integrations: () => (
    <>
      <CalendarSourceSection />
      <AgentCalendarConnectorSection />
    </>
  ),
  voice: (tracker) => <VoiceInputSection tracker={tracker} />,
  automation: (tracker) => <AutomationSection tracker={tracker} />,
};

/**
 * SettingsCategory — the detail pane of the settings MasterDetail. Reads the
 * `:category` route param, then renders that category's re-homed section(s).
 * The sections own their headings, so desktop and mobile do not show duplicated
 * "detail title + section title" labels.
 */
export function SettingsCategory() {
  const { category } = useParams();
  const { tracker } = useOutletContext<SettingsOutletContext>();
  const t = useT();
  const meta = categoryMeta(category ?? "");

  if (!meta) {
    return (
      <div className="settings-detail">
        <div className="settings-detail-empty">{t("settings.detail.unknownCategory")}</div>
      </div>
    );
  }

  const renderSections = CATEGORY_SECTIONS[meta.id];

  return (
    <div className="settings-detail">
      {renderSections ? (
        renderSections(tracker)
      ) : (
        <div className="settings-detail-empty">{t("settings.detail.automationComingSoon")}</div>
      )}
    </div>
  );
}
