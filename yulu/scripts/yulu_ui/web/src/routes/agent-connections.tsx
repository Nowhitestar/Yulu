import { useEffect, useRef, useState } from "react";
import { Link, Navigate, useLocation, useSearchParams } from "react-router";
import { trpc } from "../trpc.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./agent-connections.css";

export const handle = { breadcrumb: "breadcrumb.agentConnections", filters: null };

export function LegacyAgentConnectionsRedirect() {
  const { search } = useLocation();
  return <Navigate to={`/settings/llm${search}`} replace />;
}

type Capability = "transcription" | "summary" | "conversation";

const SUPPORTED_RUNTIME_GUIDANCE = [
  { adapter: "codex", label: "Codex", command: "codex" },
  { adapter: "claude-code", label: "Claude Code", command: "claude" },
  { adapter: "hermes", label: "Hermes", command: "hermes" },
  { adapter: "openclaw", label: "OpenClaw", command: "openclaw" },
] as const;

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

function supportedAgentCopy(adapter: string) {
  if (adapter === "claude-code") return "agentConnections.claude";
  if (adapter === "hermes") return "agentConnections.hermes";
  if (adapter === "openclaw") return "agentConnections.openclaw";
  return "agentConnections.codex";
}

function authorizationClassLabel(
  t: ReturnType<typeof useT>,
  authorizationClass: string | null,
): string {
  if (authorizationClass === "chatgpt") return t("agentConnections.authorizationClass.chatgpt");
  if (authorizationClass === "claude-subscription") {
    return t("agentConnections.authorizationClass.claudeSubscription");
  }
  if (authorizationClass === "api-key") return t("agentConnections.authorizationClass.apiKey");
  if (authorizationClass === "amazon-bedrock") return t("agentConnections.authorizationClass.amazonBedrock");
  return t("agentConnections.authorizationClass.unknown");
}

function candidateModel(adapter: string) {
  if (adapter === "claude-code") return "claude-sonnet-5";
  if (adapter === "hermes") return "grok-4.6";
  if (adapter === "openclaw") return "openai-codex/gpt-5.5";
  return "gpt-5.6-sol";
}

function actionFailureReason(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : String(error || "Unknown error");
}

function readinessFailure(
  t: ReturnType<typeof useT>,
  capability: Capability,
  readiness: {
    model: string;
    credentialSource?: "oauth" | "api-key" | null;
    reason?: "invalid_model" | "missing_credentials" | "entitlement_failed" | "credential_refresh_failed" |
      "identity_mismatch" | "readiness_failed" | "unknown_outcome";
  },
): string {
  const source = readiness.credentialSource === "api-key"
    ? t("agentConnections.credentialSource.apiKey")
    : readiness.credentialSource === "oauth"
      ? t("agentConnections.credentialSource.oauth")
      : t("agentConnections.credentialSource.none");
  if (readiness.reason === "unknown_outcome") {
    return t(capability === "conversation"
      ? "agentConnections.remediation.conversationUnknownOutcome"
      : "agentConnections.remediation.unknownOutcome", { model: readiness.model, source });
  }
  if (capability === "transcription") {
    if (readiness.reason === "missing_credentials") {
      return t("agentConnections.remediation.transcriptionMissingCredentials", { source });
    }
    if (readiness.reason === "entitlement_failed") {
      return t("agentConnections.remediation.transcriptionEntitlement", { source });
    }
    if (readiness.reason === "credential_refresh_failed") {
      return t("agentConnections.remediation.transcriptionCredentialRefresh", { source });
    }
    if (readiness.reason === "identity_mismatch") {
      return t("agentConnections.remediation.transcriptionIdentityMismatch", { source });
    }
    return t("agentConnections.remediation.transcriptionProbeFailed", { source });
  }
  if (readiness.reason === "missing_credentials") {
    return t("agentConnections.remediation.missingCredentials", { model: readiness.model, source });
  }
  if (readiness.reason === "entitlement_failed") {
    return t("agentConnections.remediation.entitlement", { model: readiness.model, source });
  }
  if (readiness.reason === "credential_refresh_failed") {
    return t("agentConnections.remediation.credentialRefresh", { model: readiness.model, source });
  }
  if (readiness.reason === "identity_mismatch") {
    return t("agentConnections.remediation.identityMismatch", { model: readiness.model, source });
  }
  return readiness.reason === "invalid_model"
    ? t("agentConnections.remediation.invalidModel", { model: readiness.model, source })
    : t("agentConnections.remediation.probeFailed", { model: readiness.model, source });
}

