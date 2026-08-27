import { basename } from "node:path";
import { randomUUID } from "node:crypto";
import type { ConfigManager } from "./config.js";
import type { HostStore, PersistedAgentConnection } from "./hostStore.js";
import type {
  XaiAuthorizationState,
  XaiCredentialSource,
  XaiCredentialStatus,
} from "./xaiCredentials.js";
import type { XaiProviderReadiness, XaiReadinessResult } from "./routers/providers.js";
import { XAI_TEXT_MODEL_DEFAULT } from "./settingsRegistry.js";
import {
  CLAUDE_CODE_SUMMARY_DISCLOSURE_VERSION,
  CLIPROXYAPI_SUMMARY_DISCLOSURE_VERSION,
  CODEX_SUMMARY_DISCLOSURE_VERSION,
  hasCurrentXaiSummaryDisclosure,
  XAI_SUMMARY_DISCLOSURE_VERSION,
} from "./summaryDataDisclosure.js";
import {
  hasCurrentXaiTranscriptionConsent,
  XAI_TRANSCRIPTION_DISCLOSURE_VERSION,
} from "./transcriptionConsent.js";
import { readAgentSessionStore } from "./agentSessionStore.js";
import {
  CLAUDE_CODE_CONVERSATION_DISCLOSURE_VERSION,
  CLIPROXYAPI_CONVERSATION_DISCLOSURE_VERSION,
  CODEX_CONVERSATION_DISCLOSURE_VERSION,
  hasCurrentXaiConversationDisclosure,
  XAI_CONVERSATION_DISCLOSURE_VERSION,
} from "./conversationDataDisclosure.js";
import type { CodexAgentAdapter } from "./codexAgentAdapter.js";
import { ClaudeCodeConversationError, type ClaudeCodeAdapter } from "./claudeCodeAdapter.js";
import {
  AgentUnavailableError,
  type AgentArtifactWorkflowInput,
  type AgentNotionWorkflowInput,
} from "./agentGateway.js";
import type {
  SupportedAgentSummaryAdapter,
  SupportedAgentSummaryReadiness,
  SupportedAgentSummarySnapshot,
} from "./summaryProviderReadiness.js";
import {
  ClaudeCodeSummaryUnknownOutcomeError,
  GatewaySummaryUnknownOutcomeError,
} from "./summaryProviderReadiness.js";
import {
  GatewayRequestUnknownOutcomeError,
  isExactGatewayRuntimeEvidence,
} from "./cliProxyApiAdapter.js";
import type {
  CliProxyApiAdapter,
  GatewaySecretStore,
  GatewayRuntimeEvidence,
} from "./cliProxyApiAdapter.js";

export type AgentConnectionCapability = "transcription" | "summary" | "conversation";

interface CredentialBoundary {
  status(): Promise<XaiCredentialStatus>;
  authorize(): Promise<XaiAuthorizationState>;
  cancelAuthorization(): XaiAuthorizationState;
  logout(): Promise<void>;
  setApiKey(value: string): Promise<XaiCredentialStatus>;
  clearApiKey(): Promise<XaiCredentialStatus>;
  setPreferredSource?(source: XaiCredentialSource | null): void;
}

interface XaiAudioBoundary {
  testXai(): Promise<{ credentialSource?: XaiCredentialSource; provider?: string }>;
}

interface XaiTextBoundary {
  request(input: {
    capability: "summary" | "conversation";
    model: string;
    input: Array<{ role: "system" | "user"; content: string }>;
    maxOutputTokens: number;
    credentialSource?: XaiCredentialSource;
  }): Promise<{ credentialSource: XaiCredentialSource; model: string }>;
}

export interface DiscoveredAgentRuntime {
  adapter: "codex" | "claude-code" | "hermes" | "openclaw";
  label: string;
  path: string;
}

export interface AgentConnectionCenterOptions {
  config: ConfigManager;
  host: HostStore;
  configDir: string;
  credentials: CredentialBoundary;
  audio: XaiAudioBoundary;
  text: XaiTextBoundary;
  readiness?: XaiProviderReadiness;
  discover: () => DiscoveredAgentRuntime[];
  codexAdapter?: (executable: string) => Pick<
    CodexAgentAdapter,
    "status" | "probe" | "probeSummary" | "summarize" | "converse"
  >;
  claudeAdapter?: (executable: string) => Pick<
    ClaudeCodeAdapter,
    "status" | "probe" | "probeSummary" | "summarize" | "converse"
  >;
  gatewaySecretStore?: (credentialIdentity: string) => GatewaySecretStore;
  cliProxyAdapter?: (input: { endpoint: string; httpsApproved: boolean; credentialIdentity: string }) => Pick<
    CliProxyApiAdapter,
    "validateEndpoint" | "keyConfigured" | "probe" | "summarize" | "converse"
  >;
}

const DIRECT_XAI_ID = "direct-xai";
const CODEX_ID = "codex";
const CLAUDE_CODE_ID = "claude-code";
const CLIPROXYAPI_ID = "cliproxyapi";
const MIGRATION_ID = "agent-connections-v1";
const DIRECT_XAI_CREDENTIAL_SOURCE_MIGRATION_ID = "direct-xai-credential-source-v1";
const SUPPORTED_ADAPTERS = new Set(["codex", "claude-code", "hermes", "openclaw"]);
const CODEX_SUMMARY_ISOLATION_FEATURES = [
  "account/read",
  "model/list",
  "thread/start",
  "turn/start",
  "experimentalFeature/list",
  "mcpServerStatus/list",
  "app/list",
  "no-provider-model-fallback",
] as const;
const CLAUDE_CODE_SUMMARY_ISOLATION_FEATURES = [
  "auth/status",
  "safe-mode",
  "print/stream-json",
  "verbose",
  "model",
  "session-id",
  "probe-bounds",
  "tools/none",
  "probe-isolation",
  "fallback-model/opt-in",
  "managed-hooks/none",
] as const;

const LABELS: Record<string, string> = {
  codex: "Codex",
  "claude-code": "Claude Code",
  hermes: "Hermes",
  openclaw: "OpenClaw",
};

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function normalizeAdapter(value: unknown): string | null {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (normalized === "claude") return "claude-code";
  return SUPPORTED_ADAPTERS.has(normalized) ? normalized : null;
}

function adapterFromCommand(command: string[]): string | null {
  if (command.length !== 1) return null;
  const executable = basename(command[0] ?? "").toLowerCase();
  if (executable === "codex") return "codex";
  if (executable === "claude") return "claude-code";
  if (executable === "hermes") return "hermes";
  if (executable === "openclaw") return "openclaw";
  return null;
}

function capabilitiesForAdapter(adapter: string): AgentConnectionCapability[] {
  if (adapter === "hermes" || adapter === "openclaw") return ["conversation"];
  if (adapter === "codex") return ["conversation"];
  if (adapter === "claude-code") return ["conversation"];
  return [];
}

function codexSummaryIsolationDeclared(
  status: Awaited<ReturnType<CodexAgentAdapter["status"]>> | null,
): boolean {
  return Boolean(status?.supported && CODEX_SUMMARY_ISOLATION_FEATURES.every(
    (feature) => status.features.includes(feature),
  ));
}

function claudeSummaryIsolationDeclared(
  status: Awaited<ReturnType<ClaudeCodeAdapter["status"]>> | null,
): boolean {
  return Boolean(status?.supported && CLAUDE_CODE_SUMMARY_ISOLATION_FEATURES.every(
    (feature) => status.features.includes(feature),
  ));
}

function untested(capability: AgentConnectionCapability, model: string): XaiReadinessResult {
  return {
    capability,
    status: "untested",
    model,
    testedAt: null,
    detail: "Not tested in this Host process",
    credentialSource: null,
  };
}

export class AgentConnectionCenter {
  private readonly config: ConfigManager;
  private readonly host: HostStore;
  private readonly credentials: CredentialBoundary;
  private readonly audio: XaiAudioBoundary;
  private readonly text: XaiTextBoundary;
  private readonly readiness: XaiProviderReadiness;
  private readonly configDir: string;
  private readonly codexReadiness = new Map<string, {
    readiness: XaiReadinessResult;
    identity: string;
  }>();
  private readonly claudeReadiness = new Map<string, {
    readiness: XaiReadinessResult;
    identity: string;
  }>();
  private readonly gatewayReadiness = new Map<string, {
    readiness: XaiReadinessResult;
    identity: string;
  }>();

  private codexReadinessKey(connectionId: string, capability: "summary" | "conversation"): string {
    return `${connectionId}:${capability}`;
  }

  private claudeReadinessKey(connectionId: string, capability: "summary" | "conversation"): string {
    return `${connectionId}:${capability}`;
  }

  private gatewayReadinessKey(
    connectionId: string,
    capability: "summary" | "conversation",
    credentialIdentity: string,
    model: string,
  ): string {
    return `${connectionId}:${capability}:${credentialIdentity}:${model}`;
  }

  constructor(private readonly options: AgentConnectionCenterOptions) {
    this.config = options.config;
    this.host = options.host;
    this.credentials = options.credentials;
    this.audio = options.audio;
    this.text = options.text;
    this.readiness = options.readiness ?? new Map();
    this.configDir = options.configDir;
    this.ensureMigrated();
    const direct = this.host.listAgentConnectionRecords().find((record) => record.id === DIRECT_XAI_ID);
    this.credentials.setPreferredSource?.(this.credentialSource(direct?.settings.credentialSource));
  }

