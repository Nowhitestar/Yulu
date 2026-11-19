import { useCallback, useEffect, useState } from "react";
import { InlineEditRow } from "../InlineEditRow.js";
import { useLocale, useT } from "../../i18n/LanguageProvider.js";

/** What the App's updater reports. Only the Yulu App provides it. */
export interface UpdateState {
  available: boolean;
  version?: string;
  automaticChecks?: boolean;
  canCheck?: boolean;
  lastCheck?: string;
}

type UpdateMessage =
  | { action: "state" }
  | { action: "check" }
  | { action: "setAutomaticChecks"; enabled: boolean };

interface UpdateBridge { postMessage(message: UpdateMessage): Promise<unknown> }

function updateBridge(): UpdateBridge | null {
  const handlers = (window as { webkit?: { messageHandlers?: { yuluUpdates?: UpdateBridge } } })
    .webkit?.messageHandlers;
  return handlers?.yuluUpdates ?? null;
}

function readState(value: unknown): UpdateState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return {
    available: raw.available === true,
    version: typeof raw.version === "string" ? raw.version : undefined,
    automaticChecks: typeof raw.automaticChecks === "boolean" ? raw.automaticChecks : undefined,
    canCheck: typeof raw.canCheck === "boolean" ? raw.canCheck : undefined,
    lastCheck: typeof raw.lastCheck === "string" ? raw.lastCheck : undefined,
  };
}

/**
 * Updates belong to the Yulu App: it checks on a schedule, announces what it
 * finds, and installs only from its own window after you confirm. This page
 * can read that state, start a check, or turn scheduled checks on and off.
 * Opened in a browser, there is no App to ask, so nothing renders.
 */
export function UpdateSection() {
  const t = useT();
  const locale = useLocale();
  const [bridge] = useState(updateBridge);
  const [state, setState] = useState<UpdateState | null>(null);
  const [failed, setFailed] = useState(false);

  const send = useCallback(async (message: UpdateMessage) => {
    if (!bridge) return;
    try {
      const next = readState(await bridge.postMessage(message));
      if (next) setState(next);
      setFailed(!next);
    } catch {
      setFailed(true);
    }
  }, [bridge]);

  useEffect(() => {
    void send({ action: "state" });
    // A check finishes in the App's own window; read the result on return.
    const refresh = () => { void send({ action: "state" }); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [send]);

  if (!bridge || (!state && !failed)) return null;

  const lastCheck = state?.lastCheck ? new Date(state.lastCheck) : null;
  const checkedText = lastCheck && !Number.isNaN(lastCheck.valueOf())
    ? t("settings.updates.lastCheck", {
      time: lastCheck.toLocaleString(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }),
    })
    : t("settings.updates.never");

  return (
    <section id="updates" className="settings-section">
      <h2 className="settings-section-h">{t("settings.updates.heading")}</h2>
      <p className="settings-section-sub">{t("settings.updates.sub")}</p>
      {!state ? null : !state.available ? (
        <p className="settings-section-sub">{t("settings.updates.unavailable")}</p>
      ) : (
        <>
          <InlineEditRow
            label={t("settings.updates.automatic")}
            help={t("settings.updates.automaticHelp")}
            type="toggle"
            value={state.automaticChecks ?? true}
            onCommit={(enabled) => void send({ action: "setAutomaticChecks", enabled })}
          />
          <div className="row">
            <div className="row-label">
              <div>{t("settings.updates.check")}</div>
              <div className="row-help">{checkedText}</div>
            </div>
            <div className="row-value">
              <button
                type="button"
                className="path-btn"
                disabled={state.canCheck === false}
                onClick={() => void send({ action: "check" })}
              >
                {t("settings.updates.checkNow")}
              </button>
            </div>
            <div className="row-status" />
          </div>
        </>
      )}
      {failed && <p className="settings-section-sub" role="alert">{t("settings.updates.failed")}</p>}
    </section>
  );
}
