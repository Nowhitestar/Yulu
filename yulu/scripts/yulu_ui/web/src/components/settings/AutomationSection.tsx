import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { AdvancedDisclosure } from "./AdvancedDisclosure.js";
import { ArrayField } from "./ArrayField.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import { useT } from "../../i18n/LanguageProvider.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface AutomationSectionProps {
  tracker: SettingsRestartTracker;
}

// The advanced match arrays — registry key → i18n key roots for label/help. The
// detector matches a foreground window against these; they're power-user knobs,
// hidden behind the Advanced disclosure (P3-2).
const MATCH_ARRAYS: Array<{ key: string; field: string; labelKey: string; helpKey: string }> = [
  { key: "meeting_detection.window_keywords",        field: "window_keywords",        labelKey: "settings.automation.match.windowKeywords.label",  helpKey: "settings.automation.match.windowKeywords.help" },
  { key: "meeting_detection.app_name_hints",         field: "app_name_hints",         labelKey: "settings.automation.match.appHints.label",        helpKey: "settings.automation.match.appHints.help" },
  { key: "meeting_detection.target_app_names",       field: "target_app_names",       labelKey: "settings.automation.match.targetApps.label",      helpKey: "settings.automation.match.targetApps.help" },
  { key: "meeting_detection.dedicated_meeting_apps", field: "dedicated_meeting_apps", labelKey: "settings.automation.match.dedicatedApps.label",   helpKey: "settings.automation.match.dedicatedApps.help" },
  { key: "meeting_detection.ignore_window_keywords", field: "ignore_window_keywords", labelKey: "settings.automation.match.ignoreKeywords.label",  helpKey: "settings.automation.match.ignoreKeywords.help" },
];

/**
 * AutomationSection — meeting auto-detection knobs (P2-3). The detector daemon
 * polls window titles and offers to record when it sees a meeting; these fields
 * are restart-class (the daemon reads them at startup), so useConfigField guards
 * them while a recording is in flight. The large keyword/app match arrays
 * (window_keywords, app_name_hints, …) are edited as string-array chips behind an
 * Advanced disclosure (P3-2).
 */
export function AutomationSection({ tracker }: AutomationSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const { commit, isBlocked } = useConfigField(tracker);
  const t = useT();

  if (!cfg) return null;

  const md = (cfg.meeting_detection ?? {}) as {
    enabled?: boolean;
    interval_sec?: number;
    stable_sec?: number;
    prompt_cooldown_sec?: number;
    [key: string]: unknown;
  };
  const pipeline = (cfg.agent_pipeline ?? {
    enabled: true,
    auto_process_recordings: true,
  }) as {
    enabled: boolean;
    auto_process_recordings: boolean;
  };

  return (
    <section id="automation" className="settings-section">
      <h2 className="settings-section-h">{t("settings.automation.heading")}</h2>
      <p className="settings-section-sub">{t("settings.automation.sub")}</p>

      <InlineEditRow
        label={t("settings.automation.pipeline.enabled.label")}
        help={t("settings.automation.pipeline.enabled.help")}
        type="toggle"
        value={pipeline.enabled}
        onCommit={commit("agent_pipeline.enabled") as (v: boolean) => void}
        disabled={isBlocked("agent_pipeline.enabled")}
        status={tracker.statusFor("agent_pipeline.enabled")}
      />
      <InlineEditRow
        label={t("settings.automation.pipeline.autoProcess.label")}
        help={t("settings.automation.pipeline.autoProcess.help")}
        type="toggle"
        value={pipeline.auto_process_recordings}
        onCommit={commit("agent_pipeline.auto_process_recordings") as (v: boolean) => void}
        disabled={isBlocked("agent_pipeline.auto_process_recordings")}
        status={tracker.statusFor("agent_pipeline.auto_process_recordings")}
      />

      <InlineEditRow
        label={t("settings.automation.enabled.label")}
        help={t("settings.automation.enabled.help")}
        type="toggle"
        value={md.enabled ?? false}
        onCommit={commit("meeting_detection.enabled") as (v: boolean) => void}
        disabled={isBlocked("meeting_detection.enabled")}
        status={tracker.statusFor("meeting_detection.enabled")}
      />
      <InlineEditRow
        label={t("settings.automation.interval.label")}
        help={t("settings.automation.interval.help")}
        type="number"
        min={1}
        step={1}
        value={md.interval_sec ?? 10}
        onCommit={commit("meeting_detection.interval_sec") as (v: number) => void}
        disabled={isBlocked("meeting_detection.interval_sec")}
        status={tracker.statusFor("meeting_detection.interval_sec")}
      />
      <InlineEditRow
        label={t("settings.automation.stable.label")}
        help={t("settings.automation.stable.help")}
        type="number"
        min={1}
        step={1}
        value={md.stable_sec ?? 15}
        onCommit={commit("meeting_detection.stable_sec") as (v: number) => void}
        disabled={isBlocked("meeting_detection.stable_sec")}
        status={tracker.statusFor("meeting_detection.stable_sec")}
      />
      <InlineEditRow
        label={t("settings.automation.cooldown.label")}
        help={t("settings.automation.cooldown.help")}
        type="number"
        min={0}
        step={1}
        value={md.prompt_cooldown_sec ?? 1800}
        onCommit={commit("meeting_detection.prompt_cooldown_sec") as (v: number) => void}
        disabled={isBlocked("meeting_detection.prompt_cooldown_sec")}
        status={tracker.statusFor("meeting_detection.prompt_cooldown_sec")}
      />

      <AdvancedDisclosure title={t("settings.automation.match.heading")} note={t("settings.automation.match.note")}>
        {MATCH_ARRAYS.map(({ key, field, labelKey, helpKey }) => (
          <ArrayField
            key={key}
            label={t(labelKey)}
            help={t(helpKey)}
            value={Array.isArray(md[field]) ? (md[field] as string[]) : []}
            onChange={(next) => commit(key)(next)}
            blocked={isBlocked(key)}
          />
        ))}
      </AdvancedDisclosure>
    </section>
  );
}
