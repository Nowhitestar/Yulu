import { useState } from "react";
import type { YuluConfig } from "../../../../src/config.js";
import { dictationCleanupLevel, FAST_DICTATION_MODEL, type DictationCleanupLevel, type DictationStyle } from "../../../../src/dictationPreferences.js";
import { XAI_TEXT_MODEL_DEFAULT } from "../../../../src/settingsRegistry.js";
import { useT } from "../../i18n/LanguageProvider.js";
import { InlineEditRow } from "../InlineEditRow.js";
import "./DictationSettings.css";

/** Where dictated text may be sent, as reported by the Host (`dictationText.status`). */
export interface DictationTextStatus {
  provider: "none" | "xai";
  model: string;
  audioEngine: "local" | "xai";
  credentialSource: "oauth" | "api-key" | null;
  disclosure: { accepted: boolean; disclosureVersion: string };
  active: boolean;
}

export function DictationSettings({ preferences, text, onCommit, onAcceptDisclosure }: {
  preferences: YuluConfig["transcription"]["dictation"];
  /** Undefined until the Host has answered; nothing is assumed ready meanwhile. */
  text: DictationTextStatus | undefined;
  onCommit: (path: string, value: unknown) => unknown;
  onAcceptDisclosure: () => unknown;
}) {
  const t = useT();
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const provider = text?.provider ?? preferences.text_provider ?? "none";
  const model = text?.model ?? preferences.text_model ?? XAI_TEXT_MODEL_DEFAULT;
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
  // Dictated text is sent to xAI only after this exact disclosure is accepted.
  const chooseProvider = (next: boolean) => {
    if (!next) {
      setReviewing(false);
      return save("transcription.dictation.text_provider", "none");
    }
    if (!text?.disclosure.accepted) {
      setReviewing(true);
      return undefined;
    }
    return save("transcription.dictation.text_provider", "xai");
  };
  const acceptAndEnable = async () => {
    setSaving(true);
    try {
      await onAcceptDisclosure();
      await onCommit("transcription.dictation.text_provider", "xai");
      setReviewing(false);
    } catch { /* The shared settings commit displays the save error. */ }
    finally { setSaving(false); }
  };
  const unavailable = provider !== "xai" ? "settings.voice.textOff"
    : !text ? null
      : text.audioEngine !== "xai" ? "settings.voice.textNeedsXaiAudio"
        : !text.disclosure.accepted ? "settings.voice.textNeedsDisclosure"
          : !text.credentialSource ? "settings.voice.textNeedsConnection"
            : null;
  const toggleCleanup = (next: boolean) => save("transcription.dictation", {
    ...preferences, cleanup_enabled: next, cleanup_level: level,
    prompt_slug: next && preferences.prompt_slug === "none" ? "dictation-cleanup" : preferences.prompt_slug,
  });
  return <section className="dictation-settings" aria-label={t("settings.voice.cleanup")}>
    <h3 className="settings-subsection-h">{t("settings.voice.cleanup")}</h3>
    <p className="dictation-settings-help">{t("settings.voice.cleanupHelp")}</p>
    <InlineEditRow label={t("settings.voice.textProvider")} help={t("settings.voice.textProviderHelp")}
      type="toggle" value={provider === "xai"} disabled={saving} disabledNote=""
      onCommit={(next) => { void chooseProvider(next); }} />
    {reviewing && <div className="dictation-disclosure" role="group" aria-labelledby="dictation-text-disclosure">
      <strong id="dictation-text-disclosure">{t("settings.voice.textDisclosure.title", {
        version: text?.disclosure.disclosureVersion ?? "",
      })}</strong>
      <p>{t("settings.voice.textDisclosure.body")}</p>
      <div className="dictation-disclosure-actions">
        <button type="button" className="path-btn" disabled={saving} onClick={() => { void acceptAndEnable(); }}>
          {t("settings.voice.textDisclosure.accept")}
        </button>
        <button type="button" className="path-btn" disabled={saving} onClick={() => setReviewing(false)}>
          {t("settings.voice.textDisclosure.cancel")}
        </button>
      </div>
    </div>}
    {unavailable && !reviewing && <p className="dictation-settings-note">
      {t(unavailable)}
      {unavailable === "settings.voice.textNeedsDisclosure" && <>
        {" "}<button type="button" className="path-btn" disabled={saving} onClick={() => setReviewing(true)}>
          {t("settings.voice.textDisclosure.review")}
        </button>
      </>}
    </p>}
    <InlineEditRow label={t("settings.voice.cleanupEnabled")} type="toggle" value={enabled}
      disabled={saving} onCommit={toggleCleanup} />
    <InlineEditRow label={t("settings.voice.cleanupModel")} help={t("settings.voice.cleanupModelHelp")}
      type="select" value={model}
      options={[
        { value: FAST_DICTATION_MODEL, label: t("settings.voice.cleanupModelFast") },
        { value: XAI_TEXT_MODEL_DEFAULT, label: t("settings.voice.cleanupModelStandard", { model: XAI_TEXT_MODEL_DEFAULT }) },
        // A model carried over from an earlier selection stays selectable as it is.
        ...(model !== FAST_DICTATION_MODEL && model !== XAI_TEXT_MODEL_DEFAULT ? [{ value: model, label: model }] : []),
      ]} disabled={saving} disabledNote=""
      onCommit={(value) => { void save("transcription.dictation.text_model", value); }} />
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
