import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { trpc } from "../trpc.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./agent-connections.css";

export const handle = { breadcrumb: "breadcrumb.agentConnections", filters: null };

type Capability = "transcription" | "summary" | "conversation";

interface DeletionImpact {
  connectionId: string;
  selectedCapabilities: Capability[];
  pinnedTasks: Array<{ id: string; title: string; recordingStem: string }>;
  pinnedConversations: Array<{ id: string; title: string }>;
  removesRuntimeAuthorization: boolean;
  removesYuluManagedCredentials: boolean;
}

function capabilityLabel(t: ReturnType<typeof useT>, capability: Capability): string {
  return t(`agentConnections.capability.${capability}`);
}

function readinessFailure(
  t: ReturnType<typeof useT>,
  readiness: { model: string; reason?: "invalid_model" | "readiness_failed" },
): string {
  return readiness.reason === "invalid_model"
    ? t("agentConnections.remediation.invalidModel", { model: readiness.model })
    : t("agentConnections.remediation.probeFailed", { model: readiness.model });
}

export function AgentConnections() {
  const t = useT();
  const view = trpc.agentConnections.view.useQuery();
  const utils = trpc.useUtils();
  const refreshCandidates = trpc.agentConnections.refreshCandidates.useMutation();
  const confirmCandidate = trpc.agentConnections.confirmCandidate.useMutation();
  const select = trpc.agentConnections.select.useMutation();
  const selectCredentialSource = trpc.agentConnections.selectCredentialSource.useMutation();
  const probe = trpc.agentConnections.probe.useMutation();
  const acceptDisclosure = trpc.agentConnections.acceptDisclosure.useMutation();
  const restoreDirectXai = trpc.agentConnections.restoreDirectXai.useMutation();
  const authorize = trpc.agentConnections.authorize.useMutation();
  const cancelAuthorization = trpc.agentConnections.cancelAuthorization.useMutation();
  const logoutOAuth = trpc.agentConnections.logoutOAuth.useMutation();
  const setApiKey = trpc.agentConnections.setApiKey.useMutation();
  const clearApiKey = trpc.agentConnections.clearApiKey.useMutation();
  const deletionImpact = trpc.agentConnections.deletionImpact.useMutation();
  const remove = trpc.agentConnections.remove.useMutation();
  const [apiKey, setApiKeyValue] = useState("");
  const [modelDrafts, setModelDrafts] = useState<Partial<Record<Capability, string>>>({});
  const [agentModelDrafts, setAgentModelDrafts] = useState<Record<string, string>>({});
  const [impact, setImpact] = useState<DeletionImpact | null>(null);
  const [actionError, setActionError] = useState(false);
  const deleteButtonRef = useRef<HTMLButtonElement>(null);
  const deletionDialogRef = useRef<HTMLElement>(null);

  useEffect(() => {
    if (impact) deletionDialogRef.current?.focus();
  }, [impact]);

  const closeDeletionImpact = () => {
    setImpact(null);
    queueMicrotask(() => deleteButtonRef.current?.focus());
  };

  const refresh = async () => {
    await utils.agentConnections.view.invalidate();
  };
  const run = async (action: () => Promise<unknown>) => {
    setActionError(false);
    try {
      await action();
      await refresh();
    } catch {
      setActionError(true);
    }
  };

  if (view.isPending) return <main className="agent-connections-page" aria-live="polite">{t("agentConnections.loading")}</main>;
  if (view.isError || !view.data) {
    return (
      <main className="agent-connections-page">
        <h1>{t("agentConnections.title")}</h1>
        <p role="alert">{t("agentConnections.loadFailed")}</p>
      </main>
    );
  }

  type ConnectionView = (typeof view.data.connections)[number];
  const connection = view.data.connections.find((item): item is Extract<
    ConnectionView,
    { adapter: "direct-xai" }
  > => item.adapter === "direct-xai");
  const supportedAgentConnections = view.data.connections.filter((item): item is Extract<
    ConnectionView,
    { adapter: "codex" | "claude-code" }
  > => item.adapter === "codex" || item.adapter === "claude-code");
  const authorizing = connection?.authorization.status === "starting" || connection?.authorization.status === "running";
  const startAuthorization = () => {
    const authorizationWindow = window.open("about:blank", "_blank");
    if (authorizationWindow) authorizationWindow.opener = null;
    void run(async () => {
      const state = await authorize.mutateAsync();
      if (!state.verificationUrl) {
        authorizationWindow?.close();
      } else if (authorizationWindow) {
        authorizationWindow.location.href = state.verificationUrl;
      } else {
        window.open(state.verificationUrl, "_blank", "noopener,noreferrer");
      }
    });
  };

  return (
    <main className="agent-connections-page" aria-labelledby="agent-connections-title">
      <header className="agent-connections-hero">
        <div>
          <p className="agent-connections-eyebrow">Yulu Host</p>
          <h1 id="agent-connections-title">{t("agentConnections.title")}</h1>
          <p>{t("agentConnections.subtitle")}</p>
        </div>
        <button
          type="button"
          className="agent-connection-button"
          disabled={refreshCandidates.isPending}
          onClick={() => void run(() => refreshCandidates.mutateAsync())}
        >
          {t("agentConnections.refreshCandidates")}
        </button>
      </header>

      <p className="agent-connections-shared-note">{t("agentConnections.sharedDestination")}</p>
      {actionError && <p className="agent-connection-error" role="alert">{t("agentConnections.actionFailed")}</p>}

      {connection && (
        <section className="agent-connection-card" aria-labelledby="direct-xai-title">
          <div className="agent-connection-card-head">
            <div>
              <h2 id="direct-xai-title">xAI</h2>
              <p>{t("agentConnections.xai.description")}</p>
            </div>
            <span
              className={`agent-connection-state ${connection.authorization.connected ? "ready" : "muted"}`}
              role="status"
              aria-label={t("agentConnections.xai.statusAria")}
            >
              {connection.authorization.connected
                ? t("agentConnections.connected")
                : t("agentConnections.disconnected")}
            </span>
          </div>

          <div className="agent-connection-actions">
            {authorizing ? (
              <button type="button" onClick={() => void run(() => cancelAuthorization.mutateAsync())}>
                {t("agentConnections.authorization.cancel")}
              </button>
            ) : (
              <button type="button" onClick={startAuthorization}>
                {connection.authorization.oauthConnected
                  ? t("agentConnections.authorization.reconnect")
                  : t("agentConnections.authorization.connect")}
              </button>
            )}
            {connection.authorization.oauthConnected && !authorizing && (
              <button type="button" onClick={() => void run(() => logoutOAuth.mutateAsync())}>
                {t("agentConnections.authorization.logout")}
              </button>
            )}
          </div>

          <fieldset className="agent-connection-credential-source">
            <legend>{t("agentConnections.credentialSource.legend")}</legend>
            <label>
              <input
                type="radio"
                name="direct-xai-credential-source"
                checked={connection.authorization.credentialSource === "oauth"}
                onChange={() => void run(() => selectCredentialSource.mutateAsync({
                  connectionId: connection.id,
                  credentialSource: "oauth",
                }))}
              />
              {t("agentConnections.credentialSource.oauth")}
            </label>
            <label>
              <input
                type="radio"
                name="direct-xai-credential-source"
                checked={connection.authorization.credentialSource === "api-key"}
                onChange={() => void run(() => selectCredentialSource.mutateAsync({
                  connectionId: connection.id,
                  credentialSource: "api-key",
                }))}
              />
              {t("agentConnections.credentialSource.apiKey")}
            </label>
            {connection.authorization.credentialSource === null && (
              <small>{t("agentConnections.credentialSource.required")}</small>
            )}
          </fieldset>

          {authorizing && (
            <div className="agent-connection-guidance" role="status" aria-live="polite">
              {t("agentConnections.authorization.nativeFlow")}
              {connection.authorization.verificationUrl && (
                <> · <a href={connection.authorization.verificationUrl} target="_blank" rel="noreferrer">{t("agentConnections.authorization.open")}</a></>
              )}
              {connection.authorization.userCode && <> · <code>{connection.authorization.userCode}</code></>}
            </div>
          )}

          <form
            className="agent-connection-api-key"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                await setApiKey.mutateAsync({ apiKey });
                setApiKeyValue("");
              });
            }}
          >
            <label htmlFor="agent-connection-xai-key">{t("agentConnections.apiKey.label")}</label>
            <div>
              <input
                id="agent-connection-xai-key"
                type="password"
                autoComplete="new-password"
                maxLength={4_096}
                value={apiKey}
                onChange={(event) => setApiKeyValue(event.target.value)}
              />
              <button type="submit" disabled={!apiKey.trim()}>{t("agentConnections.apiKey.save")}</button>
              {connection.authorization.apiKeyConfigured && (
                <button type="button" onClick={() => void run(() => clearApiKey.mutateAsync())}>
                  {t("agentConnections.apiKey.remove")}
                </button>
              )}
            </div>
            <small>{t("agentConnections.apiKey.help")}</small>
          </form>

          <div className="agent-connection-capabilities">
            {connection.capabilities.map((item) => {
              const capability = item.capability as Capability;
              const testing = probe.isPending && probe.variables?.capability === capability;
              const current = testing ? "testing" : item.currentReadiness.status;
              const history = item.readinessHistory[0];
              const model = modelDrafts[capability] ?? item.currentReadiness.model;
              return (
                <article className="agent-connection-capability" data-testid={`connection-capability-${capability}`} key={capability}>
                  <div className="agent-connection-capability-head">
                    <div>
                      <h3>{capabilityLabel(t, capability)}</h3>
                      <p>{item.currentReadiness.model}</p>
                    </div>
                    <span
                      className={`agent-capability-state ${current}`}
                      role={current === "failed" ? "alert" : "status"}
                    >
                      {t(`agentConnections.readiness.${current}`)}
                    </span>
                  </div>
                  {item.currentReadiness.status === "failed" && (
                    <p className="agent-capability-detail">{readinessFailure(t, item.currentReadiness)}</p>
                  )}
                  {history && (
                    <p className="agent-readiness-history">
                      {t("agentConnections.readiness.history", { state: t(`agentConnections.readiness.${history.status}`) })}
                      {" · "}{history.model}{" · "}{history.testedAt.slice(0, 16).replace("T", " ")}
                    </p>
                  )}
                  {capability !== "transcription" && (
                    <label className="agent-connection-model" htmlFor={`agent-connection-model-${capability}`}>
                      <span>{t("agentConnections.model", { capability: capabilityLabel(t, capability) })}</span>
                      <input
                        id={`agent-connection-model-${capability}`}
                        type="text"
                        maxLength={128}
                        value={model}
                        onChange={(event) => setModelDrafts((currentDrafts) => ({
                          ...currentDrafts,
                          [capability]: event.target.value,
                        }))}
                      />
                    </label>
                  )}
                  {item.disclosure?.required && (
                    <div className="agent-connection-guidance" role="alert">
                      {t(`agentConnections.disclosure.${capability}`)}
                      <button
                        type="button"
                        onClick={() => void run(() => acceptDisclosure.mutateAsync({ connectionId: connection.id, capability }))}
                      >
                        {t("agentConnections.disclosure.accept")}
                      </button>
                    </div>
                  )}
                  <div className="agent-connection-actions">
                    {(capability !== "transcription" || !item.selected) && (
                      <button
                        type="button"
                        disabled={capability !== "transcription" && !model.trim()}
                        onClick={() => void run(() => select.mutateAsync({
                          connectionId: connection.id,
                          capability,
                          ...(capability === "transcription" ? {} : { model }),
                        }))}
                      >
                        {capability === "transcription"
                          ? t("agentConnections.select")
                          : t("agentConnections.saveSelection", { capability: capabilityLabel(t, capability) })}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!connection.authorization.connected || probe.isPending}
                      onClick={() => void run(() => probe.mutateAsync({ connectionId: connection.id, capability }))}
                    >
                      {testing
                        ? t("agentConnections.readiness.testing")
                        : t(`agentConnections.test.${capability}`)}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          <button
            ref={deleteButtonRef}
            type="button"
            className="agent-connection-delete"
            onClick={() => {
              setActionError(false);
              void deletionImpact.mutateAsync({ connectionId: connection.id })
                .then((result) => setImpact(result as DeletionImpact), () => setActionError(true));
            }}
          >
            {t("agentConnections.delete")}
          </button>
        </section>
      )}
      {!connection && (
        <section className="agent-connection-card" aria-labelledby="restore-direct-xai-title">
          <h2 id="restore-direct-xai-title">xAI</h2>
          <p>{t("agentConnections.restore.description")}</p>
          <button
            type="button"
            className="agent-connection-button"
            disabled={restoreDirectXai.isPending}
            onClick={() => void run(() => restoreDirectXai.mutateAsync())}
          >
            {t("agentConnections.restore.action")}
          </button>
        </section>
      )}

      {supportedAgentConnections.map((agent) => {
        const copy = agent.adapter === "claude-code"
          ? "agentConnections.claude"
          : "agentConnections.codex";
        return (
          <section
            className="agent-connection-card"
            data-testid={`agent-connection-${agent.adapter}`}
            aria-labelledby={`${agent.id}-title`}
            key={agent.id}
          >
            <div className="agent-connection-card-head">
              <div>
                <h2 id={`${agent.id}-title`}>{agent.label}</h2>
                <p>{t(`${copy}.description`)}</p>
              </div>
              <span
                className={`agent-connection-state ${agent.authorization.connected ? "ready" : "muted"}`}
                role="status"
                aria-label={t(`${copy}.statusAria`)}
              >
                {agent.authorization.connected
                  ? t("agentConnections.connected")
                  : t("agentConnections.disconnected")}
              </span>
            </div>

            <dl className="agent-connection-runtime-details">
              <div>
                <dt>{t(`${copy}.version`)}</dt>
                <dd>{agent.authorization.runtimeVersion ?? "—"} · {t(`${copy}.minimumVersion`, {
                  version: agent.authorization.minimumVersion ?? "—",
                })}</dd>
              </div>
              <div>
                <dt>{t(`${copy}.authorization`)}</dt>
                <dd>{t(`${copy}.runtimeOAuth`)}</dd>
              </div>
              <div>
                <dt>{t(`${copy}.features`)}</dt>
                <dd>{agent.authorization.features.join(" · ")}</dd>
              </div>
            </dl>

            <div className="agent-connection-guidance" role={agent.authorization.remediation ? "alert" : "note"}>
              <p>{t(`${copy}.loginGuidance`)}</p>
              <code>{agent.authorization.loginCommand}</code>
              <br />
              <code>{agent.authorization.statusCommand}</code>
              {agent.authorization.remediation && <p>{agent.authorization.remediation}</p>}
            </div>

            <div className="agent-connection-capabilities">
              {agent.capabilities.map((item) => {
                const capability = item.capability;
                const modelKey = `${agent.id}:${capability}`;
                const configuredModel = capability === "summary" && "summaryModel" in agent.settings
                  ? agent.settings.summaryModel
                  : agent.settings.conversationModel;
                const model = agentModelDrafts[modelKey] ?? configuredModel;
                const testing = probe.isPending && probe.variables?.connectionId === agent.id &&
                  probe.variables.capability === capability;
                const current = testing ? "testing" : item.currentReadiness.status;
                return (
                  <article
                    className="agent-connection-capability"
                    data-testid={`connection-capability-${agent.adapter}-${capability}`}
                    key={capability}
                  >
                    <div className="agent-connection-capability-head">
                      <div>
                        <h3>{capabilityLabel(t, capability)}</h3>
                        <p>{item.currentReadiness.model}</p>
                      </div>
                      <span
                        className={`agent-capability-state ${current}`}
                        role={current === "failed" ? "alert" : "status"}
                      >
                        {t(`agentConnections.readiness.${current}`)}
                      </span>
                    </div>
                    {item.currentReadiness.status === "failed" && (
                      <p className="agent-capability-detail">
                        {readinessFailure(t, item.currentReadiness)}
                      </p>
                    )}
                    <label className="agent-connection-model" htmlFor={`${agent.id}-${capability}-model`}>
                      <span>{t(`${copy}.model.${capability}`)}</span>
                      <input
                        id={`${agent.id}-${capability}-model`}
                        type="text"
                        maxLength={128}
                        value={model}
                        onChange={(event) => setAgentModelDrafts((currentModels) => ({
                          ...currentModels,
                          [modelKey]: event.target.value,
                        }))}
                      />
                    </label>
                    {item.disclosure?.required && (
                      <div className="agent-connection-guidance" role="alert">
                        {t(`${copy}.disclosure.${capability}`)}
                        <button
                          type="button"
                          onClick={() => void run(() => acceptDisclosure.mutateAsync({
                            connectionId: agent.id,
                            capability,
                          }))}
                        >
                          {t(`${copy}.disclosureAccept.${capability}`)}
                        </button>
                      </div>
                    )}
                    <div className="agent-connection-actions">
                      <button
                        type="button"
                        disabled={!model.trim()}
                        onClick={() => void run(() => select.mutateAsync({
                          connectionId: agent.id,
                          capability,
                          model,
                        }))}
                      >
                        {t(`${copy}.select.${capability}`)}
                      </button>
                      <button
                        type="button"
                        disabled={!agent.authorization.connected || probe.isPending}
                        onClick={() => void run(() => probe.mutateAsync({
                          connectionId: agent.id,
                          capability,
                          model,
                        }))}
                      >
                        {testing
                          ? t("agentConnections.readiness.testing")
                          : t(`agentConnections.test.${capability}`)}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        );
      })}

      <section className="agent-connections-list" aria-labelledby="agent-candidates-title">
        <h2 id="agent-candidates-title">{t("agentConnections.candidates.title")}</h2>
        <p>{t("agentConnections.candidates.explanation")}</p>
        {view.data.candidates.map((candidate) => (
          <details
            className="agent-connection-card compact"
            data-testid={`agent-candidate-${candidate.adapter}`}
            open={candidate.adapter === "codex" || candidate.adapter === "claude-code"}
            key={candidate.id}
          >
            <summary>
              <strong>{candidate.label}</strong>
              <span>{t("agentConnections.candidates.badge")}</span>
            </summary>
            <p>{t("agentConnections.candidates.notReady")}</p>
            <dl>
              <div><dt>{t("agentConnections.detectedPath")}</dt><dd><code>{candidate.detectedPath ?? t("agentConnections.migrated")}</code></dd></div>
              <div><dt>{t("agentConnections.declaredCapabilities")}</dt><dd>{candidate.capabilities.map((item) => capabilityLabel(t, item as Capability)).join(" · ")}</dd></div>
            </dl>
            {(candidate.adapter === "codex" || candidate.adapter === "claude-code") && candidate.detectedPath && (
              <div className="agent-connection-candidate-action">
                <label className="agent-connection-model" htmlFor={`${candidate.id}-conversation-model`}>
                  <span>{t(candidate.adapter === "claude-code"
                    ? "agentConnections.claude.model"
                    : "agentConnections.codex.model")}</span>
                  <input
                    id={`${candidate.id}-conversation-model`}
                    type="text"
                    maxLength={128}
                    value={agentModelDrafts[candidate.id] ?? (candidate.adapter === "claude-code" ? "claude-sonnet-5" : "gpt-5.6-sol")}
                    onChange={(event) => setAgentModelDrafts((currentModels) => ({
                      ...currentModels,
                      [candidate.id]: event.target.value,
                    }))}
                  />
                </label>
                <button
                  type="button"
                  disabled={confirmCandidate.isPending || !(agentModelDrafts[candidate.id] ?? (candidate.adapter === "claude-code" ? "claude-sonnet-5" : "gpt-5.6-sol")).trim()}
                  onClick={() => void run(() => confirmCandidate.mutateAsync({
                    candidateId: candidate.id,
                    model: agentModelDrafts[candidate.id] ?? (candidate.adapter === "claude-code" ? "claude-sonnet-5" : "gpt-5.6-sol"),
                  }))}
                >
                  {t(candidate.adapter === "claude-code"
                    ? "agentConnections.claude.confirm"
                    : "agentConnections.codex.confirm")}
                </button>
              </div>
            )}
          </details>
        ))}
        {view.data.candidates.length === 0 && <p>{t("agentConnections.candidates.empty")}</p>}
      </section>

      {view.data.legacyConnections.length > 0 && (
        <section className="agent-connections-list" aria-labelledby="legacy-connections-title">
          <h2 id="legacy-connections-title">{t("agentConnections.legacy.title")}</h2>
          <p role="note">{t("agentConnections.legacy.explanation")}</p>
          {view.data.legacyConnections.map((legacy) => (
            <div className="agent-connection-card compact" key={legacy.id}>
              <strong>{legacy.label}</strong>
              <p>{t("agentConnections.legacy.manualOnly")}</p>
            </div>
          ))}
        </section>
      )}

      <nav className="agent-connections-backlinks" aria-label={t("agentConnections.backlinks") }>
        <Link to="/activate">{t("breadcrumb.activate")}</Link>
        <Link to="/settings/llm">{t("breadcrumb.settings")}</Link>
        <Link to="/agent-console">{t("breadcrumb.agentConsole")}</Link>
      </nav>

      {impact && connection && (
        <div className="agent-connection-dialog-backdrop">
          <section
            ref={deletionDialogRef}
            className="agent-connection-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-agent-connection-title"
            aria-describedby="delete-agent-connection-body"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Escape") closeDeletionImpact();
            }}
          >
            <h2 id="delete-agent-connection-title">{t("agentConnections.delete.title", { name: connection.label })}</h2>
            <p id="delete-agent-connection-body">{t("agentConnections.delete.body")}</p>
            <p>{t("agentConnections.delete.selected", {
              capabilities: impact.selectedCapabilities.map((item) => capabilityLabel(t, item)).join(" · ") || t("agentConnections.none"),
            })}</p>
            <h3>{t("agentConnections.delete.tasks")}</h3>
            <ul>{impact.pinnedTasks.map((task) => <li key={task.id}>{task.title} · {task.recordingStem}</li>)}</ul>
            <h3>{t("agentConnections.delete.conversations")}</h3>
            <ul>{impact.pinnedConversations.map((session) => <li key={session.id}>{session.title}</li>)}</ul>
            <p>{t("agentConnections.delete.oauthBoundary")}</p>
            <div className="agent-connection-actions">
              <button type="button" onClick={closeDeletionImpact}>{t("agentConnections.delete.cancel")}</button>
              <button
                type="button"
                className="agent-connection-delete"
                onClick={() => void run(async () => {
                  await remove.mutateAsync({ connectionId: connection.id, confirmed: true });
                  closeDeletionImpact();
                })}
              >
                {t("agentConnections.delete.confirm")}
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
