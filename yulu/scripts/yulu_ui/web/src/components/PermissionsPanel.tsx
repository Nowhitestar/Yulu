import { useState } from "react";
import { CheckCircle2, RefreshCw, ShieldCheck, X } from "lucide-react";
import { Link } from "react-router";
import { trpc } from "../trpc.js";
import { usePermissions } from "../hooks/usePermissions.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./PermissionsPanel.css";

const PERMISSIONS = ["microphone", "systemAudio", "input", "notifications"] as const;
type Permission = typeof PERMISSIONS[number];

export function PermissionsPanel() {
  const t = useT();
  const status = usePermissions();
  const open = trpc.permissions.openSettings.useMutation();
  const [error, setError] = useState(false);
  const inputPane = status.data?.macosMajor == null ? "unknownVersion"
    : status.data.macosMajor >= 27 ? "deviceControl" : "accessibility";
  const openSettings = async (permission: Permission) => {
    setError(false);
    try {
      await open.mutateAsync({ permission });
      await status.refetch();
    } catch { setError(true); }
  };

  return <section className="permissions-panel" id="permissions" aria-labelledby="permissions-title">
    <header className="permissions-heading">
      <div><h2 id="permissions-title"><ShieldCheck size={19} aria-hidden="true" />{t("permissions.title")}</h2><p>{t("permissions.intro")}</p></div>
      <button type="button" className="permissions-action" disabled={status.isFetching} onClick={() => void status.refetch()}>
        <RefreshCw size={14} aria-hidden="true" />{t("permissions.refresh")}
      </button>
    </header>
    <div className="permissions-list">
      {PERMISSIONS.map((permission) => {
        const observed = status.isError ? "check_failed" : status.data?.[permission] ?? "unknown";
        const ready = observed === "ready" || observed === "granted";
        const state = ready ? "ready" : observed === "unknown" ? "unknown" : "needsAttention";
        const label = permission === "systemAudio" && ready
          ? status.data?.systemAudioCapturing === false ? "authorizedIdle" : "authorized"
          : observed === "denied" ? "denied" : observed === "not_determined" ? "notDetermined"
          : observed === "check_failed" ? "checkFailed" : state;
        const path = permission === "input" ? `permissions.input.${inputPane}`
          : permission === "systemAudio" && (status.data?.macosMajor ?? 0) >= 27
            ? "permissions.systemAudio.path27" : `permissions.${permission}.path`;
        return <article className="permissions-row" key={permission} data-permission={permission} data-state={state}>
          <div className="permissions-copy">
            <h3>{t(`permissions.${permission}.title`)}{permission === "notifications" && <small>{t("permissions.optional")}</small>}</h3>
            <p>{t(`permissions.${permission}.purpose`)}</p>
            <p className="permissions-path">{t(path)}</p>
            {permission === "notifications" && observed === "denied" && <p>{t("permissions.notifications.ownerHint")}</p>}
          </div>
          <span className="permissions-state">{ready && <CheckCircle2 size={14} aria-hidden="true" />}{t(`permissions.state.${label}`)}</span>
          <button type="button" className="permissions-action" disabled={open.isPending} onClick={() => void openSettings(permission)}>
            {t(ready ? "permissions.manage" : permission === "notifications" && observed === "not_determined" ? "permissions.enable" : "permissions.open")}
          </button>
        </article>;
      })}
    </div>
    <p className="permissions-footnote">{t("permissions.returnHint")}</p>
    {(error || status.isError) && <p className="permissions-error" role="alert">{t(error ? "permissions.openFailed" : "permissions.checkFailed")}</p>}
  </section>;
}

export function PermissionReminder() {
  const t = useT();
  const status = usePermissions();
  const [dismissed, setDismissed] = useState(false);
  const data = status.data;
  if (dismissed || !data) return null;
  const inputMissing = data.voiceInputEnabled && data.input === "needs_attention";
  const audioMissing = data.microphone === "needs_attention";
  if (!inputMissing && !audioMissing) return null;
  return <aside className="permission-reminder" role="status">
    <ShieldCheck size={17} aria-hidden="true" />
    <span>{t(inputMissing ? "permissions.reminder.input" : "permissions.reminder.audio")}</span>
    <Link to="/onboarding#permissions">{t("permissions.reminder.open")}</Link>
    <button type="button" onClick={() => setDismissed(true)} aria-label={t("permissions.reminder.dismiss")}><X size={15} aria-hidden="true" /></button>
  </aside>;
}
