import { useState } from "react";
import type { YuluConfig } from "../../../../src/config.js";
import { dictationCleanupLevel, FAST_DICTATION_MODEL, type DictationCleanupLevel, type DictationStyle } from "../../../../src/dictationPreferences.js";
import { useT } from "../../i18n/LanguageProvider.js";
import { InlineEditRow } from "../InlineEditRow.js";
import "./DictationSettings.css";

export function DictationSettings({ preferences, available, onCommit }: {
  preferences: YuluConfig["transcription"]["dictation"];
  available: boolean;
  onCommit: (path: string, value: unknown) => unknown;
}) {
  const t = useT();
  const [saving, setSaving] = useState(false);
  const enabled = dictationCleanupLevel(preferences) !== "none";
  const level = preferences.cleanup_level && preferences.cleanup_level !== "none" ? preferences.cleanup_level : "medium";
  const style = preferences.style ?? "casual";
  const levels: Exclude<DictationCleanupLevel, "none">[] = ["light", "medium", "heavy"];
  const styles: DictationStyle[] = ["formal", "casual", "very_casual"];
  const save = async (path: string, value: unknown) => {
    setSaving(true);
    try { await onCommit(path, value); }
    catch { /* The shared settings commit displays the save error. */ }
    finally { setSaving(false); }
  };
  const chooseLevel = (next: Exclude<DictationCleanupLevel, "none">) => save("transcription.dictation", {
    ...preferences, cleanup_level: next, cleanup_enabled: true,
    prompt_slug: preferences.prompt_slug === "none" ? "dictation-cleanup" : preferences.prompt_slug,
  });
  const toggleCleanup = (next: boolean) => save("transcription.dictation", {
    ...preferences, cleanup_enabled: next, cleanup_level: level,
    prompt_slug: next && preferences.prompt_slug === "none" ? "dictation-cleanup" : preferences.prompt_slug,
  });
  return <section className="dictation-settings" aria-label={t("settings.voice.cleanup")}>
    <h3 className="settings-subsection-h">{t("settings.voice.cleanup")}</h3>
    <p className="dictation-settings-help">{t("settings.voice.cleanupHelp")}</p>
    {!available && <p className="dictation-settings-note">{t("settings.voice.cleanupUnavailable")}</p>}
    <InlineEditRow label={t("settings.voice.cleanupEnabled")} type="toggle" value={enabled}
      disabled={saving} onCommit={toggleCleanup} />
    <InlineEditRow label={t("settings.voice.cleanupModel")} help={t("settings.voice.cleanupModelHelp")}
      type="select" value={preferences.cleanup_model ?? "conversation"}
      options={[
        { value: FAST_DICTATION_MODEL, label: t("settings.voice.cleanupModelFast") },
        { value: "conversation", label: t("settings.voice.cleanupModelConversation") },
      ]} disabled={saving} disabledNote=""
      onCommit={(value) => { void save("transcription.dictation.cleanup_model", value); }} />
    <fieldset className="dictation-choices" disabled={saving || !enabled}>
      <legend>{t("settings.voice.cleanupLevel")}</legend>
      <div className="dictation-choice-grid">
        {levels.map((value) => <label className="dictation-choice" key={value} data-selected={level === value}>
          <span className="dictation-choice-title"><input type="radio" name="dictation-cleanup-level"
            value={value} checked={level === value} onChange={() => chooseLevel(value)} />
            <strong>{t(`settings.voice.level.${value}`)}</strong></span>
          <span className="dictation-choice-description">{t(`settings.voice.level.${value}.help`)}</span>
          <span className="dictation-choice-example">{t(`settings.voice.level.${value}.example`)}</span>
        </label>)}
      </div>
    </fieldset>
    <fieldset className="dictation-choices" disabled={saving || !enabled}>
      <legend>{t("settings.voice.style")}</legend>
      <div className="dictation-choice-grid">
        {styles.map((value) => <label className="dictation-choice" key={value} data-selected={style === value}>
          <span className="dictation-choice-title"><input type="radio" name="dictation-style"
            value={value} checked={style === value} onChange={() => { void save("transcription.dictation.style", value); }} />
            <strong>{t(`settings.voice.style.${value}`)}</strong></span>
          <span className="dictation-choice-description">{t(`settings.voice.style.${value}.help`)}</span>
          <span className="dictation-choice-example">{t(`settings.voice.style.${value}.example`)}</span>
        </label>)}
      </div>
    </fieldset>
    <p className="dictation-settings-help">{t(enabled ? "settings.voice.cleanupOriginal" : "settings.voice.cleanupOff")}</p>
  </section>;
}
