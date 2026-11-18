import { Fragment, useState } from "react";
import { trpc } from "../../trpc.js";
import { useT } from "../../i18n/LanguageProvider.js";

const NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", openclaw: "OpenClaw", hermes: "Hermes" };

/**
 * Yulu has no assistant of its own: questions about your meetings belong in the
 * Agent you already use. This registers Yulu's MCP endpoint with those Agents.
 */
export function McpAgentsSection() {
  const t = useT();
  const utils = trpc.useUtils();
  const status = trpc.mcpAgents.status.useQuery(undefined, { retry: false });
  const install = trpc.mcpAgents.install.useMutation({ onSettled: () => void utils.mcpAgents.status.invalidate() });
  const test = trpc.mcpAgents.test.useMutation();
  // What this session did, for Agents that cannot report their own registration.
  const [outcome, setOutcome] = useState<Record<string, "connected" | "failed">>({});
  const agents = (status.data?.agents ?? []).filter((agent) => agent.detected);

  const connect = (id: (typeof agents)[number]["id"]) => {
    install.mutate({ agent: id }, {
      onSuccess: (result) => setOutcome((current) => ({ ...current, [id]: result.ok ? "connected" : "failed" })),
      onError: () => setOutcome((current) => ({ ...current, [id]: "failed" })),
    });
  };

  return (
    <section id="mcp-agents" className="settings-section">
      <h2 className="settings-section-h">{t("settings.mcp.heading")}</h2>
      <p className="settings-section-sub">{t("settings.mcp.sub")}</p>
      {status.isPending ? <p className="settings-section-sub">{t("common.loading")}</p>
        : !status.data?.available ? <p className="settings-section-sub" role="alert">{t("settings.mcp.unavailable")}</p>
        : agents.length === 0 ? <p className="settings-section-sub">{t("settings.mcp.none")}</p>
        : agents.map((agent) => {
          const name = NAMES[agent.id] ?? agent.id;
          const connected = agent.configured === true || outcome[agent.id] === "connected";
          const connecting = install.isPending && install.variables?.agent === agent.id;
          return (
            <Fragment key={agent.id}>
              <div className="row" data-agent={agent.id}>
                <div className="row-label">{name}</div>
                <div className="row-value">
                  <span className="mcp-agent-state" data-connected={connected}>
                    <i aria-hidden="true" />
                    {t(connected ? "settings.mcp.connected" : agent.configured === null ? "settings.mcp.unknown" : "settings.mcp.notConnected")}
                  </span>
                  {connected ? (
                    <button type="button" className="btn" disabled={test.isPending} aria-label={`${t("settings.mcp.test")} ${name}`} onClick={() => test.mutate()}>
                      {t("settings.mcp.test")}
                    </button>
                  ) : (
                    <button type="button" className="btn" disabled={install.isPending} aria-label={`${t("settings.mcp.connect")} ${name}`} onClick={() => connect(agent.id)}>
                      {t(connecting ? "settings.mcp.connecting" : "settings.mcp.connect")}
                    </button>
                  )}
                </div>
                <div className="row-status" />
              </div>
              {outcome[agent.id] === "connected" && <p className="settings-section-sub" role="status">{t("settings.mcp.connectOk", { agent: name })}</p>}
              {outcome[agent.id] === "failed" && <p className="calendar-source-error" role="alert">{t("settings.mcp.connectFailed", { agent: name, id: agent.id })}</p>}
            </Fragment>
          );
        })}
      {test.data && <p className={test.data.ok ? "settings-section-sub" : "calendar-source-error"} role="status">{t(test.data.ok ? "settings.mcp.testOk" : "settings.mcp.testFailed")}</p>}
    </section>
  );
}
