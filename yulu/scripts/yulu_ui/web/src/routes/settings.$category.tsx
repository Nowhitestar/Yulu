// web/src/routes/settings.$category.tsx
import type { ReactNode } from "react";
import { useParams, useOutletContext } from "react-router";
import { categoryMeta } from "../components/settings/categories.js";
import type { SettingsOutletContext } from "./settings.js";
import type { SettingsRestartTracker } from "../hooks/useSettingsRestartTracker.js";
import { CapabilitiesSection } from "../components/settings/CapabilitiesSection.js";
import { HotkeySection } from "../components/settings/HotkeySection.js";
import { AudioSection } from "../components/settings/AudioSection.js";
import { StorageSection } from "../components/settings/StorageSection.js";
import { TranscriptionSection } from "../components/settings/TranscriptionSection.js";
import { LlmSection } from "../components/settings/LlmSection.js";
import { AutomationSection } from "../components/settings/AutomationSection.js";
import { IntegrationsSection } from "../components/settings/IntegrationsSection.js";
import { AdvancedSection } from "../components/settings/AdvancedSection.js";

/**
 * Maps a settings category to the rich section components that render its
 * fields. The sections own the per-field queries (audio devices, detected
 * models), test buttons, capability report, and DB stats — re-homing here keeps
 * all that behaviour intact while the registry-driven categories decide *where*
 * each block lives (P1 category→content map). The generic InlineEditRow rows are
 * rendered inside these sections; their input type/label/help already match the
 * registry.
 */
const CATEGORY_SECTIONS: Record<string, (tracker: SettingsRestartTracker) => ReactNode> = {
  general: (tracker) => (
    <>
      <CapabilitiesSection />
      <HotkeySection tracker={tracker} />
    </>
  ),
  audio: (tracker) => (
    <>
      <AudioSection tracker={tracker} />
      <StorageSection tracker={tracker} />
    </>
  ),
  transcription: (tracker) => <TranscriptionSection tracker={tracker} />,
  llm: (tracker) => <LlmSection tracker={tracker} />,
  automation: (tracker) => <AutomationSection tracker={tracker} />,
  integrations: (tracker) => <IntegrationsSection tracker={tracker} />,
  advanced: (tracker) => <AdvancedSection tracker={tracker} />,
};

/**
 * SettingsCategory — the detail pane of the settings MasterDetail. Reads the
 * `:category` route param, renders that category's heading, then its re-homed
 * section(s). Shares the restart tracker via Outlet context so restart-class
 * edits surface in the layout's RestartBanner.
 */
export function SettingsCategory() {
  const { category } = useParams();
  const { tracker } = useOutletContext<SettingsOutletContext>();
  const meta = categoryMeta(category ?? "");

  if (!meta) {
    return (
      <div className="settings-detail">
        <div className="settings-detail-empty">未知设置分类。</div>
      </div>
    );
  }

  const renderSections = CATEGORY_SECTIONS[meta.id];

  return (
    <div className="settings-detail">
      <div className="settings-detail-head">
        <h1 className="settings-detail-title">{meta.label}</h1>
        <p className="settings-detail-sub">{meta.description}</p>
      </div>
      {renderSections ? (
        renderSections(tracker)
      ) : (
        <div className="settings-detail-empty">更多自动化设置即将到来 (P2)。</div>
      )}
    </div>
  );
}
