import { trpc } from "../../trpc.js";
import { useT } from "../../i18n/LanguageProvider.js";

// Provenance copy is locked by D-02. host-path and agent-config both read as
// "reused from your PATH" (the host coding agent already provides the tool);
// yulu-managed reads "Yulu-managed"; absent reads "not found". Returns an i18n
// key resolved by the caller through t(); an unknown provenance falls back to
// the raw string (translate() returns the key itself when it isn't a real key).
export function provenanceKey(provenance: string): string {
  switch (provenance) {
    case "host-path":
    case "agent-config":
      return "settings.capabilities.provenance.hostPath";
    case "yulu-managed":
      return "settings.capabilities.provenance.yuluManaged";
    case "absent":
      return "settings.capabilities.provenance.absent";
    default:
      return provenance;
  }
}

// Tri-state badge text (Phase 3 status: usable / present-but-unverified / absent).
// Never a boolean — three distinct human labels. Returns an i18n key (see above).
export function statusKey(status: string): string {
  switch (status) {
    case "usable":
      return "settings.capabilities.status.usable";
    case "present-but-unverified":
      return "settings.capabilities.status.unverified";
    case "absent":
      return "settings.capabilities.status.absent";
    default:
      return status;
  }
}

interface Capability {
  provenance: string;
  status: string;
  resolved_path: string;
  detail: string;
}

/**
 * CapabilitiesSection — the first UI consumer of the Phase 3 host capability
 * report (SET-01 consumer / SET-02 / D-02 / D-07). For each detected capability
 * it shows a friendly provenance label, the resolved path, and a tri-state
 * status badge. A manual "Refresh" re-runs the (subprocess-heavy) doctor query;
 * there is no aggressive polling (D-01).
 *
 * The report is treated as display-only: all strings render as JSX text
 * children, so React escapes them — never dangerouslySetInnerHTML (T-04-XSS).
 * A doctor failure resolves a typed `{ error, capabilities: {} }` shape upstream,
 * so this section shows a friendly line instead of blanking or crashing (SET-01).
 */
export function CapabilitiesSection() {
  const { data, refetch, isError } = trpc.capabilities.host_capabilities.useQuery();
  const t = useT();

  const caps = Object.entries((data?.capabilities ?? {}) as Record<string, Capability>);
  const failed = isError || Boolean(data?.error);

  return (
    <section id="capabilities" className="settings-section">
      <div className="cap-head">
        <div>
          <h2 className="settings-section-h">{t("settings.capabilities.heading")}</h2>
          <p className="settings-section-sub">{t("settings.capabilities.sub")}</p>
        </div>
        <button type="button" className="path-btn" onClick={() => { refetch(); }}>
          {t("settings.capabilities.refresh")}
        </button>
      </div>

      {failed ? (
        <div className="cap-error">
          {t("settings.capabilities.error")}
        </div>
      ) : caps.length === 0 ? (
        <div className="cap-error">{t("settings.capabilities.none")}</div>
      ) : (
        caps.map(([name, cap]) => (
          <div className="row" key={name}>
            <div className="row-label">
              {name}
              <div className="row-help">{t(provenanceKey(cap.provenance))}</div>
            </div>
            <div className="row-value">
              {cap.resolved_path ? (
                <span className="cap-path">{cap.resolved_path}</span>
              ) : (
                <span className="cap-path cap-path--empty">—</span>
              )}
            </div>
            <div className="row-status">
              <span className="cap-badge" data-status={cap.status}>
                {t(statusKey(cap.status))}
              </span>
            </div>
          </div>
        ))
      )}
    </section>
  );
}