  async view() {
    this.ensureMigrated();
    const config = this.config.read();
    let records = this.host.listAgentConnectionRecords();
    let direct = records.find((record) => record.id === DIRECT_XAI_ID);
    let selectedCredentialSource = direct
      ? this.credentialSource(direct.settings.credentialSource) : null;
    this.credentials.setPreferredSource?.(selectedCredentialSource);
    const status = await this.credentials.status();
    selectedCredentialSource = this.migrateDirectXaiCredentialSource(
      config,
      status,
    );
    records = this.host.listAgentConnectionRecords();
    direct = records.find((record) => record.id === DIRECT_XAI_ID);
    if (!direct) selectedCredentialSource = null;
    this.credentials.setPreferredSource?.(selectedCredentialSource);
    const selectedCredentialConnected = selectedCredentialSource === "oauth"
      ? status.oauthConnected
      : selectedCredentialSource === "api-key" ? status.apiKeyConfigured : false;
    const directConnections = direct ? [{
      id: direct.id,
      kind: "direct-provider" as const,
      adapter: "direct-xai" as const,
      label: direct.label,
      lifecycle: selectedCredentialConnected ? "connected" as const : "disconnected" as const,
      authorization: {
        connected: selectedCredentialConnected,
        credentialSource: selectedCredentialSource,
        oauthConnected: status.oauthConnected,
        apiKeyConfigured: status.apiKeyConfigured,
        status: status.authorization.status,
        verificationUrl: status.authorization.verificationUrl,
        userCode: status.authorization.userCode,
        message: status.authorization.message,
      },
      capabilities: (["transcription", "summary", "conversation"] as const).map((capability) => {
        const model = capability === "transcription"
          ? "speech-to-text"
          : config.intelligence[capability].provider === "xai"
            ? config.intelligence[capability].model
            : XAI_TEXT_MODEL_DEFAULT;
        const current = this.readiness.get(capability);
        const currentReadiness = selectedCredentialConnected && current?.model === model &&
          current.credentialSource === selectedCredentialSource
          ? current
          : untested(capability, model);
        const disclosure = capability === "transcription"
          ? {
              required: config.transcription.engine === "xai" &&
                !hasCurrentXaiTranscriptionConsent(this.host),
              disclosureVersion: XAI_TRANSCRIPTION_DISCLOSURE_VERSION,
              data: "recording_audio",
              destination: "xAI",
              decision: this.host.getCloudTranscriptionConsent()?.disclosureVersion ===
                XAI_TRANSCRIPTION_DISCLOSURE_VERSION ? "accepted" as const : null,
              decidedAt: this.host.getCloudTranscriptionConsent()?.acceptedAt ?? null,
            }
          : capability === "summary"
            ? {
                required: config.intelligence.summary.provider === "xai" &&
                  !hasCurrentXaiSummaryDisclosure(this.host),
                disclosureVersion: XAI_SUMMARY_DISCLOSURE_VERSION,
                data: "transcript_text",
                destination: "xAI",
                decision: this.host.getSummaryDataPathDisclosure("xai")?.disclosureVersion ===
                  XAI_SUMMARY_DISCLOSURE_VERSION
                  ? this.host.getSummaryDataPathDisclosure("xai")?.decision ?? null : null,
                decidedAt: this.host.getSummaryDataPathDisclosure("xai")?.decidedAt ?? null,
              }
            : {
                required: config.intelligence.conversation.provider === "xai" &&
                  !hasCurrentXaiConversationDisclosure(this.host),
                disclosureVersion: XAI_CONVERSATION_DISCLOSURE_VERSION,
                data: "meeting_excerpt_text",
                destination: "xAI",
                decision: this.host.getAgentConnectionDisclosure(DIRECT_XAI_ID, "conversation")?.disclosureVersion ===
                  XAI_CONVERSATION_DISCLOSURE_VERSION
                  ? this.host.getAgentConnectionDisclosure(DIRECT_XAI_ID, "conversation")?.decision ?? null : null,
                decidedAt: this.host.getAgentConnectionDisclosure(DIRECT_XAI_ID, "conversation")?.decidedAt ?? null,
              };
        return {
          capability,
          declared: true,
          currentReadiness,
          readinessHistory: this.host.listAgentConnectionReadinessHistory(
            DIRECT_XAI_ID,
            capability,
          ),
          disclosure,
          selected: capability === "transcription"
            ? config.transcription.engine === "xai"
            : config.intelligence[capability].provider === "xai",
          remediation: currentReadiness.status === "failed"
            ? { href: `/agent-connections?connection=${DIRECT_XAI_ID}&capability=${capability}` }
            : null,
        };
      }),
      settings: {
        credentialSource: selectedCredentialSource,
        summaryModel: config.intelligence.summary.provider === "xai"
          ? config.intelligence.summary.model
          : XAI_TEXT_MODEL_DEFAULT,
        conversationModel: config.intelligence.conversation.provider === "xai"
          ? config.intelligence.conversation.model
          : XAI_TEXT_MODEL_DEFAULT,
      },
    }] : [];
    const codexConnections = await Promise.all(records
      .filter((record) => record.kind === "supported-agent" && record.adapter === "codex")
      .map(async (record) => {
        const executable = String(record.settings.executablePath ?? "");
        const summaryModel = String(record.settings.summaryModel ?? record.settings.conversationModel ?? "").trim();
        const conversationModel = String(record.settings.conversationModel ?? record.settings.summaryModel ?? "").trim();
        let status: Awaited<ReturnType<CodexAgentAdapter["status"]>> | null = null;
        let statusError: string | null = null;
        try {
          status = await this.requireCodexAdapter(executable).status();
        } catch {
          statusError = "Codex runtime status is unavailable";
        }
        const capabilities = (["summary", "conversation"] as const).map((capability) => {
          const model = capability === "summary" ? summaryModel : conversationModel;
          const readinessKey = this.codexReadinessKey(record.id, capability);
          const proof = status ? this.codexReadiness.get(readinessKey) : undefined;
          const identity = status ? this.codexIdentity(executable, model, status) : null;
          const currentReadiness = proof && proof.identity === identity
            ? proof.readiness
            : untested(capability, model);
          if (proof && proof.identity !== identity) this.codexReadiness.delete(readinessKey);
          const disclosure = this.host.getAgentConnectionDisclosure(record.id, capability);
          const disclosureVersion = capability === "summary"
            ? CODEX_SUMMARY_DISCLOSURE_VERSION
            : CODEX_CONVERSATION_DISCLOSURE_VERSION;
          const selection = asRecord(config.intelligence[capability]);
          return {
            capability,
            declared: capability === "summary"
              ? codexSummaryIsolationDeclared(status) && currentReadiness.status === "ready"
              : true,
            currentReadiness,
            readinessHistory: this.host.listAgentConnectionReadinessHistory(record.id, capability),
            disclosure: {
              required: disclosure?.disclosureVersion !== disclosureVersion || disclosure.decision !== "accepted",
              disclosureVersion,
              data: capability === "summary"
                ? "transcript_text" as const
                : "conversation_text_and_agent_tool_context" as const,
              destination: capability === "summary"
                ? "Codex runtime and its configured model provider"
                : "Codex runtime and its configured providers/connectors",
              decision: disclosure?.disclosureVersion === disclosureVersion ? disclosure.decision : null,
              decidedAt: disclosure?.disclosureVersion === disclosureVersion ? disclosure.decidedAt : null,
            },
            selected: selection.provider === "agent" && selection.connectionId === record.id,
            remediation: currentReadiness.status === "failed" || !status?.authorized || !status?.supported
              ? { href: `/agent-connections?connection=${record.id}&capability=${capability}` }
              : null,
          };
        });
        return {
          id: record.id,
          kind: "supported-agent" as const,
          adapter: "codex" as const,
          label: record.label,
          lifecycle: status?.authorized ? "connected" as const : "disconnected" as const,
          authorization: {
            connected: Boolean(status?.authorized && status.supported),
            credentialSource: "runtime-oauth" as const,
            runtimeVersion: status?.runtimeVersion ?? null,
            minimumVersion: status?.minimumVersion ?? null,
            supported: status?.supported ?? false,
            availableModels: status?.availableModels ?? [],
            features: status?.features ?? [],
            loginCommand: status?.login.command ?? `${executable} login`,
            statusCommand: status?.login.statusCommand ?? `${executable} login status`,
            remediation: status?.remediation ?? statusError,
          },
          capabilities,
          settings: {
            summaryModel,
            conversationModel,
            executablePath: executable,
          },
        };
      }));
    const claudeConnections = await Promise.all(records
      .filter((record) => record.kind === "supported-agent" && record.adapter === "claude-code")
      .map(async (record) => {
        const executable = String(record.settings.executablePath ?? "");
        const summaryModel = String(record.settings.summaryModel ?? record.settings.conversationModel ?? "").trim();
        const conversationModel = String(record.settings.conversationModel ?? record.settings.summaryModel ?? "").trim();
        let status: Awaited<ReturnType<ClaudeCodeAdapter["status"]>> | null = null;
        let summaryStatus: Awaited<ReturnType<ClaudeCodeAdapter["status"]>> | null = null;
        let statusError: string | null = null;
        let summaryStatusError: string | null = null;
        try {
          const adapter = this.requireClaudeAdapter(executable);
          const [conversationResult, summaryResult] = await Promise.allSettled([
            adapter.status(),
            adapter.status({ toolFree: true }),
          ]);
          if (conversationResult.status === "fulfilled") status = conversationResult.value;
          else statusError = "Claude Code runtime status is unavailable";
          if (summaryResult.status === "fulfilled") summaryStatus = summaryResult.value;
          else summaryStatusError = "Claude Code Summary isolation status is unavailable";
        } catch {
          statusError = "Claude Code runtime status is unavailable";
          summaryStatusError = "Claude Code Summary isolation status is unavailable";
        }
        const capabilities = (["summary", "conversation"] as const).map((capability) => {
          const model = capability === "summary" ? summaryModel : conversationModel;
          const capabilityStatus = capability === "summary" ? summaryStatus : status;
          const readinessKey = this.claudeReadinessKey(record.id, capability);
          const proof = capabilityStatus ? this.claudeReadiness.get(readinessKey) : undefined;
          const identity = capabilityStatus ? this.claudeIdentity(executable, model, capabilityStatus) : null;
          let currentReadiness = proof && proof.identity === identity
            ? proof.readiness
            : untested(capability, model);
          if (capability === "summary" && (!summaryStatus || !summaryStatus.supported)) {
            currentReadiness = {
              ...currentReadiness,
              status: "failed",
              detail: summaryStatus?.remediation ?? summaryStatusError ??
                "Claude Code Summary isolation proof is unavailable",
              reason: "readiness_failed",
            };
          }
          if (proof && proof.identity !== identity) this.claudeReadiness.delete(readinessKey);
          const disclosure = this.host.getAgentConnectionDisclosure(record.id, capability);
          const disclosureVersion = capability === "summary"
            ? CLAUDE_CODE_SUMMARY_DISCLOSURE_VERSION
            : CLAUDE_CODE_CONVERSATION_DISCLOSURE_VERSION;
          const selection = asRecord(config.intelligence[capability]);
          return {
            capability,
            declared: capability === "summary"
              ? claudeSummaryIsolationDeclared(summaryStatus) && currentReadiness.status === "ready"
              : true,
            currentReadiness,
            readinessHistory: this.host.listAgentConnectionReadinessHistory(record.id, capability),
            disclosure: {
              required: disclosure?.disclosureVersion !== disclosureVersion || disclosure.decision !== "accepted",
              disclosureVersion,
              data: capability === "summary"
                ? "transcript_text" as const
                : "conversation_text_and_agent_tool_context" as const,
              destination: capability === "summary"
                ? "Claude Code runtime and its configured model provider"
                : "Claude Code runtime and its configured model/tools",
              decision: disclosure?.disclosureVersion === disclosureVersion ? disclosure.decision : null,
              decidedAt: disclosure?.disclosureVersion === disclosureVersion ? disclosure.decidedAt : null,
            },
            selected: selection.provider === "agent" && selection.connectionId === record.id,
            remediation: currentReadiness.status === "failed" || !capabilityStatus?.authorized || !capabilityStatus?.supported
              ? { href: `/agent-connections?connection=${record.id}&capability=${capability}` }
              : null,
          };
        });
        return {
          id: record.id,
          kind: "supported-agent" as const,
          adapter: "claude-code" as const,
          label: record.label,
          lifecycle: status?.authorized ? "connected" as const : "disconnected" as const,
          authorization: {
            connected: Boolean(status?.authorized && status.supported),
            credentialSource: "runtime-oauth" as const,
            runtimeVersion: status?.runtimeVersion ?? null,
            minimumVersion: status?.minimumVersion ?? null,
            supported: status?.supported ?? false,
            authorizationMethod: status?.authorizationMethod ?? null,
            apiProvider: status?.apiProvider ?? null,
            availableModels: status?.availableModels ?? [],
            features: status?.features ?? [],
            loginCommand: status?.login.command ?? `${executable} auth login`,
            statusCommand: status?.login.statusCommand ?? `${executable} auth status`,
            remediation: status?.remediation ?? statusError,
          },
          capabilities,
          settings: {
            summaryModel,
            conversationModel,
            executablePath: executable,
          },
        };
      }));
    const gatewayConnections = await Promise.all(records
      .filter((record) => record.kind === "gateway" && record.adapter === "cliproxyapi")
      .map(async (record) => {
        const endpoint = String(record.settings.endpoint ?? "").trim();
        const httpsApproved = record.settings.httpsApproved === true;
        const summaryModel = String(record.settings.summaryModel ?? "").trim();
        const conversationModel = String(record.settings.conversationModel ?? "").trim();
        const credentialIdentity = this.currentGatewayCredentialIdentity(record);
        const adapter = this.requireGatewayAdapter(endpoint, httpsApproved, credentialIdentity);
        const keyConfigured = await adapter.keyConfigured();
        const capabilities = (["summary", "conversation"] as const).map((capability) => {
          const model = capability === "summary" ? summaryModel : conversationModel;
          const readinessKey = this.gatewayReadinessKey(record.id, capability, credentialIdentity, model);
          const identity = this.gatewayIdentity(endpoint, httpsApproved, model, keyConfigured, credentialIdentity);
          const proof = this.gatewayReadiness.get(readinessKey);
          const currentReadiness = proof && proof.identity === identity
            ? proof.readiness
            : untested(capability, model);
          if (proof && proof.identity !== identity) this.gatewayReadiness.delete(readinessKey);
          const disclosure = this.host.getAgentConnectionDisclosure(record.id, capability);
          const disclosureVersion = capability === "summary"
            ? CLIPROXYAPI_SUMMARY_DISCLOSURE_VERSION
            : CLIPROXYAPI_CONVERSATION_DISCLOSURE_VERSION;
          const disclosureAccepted = this.hasGatewayDisclosure(
            record,
            capability,
            disclosureVersion,
            endpoint,
          );
          const selection = asRecord(config.intelligence[capability]);
          return {
            capability,
            declared: true,
            currentReadiness,
            readinessHistory: this.host.listAgentConnectionReadinessHistory(record.id, capability),
            disclosure: {
              required: !disclosureAccepted,
              disclosureVersion,
              data: capability === "summary"
                ? "transcript_text" as const
                : "conversation_text" as const,
              destination: endpoint,
              decision: disclosureAccepted ? disclosure?.decision ?? null : null,
              decidedAt: disclosureAccepted ? disclosure?.decidedAt ?? null : null,
            },
            selected: selection.provider === "agent" && selection.connectionId === record.id,
            remediation: currentReadiness.status === "failed" || !keyConfigured
              ? { href: `/agent-connections?connection=${record.id}&capability=${capability}` }
              : null,
          };
        });
        return {
          id: record.id,
          kind: "gateway" as const,
          adapter: "cliproxyapi" as const,
          label: record.label,
          lifecycle: keyConfigured ? "connected" as const : "disconnected" as const,
          authorization: {
            connected: keyConfigured,
            credentialSource: "api-key" as const,
            keyConfigured,
            compatibilityTarget: "v0.23.0-rc.1" as const,
          },
          capabilities,
          settings: {
            endpoint,
            transport: String(record.settings.transport ?? ""),
            summaryModel,
            conversationModel,
            credentialClass: "api-key" as const,
            httpsApproved,
          },
        };
      }));
    const connections = [...directConnections, ...codexConnections, ...claudeConnections, ...gatewayConnections];
    const connectedAdapters = new Set(records
      .filter((record) => record.kind === "supported-agent")
      .map((record) => record.adapter));
    const candidates = this.host.listAgentConnectionCandidates()
      .filter((candidate) => !connectedAdapters.has(candidate.adapter))
      .map((candidate) => ({
      id: candidate.id,
      kind: "supported-agent" as const,
      adapter: candidate.adapter,
      label: candidate.label,
      lifecycle: "candidate" as const,
      source: candidate.source,
      detectedPath: candidate.detectedPath,
      capabilities: capabilitiesForAdapter(candidate.adapter),
      selected: false,
      readiness: "untested" as const,
      remediation: { href: `/agent-connections?candidate=${encodeURIComponent(candidate.id)}` },
      }));
    const legacyConnections = records
      .filter((record) => record.kind === "legacy-custom")
      .map((record) => ({
        id: record.id,
        kind: record.kind,
        adapter: record.adapter,
        label: record.label,
        lifecycle: "legacy" as const,
        selected: false,
        capabilities: [],
        readiness: "unsupported" as const,
        settings: record.settings,
        remediation: { href: `/agent-connections?legacy=${encodeURIComponent(record.id)}` },
      }));
    return {
      connections,
      candidates,
      legacyConnections,
      selections: {
        transcription: direct && config.transcription.engine === "xai"
          ? { connectionId: DIRECT_XAI_ID, model: "speech-to-text" }
          : { connectionId: null, model: "local" },
        summary: direct && config.intelligence.summary.provider === "xai"
          ? { connectionId: DIRECT_XAI_ID, model: config.intelligence.summary.model }
          : config.intelligence.summary.provider === "agent" &&
              "connectionId" in config.intelligence.summary && config.intelligence.summary.connectionId
            ? {
                connectionId: config.intelligence.summary.connectionId,
                model: config.intelligence.summary.model,
              }
            : { connectionId: null, model: config.intelligence.summary.model },
        conversation: config.intelligence.conversation.provider === "xai" && direct
          ? { connectionId: DIRECT_XAI_ID, model: config.intelligence.conversation.model }
          : config.intelligence.conversation.provider === "agent" &&
              "connectionId" in config.intelligence.conversation && config.intelligence.conversation.connectionId
            ? {
                connectionId: config.intelligence.conversation.connectionId,
                model: config.intelligence.conversation.model,
              }
            : { connectionId: null, model: config.intelligence.conversation.model },
      },
    };
  }