export function AgentConnections({ embedded = false }: { embedded?: boolean } = {}) {
  const t = useT();
  const [searchParams] = useSearchParams();
  const view = trpc.agentConnections.view.useQuery();
  const utils = trpc.useUtils();
  const refreshCandidates = trpc.agentConnections.refreshCandidates.useMutation();
  const startNativeAuthorization = trpc.agentConnections.startNativeAuthorization.useMutation();
  const refreshNativeAuthorizationStatus = trpc.agentConnections.refreshNativeAuthorizationStatus.useMutation();
  const confirmCandidate = trpc.agentConnections.confirmCandidate.useMutation();
  const select = trpc.agentConnections.select.useMutation();
  const selectCredentialSource = trpc.agentConnections.selectCredentialSource.useMutation();
  const probe = trpc.agentConnections.probe.useMutation();
  const createConversationProbeAttempt = trpc.agentConnections.createConversationProbeAttempt.useMutation();
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
  const [acceptedSupportedDisclosures, setAcceptedSupportedDisclosures] = useState<Set<string>>(() => new Set());
  const [nativeLoginStarted, setNativeLoginStarted] = useState<string | null>(null);
  const [nativeAuthorizationStatus, setNativeAuthorizationStatus] = useState<Record<string, string>>({});
  const [impact, setImpact] = useState<DeletionImpact | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const deleteButtonRef = useRef<HTMLButtonElement | null>(null);
  const deletionDialogRef = useRef<HTMLElement>(null);
  const focusedRemediation = useRef<string | null>(null);
  const remediationConnection = searchParams.get("connection");
  const remediationCapability = searchParams.get("capability") as Capability | null;
  const remediationTargetId = remediationConnection && remediationCapability &&
    ["transcription", "summary", "conversation"].includes(remediationCapability)
    ? `agent-connection-${remediationConnection}-${remediationCapability}`
    : remediationConnection ? `agent-connection-${remediationConnection}` : null;

  useEffect(() => {
    if (!view.data || !remediationTargetId || focusedRemediation.current === remediationTargetId) return;
    const target = document.getElementById(remediationTargetId);
    if (!target) return;
    focusedRemediation.current = remediationTargetId;
    target.focus();
    target.scrollIntoView?.({
      block: "center",
      behavior: window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches ? "auto" : "smooth",
    });
  }, [remediationTargetId, view.data]);

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
    setActionError(null);
    try {
      await action();
      await refresh();
    } catch (error) {
      setActionError(actionFailureReason(error));
    }
  };
  const launchNativeLogin = (connectionId: string) => void run(async () => {
    await startNativeAuthorization.mutateAsync({ connectionId });
    setNativeLoginStarted(connectionId);
  });
  const refreshAfterNativeLogin = (connectionId: string) => void (async () => {
    setActionError(null);
    try {
      const status = await refreshNativeAuthorizationStatus.mutateAsync({ connectionId });
      await view.refetch();
      setNativeAuthorizationStatus((current) => ({ ...current, [connectionId]: status.detail }));
      setNativeLoginStarted((current) => current === connectionId ? null : current);
    } catch (error) {
      setActionError(actionFailureReason(error));
    }
  })();
  const nativeAuthorizationActions = (connectionId: string, label: string) => (
    <div className="agent-connection-actions">
      <button
        type="button"
        disabled={startNativeAuthorization.isPending}
        onClick={() => launchNativeLogin(connectionId)}
      >
        {t("agentConnections.nativeAuthorization.open", { agent: label })}
      </button>
      {nativeLoginStarted === connectionId && (
        <button
          type="button"
          disabled={refreshNativeAuthorizationStatus.isPending}
          onClick={() => refreshAfterNativeLogin(connectionId)}
        >
          {t("agentConnections.nativeAuthorization.refresh")}
        </button>
      )}
      {nativeAuthorizationStatus[connectionId] && (
        <p role="status">{nativeAuthorizationStatus[connectionId]}</p>
      )}
    </div>
  );

  if (view.isPending) return <section className="agent-connections-page" aria-live="polite">{t("agentConnections.loading")}</section>;
  if (view.isError || !view.data) {
    return (
      <section className="agent-connections-page">
        <h1>{t("agentConnections.title")}</h1>
        <p role="alert">{t("agentConnections.loadFailed")}</p>
      </section>
    );
  }

  type ConnectionView = (typeof view.data.connections)[number];
  const connection = view.data.connections.find((item): item is Extract<
    ConnectionView,
    { adapter: "direct-xai" }
  > => item.adapter === "direct-xai");
  const supportedAgentConnections = view.data.connections.filter((item): item is Extract<
    ConnectionView,
    { adapter: "codex" | "claude-code" | "hermes" | "openclaw" }
  > => item.adapter === "codex" || item.adapter === "claude-code" ||
    item.adapter === "hermes" || item.adapter === "openclaw");
  const deletionConnection = impact
    ? view.data.connections.find((item) => item.id === impact.connectionId)
    : undefined;
  const missingRemediationConnection = remediationConnection &&
    !view.data.connections.some((item) => item.id === remediationConnection)
    ? remediationConnection
    : null;
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

  const Page = embedded ? "section" : "main";
  const Title = embedded ? "h2" : "h1";
  return (
    <Page className={`agent-connections-page${embedded ? " embedded" : ""}`} aria-labelledby="agent-connections-title">
      <header className="agent-connections-hero">
        <div>
          <p className="agent-connections-eyebrow">Yulu Host</p>
          <Title id="agent-connections-title">{t("agentConnections.title")}</Title>
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
      {actionError && (
        <p className="agent-connection-error" role="alert">
          {t("agentConnections.actionFailedDetail", { reason: actionError })}
        </p>
      )}

      {missingRemediationConnection && remediationTargetId && (
        <section
          id={remediationTargetId}
          className="agent-connection-card agent-connection-missing"
          data-testid="missing-remediation-connection"
          aria-current="location"
          tabIndex={-1}
          role="alert"
        >
          <h2>{t("agentConnections.missing.heading")}</h2>
          <p>{t("agentConnections.missing.body", {
            connection: missingRemediationConnection,
            capability: remediationCapability
              ? capabilityLabel(t, remediationCapability)
              : t("agentConnections.missing.allCapabilities"),
          })}</p>
          <p>{t("agentConnections.missing.pinned")}</p>
          <button
            type="button"
            className="agent-connection-button"
            disabled={refreshCandidates.isPending}
            onClick={() => void run(() => refreshCandidates.mutateAsync())}
          >
            {t("agentConnections.refreshCandidates")}
          </button>
        </section>
      )}

      {connection && (
        <section
          id={`agent-connection-${connection.id}`}
          className="agent-connection-card"
          aria-labelledby="direct-xai-title"
          aria-current={remediationTargetId === `agent-connection-${connection.id}` ? "location" : undefined}
          tabIndex={-1}
        >
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
              const requiresNewAttempt = capability === "conversation" &&
                ((item.currentReadiness.reason === "unknown_outcome" && item.currentReadiness.model === model) ||
                  (history?.reason === "unknown_outcome" && history.model === model));
              return (
                <article
                  id={`agent-connection-${connection.id}-${capability}`}
                  className="agent-connection-capability"
                  data-testid={`connection-capability-${capability}`}
                  aria-current={remediationTargetId === `agent-connection-${connection.id}-${capability}` ? "location" : undefined}
                  tabIndex={-1}
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
                    <p className="agent-capability-detail">{readinessFailure(t, capability, item.currentReadiness)}</p>
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
                      <strong>{t(`agentConnections.disclosure.title.${capability}`, {
                        version: item.disclosure.disclosureVersion,
                      })}</strong>
                      <p>{t(`agentConnections.disclosure.${capability}`)}</p>
                      <button
                        type="button"
                        onClick={() => void run(() => acceptDisclosure.mutateAsync({ connectionId: connection.id, capability }))}
                      >
                        {t(`agentConnections.disclosure.accept.${capability}`)}
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
                      disabled={!connection.authorization.connected || !item.selected ||
                        item.disclosure?.required === true || probe.isPending ||
                        createConversationProbeAttempt.isPending}
                      onClick={() => void run(() => requiresNewAttempt
                        ? createConversationProbeAttempt.mutateAsync({
                            connectionId: connection.id,
                            model,
                          })
                        : probe.mutateAsync({ connectionId: connection.id, capability }))}
                    >
                      {testing
                        ? t("agentConnections.readiness.testing")
                        : requiresNewAttempt
                          ? t("agentConnections.test.newConversationAttempt")
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
              setActionError(null);
              void deletionImpact.mutateAsync({ connectionId: connection.id })
                .then(
                  (result) => setImpact(result as DeletionImpact),
                  (error) => setActionError(actionFailureReason(error)),
                );
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
        const copy = supportedAgentCopy(agent.adapter);
        return (
          <section
            id={`agent-connection-${agent.id}`}
            className="agent-connection-card"
            data-testid={`agent-connection-${agent.adapter}`}
            aria-labelledby={`${agent.id}-title`}
            aria-current={remediationTargetId === `agent-connection-${agent.id}` ? "location" : undefined}
            tabIndex={-1}
            key={agent.id}
          >
            <div className="agent-connection-card-head">
              <div>
                <h2 id={`${agent.id}-title`}>{agent.label}</h2>
                <p>{t(`${copy}.description`)}</p>
                {"summaryUnsupported" in agent && (
                  <p className="agent-capability-detail">{t(`${copy}.summaryUnsupported`)}</p>
                )}
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
                <dd>
                  {t(`${copy}.runtimeOAuth`)}
                  {"authorizationClass" in agent.authorization && (
                    <><br /><span>{authorizationClassLabel(
                      t,
                      agent.authorization.authorizationClass,
                    )}</span></>
                  )}
                </dd>
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
              {nativeAuthorizationActions(agent.id, agent.label)}
            </div>

            <div className="agent-connection-capabilities">
              {agent.capabilities.map((item) => {
                const capability = item.capability;
                const modelKey = `${agent.id}:${capability}`;
                const configuredModel = capability === "summary"
                  ? ("summaryModel" in agent.settings ? agent.settings.summaryModel : undefined) ??
                    agent.settings.conversationModel
                  : agent.settings.conversationModel;
                const model = agentModelDrafts[modelKey] ?? configuredModel;
                const testing = probe.isPending && probe.variables?.connectionId === agent.id &&
                  probe.variables.capability === capability;
                const current = testing ? "testing" : item.currentReadiness.status;
                const history = item.readinessHistory[0];
                const requiresNewAttempt = capability === "conversation" &&
                  ((item.currentReadiness.reason === "unknown_outcome" && item.currentReadiness.model === model) ||
                    (history?.reason === "unknown_outcome" && history.model === model));
                const disclosureAcceptedLocally = acceptedSupportedDisclosures.has(modelKey);
                return (
                  <article
                    id={`agent-connection-${agent.id}-${capability}`}
                    className="agent-connection-capability"
                    data-testid={`connection-capability-${agent.adapter}-${capability}`}
                    aria-current={remediationTargetId === `agent-connection-${agent.id}-${capability}` ? "location" : undefined}
                    tabIndex={-1}
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
                        {item.currentReadiness.detail}
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
                    {item.disclosure?.required && !disclosureAcceptedLocally && (
                      <div className="agent-connection-guidance" role="alert">
                        {t(`${copy}.disclosure.${capability}`)}
                        <button
                          type="button"
                          onClick={() => void run(async () => {
                            await acceptDisclosure.mutateAsync({ connectionId: agent.id, capability });
                            setAcceptedSupportedDisclosures((currentAccepted) => new Set(currentAccepted).add(modelKey));
                          })}
                        >
                          {t(`${copy}.disclosureAccept.${capability}`)}
                        </button>
                      </div>
                    )}
                    <div className="agent-connection-actions">
                      <button
                        type="button"
                        disabled={!agent.authorization.connected || !model.trim() ||
                          item.currentReadiness.status !== "ready"}
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
                        disabled={!agent.authorization.connected || probe.isPending ||
                          createConversationProbeAttempt.isPending ||
                          (item.disclosure?.required === true && !disclosureAcceptedLocally)}
                        onClick={() => void run(() => requiresNewAttempt
                          ? createConversationProbeAttempt.mutateAsync({
                              connectionId: agent.id,
                              model,
                            })
                          : probe.mutateAsync({
                              connectionId: agent.id,
                              capability,
                              model,
                            }))}
                      >
                        {testing
                          ? t("agentConnections.readiness.testing")
                          : requiresNewAttempt
                            ? t("agentConnections.test.newConversationAttempt")
                            : t(`agentConnections.test.${capability}`)}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
            <button
              type="button"
              className="agent-connection-delete"
              onClick={(event) => {
                deleteButtonRef.current = event.currentTarget;
                setActionError(null);
                void deletionImpact.mutateAsync({ connectionId: agent.id })
                  .then(
                    (result) => setImpact(result as DeletionImpact),
                    (error) => setActionError(actionFailureReason(error)),
                  );
              }}
            >
              {t("agentConnections.delete")}
            </button>
          </section>
        );
      })}

      <section
        className="agent-connections-list"
        data-testid="agent-runtime-install-guidance"
        aria-labelledby="agent-runtime-install-guidance-title"
      >
        <h2 id="agent-runtime-install-guidance-title">{t("agentConnections.install.title")}</h2>
        <p>{t("agentConnections.install.explanation")}</p>
        <ul>
          {SUPPORTED_RUNTIME_GUIDANCE.map((runtime) => (
            <li key={runtime.adapter}>
              {t("agentConnections.install.runtime", {
                agent: runtime.label,
                command: runtime.command,
              })}
            </li>
          ))}
        </ul>
      </section>

      <section className="agent-connections-list" aria-labelledby="agent-candidates-title">
        <h2 id="agent-candidates-title">{t("agentConnections.candidates.title")}</h2>
        <p>{t("agentConnections.candidates.explanation")}</p>
        {view.data.candidates.map((candidate) => (
          <details
            className="agent-connection-card compact"
            data-testid={`agent-candidate-${candidate.adapter}`}
            open={candidate.adapter === "codex" || candidate.adapter === "claude-code" ||
              candidate.adapter === "hermes" || candidate.adapter === "openclaw"}
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
            {(candidate.adapter === "codex" || candidate.adapter === "claude-code" ||
              candidate.adapter === "hermes" || candidate.adapter === "openclaw") && candidate.detectedPath && (
              <div className="agent-connection-candidate-action">
                <label className="agent-connection-model" htmlFor={`${candidate.id}-conversation-model`}>
                  <span>{t(`${supportedAgentCopy(candidate.adapter)}.model`)}</span>
                  <input
                    id={`${candidate.id}-conversation-model`}
                    type="text"
                    maxLength={128}
                    value={agentModelDrafts[candidate.id] ?? candidateModel(candidate.adapter)}
                    onChange={(event) => setAgentModelDrafts((currentModels) => ({
                      ...currentModels,
                      [candidate.id]: event.target.value,
                    }))}
                  />
                </label>
                <button
                  type="button"
                  disabled={confirmCandidate.isPending || !(agentModelDrafts[candidate.id] ?? candidateModel(candidate.adapter)).trim()}
                  onClick={() => void run(() => confirmCandidate.mutateAsync({
                    candidateId: candidate.id,
                    model: agentModelDrafts[candidate.id] ?? candidateModel(candidate.adapter),
                  }))}
                >
                  {t(`${supportedAgentCopy(candidate.adapter)}.confirm`)}
                </button>
                {nativeAuthorizationActions(candidate.id, candidate.label)}
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

      {!embedded && (
        <nav className="agent-connections-backlinks" aria-label={t("agentConnections.backlinks") }>
          <Link to="/activate">{t("breadcrumb.activate")}</Link>
          <Link to="/settings/llm">{t("breadcrumb.settings")}</Link>
          <Link to="/agent-console">{t("breadcrumb.agentConsole")}</Link>
        </nav>
      )}

      {impact && deletionConnection && (
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
            <h2 id="delete-agent-connection-title">{t("agentConnections.delete.title", { name: deletionConnection.label })}</h2>
            <p id="delete-agent-connection-body">{t("agentConnections.delete.body")}</p>
            <p>{t("agentConnections.delete.selected", {
              capabilities: impact.selectedCapabilities.map((item) => capabilityLabel(t, item)).join(" · ") || t("agentConnections.none"),
            })}</p>
            <h3>{t("agentConnections.delete.tasks")}</h3>
            <ul>{impact.pinnedTasks.map((task) => <li key={task.id}>{task.title} · {task.recordingStem}</li>)}</ul>
            <h3>{t("agentConnections.delete.conversations")}</h3>
            <ul>{impact.pinnedConversations.map((session) => <li key={session.id}>{session.title}</li>)}</ul>
            <p>{t(deletionConnection.adapter !== "direct-xai"
                ? "agentConnections.delete.runtimeBoundary"
                : "agentConnections.delete.oauthBoundary")}</p>
            <div className="agent-connection-actions">
              <button type="button" onClick={closeDeletionImpact}>{t("agentConnections.delete.cancel")}</button>
              <button
                type="button"
                className="agent-connection-delete"
                onClick={() => void run(async () => {
                  const deletedConnectionId = deletionConnection.id;
                  await remove.mutateAsync({ connectionId: deletedConnectionId, confirmed: true });
                  setAcceptedSupportedDisclosures((currentAccepted) => new Set(
                    [...currentAccepted].filter((key) => !key.startsWith(`${deletedConnectionId}:`)),
                  ));
                  closeDeletionImpact();
                })}
              >
                {t("agentConnections.delete.confirm")}
              </button>
            </div>
          </section>
        </div>
      )}
    </Page>
  );
}
