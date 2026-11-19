import { useState } from "react";
import { Link } from "react-router";
import { trpc } from "../../trpc.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";
import { useT } from "../../i18n/LanguageProvider.js";
import { InlineEditRow } from "../InlineEditRow.js";
import "./DictationSettings.css";

/**
 * Live notes: during a recording, Yulu turns new speech into key points,
 * tables and diagrams on the right edge of the screen, and saves them with the
 * recording. Meeting text goes to xAI only after this switch is on and its data
 * notice was accepted; the notice is shown once, before anything is sent.
 */
export function LiveNotesSection({ tracker }: { tracker: SettingsRestartTracker }) {
  const t = useT();
  const utils = trpc.useUtils();
  const status = trpc.liveNotes.status.useQuery();
  const accept = trpc.liveNotes.acceptDisclosure.useMutation();
  const { commit } = useConfigField(tracker);
  const [reviewing, setReviewing] = useState(false);
  const [saving, setSaving] = useState(false);
  const data = status.data;
  const on = data?.provider === "xai";

  const save = async (path: string, value: unknown) => {
    setSaving(true);
    try {
      await commit(path)(value);
      await utils.liveNotes.status.invalidate();
    } catch { /* the shared commit path shows the error */ }
    finally { setSaving(false); }
  };
  const toggle = (next: boolean) => {
    if (!next) {
      setReviewing(false);
      void save("transcription.live_notes.provider", "none");
      return;
    }
    if (!data?.disclosure.accepted) {
      setReviewing(true);
      return;
    }
    void save("transcription.live_notes.provider", "xai");
  };
  const acceptAndTurnOn = async () => {
    setSaving(true);
    try {
      await accept.mutateAsync();
      await commit("transcription.live_notes.provider")("xai");
      await utils.liveNotes.status.invalidate();
      setReviewing(false);
    } catch { /* the shared commit path shows the error */ }
    finally { setSaving(false); }
  };

  return (
    <section id="live-notes" className="settings-section">
      <h2 className="settings-section-h">{t("settings.liveNotes.heading")}</h2>
      <p className="settings-section-sub">{t("settings.liveNotes.sub")}</p>
      <InlineEditRow
        label={t("settings.liveNotes.provider")}
        help={t("settings.liveNotes.providerHelp")}
        type="toggle"
        value={on}
        disabled={saving || !data}
        disabledNote=""
        onCommit={toggle}
      />
      {reviewing && (
        <div className="dictation-disclosure" role="group" aria-labelledby="live-notes-disclosure">
          <strong id="live-notes-disclosure">{t("settings.liveNotes.disclosure.title")}</strong>
          <p>{t("settings.liveNotes.disclosure.body")}</p>
          <div className="dictation-disclosure-actions">
            <button type="button" className="path-btn" disabled={saving} onClick={() => setReviewing(false)}>
              {t("settings.liveNotes.disclosure.cancel")}
            </button>
            <button type="button" className="path-btn path-btn--primary" disabled={saving} onClick={() => { void acceptAndTurnOn(); }}>
              {t("settings.liveNotes.disclosure.accept")}
            </button>
          </div>
        </div>
      )}
      {on && data && !data.credentialSource && !reviewing && (
        <p className="settings-section-sub">
          {t("settings.liveNotes.needsConnection")} <Link to="/settings/connections#ai-connections">{t("settings.liveNotes.openConnections")}</Link>
        </p>
      )}
      <div className="row">
        <div className="row-label">{t("settings.liveNotes.language")}</div>
        <div className="row-value">
          <div className="seg" role="group" aria-label={t("settings.liveNotes.language")}>
            {(["zh", "en"] as const).map((language) => (
              <button
                key={language}
                type="button"
                aria-pressed={data?.language === language}
                disabled={saving || !data}
                onClick={() => { void save("transcription.live_notes.language", language); }}
              >
                {t(`settings.liveNotes.language.${language}`)}
              </button>
            ))}
          </div>
        </div>
        <div className="row-status" />
      </div>
    </section>
  );
}