  async xaiProjection() {
    const view = await this.view();
    const direct = view.connections.find((connection): connection is Extract<
      (typeof view.connections)[number],
      { adapter: "direct-xai" }
    > => connection.adapter === "direct-xai");
    if (!direct) {
      const config = this.config.read();
      return {
        connection: {
          connected: false,
          source: null,
          oauthConnected: false,
          apiKeyConfigured: false,
          detail: "Add direct xAI in Agent Connection Center",
          authorization: {
            status: "idle" as const,
            verificationUrl: "",
            userCode: "",
            message: "",
          },
        },
        readiness: {
          transcription: untested("transcription", "speech-to-text"),
          summary: untested("summary", config.intelligence.summary.model),
          conversation: untested("conversation", config.intelligence.conversation.model),
        },
        disclosures: {},
      };
    }
    return {
      connection: {
        connected: direct.authorization.connected,
        source: direct.authorization.credentialSource,
        oauthConnected: direct.authorization.oauthConnected,
        apiKeyConfigured: direct.authorization.apiKeyConfigured,
        detail: direct.authorization.connected ? "xAI connection is available" : "Connect xAI in Agent Connection Center",
        authorization: {
          status: direct.authorization.status,
          verificationUrl: direct.authorization.verificationUrl,
          userCode: direct.authorization.userCode,
          message: direct.authorization.message,
        },
      },
      readiness: Object.fromEntries(direct.capabilities.map((item) => [
        item.capability,
        item.currentReadiness,
      ])),
      disclosures: Object.fromEntries(direct.capabilities
        .filter((item) => item.capability !== "conversation")
        .map((item) => [item.capability, item.disclosure])),
    };
  }

  async saveGateway(input: {
    endpoint: string;
    summaryModel: string;
    conversationModel: string;
    inferenceKey: string;
    httpsApproved: boolean;
    confirmed: true;
  }) {
    this.ensureMigrated();
    const summaryModel = input.summaryModel.trim();
    const conversationModel = input.conversationModel.trim();
    const inferenceKey = input.inferenceKey.trim();
    if (!summaryModel || summaryModel.length > 128 || !conversationModel || conversationModel.length > 128) {
      throw new Error("CLIProxyAPI exact Summary and Conversation models are required");
    }
    if (!inferenceKey || inferenceKey.length > 4_096) {
      throw new Error("CLIProxyAPI least-privilege inference key is required");
    }
    const credentialIdentity = `gateway.cliproxyapi.${randomUUID()}`;
    const secretStore = this.requireGatewaySecretStore(credentialIdentity);
    const identity = await this.requireGatewayAdapter(
      input.endpoint,
      input.httpsApproved,
      credentialIdentity,
    ).validateEndpoint();
    const httpsApproved = identity.transport === "approved-https";
    await secretStore.write(inferenceKey);
    // Re-read immediately before the synchronous Host upsert so concurrent
    // authenticated saves merge every immutable revision instead of orphaning one.
    const existing = this.gatewayRecord(CLIPROXYAPI_ID);
    const connectionIdentityChanged = Boolean(existing);
    try {
      this.host.upsertAgentConnectionRecord({
        id: CLIPROXYAPI_ID,
        kind: "gateway",
        adapter: "cliproxyapi",
        label: "CLIProxyAPI",
        lifecycle: "available",
        settings: {
          endpoint: identity.endpoint,
          transport: identity.transport,
          httpsApproved,
          summaryModel,
          conversationModel,
          credentialClass: "api-key",
          credentialIdentity,
          credentialIdentities: [
            ...this.gatewayCredentialIdentities(existing),
            credentialIdentity,
          ],
          credentialRevisions: [
            ...this.gatewayCredentialRevisions(existing),
            {
              credentialIdentity,
              endpoint: identity.endpoint,
              httpsApproved,
            },
          ],
          compatibilityTarget: "v0.23.0-rc.1",
        },
      });
    } catch (error) {
      await secretStore.clear().catch(() => {});
      throw error;
    }
    if (connectionIdentityChanged) {
      this.host.clearAgentConnectionDisclosures(CLIPROXYAPI_ID);
      this.clearGatewaySelections(CLIPROXYAPI_ID);
    }
    return await this.view();
  }

