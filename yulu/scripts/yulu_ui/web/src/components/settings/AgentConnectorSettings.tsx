import { useState } from "react";
import { trpc } from "../../trpc.js";
import { useT } from "../../i18n/LanguageProvider.js";

export function AgentConnectorSettings() {
  const t = useT();
  const [open, setOpen] = useState(false);
  return <div id="agent-connectors"><details className="adv-disclosure" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="adv-summary"><span>{t("assistant.connectors")}</span><span className="adv-summary-note">{t("assistant.connectors.note")}</span></summary>
    <div className="adv-body">{open && <AgentConnectorControls />}</div>
  </details></div>;
}

export function AgentConnectorControls() {
  const t = useT();
  const overview = trpc.agentConsole.connectors.useQuery(undefined, { retry: false });
  const [copied, setCopied] = useState(false);
  const configure = trpc.agentConsole.configurePlugin.useMutation({ onSuccess: () => setCopied(false) });
  const guide = configure.data;
  const connectors = overview.data?.all.filter((plugin) => plugin.id !== "summary") ?? [];
  return <section className="settings-section agent-connector-settings">
    <p className="settings-section-sub">{t("assistant.connectors.ownership", { agent: overview.data?.agent ?? "Agent" })}</p>
    {overview.isError ? <p role="alert">{t("assistant.connectors.error")}</p> : overview.isPending ? <p>{t("common.loading")}</p> : connectors.map((plugin) => <div className="settings-connector-row" key={plugin.id}>
      <strong>{plugin.label}</strong><span>{t(`assistant.connector.${plugin.status}`)}</span>
      <button type="button" className="settings-action" aria-label={`${t("assistant.connector.manage")} ${plugin.label}`} disabled={configure.isPending || plugin.status === "unsupported"} onClick={() => configure.mutate({ plugin: plugin.id })}>{t("assistant.connector.manage")}</button>
    </div>)}
    {configure.error && <p role="alert">{configure.error.message}</p>}
    {guide && <div className="settings-connector-guide" role="region" aria-label={`${guide.label} Connector 管理`}>
      <strong>{t("assistant.connector.guide", { agent: guide.agent ?? "Agent", label: guide.label })}</strong><p>{guide.message}</p>
      {guide.manageCommand && <><code>{guide.manageCommand}</code><button type="button" className="settings-action" onClick={() => void navigator.clipboard.writeText(guide.manageCommand).then(() => setCopied(true)).catch(() => window.prompt(t("assistant.connector.copy"), guide.manageCommand))}>{t(copied ? "assistant.connector.copied" : "assistant.connector.copy")}</button></>}
    </div>}
    <button type="button" className="settings-text-link" disabled={overview.isFetching} onClick={() => void overview.refetch()}>{t("common.refresh")}</button>
  </section>;
}
