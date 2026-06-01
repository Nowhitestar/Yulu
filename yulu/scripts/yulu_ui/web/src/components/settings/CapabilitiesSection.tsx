import { trpc } from "../../trpc.js";

// Provenance copy is locked by D-02. host-path and agent-config both read as
// "reused from your PATH" (the host coding agent already provides the tool);
// yulu-managed reads "Yulu-managed"; absent reads "not found".
export function provenanceLabel(provenance: string): string {
  switch (provenance) {
    case "host-path":
    case "agent-config":
      return "reused from your PATH";
    case "yulu-managed":
      return "Yulu-managed";
    case "absent":
      return "not found";
    default:
      return provenance;
  }
}

// Tri-state badge text (Phase 3 status: usable / present-but-unverified / absent).
// Never a boolean — three distinct human labels.
export function statusLabel(status: string): string {
  switch (status) {
    case "usable":
      return "usable";
    case "present-but-unverified":
      return "present, unverified";
    case "absent":
      return "absent";
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

  const caps = Object.entries((data?.capabilities ?? {}) as Record<string, Capability>);
  const failed = isError || Boolean(data?.error);

  return (
    <section id="capabilities" className="settings-section">
      <div className="cap-head">
        <div>
          <h2 className="settings-section-h">Capabilities</h2>
          <p className="settings-section-sub">What Yulu detected on this machine</p>
        </div>
        <button type="button" className="path-btn" onClick={() => { refetch(); }}>
          Refresh
        </button>
      </div>

      {failed ? (
        <div className="cap-error">
          Couldn&apos;t read capabilities right now — try Refresh.
        </div>
      ) : caps.length === 0 ? (
        <div className="cap-error">No capabilities detected yet — try Refresh.</div>
      ) : (
        caps.map(([name, cap]) => (
          <div className="row" key={name}>
            <div className="row-label">
              {name}
              <div className="row-help">{provenanceLabel(cap.provenance)}</div>
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
                {statusLabel(cap.status)}
              </span>
            </div>
          </div>
        ))
      )}
    </section>
  );
}