  async probe(input: {
    connectionId: string;
    capability: AgentConnectionCapability;
    model?: string;
  }): Promise<XaiReadinessResult> {
    this.ensureMigrated();
    const gatewayRecord = this.gatewayRecord(input.connectionId);
    if (gatewayRecord) {
      if (input.capability !== "summary" && input.capability !== "conversation") {
        throw new Error("This CLIProxyAPI Gateway supports Summary and Conversation only");
      }
      const setting = input.capability === "summary" ? "summaryModel" : "conversationModel";
      const label = input.capability === "summary" ? "Summary" : "Conversation";
      const model = input.model?.trim() || String(gatewayRecord.settings[setting] ?? "").trim();
      if (!model || model.length > 128) throw new Error(`CLIProxyAPI ${label} model is invalid`);
      const endpoint = String(gatewayRecord.settings.endpoint ?? "").trim();
      const httpsApproved = gatewayRecord.settings.httpsApproved === true;
      const credentialIdentity = this.currentGatewayCredentialIdentity(gatewayRecord);
      const readinessKey = this.gatewayReadinessKey(gatewayRecord.id, input.capability, credentialIdentity, model);
      if (model !== gatewayRecord.settings[setting]) {
        this.gatewayReadiness.delete(readinessKey);
        this.host.upsertAgentConnectionRecord({
          ...gatewayRecord,
          settings: { ...gatewayRecord.settings, [setting]: model },
        });
      }
      const adapter = this.requireGatewayAdapter(endpoint, httpsApproved, credentialIdentity);
      const testedAt = new Date().toISOString();
      const result = await adapter.probe({ capability: input.capability, model });
      const keyConfigured = await adapter.keyConfigured();
      const evidence = result.evidence as GatewayRuntimeEvidence | undefined;
      const exactIdentity = Boolean(keyConfigured && evidence && isExactGatewayRuntimeEvidence(evidence, {
        endpoint,
        model,
        terminalStatus: "ready",
      }));
      const exactUnknown = Boolean(evidence && result.reason === "unknown_outcome" &&
        isExactGatewayRuntimeEvidence(evidence, { endpoint, model, terminalStatus: "unknown" }));
      const effectiveStatus = result.status === "ready" && exactIdentity ? "ready" : "failed";
      const readiness: XaiReadinessResult = {
        capability: input.capability,
        status: effectiveStatus,
        model,
        credentialSource: "api-key",
        testedAt,
        detail: effectiveStatus === "ready"
          ? `${input.capability} · ${model} passed the CLIProxyAPI production adapter probe`
          : result.remediation ?? `${input.capability} · ${model} failed`,
        ...(effectiveStatus === "failed" ? {
          reason: result.reason === "invalid_model"
            ? "invalid_model" as const
            : result.reason === "unknown_outcome" ? "unknown_outcome" as const : "readiness_failed" as const,
        } : {}),
      };
      this.gatewayReadiness.set(readinessKey, {
        readiness,
        identity: this.gatewayIdentity(endpoint, httpsApproved, model, keyConfigured, credentialIdentity),
      });
      if (exactIdentity || exactUnknown) {
        this.host.recordAgentConnectionReadiness({
          connectionId: gatewayRecord.id,
          capability: input.capability,
          status: effectiveStatus,
          model,
          credentialSource: "api-key",
          detail: readiness.detail,
          reason: readiness.reason ?? null,
          runtimeEvidence: evidence!,
          testedAt,
        });
      }
      return readiness;
    }
    const codexRecord = this.codexRecord(input.connectionId);
    if (codexRecord) {
      if (input.capability !== "summary" && input.capability !== "conversation") {
        throw new Error("This Codex connection supports Summary and Conversation only");
      }
      const setting = input.capability === "summary" ? "summaryModel" : "conversationModel";
      const label = input.capability === "summary" ? "Summary" : "Conversation";
      const model = input.model?.trim() || String(codexRecord.settings[setting] ?? "").trim();
      if (!model || model.length > 128) throw new Error(`Codex ${label} model is invalid`);
      const readinessKey = this.codexReadinessKey(codexRecord.id, input.capability);
      if (model !== codexRecord.settings[setting]) {
        this.codexReadiness.delete(readinessKey);
        this.host.upsertAgentConnectionRecord({
          ...codexRecord,
          settings: { ...codexRecord.settings, [setting]: model },
        });
      }
      const testedAt = new Date().toISOString();
      const executable = String(codexRecord.settings.executablePath ?? "");
      const adapter = this.requireCodexAdapter(executable);
      const result = input.capability === "summary"
        ? await adapter.probeSummary({ model })
        : await adapter.probe({ model });
      const status = await adapter.status(input.capability === "summary" ? { toolFree: true } : {});
      const exactIdentity = Boolean(
        status.supported &&
        (input.capability !== "summary" || codexSummaryIsolationDeclared(status)) &&
        status.authorized &&
        status.availableModels.includes(model) &&
        result.evidence?.runtimeVersion === status.runtimeVersion &&
        result.evidence.requestedModel === model &&
        result.evidence.actualModel === model &&
        result.evidence.actualProvider === "openai" &&
        result.evidence.fallbackOccurred === false,
      );
      const effectiveStatus = result.status === "ready" && !exactIdentity ? "failed" : result.status;
      const readiness: XaiReadinessResult = {
        capability: input.capability,
        status: effectiveStatus,
        model,
        credentialSource: null,
        testedAt,
        detail: effectiveStatus === "ready"
          ? `${input.capability} · ${model} passed the Codex production adapter probe`
          : result.status === "failed"
            ? result.remediation ?? `${input.capability} · ${model} failed`
            : `${input.capability} · ${model} failed; the exact Codex executable, authorization, version, features, or model changed during the probe`,
        reason: result.reason === "invalid_model" ? "invalid_model" : "readiness_failed",
      };
      this.codexReadiness.set(readinessKey, {
        readiness,
        identity: this.codexIdentity(executable, model, status),
      });
      if (result.evidence) {
        this.host.recordAgentConnectionReadiness({
          connectionId: codexRecord.id,
          capability: input.capability,
          status: effectiveStatus,
          model,
          credentialSource: null,
          detail: readiness.detail,
          reason: readiness.reason ?? null,
          runtimeEvidence: result.evidence,
          testedAt,
        });
      }
      return readiness;
    }
    const claudeRecord = this.claudeRecord(input.connectionId);
    if (claudeRecord) {
      if (input.capability !== "summary" && input.capability !== "conversation") {
        throw new Error("This Claude Code connection supports Summary and Conversation only");
      }
      const setting = input.capability === "summary" ? "summaryModel" : "conversationModel";
      const fallbackSetting = input.capability === "summary" ? "conversationModel" : "summaryModel";
      const label = input.capability === "summary" ? "Summary" : "Conversation";
      const model = input.model?.trim() ||
        String(claudeRecord.settings[setting] ?? claudeRecord.settings[fallbackSetting] ?? "").trim();
      if (!model || model.length > 128) throw new Error(`Claude Code ${label} model is invalid`);
      const readinessKey = this.claudeReadinessKey(claudeRecord.id, input.capability);
      if (model !== claudeRecord.settings[setting]) {
        this.claudeReadiness.delete(readinessKey);
        this.host.upsertAgentConnectionRecord({
          ...claudeRecord,
          settings: { ...claudeRecord.settings, [setting]: model },
        });
      }
      const testedAt = new Date().toISOString();
      const executable = String(claudeRecord.settings.executablePath ?? "");
      const adapter = this.requireClaudeAdapter(executable);
      const result = input.capability === "summary"
        ? await adapter.probeSummary({ model })
        : await adapter.probe({ model });
      const status = await adapter.status(input.capability === "summary" ? { toolFree: true } : {});
      const exactIdentity = Boolean(
        status.supported &&
        (input.capability !== "summary" || claudeSummaryIsolationDeclared(status)) &&
        status.authorized &&
        result.evidence?.runtimeVersion === status.runtimeVersion &&
        result.evidence.requestedProvider === null &&
        result.evidence.requestedModel === model &&
        result.evidence.actualProvider === null &&
        result.evidence.actualModel === model &&
        result.evidence.sessionId &&
        result.evidence.fallbackOccurred === false,
      );
      const effectiveStatus = result.status === "ready" && !exactIdentity ? "failed" : result.status;
      const readiness: XaiReadinessResult = {
        capability: input.capability,
        status: effectiveStatus,
        model,
        credentialSource: null,
        testedAt,
        detail: effectiveStatus === "ready"
          ? `${input.capability} · ${model} passed the Claude Code production adapter probe`
          : result.status === "failed"
            ? result.remediation ?? `${input.capability} · ${model} failed`
            : `${input.capability} · ${model} failed; the exact Claude executable, authorization, version, features, model, or session changed during the probe`,
        reason: result.reason === "unknown_outcome" ? "unknown_outcome" : "readiness_failed",
      };
      this.claudeReadiness.set(readinessKey, {
        readiness,
        identity: this.claudeIdentity(executable, model, status),
      });
      if (result.evidence) {
        this.host.recordAgentConnectionReadiness({
          connectionId: claudeRecord.id,
          capability: input.capability,
          status: effectiveStatus,
          model,
          credentialSource: null,
          detail: readiness.detail,
          reason: readiness.reason ?? null,
          runtimeEvidence: result.evidence,
          testedAt,
        });
      }
      return readiness;
    }
    if (input.connectionId !== DIRECT_XAI_ID || !this.hasDirectConnection()) {
      throw new Error("Only explicit Agent Connections can run a Capability Probe");
    }
    const capability = input.capability;
    const config = this.config.read();
    const model = capability === "transcription"
      ? "speech-to-text"
      : config.intelligence[capability].provider === "xai"
        ? config.intelligence[capability].model
        : XAI_TEXT_MODEL_DEFAULT;
    const direct = this.host.listAgentConnectionRecords().find((record) => record.id === DIRECT_XAI_ID);
    const selectedCredentialSource = this.credentialSource(direct?.settings.credentialSource);
    this.credentials.setPreferredSource?.(selectedCredentialSource);
    const connection = await this.credentials.status();
    const selectedConnected = selectedCredentialSource === "oauth"
      ? connection.oauthConnected
      : selectedCredentialSource === "api-key" ? connection.apiKeyConfigured : false;
    if (!selectedConnected || !selectedCredentialSource) {
      return this.finishProbe({
        capability,
        status: "failed",
        model,
        credentialSource: null,
        testedAt: new Date().toISOString(),
        detail: `${capability} · ${model} failed; select and connect one xAI credential source, then test again`,
        reason: "readiness_failed",
      }, null);
    }
    try {
      let credentialSource: XaiCredentialSource;
      let actualProvider: string | null = null;
      let actualModel: string | null = null;
      if (capability === "transcription") {
        const result = await this.audio.testXai();
        credentialSource = result.credentialSource ?? selectedCredentialSource;
        actualProvider = result.provider ?? null;
      } else {
        const result = await this.text.request({
          capability,
          model,
          input: capability === "summary"
            ? [
                { role: "system", content: "Return one short acknowledgement." },
                { role: "user", content: "Yulu xAI summary capability probe." },
              ]
            : [
                { role: "system", content: "Return one short acknowledgement." },
                { role: "user", content: "Yulu xAI conversation capability probe." },
              ],
          maxOutputTokens: 32,
          credentialSource: selectedCredentialSource,
        });
        if (result.model !== model) throw new Error("provider returned a different model");
        credentialSource = result.credentialSource;
        actualProvider = "xai";
        actualModel = result.model;
      }
      return this.finishProbe({
        capability,
        status: "ready",
        model,
        credentialSource,
        testedAt: new Date().toISOString(),
        detail: `${capability} · ${model} passed a production-path probe`,
      }, {
        actualProvider,
        actualModel,
      });
    } catch (error) {
      const reason = /HTTP 404/i.test(error instanceof Error ? error.message : "")
        ? "invalid_model" as const
        : "readiness_failed" as const;
      return this.finishProbe({
        capability,
        status: "failed",
        model,
        credentialSource: selectedCredentialSource,
        testedAt: new Date().toISOString(),
        detail: `${capability} · ${model} failed; check account access and the exact model, then test again`,
        reason,
      }, null);
    }
  }

  async refreshCandidates() {
    this.ensureMigrated();
    for (const runtime of this.options.discover()) {
      this.host.upsertAgentConnectionCandidate({
        id: `candidate:${runtime.adapter}`,
        adapter: runtime.adapter,
        label: runtime.label,
        source: "discovered",
        detectedPath: runtime.path,
        settings: {},
      });
    }
    return await this.view();
  }

  async confirmCandidate(input: { candidateId: string; model: string }) {
    this.ensureMigrated();
    const candidate = this.host.listAgentConnectionCandidates()
      .find((item) => item.id === input.candidateId);
    if (!candidate || !candidate.detectedPath) {
      throw new Error("Supported Agent Connection Candidate with a detected runtime is required");
    }
    const model = input.model.trim();
    if (!model || model.length > 128) throw new Error("Agent Connection model is invalid");
    if (candidate.adapter === "claude-code") {
      const status = await this.requireClaudeAdapter(candidate.detectedPath).status();
      if (!status.supported) throw new Error(status.remediation ?? "Claude Code runtime is unsupported");
      this.claudeReadiness.delete(this.claudeReadinessKey(CLAUDE_CODE_ID, "summary"));
      this.claudeReadiness.delete(this.claudeReadinessKey(CLAUDE_CODE_ID, "conversation"));
      this.host.upsertAgentConnectionRecord({
        id: CLAUDE_CODE_ID,
        kind: "supported-agent",
        adapter: "claude-code",
        label: candidate.label,
        lifecycle: "available",
        settings: {
          executablePath: candidate.detectedPath,
          summaryModel: model,
          conversationModel: model,
          credentialSource: "runtime-oauth",
        },
      });
      return await this.view();
    }
    if (candidate.adapter !== "codex") {
      throw new Error("This Connection Candidate does not yet have a supported production adapter");
    }
    const status = await this.requireCodexAdapter(candidate.detectedPath).status();
    if (!status.supported) throw new Error(status.remediation ?? "Codex runtime is unsupported");
    if (status.authorized && !status.availableModels.includes(model)) {
      throw new Error(`Codex model ${model} is not available from model/list`);
    }
    this.codexReadiness.delete(this.codexReadinessKey(CODEX_ID, "summary"));
    this.codexReadiness.delete(this.codexReadinessKey(CODEX_ID, "conversation"));
    this.host.upsertAgentConnectionRecord({
      id: CODEX_ID,
      kind: "supported-agent",
      adapter: "codex",
      label: candidate.label,
      lifecycle: "available",
      settings: {
        executablePath: candidate.detectedPath,
        summaryModel: model,
        conversationModel: model,
        credentialSource: "runtime-oauth",
      },
    });
    return await this.view();
  }

  async select(input: {
    connectionId: string;
    capability: AgentConnectionCapability;
    model?: string;
  }) {
    this.ensureMigrated();
    const gatewayRecord = this.gatewayRecord(input.connectionId);
    if (gatewayRecord) {
      if (input.capability !== "summary" && input.capability !== "conversation") {
        throw new Error("This CLIProxyAPI Gateway supports Summary and Conversation only");
      }
      const setting = input.capability === "summary" ? "summaryModel" : "conversationModel";
      const model = input.model?.trim() || String(gatewayRecord.settings[setting] ?? "").trim();
      if (!model || model.length > 128) throw new Error(`CLIProxyAPI ${input.capability} model is invalid`);
      await this.requireCurrentGatewayReadiness(gatewayRecord.id, input.capability, model);
      const disclosureVersion = input.capability === "summary"
        ? CLIPROXYAPI_SUMMARY_DISCLOSURE_VERSION
        : CLIPROXYAPI_CONVERSATION_DISCLOSURE_VERSION;
      const endpoint = String(gatewayRecord.settings.endpoint ?? "").trim();
      if (!this.hasGatewayDisclosure(gatewayRecord, input.capability, disclosureVersion, endpoint)) {
        throw new Error(
          `Accept the current CLIProxyAPI ${input.capability} endpoint data path disclosure before selection`,
        );
      }
      this.host.upsertAgentConnectionRecord({
        ...gatewayRecord,
        settings: { ...gatewayRecord.settings, [setting]: model },
      });
      this.config.update(`intelligence.${input.capability}`, {
        provider: "agent",
        connectionId: gatewayRecord.id,
        model,
      });
      return await this.view();
    }
    const codexRecord = this.codexRecord(input.connectionId);
    if (codexRecord) {
      if (input.capability !== "summary" && input.capability !== "conversation") {
        throw new Error("This Codex connection supports Summary and Conversation only");
      }
      const setting = input.capability === "summary" ? "summaryModel" : "conversationModel";
      const model = input.model?.trim() || String(codexRecord.settings[setting] ?? "").trim();
      if (!model || model.length > 128) throw new Error(`Codex ${input.capability} model is invalid`);
      await this.requireCurrentCodexReadiness(codexRecord.id, input.capability, model);
      this.host.upsertAgentConnectionRecord({
        ...codexRecord,
        settings: { ...codexRecord.settings, [setting]: model },
      });
      this.config.update(`intelligence.${input.capability}`, {
        provider: "agent",
        connectionId: codexRecord.id,
        model,
      });
      return await this.view();
    }
    const claudeRecord = this.claudeRecord(input.connectionId);
    if (claudeRecord) {
      if (input.capability !== "summary" && input.capability !== "conversation") {
        throw new Error("This Claude Code connection supports Summary and Conversation only");
      }
      const setting = input.capability === "summary" ? "summaryModel" : "conversationModel";
      const fallbackSetting = input.capability === "summary" ? "conversationModel" : "summaryModel";
      const model = input.model?.trim() ||
        String(claudeRecord.settings[setting] ?? claudeRecord.settings[fallbackSetting] ?? "").trim();
      if (!model || model.length > 128) throw new Error(`Claude Code ${input.capability} model is invalid`);
      await this.requireCurrentClaudeReadiness(claudeRecord.id, input.capability, model);
      this.host.upsertAgentConnectionRecord({
        ...claudeRecord,
        settings: { ...claudeRecord.settings, [setting]: model },
      });
      this.config.update(`intelligence.${input.capability}`, {
        provider: "agent",
        connectionId: claudeRecord.id,
        model,
      });
      return await this.view();
    }
    if (input.connectionId !== DIRECT_XAI_ID) {
      const candidate = this.host.listAgentConnectionCandidates()
        .find((item) => item.id === input.connectionId);
      if (candidate) {
        throw new Error("Connection Candidate must be confirmed by a supported adapter before selection");
      }
      throw new Error("Agent Connection not found");
    }
    if (!this.hasDirectConnection()) throw new Error("Agent Connection not found");
    if (input.capability === "transcription") {
      this.config.update("transcription.engine", "xai");
    } else {
      const model = input.model?.trim() || XAI_TEXT_MODEL_DEFAULT;
      if (!model || model.length > 128) throw new Error("Agent Connection model is invalid");
      this.config.update(`intelligence.${input.capability}`, { provider: "xai", model });
    }
    return await this.view();
  }

