import { basename } from "node:path";
import type { ConfigManager } from "./config.js";
import type { HostStore } from "./hostStore.js";
import type {
  XaiAuthorizationState,
  XaiCredentialSource,
  XaiCredentialStatus,
} from "./xaiCredentials.js";
import type { XaiProviderReadiness, XaiReadinessResult } from "./routers/providers.js";
import { XAI_TEXT_MODEL_DEFAULT } from "./settingsRegistry.js";
import {
  hasCurrentXaiSummaryDisclosure,
  XAI_SUMMARY_DISCLOSURE_VERSION,
} from "./summaryDataDisclosure.js";
import {
  hasCurrentXaiTranscriptionConsent,
  XAI_TRANSCRIPTION_DISCLOSURE_VERSION,
} from "./transcriptionConsent.js";
import { readAgentSessionStore } from "./agentSessionStore.js";
import {
  hasCurrentXaiConversationDisclosure,
  XAI_CONVERSATION_DISCLOSURE_VERSION,
} from "./conversationDataDisclosure.js";

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
}

const DIRECT_XAI_ID = "direct-xai";
const MIGRATION_ID = "agent-connections-v1";
const SUPPORTED_ADAPTERS = new Set(["codex", "claude-code", "hermes", "openclaw"]);

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
  if (adapter === "codex" || adapter === "claude-code") return ["summary", "conversation"];
  return [];
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
    const records = this.host.listAgentConnectionRecords();
    const direct = records.find((record) => record.id === DIRECT_XAI_ID);
    const selectedCredentialSource = direct
      ? this.credentialSource(direct.settings.credentialSource) : null;
    this.credentials.setPreferredSource?.(selectedCredentialSource);
    const status = await this.credentials.status();
    const selectedCredentialConnected = selectedCredentialSource === "oauth"
      ? status.oauthConnected
      : selectedCredentialSource === "api-key" ? status.apiKeyConfigured : false;
    const connections = direct ? [{
      id: direct.id,
      kind: direct.kind,
      adapter: direct.adapter,
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
    const candidates = this.host.listAgentConnectionCandidates().map((candidate) => ({
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
          : { connectionId: null, model: config.intelligence.summary.model },
        conversation: direct && config.intelligence.conversation.provider === "xai"
          ? { connectionId: DIRECT_XAI_ID, model: config.intelligence.conversation.model }
          : { connectionId: null, model: config.intelligence.conversation.model },
      },
    };
  }

  async xaiProjection() {
    const view = await this.view();
    const direct = view.connections.find((connection) => connection.id === DIRECT_XAI_ID);
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

  async probe(input: { connectionId: string; capability: AgentConnectionCapability }): Promise<XaiReadinessResult> {
    this.ensureMigrated();
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

  async select(input: {
    connectionId: string;
    capability: AgentConnectionCapability;
    model?: string;
  }) {
    this.ensureMigrated();
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

  private credentialSource(value: unknown): XaiCredentialSource | null {
    return value === "oauth" || value === "api-key" ? value : null;
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
