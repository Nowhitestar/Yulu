import { trpc } from "../../trpc.js";
import { CommandEditor } from "../CommandEditor.js";
import { AdvancedDisclosure } from "./AdvancedDisclosure.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import { useT } from "../../i18n/LanguageProvider.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface AdvancedSectionProps {
  tracker: SettingsRestartTracker;
}

/**
 * AdvancedSection — fields the registry flags `category: "advanced"`. Today this
 * is the cloud transcription command (the user's OWN command — the llm.command
 * trust model; Yulu holds no cloud credentials). Re-homed out of the
 * transcription section so advanced/danger-leaning knobs live together (P1
 * category→content map). P3-2: the knobs sit behind a collapsed-by-default
 * disclosure so the category opens calm, with a "change with care" note.
 */
export function AdvancedSection({ tracker }: AdvancedSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const { commit, isBlocked } = useConfigField(tracker);
  const t = useT();

  if (!cfg) return null;

  const tr = cfg.transcription as { cloud_command?: string[] };
  const blocked = isBlocked("transcription.cloud_command");

  return (
    <section id="advanced" className="settings-section">
      <h2 className="settings-section-h">{t("settings.advanced.heading")}</h2>
      <p className="settings-section-sub">{t("settings.advanced.sub")}</p>

      <AdvancedDisclosure title={t("settings.advanced.disclosure.title")} note={t("settings.advanced.disclosure.note")}>
        {/* TRANS-02 (D-04): cloud transcription is the user's OWN command — the
            llm.command trust model. Yulu holds and asks for no cloud credentials.
            This is a command array, never a credential field. */}
        <div className="row">
          <div className="row-label">
            <div>{t("settings.advanced.cloudCommand.label")}</div>
            <div className="row-help">{t("settings.advanced.cloudCommand.help")}</div>
          </div>
          <div className="row-value">
            {blocked ? (
              <span className="value-disabled">
                <span className="value-disabled-text">{(tr.cloud_command ?? []).join(" ") || t("value.unset")}</span>
                <span className="value-disabled-note">{t("settings.locked.recording")}</span>
              </span>
            ) : (
              <CommandEditor
                value={tr.cloud_command ?? []}
                onChange={(next) => commit("transcription.cloud_command")(next)}
              />
            )}
          </div>
          <div className="row-status" />
        </div>
      </AdvancedDisclosure>
    </section>
  );
}