  async selectCredentialSource(input: {
    connectionId: string;
    credentialSource: XaiCredentialSource;
  }) {
    this.ensureMigrated();
    if (input.connectionId !== DIRECT_XAI_ID || !this.hasDirectConnection()) {
      throw new Error("Agent Connection not found");
    }
    this.persistCredentialSource(input.credentialSource);
    return await this.view();
  }

  acceptDisclosure(input: { connectionId: string; capability: AgentConnectionCapability }) {
    this.ensureMigrated();
    if (this.gatewayRecord(input.connectionId)) {
      if (input.capability !== "summary" && input.capability !== "conversation") {
        throw new Error("This CLIProxyAPI Gateway supports Summary and Conversation only");
      }
      const gatewayRecord = this.gatewayRecord(input.connectionId)!;
      const receipt = this.host.recordAgentConnectionDisclosure({
        connectionId: input.connectionId,
        capability: input.capability,
        disclosureVersion: input.capability === "summary"
          ? CLIPROXYAPI_SUMMARY_DISCLOSURE_VERSION
          : CLIPROXYAPI_CONVERSATION_DISCLOSURE_VERSION,
        decision: "accepted",
      });
      this.setGatewayDisclosureEndpoint(
        gatewayRecord,
        input.capability,
        String(gatewayRecord.settings.endpoint ?? ""),
      );
      return { ...input, accepted: true, disclosureVersion: receipt.disclosureVersion };
    }
    if (this.claudeRecord(input.connectionId)) {
      if (input.capability !== "summary" && input.capability !== "conversation") {
        throw new Error("This Claude Code connection supports Summary and Conversation only");
      }
      const receipt = this.host.recordAgentConnectionDisclosure({
        connectionId: input.connectionId,
        capability: input.capability,
        disclosureVersion: input.capability === "summary"
          ? CLAUDE_CODE_SUMMARY_DISCLOSURE_VERSION
          : CLAUDE_CODE_CONVERSATION_DISCLOSURE_VERSION,
        decision: "accepted",
      });
      return { ...input, accepted: true, disclosureVersion: receipt.disclosureVersion };
    }
    if (this.codexRecord(input.connectionId)) {
      if (input.capability !== "summary" && input.capability !== "conversation") {
        throw new Error("This Codex connection supports Summary and Conversation only");
      }
      const receipt = this.host.recordAgentConnectionDisclosure({
        connectionId: input.connectionId,
        capability: input.capability,
        disclosureVersion: input.capability === "summary"
          ? CODEX_SUMMARY_DISCLOSURE_VERSION
          : CODEX_CONVERSATION_DISCLOSURE_VERSION,
        decision: "accepted",
      });
      return { ...input, accepted: true, disclosureVersion: receipt.disclosureVersion };
    }
    if (input.connectionId !== DIRECT_XAI_ID || !this.hasDirectConnection()) {
      throw new Error("Agent Connection not found");
    }
    if (input.capability === "transcription") {
      const receipt = this.host.recordCloudTranscriptionConsent(XAI_TRANSCRIPTION_DISCLOSURE_VERSION);
      return { ...input, accepted: true, disclosureVersion: receipt.disclosureVersion };
    }
    if (input.capability === "summary") {
      const receipt = this.host.recordSummaryDataPathDisclosure("xai", XAI_SUMMARY_DISCLOSURE_VERSION);
      return { ...input, accepted: true, disclosureVersion: receipt.disclosureVersion };
    }
    const receipt = this.host.recordAgentConnectionDisclosure({
      connectionId: DIRECT_XAI_ID,
      capability: "conversation",
      disclosureVersion: XAI_CONVERSATION_DISCLOSURE_VERSION,
      decision: "accepted",
    });
    return { ...input, accepted: true, disclosureVersion: receipt.disclosureVersion };
  }

  declineDisclosure(input: {
    connectionId: string;
    capability: "summary" | "conversation";
  }) {
    this.ensureMigrated();
    if (this.gatewayRecord(input.connectionId)) {
      const gatewayRecord = this.gatewayRecord(input.connectionId)!;
      const disclosureVersion = input.capability === "summary"
        ? CLIPROXYAPI_SUMMARY_DISCLOSURE_VERSION
        : CLIPROXYAPI_CONVERSATION_DISCLOSURE_VERSION;
      const receipt = this.host.recordAgentConnectionDisclosure({
        connectionId: input.connectionId,
        capability: input.capability,
        disclosureVersion,
        decision: "declined",
      });
      this.setGatewayDisclosureEndpoint(gatewayRecord, input.capability, null);
      return { ...input, decision: receipt.decision, disclosureVersion: receipt.disclosureVersion };
    }
    if (this.claudeRecord(input.connectionId)) {
      if (input.capability !== "summary" && input.capability !== "conversation") {
        throw new Error("This Claude Code connection supports Summary and Conversation only");
      }
      const disclosureVersion = input.capability === "summary"
        ? CLAUDE_CODE_SUMMARY_DISCLOSURE_VERSION
        : CLAUDE_CODE_CONVERSATION_DISCLOSURE_VERSION;
      const receipt = this.host.recordAgentConnectionDisclosure({
        connectionId: input.connectionId,
        capability: input.capability,
        disclosureVersion,
        decision: "declined",
      });
      return { ...input, decision: receipt.decision, disclosureVersion: receipt.disclosureVersion };
    }
    if (this.codexRecord(input.connectionId)) {
      if (input.capability !== "summary" && input.capability !== "conversation") {
        throw new Error("This Codex connection supports Summary and Conversation only");
      }
      const disclosureVersion = input.capability === "summary"
        ? CODEX_SUMMARY_DISCLOSURE_VERSION
        : CODEX_CONVERSATION_DISCLOSURE_VERSION;
      const receipt = this.host.recordAgentConnectionDisclosure({
        connectionId: input.connectionId,
        capability: input.capability,
        disclosureVersion,
        decision: "declined",
      });
      return { ...input, decision: receipt.decision, disclosureVersion: receipt.disclosureVersion };
    }
    if (input.connectionId !== DIRECT_XAI_ID || !this.hasDirectConnection()) {
      throw new Error("Agent Connection not found");
    }
    if (input.capability === "summary") {
      const receipt = this.host.declineSummaryDataPathDisclosure("xai", XAI_SUMMARY_DISCLOSURE_VERSION);
      return { ...input, decision: receipt.decision, disclosureVersion: receipt.disclosureVersion };
    }
    const receipt = this.host.recordAgentConnectionDisclosure({
      connectionId: DIRECT_XAI_ID,
      capability: "conversation",
      disclosureVersion: XAI_CONVERSATION_DISCLOSURE_VERSION,
      decision: "declined",
    });
    return { ...input, decision: receipt.decision, disclosureVersion: receipt.disclosureVersion };
  }

  async deletionImpact(input: { connectionId: string }) {
    this.ensureMigrated();
    const gateway = this.gatewayRecord(input.connectionId);
    if (gateway) {
      const config = this.config.read();
      const selectedCapabilities = (["summary", "conversation"] as const).filter((capability) => {
        const selection = config.intelligence[capability];
        return selection.provider === "agent" && "connectionId" in selection && selection.connectionId === gateway.id;
      });
      const pinnedTasks = this.host.listTasks(10_000)
        .filter((task) => task.summaryConnectionId === gateway.id && !["completed", "cancelled"].includes(task.state))
        .map((task) => ({
          id: task.id,
          recordingStem: task.recordingStem,
          title: task.title,
          state: task.state,
          model: task.summaryModel,
        }));
      const pinnedConversations = readAgentSessionStore(this.configDir).sessions
        .filter((session) => session.purpose === "ask" && session.connectionId === gateway.id)
        .map((session) => ({ id: session.id, title: session.title, status: session.status, model: session.model }));
      return {
        connectionId: gateway.id,
        selectedCapabilities,
        pinnedTasks,
        pinnedConversations,
        removesRuntimeAuthorization: false,
        removesYuluManagedCredentials: true,
      };
    }
    if (input.connectionId !== DIRECT_XAI_ID || !this.hasDirectConnection()) {
      throw new Error("Agent Connection not found");
    }
    const config = this.config.read();
    const selectedCapabilities: AgentConnectionCapability[] = [];
    if (config.transcription.engine === "xai") selectedCapabilities.push("transcription");
    if (config.intelligence.summary.provider === "xai") selectedCapabilities.push("summary");
    if (config.intelligence.conversation.provider === "xai") selectedCapabilities.push("conversation");
    const pinnedTasks = this.host.listTasks(10_000)
      .filter((task) => task.summaryProvider === "xai" && !["completed", "cancelled"].includes(task.state))
      .map((task) => ({
        id: task.id,
        recordingStem: task.recordingStem,
        title: task.title,
        state: task.state,
        model: task.summaryModel,
      }));
    const pinnedConversations = readAgentSessionStore(this.configDir).sessions
      .filter((session) => session.purpose === "ask" && session.provider === "xai")
      .map((session) => ({
        id: session.id,
        title: session.title,
        status: session.status,
        model: session.model,
      }));
    return {
      connectionId: DIRECT_XAI_ID,
      selectedCapabilities,
      pinnedTasks,
      pinnedConversations,
      removesRuntimeAuthorization: false,
      removesYuluManagedCredentials: true,
    };
  }

  async remove(input: { connectionId: string; confirmed: true }) {
    await this.deletionImpact(input);
    const gateway = this.gatewayRecord(input.connectionId);
    if (gateway) {
      for (const credentialIdentity of this.gatewayCredentialIdentities(gateway)) {
        await this.requireGatewaySecretStore(credentialIdentity).clear();
      }
      this.gatewayReadiness.clear();
      this.host.clearAgentConnectionReadinessHistory(input.connectionId);
      this.host.clearAgentConnectionDisclosures(input.connectionId);
      this.host.deleteAgentConnectionRecord(input.connectionId);
      return await this.view();
    }
    await this.credentials.logout();
    await this.credentials.clearApiKey();
    this.readiness.clear();
    this.host.clearAgentConnectionReadinessHistory(DIRECT_XAI_ID);
    this.host.clearCloudTranscriptionConsent();
    this.host.clearSummaryDataPathDisclosure("xai");
    this.host.clearAgentConnectionDisclosures(DIRECT_XAI_ID);
    this.host.deleteAgentConnectionRecord(DIRECT_XAI_ID);
    return await this.view();
  }

  async restoreDirectXai() {
    this.ensureMigrated();
    if (!this.hasDirectConnection()) {
      this.host.upsertAgentConnectionRecord({
        id: DIRECT_XAI_ID,
        kind: "direct-provider",
        adapter: "direct-xai",
        label: "xAI",
        lifecycle: "available",
        settings: { credentialSource: null },
      });
    }
    return await this.view();
  }

  async authorize() {
    this.persistCredentialSource("oauth");
    this.readiness.clear();
    return await this.credentials.authorize();
  }

  cancelAuthorization() {
    this.requireDirectConnection();
    return this.credentials.cancelAuthorization();
  }

  async logoutOAuth() {
    this.requireDirectConnection();
    await this.credentials.logout();
    this.readiness.clear();
    return await this.view();
  }

  async setApiKey(apiKey: string) {
    this.requireDirectConnection();
    this.readiness.clear();
    await this.credentials.setApiKey(apiKey);
    this.persistCredentialSource("api-key");
    return await this.view();
  }

  async clearApiKey() {
    this.requireDirectConnection();
    this.readiness.clear();
    await this.credentials.clearApiKey();
    return await this.view();
  }

