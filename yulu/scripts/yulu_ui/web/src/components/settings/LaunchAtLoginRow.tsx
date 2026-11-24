import { useCallback, useEffect, useState } from "react";
import { InlineEditRow } from "../InlineEditRow.js";
import { useT } from "../../i18n/LanguageProvider.js";

/** What the App reports about its macOS login item. */
export interface LoginItemState {
  available: boolean;
  enabled?: boolean;
  status?: "enabled" | "notRegistered" | "requiresApproval" | "notFound";
  error?: string;
}

type LoginItemMessage =
  | { action: "state" }
  | { action: "set"; enabled: boolean }
  | { action: "openSettings" };

interface LoginItemBridge { postMessage(message: LoginItemMessage): Promise<unknown> }

function loginItemBridge(): LoginItemBridge | null {
  const handlers = (window as { webkit?: { messageHandlers?: { yuluLoginItem?: LoginItemBridge } } })
    .webkit?.messageHandlers;
  return handlers?.yuluLoginItem ?? null;
}

const STATUSES = new Set(["enabled", "notRegistered", "requiresApproval", "notFound"]);

function readState(value: unknown): LoginItemState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  return {
    available: raw.available === true,
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
    status: typeof raw.status === "string" && STATUSES.has(raw.status)
      ? raw.status as LoginItemState["status"] : undefined,
    error: typeof raw.error === "string" ? raw.error : undefined,
  };
}

/**
 * Open Yulu at login. macOS owns this setting as a login item, so the switch
 * always shows what System Settings → General → Login Items says. At login
 * Yulu starts in the menu bar without opening its window. Opened in a browser,
 * there is no App to ask, so nothing renders.
 */
export function LaunchAtLoginRow() {
  const t = useT();
  const [bridge] = useState(loginItemBridge);
  const [state, setState] = useState<LoginItemState | null>(null);
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);

  const send = useCallback(async (message: LoginItemMessage) => {
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
    // The user can change it in System Settings; read it again on return.
    const refresh = () => { void send({ action: "state" }); };
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [send]);

  if (!bridge || !state?.available) {
    return failed && bridge
      ? <p className="settings-section-sub" role="alert">{t("settings.general.launchAtLogin.failed")}</p>
      : null;
  }

  const set = async (enabled: boolean) => {
    setSaving(true);
    try { await send({ action: "set", enabled }); }
    finally { setSaving(false); }
  };

  return (
    <>
      <InlineEditRow
        label={t("settings.general.launchAtLogin")}
        help={t("settings.general.launchAtLogin.help")}
        type="toggle"
        value={state.enabled ?? false}
        disabled={saving}
        disabledNote=""
        onCommit={(enabled) => { void set(enabled); }}
      />
      {state.status === "requiresApproval" && (
        <p className="settings-section-sub">
          {t("settings.general.launchAtLogin.approval")}{" "}
          <button type="button" className="path-btn" onClick={() => void send({ action: "openSettings" })}>
            {t("settings.general.launchAtLogin.openSettings")}
          </button>
        </p>
      )}
      {(state.error || failed) && (
        <p className="settings-section-sub" role="alert">{t("settings.general.launchAtLogin.failed")}</p>
      )}
    </>
  );
}
