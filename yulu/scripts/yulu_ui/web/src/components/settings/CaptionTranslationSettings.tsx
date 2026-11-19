import { useState } from "react";
import { CAPTION_TRANSLATION_MODEL_DEFAULT } from "../../../../src/captionPreferences.js";
import { XAI_TEXT_MODEL_DEFAULT } from "../../../../src/settingsRegistry.js";
import { useT } from "../../i18n/LanguageProvider.js";
import { InlineEditRow } from "../InlineEditRow.js";
import "./DictationSettings.css";

/** Where caption text may be sent, as reported by the Host (`captionTranslation.status`). */
export interface CaptionTranslationStatus {
  provider: "none" | "xai";
  model: string;
  audioEngine: "local" | "xai";
  credentialSource: "oauth" | "api-key" | null;
  disclosure: { accepted: boolean; disclosureVersion: string };
  active: boolean;
}

/**
 * The explicit live-caption translation selection (ADR-011). Caption text is
 * sent to xAI only after this exact disclosure is accepted, and only with the
 * xAI audio engine and a connection. The overlay's bilingual and
 * translation-only modes then use it; they are never consent by themselves.
 */
export function CaptionTranslationSettings({ status, onCommit, onAcceptDisclosure }: {
  /** Undefined until the Host has answered; nothing is assumed ready meanwhile. */
  status: CaptionTranslationStatus | undefined;
  onCommit: (path: string, value: unknown) => unknown;
  onAcceptDisclosure: () => unknown;
}) {
  const t = useT();
  const [saving, setSaving] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const provider = status?.provider ?? "none";
  const model = status?.model ?? CAPTION_TRANSLATION_MODEL_DEFAULT;
  const save = async (path: string, value: unknown) => {
    setSaving(true);
    try { await onCommit(path, value); }
    catch { /* The shared settings commit displays the save error. */ }
    finally { setSaving(false); }
  };
  const chooseProvider = (next: boolean) => {
    if (!next) {
      setReviewing(false);
      return save("transcription.captions.translation_provider", "none");
    }
    if (!status?.disclosure.accepted) {
      setReviewing(true);
      return undefined;
    }
    return save("transcription.captions.translation_provider", "xai");
  };
  const acceptAndEnable = async () => {
    setSaving(true);
    try {
      await onAcceptDisclosure();
      await onCommit("transcription.captions.translation_provider", "xai");
      setReviewing(false);
    } catch { /* The shared settings commit displays the save error. */ }
    finally { setSaving(false); }
  };
  const unavailable = provider !== "xai" ? "settings.captions.off"
    : !status ? null
      : status.audioEngine !== "xai" ? "settings.captions.needsXaiAudio"
        : !status.disclosure.accepted ? "settings.captions.needsDisclosure"
          : !status.credentialSource ? "settings.captions.needsConnection"
            : null;
  return <section className="dictation-settings" aria-label={t("settings.captions.heading")}>
    <h3 className="settings-subsection-h">{t("settings.captions.heading")}</h3>
    <p className="dictation-settings-help">{t("settings.captions.help")}</p>
    <InlineEditRow label={t("settings.captions.provider")} help={t("settings.captions.providerHelp")}
      type="toggle" value={provider === "xai"} disabled={saving || !status} disabledNote=""
      onCommit={(next) => { void chooseProvider(next); }} />
    {reviewing && <div className="dictation-disclosure" role="group" aria-labelledby="caption-text-disclosure">
      <strong id="caption-text-disclosure">{t("settings.captions.disclosure.title", {
        version: status?.disclosure.disclosureVersion ?? "",
      })}</strong>
      <p>{t("settings.captions.disclosure.body")}</p>
      <div className="dictation-disclosure-actions">
        <button type="button" className="path-btn" disabled={saving} onClick={() => { void acceptAndEnable(); }}>
          {t("settings.captions.disclosure.accept")}
        </button>
        <button type="button" className="path-btn" disabled={saving} onClick={() => setReviewing(false)}>
          {t("settings.captions.disclosure.cancel")}
        </button>
      </div>
    </div>}
    {unavailable && !reviewing && <p className="dictation-settings-note">
      {t(unavailable)}
      {unavailable === "settings.captions.needsDisclosure" && <>
        {" "}<button type="button" className="path-btn" disabled={saving} onClick={() => setReviewing(true)}>
          {t("settings.captions.disclosure.review")}
        </button>
      </>}
    </p>}
    <InlineEditRow label={t("settings.captions.model")} help={t("settings.captions.modelHelp")}
      type="select" value={model}
      options={[
        { value: CAPTION_TRANSLATION_MODEL_DEFAULT, label: t("settings.captions.modelFast") },
        { value: XAI_TEXT_MODEL_DEFAULT, label: t("settings.captions.modelStandard", { model: XAI_TEXT_MODEL_DEFAULT }) },
        // A model set by hand stays selectable as it is.
        ...(model !== CAPTION_TRANSLATION_MODEL_DEFAULT && model !== XAI_TEXT_MODEL_DEFAULT ? [{ value: model, label: model }] : []),
      ]} disabled={saving || !status} disabledNote=""
      onCommit={(value) => { void save("transcription.captions.translation_model", value); }} />
  </section>;
}