  summaryAdapter(): SupportedAgentSummaryAdapter {
    return {
      current: (snapshot) => this.currentSupportedAgentSummaryReadiness(snapshot),
      probe: async () => {
        const selection = this.config.read().intelligence.summary;
        if (selection.provider !== "agent" || !("connectionId" in selection)) {
          return this.unavailableSupportedSummary("Select an explicit Supported Agent Summary connection before testing it");
        }
        await this.probe({
          connectionId: selection.connectionId,
          capability: "summary",
          model: selection.model,
        });
        return this.currentSupportedAgentSummaryReadiness({
          connectionId: selection.connectionId,
          provider: "agent",
          model: selection.model,
        });
      },
      gateway: (_config, snapshot) => {
        const selection = this.config.read().intelligence.summary;
        const connectionId = snapshot?.connectionId ?? (
          selection.provider === "agent" && "connectionId" in selection ? selection.connectionId : null
        );
        const record = connectionId
          ? this.host.listAgentConnectionRecords().find((candidate) => candidate.id === connectionId)
          : null;
        const provider = snapshot?.provider === "codex" || snapshot?.provider === "claude-code" || snapshot?.provider === "cliproxyapi"
          ? snapshot.provider
          : record?.adapter === "codex" || record?.adapter === "claude-code" || record?.adapter === "cliproxyapi"
            ? record.adapter
            : "";
        return {
          provider,
          health: () => {
            const readiness = this.currentSupportedAgentSummaryReadiness(snapshot);
            return {
              available: readiness.status === "ready",
              provider,
              reason: readiness.status === "ready" ? null : readiness.detail,
            };
          },
          runArtifactWorkflow: async (input: AgentArtifactWorkflowInput) => {
            const task = input.task;
            if (task.summaryProvider === "cliproxyapi") {
              if (!task.summaryConnectionId || task.summaryCredentialClass !== "api-key") {
                throw new AgentUnavailableError("The pinned CLIProxyAPI Gateway credential class is invalid");
              }
              const gatewayRecord = this.gatewayRecord(task.summaryConnectionId);
              if (!gatewayRecord) {
                throw new AgentUnavailableError(
                  `Pinned CLIProxyAPI Gateway connection ${task.summaryConnectionId} is unavailable`,
                );
              }
              if (!task.summaryEndpointIdentity) {
                throw new AgentUnavailableError("The pinned CLIProxyAPI Gateway endpoint is unavailable");
              }
              if (!task.summaryCredentialIdentity) {
                throw new AgentUnavailableError("The pinned CLIProxyAPI Gateway credential identity is unavailable");
              }
              const revision = this.gatewayCredentialRevision(gatewayRecord, task.summaryCredentialIdentity);
              if (!revision) {
                throw new AgentUnavailableError("The pinned CLIProxyAPI Gateway credential revision is unavailable");
              }
              if (revision.endpoint !== task.summaryEndpointIdentity) {
                throw new AgentUnavailableError(
                  "The pinned CLIProxyAPI Gateway endpoint does not match its credential revision",
                );
              }
              if (!input.committedTranscript?.trim()) {
                throw new Error("CLIProxyAPI Gateway Summary requires the committed transcript text");
              }
              const adapter = this.requireGatewayAdapter(
                task.summaryEndpointIdentity,
                revision.httpsApproved,
                task.summaryCredentialIdentity,
              );
              const readinessKey = this.gatewayReadinessKey(
                task.summaryConnectionId,
                "summary",
                task.summaryCredentialIdentity,
                task.summaryModel,
              );
              const keyConfigured = await adapter.keyConfigured();
              const readinessIdentity = this.gatewayIdentity(
                task.summaryEndpointIdentity,
                revision.httpsApproved,
                task.summaryModel,
                keyConfigured,
                task.summaryCredentialIdentity,
              );
              const existingProof = this.gatewayReadiness.get(readinessKey);
              if (
                existingProof?.readiness.status !== "ready" ||
                existingProof.readiness.model !== task.summaryModel ||
                existingProof.identity !== readinessIdentity
              ) {
                this.host.beginGatewaySummaryExecution(task.id, input.leaseToken, "preflight");
                const preflight = await adapter.probe({ capability: "summary", model: task.summaryModel });
                const evidence = preflight.evidence as GatewayRuntimeEvidence | undefined;
                if (preflight.reason === "unknown_outcome" && evidence && isExactGatewayRuntimeEvidence(evidence, {
                  endpoint: task.summaryEndpointIdentity,
                  model: task.summaryModel,
                  terminalStatus: "unknown",
                })) {
                  this.host.recordAgentConnectionReadiness({
                    connectionId: task.summaryConnectionId,
                    capability: "summary",
                    status: "failed",
                    model: task.summaryModel,
                    credentialSource: "api-key",
                    detail: "Pinned CLIProxyAPI Summary preflight outcome is unknown; no transcript was sent",
                    reason: "unknown_outcome",
                    runtimeEvidence: evidence,
                    testedAt: new Date().toISOString(),
                  });
                  throw new Error(
                    "Pinned CLIProxyAPI Summary preflight outcome is unknown; the committed transcript was not sent. Verify Gateway state before an authenticated retry",
                  );
                }
                if (
                  preflight.status !== "ready" || !keyConfigured || !evidence ||
                  !isExactGatewayRuntimeEvidence(evidence, {
                    endpoint: task.summaryEndpointIdentity,
                    model: task.summaryModel,
                    terminalStatus: "ready",
                  })
                ) {
                  throw new Error(
                    "Pinned CLIProxyAPI Summary preflight failed for the retained endpoint and credential revision; restore that exact Yulu key before an authenticated retry",
                  );
                }
                const testedAt = new Date().toISOString();
                this.gatewayReadiness.set(readinessKey, {
                  identity: readinessIdentity,
                  readiness: {
                    capability: "summary",
                    status: "ready",
                    model: task.summaryModel,
                    credentialSource: "api-key",
                    testedAt,
                    detail: `summary · ${task.summaryModel} passed the pinned CLIProxyAPI production preflight`,
                  },
                });
              }
              const executionId = this.host.beginGatewaySummaryExecution(
                task.id,
                input.leaseToken,
                "summary",
              );
              let result: Awaited<ReturnType<CliProxyApiAdapter["summarize"]>>;
              try {
                result = await adapter.summarize({
                  model: task.summaryModel,
                  instructions: task.instructions,
                  transcript: input.committedTranscript,
                });
              } catch (error) {
                if (error instanceof GatewayRequestUnknownOutcomeError) {
                  throw new GatewaySummaryUnknownOutcomeError(error.message, {
                    executionId,
                    evidence: error.evidence,
                  });
                }
                throw error;
              }
              return {
                stdout: "",
                stderr: "",
                nativeSessionId: result.evidence.requestId ?? "",
                summary: result.summary,
                runtimeEvidence: result.evidence,
                summaryIdentity: { provider: task.summaryProvider, model: task.summaryModel },
                audit: {
                  ok: true,
                  toolNames: [],
                  artifactCommit: false,
                  notionDeliveryBegin: false,
                  notionSearch: false,
                  notionWrite: false,
                  notionIdempotencyMarker: false,
                  notionWriteResultVerified: false,
                  notionDeliveryCommit: false,
                  notionOrderValid: true,
                  errors: [],
                },
              };
            }
            const readiness = this.currentSupportedAgentSummaryReadiness({
              connectionId: task.summaryConnectionId,
              provider: task.summaryProvider,
              model: task.summaryModel,
            });
            if (readiness.status !== "ready" || !task.summaryConnectionId) {
              throw new AgentUnavailableError(readiness.detail);
            }
            if (task.summaryCredentialClass !== "runtime-oauth") {
              throw new AgentUnavailableError("The pinned Supported Agent credential class is not runtime-owned authorization");
            }
            const codexRecord = this.codexRecord(task.summaryConnectionId);
            const claudeRecord = this.claudeRecord(task.summaryConnectionId);
            if (!codexRecord && !claudeRecord) {
              throw new AgentUnavailableError(`Pinned Supported Agent connection ${task.summaryConnectionId} is unavailable`);
            }
            if (!input.committedTranscript?.trim()) {
              throw new Error("Supported Agent Summary requires the committed transcript text");
            }
            let result:
              | Awaited<ReturnType<CodexAgentAdapter["summarize"]>>
              | Awaited<ReturnType<ClaudeCodeAdapter["summarize"]>>;
            try {
              result = codexRecord
                ? await this.requireCodexAdapter(String(codexRecord.settings.executablePath ?? "")).summarize({
                    model: task.summaryModel,
                    instructions: task.instructions,
                    transcript: input.committedTranscript,
                  })
                : await this.requireClaudeAdapter(String(claudeRecord!.settings.executablePath ?? "")).summarize({
                    model: task.summaryModel,
                    instructions: task.instructions,
                    transcript: input.committedTranscript,
                  });
            } catch (error) {
              if (error instanceof ClaudeCodeConversationError && error.unknownOutcome && error.nativeSessionId) {
                throw new ClaudeCodeSummaryUnknownOutcomeError(error.message, {
                  nativeSessionId: error.nativeSessionId,
                  evidence: error.evidence,
                });
              }
              throw error;
            }
            return {
              stdout: "",
              stderr: "",
              nativeSessionId: result.nativeSessionId,
              summary: result.summary,
              runtimeEvidence: result.evidence,
              summaryIdentity: { provider: task.summaryProvider, model: task.summaryModel },
              audit: {
                ok: true,
                toolNames: [],
                artifactCommit: false,
                notionDeliveryBegin: false,
                notionSearch: false,
                notionWrite: false,
                notionIdempotencyMarker: false,
                notionWriteResultVerified: false,
                notionDeliveryCommit: false,
                notionOrderValid: true,
                errors: [],
              },
            };
          },
          runNotionWorkflow: async (_input: AgentNotionWorkflowInput) => {
            throw new AgentUnavailableError("Supported Agent Summary invocations have no delivery authority");
          },
          close: () => {},
        };
      },
    };
  }

