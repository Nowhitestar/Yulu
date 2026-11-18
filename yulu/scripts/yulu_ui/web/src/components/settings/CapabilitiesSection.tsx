import { trpc } from "../../trpc.js";
import { useT } from "../../i18n/LanguageProvider.js";

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

export interface Capability {
  provenance: string;
  status: string;
  resolved_path: string;
  detail: string;
}

function isConsoleManagedCapability(name: string): boolean {
  return [
    "llm_command",
    "claude",
    "codex",
    "hermes",
    "openclaw",
    "claude_cli",
    "codex_cli",
    "hermes_cli",
    "openclaw_cli",
  ].includes(name);
}

function isRetiredLocalTranscriptionCapability(name: string): boolean {
  return name === "models"
    || name === "diarization"
    || name === "mlx_whisper"
    || name === "whisper_cli"
    || name === "whisper-cli"
    || name.endsWith("_mlx_whisper");
}

export function CapabilityBadge({ status, detail }: { status: string; detail?: string }) {
  const t = useT();
  return (
    <span className="cap-badge" data-status={status} title={detail || undefined}>
      {t(statusKey(status))}
    </span>
  );
}

export function CapabilityStatusValue({ cap }: { cap?: Capability }) {
  const t = useT();
  if (!cap) {
    return (
      <>
        <span className="cap-path cap-path--empty">—</span>
        <div className="cap-detail">{t("settings.capabilities.none")}</div>
      </>
    );
  }
  return (
    <>
      {cap.resolved_path ? (
        <span className="cap-path">{cap.resolved_path}</span>
      ) : (
        <span className="cap-path cap-path--empty">—</span>
      )}
      {cap.detail ? <div className="cap-detail">{cap.detail}</div> : null}
    </>
  );
}

export function CapabilitiesSection() {
  const { data, refetch, isError, isPending } = trpc.capabilities.host_capabilities.useQuery();
  const t = useT();
  const capabilities = Object.entries((data?.capabilities ?? {}) as Record<string, Capability>)
    .filter(([name]) => !isConsoleManagedCapability(name) && !isRetiredLocalTranscriptionCapability(name));
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

      {isPending && !data ? (
        <div className="cap-error">{t("settings.capabilities.loading")}</div>
      ) : failed ? (
        <div className="cap-error">{t("settings.capabilities.error")}</div>
      ) : capabilities.length === 0 ? (
        <div className="cap-error">{t("settings.capabilities.none")}</div>
      ) : (
        capabilities.map(([name, capability]) => (
          <div className="row" key={name}>
            <div className="row-label">
              {name}
              <div className="row-help">{t(provenanceKey(capability.provenance))}</div>
            </div>
            <div className="row-value"><CapabilityStatusValue cap={capability} /></div>
            <div className="row-status"><CapabilityBadge status={capability.status} detail={capability.detail} /></div>
          </div>
        ))
      )}
    </section>
  );
}