  async converseCodex(input: {
    connectionId: string;
    model: string;
    prompt: string;
    nativeSessionId?: string;
  }) {
    const record = this.codexRecord(input.connectionId);
    if (!record) {
      throw new Error(`Pinned Codex connection ${input.connectionId} is unavailable; restore it in Agent Connection Center`);
    }
    return await this.requireCodexAdapter(String(record.settings.executablePath ?? "")).converse({
      model: input.model,
      prompt: input.prompt,
      ...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}),
    });
  }

  async assertCodexConversationReady(input: { connectionId: string; model: string }): Promise<void> {
    try {
      await this.requireCurrentCodexReadiness(input.connectionId, "conversation", input.model);
    } catch {
      throw new Error("Test this exact Codex Conversation model before starting a new conversation");
    }
  }

  async converseClaude(input: {
    connectionId: string;
    model: string;
    prompt: string;
    nativeSessionId?: string;
  }) {
    const record = this.claudeRecord(input.connectionId);
    if (!record) {
      throw new Error(`Pinned Claude Code connection ${input.connectionId} is unavailable; restore it in Agent Connection Center`);
    }
    return await this.requireClaudeAdapter(String(record.settings.executablePath ?? "")).converse({
      model: input.model,
      prompt: input.prompt,
      ...(input.nativeSessionId ? { nativeSessionId: input.nativeSessionId } : {}),
    });
  }

  async assertClaudeConversationReady(input: { connectionId: string; model: string }): Promise<void> {
    try {
      await this.requireCurrentClaudeReadiness(input.connectionId, "conversation", input.model);
    } catch {
      throw new Error("Test this exact Claude Code Conversation model before starting a new conversation");
    }
  }

  async assertGatewayConversationReady(input: { connectionId: string; model: string }): Promise<void> {
    try {
      await this.requireCurrentGatewayReadiness(input.connectionId, "conversation", input.model);
    } catch {
      throw new Error("Test this exact CLIProxyAPI Conversation model before starting a new conversation");
    }
  }

  async converseGateway(input: {
    connectionId: string;
    endpointIdentity: string;
    credentialIdentity: string;
    model: string;
    input: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  }) {
    const record = this.gatewayRecord(input.connectionId);
    if (!record) {
      throw new Error(
        `Pinned CLIProxyAPI Gateway connection ${input.connectionId} is unavailable; restore it in Agent Connection Center`,
      );
    }
    const revision = this.gatewayCredentialRevision(record, input.credentialIdentity);
    if (!revision) {
      throw new Error("Pinned CLIProxyAPI Gateway credential identity is unavailable");
    }
    if (revision.endpoint !== input.endpointIdentity) {
      throw new Error("Pinned CLIProxyAPI Gateway endpoint does not match its credential revision");
    }
    const adapter = this.requireGatewayAdapter(
      input.endpointIdentity,
      revision.httpsApproved,
      input.credentialIdentity,
    );
    return await adapter.converse({ model: input.model, input: input.input });
  }

  private unavailableSupportedSummary(detail: string): SupportedAgentSummaryReadiness {
    return {
      capability: "summary",
      provider: "",
      model: "",
      status: "failed",
      testedAt: null,
      detail,
      credentialSource: null,
      connectionId: null,
      disclosure: null,
      reason: "provider_unavailable",
    };
  }

  private currentSupportedAgentSummaryReadiness(
    snapshot?: SupportedAgentSummarySnapshot,
  ): SupportedAgentSummaryReadiness {
    const selection = this.config.read().intelligence.summary;
    const connectionId = snapshot?.connectionId ?? (
      selection.provider === "agent" && "connectionId" in selection ? selection.connectionId : null
    );
    if (!connectionId) {
      return this.unavailableSupportedSummary("Select an explicit Supported Agent Summary connection before using it");
    }
    const record = this.host.listAgentConnectionRecords().find((candidate) => candidate.id === connectionId);
    if (!record || (record.adapter !== "codex" && record.adapter !== "claude-code" && record.adapter !== "cliproxyapi")) {
      return this.unavailableSupportedSummary(`Pinned Supported Agent connection ${connectionId} is unavailable`);
    }
    if (snapshot && snapshot.provider !== "agent" && snapshot.provider !== record.adapter) {
      return this.unavailableSupportedSummary("Pinned Summary Provider does not match its Agent Connection adapter");
    }
    const exactSnapshot = snapshot ? { ...snapshot, provider: record.adapter } : undefined;
    return record.adapter === "codex"
      ? this.currentCodexSummaryReadiness(exactSnapshot)
      : record.adapter === "claude-code"
        ? this.currentClaudeSummaryReadiness(exactSnapshot)
        : this.currentGatewaySummaryReadiness(exactSnapshot);
  }

  private currentGatewaySummaryReadiness(
    snapshot?: SupportedAgentSummarySnapshot,
  ): SupportedAgentSummaryReadiness {
    const selection = this.config.read().intelligence.summary;
    const connectionId = snapshot?.connectionId ?? (
      selection.provider === "agent" && "connectionId" in selection ? selection.connectionId : null
    );
    const model = snapshot?.model ?? selection.model;
    if (!connectionId || (snapshot && snapshot.provider !== "cliproxyapi")) {
      return this.unavailableSupportedSummary("Select an explicit CLIProxyAPI Gateway Summary connection before using it");
    }
    const record = this.gatewayRecord(connectionId);
    if (!record) {
      return this.unavailableSupportedSummary(`Pinned CLIProxyAPI Gateway connection ${connectionId} is unavailable`);
    }
    const endpoint = snapshot?.endpointIdentity ?? String(record.settings.endpoint ?? "").trim();
    const credentialIdentity = snapshot?.credentialIdentity ?? this.currentGatewayCredentialIdentity(record);
    const revision = this.gatewayCredentialRevision(record, credentialIdentity);
    if (!revision) {
      return this.unavailableSupportedSummary("Pinned CLIProxyAPI Gateway credential revision is unavailable");
    }
    if (revision.endpoint !== endpoint) {
      return this.unavailableSupportedSummary(
        "Pinned CLIProxyAPI Gateway endpoint does not match its credential revision",
      );
    }
    const httpsApproved = revision.httpsApproved;
    const pinnedWork = Boolean(snapshot?.endpointIdentity && snapshot?.credentialIdentity);
    if (!pinnedWork && !this.hasGatewayDisclosure(
      record,
      "summary",
      CLIPROXYAPI_SUMMARY_DISCLOSURE_VERSION,
      endpoint,
    )) {
      return this.unavailableSupportedSummary(
        "Accept the current CLIProxyAPI Summary endpoint and credential data path disclosure before creating new work",
      );
    }
    const proof = this.gatewayReadiness.get(
      this.gatewayReadinessKey(connectionId, "summary", credentialIdentity, model),
    );
    let sameSettings = false;
    if (proof) {
      try {
        const identity = JSON.parse(proof.identity) as {
          endpoint?: string;
          httpsApproved?: boolean;
          model?: string;
          keyConfigured?: boolean;
          credentialClass?: string;
          credentialIdentity?: string;
        };
        sameSettings = identity.endpoint === endpoint && identity.httpsApproved === httpsApproved &&
          identity.model === model && identity.keyConfigured === true && identity.credentialClass === "api-key" &&
          identity.credentialIdentity === credentialIdentity;
      } catch {
        sameSettings = false;
      }
    }
    const readiness = proof && sameSettings && proof.readiness.model === model
      ? proof.readiness
      : pinnedWork
        ? {
            capability: "summary" as const,
            status: "untested" as const,
            model,
            testedAt: null,
            detail: "Pinned CLIProxyAPI identity retained; an exact production preflight is required before Summary execution",
            credentialSource: "api-key" as const,
          }
        : untested("summary", model);
    return {
      capability: "summary",
      provider: "cliproxyapi",
      model,
      status: readiness.status,
      testedAt: readiness.testedAt,
      detail: readiness.detail,
      credentialSource: "api-key",
      connectionId,
      endpointIdentity: endpoint,
      credentialIdentity,
      disclosure: {
        kind: "external",
        connectionId,
        disclosureVersion: CLIPROXYAPI_SUMMARY_DISCLOSURE_VERSION,
        data: "transcript_text",
        destination: endpoint,
      },
      ...(readiness.reason ? { reason: readiness.reason } : {}),
    };
  }

  private currentClaudeSummaryReadiness(snapshot?: {
    connectionId: string | null;
    provider: string;
    model: string;
  }): SupportedAgentSummaryReadiness {
    const selection = this.config.read().intelligence.summary;
    const connectionId = snapshot?.connectionId ?? (
      selection.provider === "agent" && "connectionId" in selection ? selection.connectionId : null
    );
    const model = snapshot?.model ?? selection.model;
    if (!connectionId || (snapshot && snapshot.provider !== "claude-code")) {
      return this.unavailableSupportedSummary("Select an explicit Claude Code Summary connection before using it");
    }
    const record = this.claudeRecord(connectionId);
    if (!record) {
      return this.unavailableSupportedSummary(`Pinned Claude Code connection ${connectionId} is unavailable`);
    }
    const proof = this.claudeReadiness.get(this.claudeReadinessKey(connectionId, "summary"));
    let sameSettings = false;
    if (proof) {
      try {
        const identity = JSON.parse(proof.identity) as { executable?: string; model?: string };
        sameSettings = identity.executable === String(record.settings.executablePath ?? "") &&
          identity.model === model;
      } catch {
        sameSettings = false;
      }
    }
    const readiness = proof && sameSettings && proof.readiness.model === model
      ? proof.readiness
      : untested("summary", model);
    return {
      capability: "summary",
      provider: "claude-code",
      model,
      status: readiness.status,
      testedAt: readiness.testedAt,
      detail: readiness.detail,
      credentialSource: "runtime-oauth",
      connectionId,
      disclosure: {
        kind: "external",
        connectionId,
        disclosureVersion: CLAUDE_CODE_SUMMARY_DISCLOSURE_VERSION,
        data: "transcript_text",
        destination: "Claude Code runtime and its configured model provider",
      },
      ...(readiness.reason ? { reason: readiness.reason } : {}),
    };
  }

  private currentCodexSummaryReadiness(snapshot?: {
    connectionId: string | null;
    provider: string;
    model: string;
  }): SupportedAgentSummaryReadiness {
    const selection = this.config.read().intelligence.summary;
    const connectionId = snapshot?.connectionId ?? (
      selection.provider === "agent" && "connectionId" in selection ? selection.connectionId : null
    );
    const model = snapshot?.model ?? selection.model;
    if (!connectionId || (snapshot && snapshot.provider !== "codex")) {
      return this.unavailableSupportedSummary("Select an explicit Codex Summary connection before using it");
    }
    const record = this.codexRecord(connectionId);
    if (!record) return this.unavailableSupportedSummary(`Pinned Codex connection ${connectionId} is unavailable`);
    const proof = this.codexReadiness.get(this.codexReadinessKey(connectionId, "summary"));
    let sameSettings = false;
    if (proof) {
      try {
        const identity = JSON.parse(proof.identity) as { executable?: string; model?: string };
        sameSettings = identity.executable === String(record.settings.executablePath ?? "") && identity.model === model;
      } catch {
        sameSettings = false;
      }
    }
    const readiness = proof && sameSettings && proof.readiness.model === model
      ? proof.readiness
      : untested("summary", model);
    return {
      capability: "summary",
      provider: "codex",
      model,
      status: readiness.status,
      testedAt: readiness.testedAt,
      detail: readiness.detail,
      credentialSource: "runtime-oauth",
      connectionId,
      disclosure: {
        kind: "external",
        connectionId,
        disclosureVersion: CODEX_SUMMARY_DISCLOSURE_VERSION,
        data: "transcript_text",
        destination: "Codex runtime and its configured model provider",
      },
      ...(readiness.reason ? { reason: readiness.reason } : {}),
    };
  }

  private finishProbe(
    result: XaiReadinessResult,
    actual: { actualProvider: string | null; actualModel: string | null } | null,
  ): XaiReadinessResult {
    this.readiness.set(result.capability, result);
    if (!actual || result.status !== "ready") return result;
    this.host.recordAgentConnectionReadiness({
      connectionId: DIRECT_XAI_ID,
      capability: result.capability,
      status: result.status === "ready" ? "ready" : "failed",
      model: result.model,
      credentialSource: result.credentialSource,
      detail: result.detail,
      reason: result.reason ?? null,
      runtimeEvidence: {
        adapter: DIRECT_XAI_ID,
        transport: "xai-http",
        runtimeVersion: null,
        requestedProvider: "xai",
        requestedModel: result.model,
        actualProvider: actual.actualProvider,
        actualModel: actual.actualModel,
        requestId: null,
        sessionId: null,
        terminalStatus: result.status === "ready" ? "ready" : "failed",
        fallbackOccurred: false,
      },
      testedAt: result.testedAt ?? new Date().toISOString(),
    });
    return result;
  }

  private hasDirectConnection(): boolean {
    return this.host.listAgentConnectionRecords().some((record) => record.id === DIRECT_XAI_ID);
  }

  private codexRecord(connectionId: string) {
    return this.host.listAgentConnectionRecords().find((record) =>
      record.id === connectionId && record.kind === "supported-agent" && record.adapter === "codex"
    );
  }

  private gatewayRecord(connectionId: string) {
    return this.host.listAgentConnectionRecords().find((record) =>
      record.id === connectionId && record.kind === "gateway" && record.adapter === "cliproxyapi"
    );
  }

  private claudeRecord(connectionId: string) {
    return this.host.listAgentConnectionRecords().find((record) =>
      record.id === connectionId && record.kind === "supported-agent" && record.adapter === "claude-code"
    );
  }

  private codexIdentity(
    executable: string,
    model: string,
    status: Awaited<ReturnType<CodexAgentAdapter["status"]>>,
  ): string {
    return JSON.stringify({
      executable,
      model,
      runtimeVersion: status.runtimeVersion,
      minimumVersion: status.minimumVersion,
      supported: status.supported,
      authorized: status.authorized,
      modelAvailable: status.availableModels.includes(model),
      features: [...status.features].sort(),
    });
  }

  private claudeIdentity(
    executable: string,
    model: string,
    status: Awaited<ReturnType<ClaudeCodeAdapter["status"]>>,
  ): string {
    return JSON.stringify({
      executable,
      model,
      runtimeVersion: status.runtimeVersion,
      minimumVersion: status.minimumVersion,
      supported: status.supported,
      authorized: status.authorized,
      authorizationMethod: status.authorizationMethod,
      apiProvider: status.apiProvider,
      features: [...status.features].sort(),
    });
  }

  private gatewayIdentity(
    endpoint: string,
    httpsApproved: boolean,
    model: string,
    keyConfigured: boolean,
    credentialIdentity: string,
  ): string {
    return JSON.stringify({
      endpoint,
      httpsApproved,
      model,
      keyConfigured,
      credentialClass: "api-key",
      credentialIdentity,
    });
  }

  private async requireCurrentGatewayReadiness(
    connectionId: string,
    capability: "summary" | "conversation",
    model: string,
  ): Promise<void> {
    const record = this.gatewayRecord(connectionId);
    if (!record) throw new Error(`Test this exact CLIProxyAPI ${capability} model before selecting it`);
    const endpoint = String(record.settings.endpoint ?? "").trim();
    const httpsApproved = record.settings.httpsApproved === true;
    const credentialIdentity = this.currentGatewayCredentialIdentity(record);
    const adapter = this.requireGatewayAdapter(endpoint, httpsApproved, credentialIdentity);
    const [identity, keyConfigured] = await Promise.all([
      adapter.validateEndpoint(),
      adapter.keyConfigured(),
    ]);
    const readinessKey = this.gatewayReadinessKey(record.id, capability, credentialIdentity, model);
    const proof = this.gatewayReadiness.get(readinessKey);
    const expected = this.gatewayIdentity(
      identity.endpoint,
      httpsApproved,
      model,
      keyConfigured,
      credentialIdentity,
    );
    if (proof?.readiness.status !== "ready" || proof.readiness.model !== model || proof.identity !== expected) {
      this.gatewayReadiness.delete(readinessKey);
      throw new Error(`Test this exact CLIProxyAPI ${capability === "summary" ? "Summary" : "Conversation"} model before selecting it`);
    }
  }

  private async requireCurrentCodexReadiness(
    connectionId: string,
    capability: "summary" | "conversation",
    model: string,
  ): Promise<void> {
    const record = this.codexRecord(connectionId);
    if (!record) throw new Error(`Test this exact Codex ${capability} model before selecting it`);
    const executable = String(record.settings.executablePath ?? "");
    const status = await this.requireCodexAdapter(executable).status(
      capability === "summary" ? { toolFree: true } : {},
    );
    const readinessKey = this.codexReadinessKey(record.id, capability);
    const proof = this.codexReadiness.get(readinessKey);
    const identity = this.codexIdentity(executable, model, status);
    if (
      proof?.readiness.status !== "ready" ||
      proof.readiness.model !== model ||
      proof.identity !== identity
    ) {
      this.codexReadiness.delete(readinessKey);
      throw new Error(`Test this exact Codex ${capability} model before selecting it`);
    }
  }

  private async requireCurrentClaudeReadiness(
    connectionId: string,
    capability: "summary" | "conversation",
    model: string,
  ): Promise<void> {
    const record = this.claudeRecord(connectionId);
    if (!record) throw new Error(`Test this exact Claude Code ${capability} model before selecting it`);
    const executable = String(record.settings.executablePath ?? "");
    const status = await this.requireClaudeAdapter(executable).status(
      capability === "summary" ? { toolFree: true } : {},
    );
    const readinessKey = this.claudeReadinessKey(record.id, capability);
    const proof = this.claudeReadiness.get(readinessKey);
    const identity = this.claudeIdentity(executable, model, status);
    if (
      proof?.readiness.status !== "ready" ||
      proof.readiness.model !== model ||
      proof.identity !== identity
    ) {
      this.claudeReadiness.delete(readinessKey);
      throw new Error(`Test this exact Claude Code ${capability} model before selecting it`);
    }
  }

  private requireCodexAdapter(executable: string) {
    if (!executable || !this.options.codexAdapter) throw new Error("Codex production adapter is unavailable");
    return this.options.codexAdapter(executable);
  }

  private requireClaudeAdapter(executable: string) {
    if (!executable || !this.options.claudeAdapter) {
      throw new Error("Claude Code production adapter is unavailable");
    }
    return this.options.claudeAdapter(executable);
  }

  private requireGatewayAdapter(endpoint: string, httpsApproved: boolean, credentialIdentity: string) {
    if (!endpoint || !this.options.cliProxyAdapter) {
      throw new Error("CLIProxyAPI production adapter is unavailable");
    }
    if (!this.gatewayCredentialIdentityValid(credentialIdentity)) {
      throw new Error("CLIProxyAPI Gateway credential identity is invalid");
    }
    return this.options.cliProxyAdapter({ endpoint, httpsApproved, credentialIdentity });
  }

  private gatewayCredentialIdentityValid(value: string): boolean {
    return /^gateway\.cliproxyapi\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
  }

  private gatewayCredentialIdentities(record: PersistedAgentConnection | undefined): string[] {
    return this.gatewayCredentialRevisions(record).map((revision) => revision.credentialIdentity);
  }

  private gatewayCredentialRevisions(record: PersistedAgentConnection | undefined): Array<{
    credentialIdentity: string;
    endpoint: string;
    httpsApproved: boolean;
  }> {
    if (!record) return [];
    const raw = Array.isArray(record.settings.credentialRevisions)
      ? record.settings.credentialRevisions
      : [];
    const revisions = raw.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const item = value as Record<string, unknown>;
      const credentialIdentity = typeof item.credentialIdentity === "string" ? item.credentialIdentity : "";
      const endpoint = typeof item.endpoint === "string" ? item.endpoint : "";
      if (!this.gatewayCredentialIdentityValid(credentialIdentity) || !endpoint) return [];
      return [{ credentialIdentity, endpoint, httpsApproved: item.httpsApproved === true }];
    });
    if (revisions.length > 0) {
      return [...new Map(revisions.map((revision) => [revision.credentialIdentity, revision])).values()];
    }
    const credentialIdentity = String(record.settings.credentialIdentity ?? "");
    const endpoint = String(record.settings.endpoint ?? "");
    return this.gatewayCredentialIdentityValid(credentialIdentity) && endpoint
      ? [{ credentialIdentity, endpoint, httpsApproved: record.settings.httpsApproved === true }]
      : [];
  }

  private gatewayCredentialRevision(record: PersistedAgentConnection, credentialIdentity: string) {
    return this.gatewayCredentialRevisions(record)
      .find((revision) => revision.credentialIdentity === credentialIdentity) ?? null;
  }

  private currentGatewayCredentialIdentity(record: PersistedAgentConnection): string {
    const value = String(record.settings.credentialIdentity ?? "").trim();
    if (!this.gatewayCredentialIdentityValid(value) || !this.gatewayCredentialIdentities(record).includes(value)) {
      throw new Error("CLIProxyAPI Gateway credential revision is unavailable");
    }
    return value;
  }

  private requireGatewaySecretStore(credentialIdentity: string): GatewaySecretStore {
    if (!this.gatewayCredentialIdentityValid(credentialIdentity) || !this.options.gatewaySecretStore) {
      throw new Error("CLIProxyAPI Keychain storage is unavailable");
    }
    return this.options.gatewaySecretStore(credentialIdentity);
  }

  private clearGatewaySelections(connectionId: string): void {
    const config = this.config.read();
    for (const capability of ["summary", "conversation"] as const) {
      const selection = config.intelligence[capability];
      if (
        selection.provider === "agent" && "connectionId" in selection &&
        selection.connectionId === connectionId
      ) {
        this.config.update(`intelligence.${capability}`, {
          provider: "agent",
          model: "runtime-managed",
        });
      }
    }
  }

  private hasGatewayDisclosure(
    record: PersistedAgentConnection,
    capability: "summary" | "conversation",
    disclosureVersion: string,
    endpoint: string,
  ): boolean {
    const receipt = this.host.getAgentConnectionDisclosure(record.id, capability);
    const setting = capability === "summary"
      ? "summaryDisclosureIdentity"
      : "conversationDisclosureIdentity";
    const identity = record.settings[setting];
    if (!identity || typeof identity !== "object" || Array.isArray(identity)) return false;
    const pinned = identity as Record<string, unknown>;
    return receipt?.disclosureVersion === disclosureVersion && receipt.decision === "accepted" &&
      pinned.endpoint === endpoint &&
      pinned.credentialIdentity === this.currentGatewayCredentialIdentity(record);
  }

  private setGatewayDisclosureEndpoint(
    record: PersistedAgentConnection,
    capability: "summary" | "conversation",
    endpoint: string | null,
  ): void {
    const setting = capability === "summary"
      ? "summaryDisclosureIdentity"
      : "conversationDisclosureIdentity";
    const settings = { ...record.settings };
    if (endpoint) {
      settings[setting] = {
        endpoint,
        credentialIdentity: this.currentGatewayCredentialIdentity(record),
      };
    } else {
      delete settings[setting];
    }
    this.host.upsertAgentConnectionRecord({ ...record, settings });
  }

  private credentialSource(value: unknown): XaiCredentialSource | null {
    return value === "oauth" || value === "api-key" ? value : null;
  }

  private migrateDirectXaiCredentialSource(
    config: ReturnType<ConfigManager["read"]>,
    status: XaiCredentialStatus,
  ): XaiCredentialSource | null {
    const liveRecord = this.host.listAgentConnectionRecords()
      .find((item) => item.id === DIRECT_XAI_ID);
    if (!liveRecord) return null;
    const current = this.credentialSource(liveRecord?.settings.credentialSource);
    if (this.host.hasAgentConnectionMigration(DIRECT_XAI_CREDENTIAL_SOURCE_MIGRATION_ID)) {
      return current;
    }

    if (status.oauthReadSucceeded !== true || status.apiKeyReadSucceeded !== true) {
      return current;
    }

    const xaiSelected = config.transcription.engine === "xai" ||
      config.intelligence.summary.provider === "xai" ||
      config.intelligence.conversation.provider === "xai";
    const unambiguousSource = status.oauthConnected !== status.apiKeyConfigured
      ? status.oauthConnected ? "oauth" as const : "api-key" as const
      : null;
    const migrated = current ?? (xaiSelected ? unambiguousSource : null);
    if (migrated && migrated !== current) {
      this.host.upsertAgentConnectionRecord({
        ...liveRecord,
        settings: { ...liveRecord.settings, credentialSource: migrated },
      });
    }
    this.host.recordAgentConnectionMigration(DIRECT_XAI_CREDENTIAL_SOURCE_MIGRATION_ID);
    return migrated;
  }

  private requireDirectConnection(): void {
    this.ensureMigrated();
    if (!this.hasDirectConnection()) throw new Error("Agent Connection not found");
  }

  private persistCredentialSource(source: XaiCredentialSource): void {
    const record = this.host.listAgentConnectionRecords().find((item) => item.id === DIRECT_XAI_ID);
    if (!record) throw new Error("Agent Connection not found");
    this.host.upsertAgentConnectionRecord({
      id: record.id,
      kind: record.kind,
      adapter: record.adapter,
      label: record.label,
      lifecycle: record.lifecycle,
      settings: { ...record.settings, credentialSource: source },
    });
    this.credentials.setPreferredSource?.(source);
    this.readiness.clear();
  }

  private ensureMigrated(): void {
    if (this.host.hasAgentConnectionMigration(MIGRATION_ID)) return;
    if (!this.host.listAgentConnectionRecords().some((record) => record.id === DIRECT_XAI_ID)) {
      this.host.upsertAgentConnectionRecord({
        id: DIRECT_XAI_ID,
        kind: "direct-provider",
        adapter: "direct-xai",
        label: "xAI",
        lifecycle: "available",
        settings: { credentialSource: null },
      });
    }
    const config = this.config.read();
    const llm = asRecord(config.llm);
    const command = Array.isArray(llm.command)
      ? llm.command.map(String).map((part) => part.trim()).filter(Boolean)
      : [];
    const configuredProvider = String(asRecord(llm.agent).provider ?? "auto").trim().toLowerCase();
    const configured = normalizeAdapter(configuredProvider);
    const legacyProvider = configuredProvider !== "auto" && !configured ? configuredProvider : null;
    const commandAdapter = adapterFromCommand(command);
    const adapter = command.length > 0 ? commandAdapter : configured;
    if (adapter) {
      this.host.upsertAgentConnectionCandidate({
        id: `candidate:${adapter}`,
        adapter,
        label: LABELS[adapter] ?? adapter,
        source: "migrated",
        detectedPath: null,
        settings: { migratedFromExplicitSelection: true },
      });
    } else if (command.length > 0 || legacyProvider) {
      const executable = basename(command[0] ?? "");
      this.host.upsertAgentConnectionRecord({
        id: "legacy-custom:migrated",
        kind: "legacy-custom",
        adapter: "legacy-command",
        label: executable || legacyProvider || "Custom command",
        lifecycle: "legacy",
        settings: { executable: executable || null, legacyProvider },
      });
    }
    if (adapter || command.length > 0 || legacyProvider) {
      this.config.archiveLegacyAgentConnection();
    }
    if (llm.enabled !== false || adapter || command.length > 0 || legacyProvider) {
      this.config.updateMany([
        { key: "llm.enabled", value: false },
        { key: "llm.command", value: null },
        { key: "llm.agent.provider", value: "auto" },
      ]);
    }
    this.host.recordAgentConnectionMigration(MIGRATION_ID);
  }
}
