import { createHash } from "node:crypto";
import { agentConnectionRevision } from "./agentConnectionRevision.js";
import type {
  HostStore,
  PersistedAgentConnection,
  PersistedSharingConfiguration,
  SharingCapabilityEvidenceSnapshot,
  SharingConnector,
} from "./hostStore.js";

export interface ConnectorDestinationOption {
  label: string;
  value: string;
}

export interface SharingConnectorContext {
  connection: PersistedAgentConnection;
  connector: SharingConnector;
}

export interface SharingReceipt {
  destination: string;
  receiptId: string;
  receiptUrl: string;
}

export class SharingConnectorUnknownOutcomeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SharingConnectorUnknownOutcomeError";
  }
}

export interface SharingConnectorAdapter {
  discover(input: SharingConnectorContext): Promise<{
    options: ConnectorDestinationOption[];
    detail: string;
  }>;
  probe(input: SharingConnectorContext): Promise<{ detail: string }>;
  testShare(input: SharingConnectorContext & {
    destination: string;
    content: string;
  }): Promise<SharingReceipt>;
  share(input: SharingConnectorContext & {
    destination: string;
    content: string;
  }): Promise<SharingReceipt>;
  verifyReceipt(input: SharingConnectorContext & {
    destination: string;
    content: string;
    receipt: SharingReceipt;
  }): Promise<SharingReceipt>;
}

type OperationState = {
  status: "untested" | "ready" | "failed";
  detail: string;
  remediation: string;
};

type DiscoveryState = OperationState & { options: ConnectorDestinationOption[] };

type SharingReadinessView = {
  status: "untested" | "ready" | "failed" | "unknown";
  detail: string;
  remediation: string;
  receipt: { id: string; url: string; verifiedAt: string } | null;
  actionId: string | null;
  action: { id: string; receiptId: string; receiptUrl: string } | null;
  duplicateWarningRequired: boolean;
};

const UNTESTED: OperationState = {
  status: "untested",
  detail: "Not tested in this Host process",
  remediation: "",
};

export const YULU_TEST_SHARE_CONTENT =
  "Yulu Test Share — connection verification only. This message contains no meeting content.";

const TEST_SHARE_SHA256 = createHash("sha256").update(YULU_TEST_SHARE_CONTENT).digest("hex");
const SHARING_AGENT_ADAPTERS = new Set(["codex", "claude-code"]);

export class SharingConfiguration {
  private readonly discovery = new Map<string, DiscoveryState>();
  private readonly readiness = new Map<string, OperationState>();

  constructor(private readonly options: {
    host: HostStore;
    adapter: SharingConnectorAdapter;
  }) {}

  view() {
    const persisted = this.options.host.getSharingConfiguration();
    const records = this.options.host.listAgentConnectionRecords();
    const selectedConnection = persisted
      ? records.find((record) => record.id === persisted.connectionId)
      : undefined;
    const key = persisted && selectedConnection
      ? this.stateKey(selectedConnection, persisted.connector)
      : "";
    const connectorReadiness = this.readiness.get(key) ?? { ...UNTESTED };
    const connections = records
      .filter((record) => record.kind === "supported-agent" && SHARING_AGENT_ADAPTERS.has(record.adapter))
      .map(({ id, adapter, label }) => ({ id, adapter, label }));
    return {
      connections,
      selection: persisted ? {
        connectionId: persisted.connectionId,
        connector: persisted.connector,
      } : null,
      connectorDiscovery: this.discovery.get(key) ?? {
        ...UNTESTED,
        options: [] as ConnectorDestinationOption[],
      },
      connectorReadiness,
      destination: {
        configured: Boolean(persisted?.destination && persisted.destinationSavedAt),
        value: persisted?.destination ?? "",
        savedAt: persisted?.destinationSavedAt ?? null,
      },
      sharingReadiness: this.sharingReadinessView(persisted, connectorReadiness),
    };
  }

  select(input: { connectionId: string; connector: SharingConnector }) {
    const connection = this.options.host.listAgentConnectionRecords()
      .find((record) => record.id === input.connectionId && record.kind === "supported-agent");
    if (!connection) throw new Error("Sharing requires a Supported Agent Connection");
    if (!SHARING_AGENT_ADAPTERS.has(connection.adapter)) {
      throw new Error(`${connection.label} is Conversation-only and cannot be selected for Sharing connectors`);
    }
    this.options.host.selectSharingConfiguration(input);
    return this.view();
  }

  async discover() {
    const { persisted, connection, key } = this.requireSelection();
    try {
      const result = await this.options.adapter.discover({ connection, connector: persisted.connector });
      this.discovery.set(key, {
        status: "ready",
        detail: result.detail,
        remediation: "",
        options: result.options,
      });
    } catch (error) {
      const detail = this.errorMessage(error);
      this.discovery.set(key, {
        status: "failed",
        detail,
        remediation: this.connectorRemediation(
          connection,
          persisted.connector,
          "discover targets again",
          detail,
        ),
        options: [],
      });
    }
    return this.view();
  }

  async probe() {
    const { persisted, connection, key } = this.requireSelection();
    try {
      const result = await this.options.adapter.probe({ connection, connector: persisted.connector });
      this.readiness.set(key, { status: "ready", detail: result.detail, remediation: "" });
    } catch (error) {
      const detail = this.errorMessage(error);
      this.readiness.set(key, {
        status: "failed",
        detail,
        remediation: this.connectorRemediation(
          connection,
          persisted.connector,
          "test connector access again",
          detail,
        ),
      });
    }
    return this.view();
  }

  saveDestination(input: { destination: string }) {
    const { persisted, key } = this.requireSelection();
    if (this.readiness.get(key)?.status !== "ready") {
      throw new Error("Test connector access before saving a Share Destination");
    }
    const destination = input.destination.trim();
    const saved = this.options.host.saveShareDestination({
      connectionId: persisted.connectionId,
      connector: persisted.connector,
      destination,
    });
    const readBack = this.options.host.getSharingConfiguration();
    if (
      !readBack || readBack.connectionId !== saved.connectionId ||
      readBack.connector !== saved.connector || readBack.destination !== destination ||
      !readBack.destinationSavedAt
    ) {
      throw new Error("Share Destination was not read back exactly; save it again");
    }
    return this.view();
  }

  async testShare(input: { actionId: string; duplicateConfirmed: boolean }) {
    const { persisted, connection, key } = this.requireSelection();
    if (!persisted.destination || !persisted.destinationSavedAt) {
      throw new Error("Save and read back an explicit Share Destination before sending a Test Share");
    }
    const actionIdentity = this.actionIdentity(persisted);
    const replay = this.options.host.getSharingTestAction(input.actionId);
    if (replay) {
      if (
        replay.connectionId !== actionIdentity.connectionId ||
        replay.connector !== actionIdentity.connector || replay.destination !== actionIdentity.destination ||
        replay.contentSha256 !== TEST_SHARE_SHA256 ||
        replay.duplicateConfirmed !== input.duplicateConfirmed
      ) {
        throw new Error("Test Share action id is already bound to a different immutable snapshot");
      }
      return this.view();
    }
    if (this.readiness.get(key)?.status !== "ready") {
      throw new Error("Prove Connector Readiness before sending a Test Share");
    }
    const latest = this.options.host.latestSharingTestAction(actionIdentity);
    if (latest?.status === "unknown" || latest?.status === "pending") {
      throw new Error(`Test Share action ${latest.id} has an Unknown Outcome; reconcile or abandon it before retrying`);
    }
    if (this.options.host.hasVerifiedSharingTestAction(actionIdentity) && !input.duplicateConfirmed) {
      throw new Error("A verified Test Share already exists for this destination; confirm the duplicate external write to continue");
    }

    const begun = this.options.host.beginSharingTestAction({
      id: input.actionId,
      ...actionIdentity,
      connectionAdapter: connection.adapter,
      connectionLabel: connection.label,
      contentSha256: TEST_SHARE_SHA256,
      duplicateConfirmed: input.duplicateConfirmed,
    });
    if (!begun.created) return this.view();
    const action = begun.action;
    let provisional: SharingReceipt | undefined;
    try {
      provisional = await this.options.adapter.testShare({
        connection,
        connector: persisted.connector,
        destination: persisted.destination,
        content: YULU_TEST_SHARE_CONTENT,
      });
      this.assertReceipt(provisional, persisted.destination);
      const verified = await this.options.adapter.verifyReceipt({
        connection,
        connector: persisted.connector,
        destination: persisted.destination,
        content: YULU_TEST_SHARE_CONTENT,
        receipt: provisional,
      });
      this.assertReceipt(verified, persisted.destination, provisional);
      this.options.host.markSharingTestActionVerified(action.id, {
        receiptId: verified.receiptId,
        receiptUrl: verified.receiptUrl,
        detail: "Connector read-back matched the exact Test Share destination, content, and receipt",
      });
    } catch (error) {
      const detail = this.errorMessage(error);
      if (error instanceof SharingConnectorUnknownOutcomeError || provisional) {
        this.options.host.markSharingTestActionUnknown(action.id, {
          detail,
          receiptId: provisional?.receiptId,
          receiptUrl: provisional?.receiptUrl,
        });
      } else {
        this.options.host.markSharingTestActionFailed(action.id, detail);
      }
    }
    return this.view();
  }

  adoptionEvidence(): {
    kind: "sharing-test-share";
    reference: string;
    snapshot: SharingCapabilityEvidenceSnapshot;
  } {
    const { persisted, connection, key } = this.requireSelection();
    const readiness = this.sharingReadinessView(
      persisted,
      this.readiness.get(key) ?? { ...UNTESTED },
    );
    if (
      readiness.status !== "ready" || !readiness.actionId || !readiness.receipt ||
      !persisted.destination || !persisted.destinationSavedAt
    ) {
      throw new Error("Sharing adoption requires a current verified Test Share receipt");
    }
    const adapter = connection.adapter;
    if (adapter !== "codex" && adapter !== "claude-code") {
      throw new Error("Sharing adoption requires a Supported Agent with an exact connector boundary");
    }
    const action = this.options.host.getSharingTestAction(readiness.actionId);
    if (
      !action || action.status !== "verified" || action.connectionId !== persisted.connectionId ||
      action.connectionAdapter !== adapter || action.connector !== persisted.connector ||
      action.connectionRevision !== agentConnectionRevision(connection) ||
      action.destination !== persisted.destination || action.contentSha256 !== TEST_SHARE_SHA256 ||
      (action.receiptId ?? "") !== readiness.receipt.id ||
      (action.receiptUrl ?? "") !== readiness.receipt.url
    ) {
      throw new Error("Sharing adoption requires an exact verified Test Share receipt");
    }
    return {
      kind: "sharing-test-share" as const,
      reference: `sharing-test-share:${action.id}`,
      snapshot: {
        capability: "sharing" as const,
        connectionId: persisted.connectionId,
        adapter,
        connectionRevision: agentConnectionRevision(connection),
        connector: persisted.connector,
        destination: persisted.destination,
        destinationSavedAt: persisted.destinationSavedAt,
        actionId: action.id,
        contentSha256: action.contentSha256,
        receiptId: readiness.receipt.id,
        receiptUrl: readiness.receipt.url,
        verifiedAt: readiness.receipt.verifiedAt,
      },
    };
  }

  recordingShareView(input: { recordingStem: string; summary: string }) {
    const persisted = this.options.host.getSharingConfiguration();
    const connection = persisted
      ? this.options.host.listAgentConnectionRecords().find((record) => (
          record.id === persisted.connectionId && record.kind === "supported-agent"
        ))
      : undefined;
    const summarySha256 = createHash("sha256").update(input.summary).digest("hex");
    const snapshot = persisted?.destination && persisted.destinationSavedAt && connection
      ? this.recordingSnapshot({
          recordingStem: input.recordingStem,
          summary: input.summary,
          summarySha256,
          connection,
          connector: persisted.connector,
          destination: persisted.destination,
        })
      : null;
    const connectorReadiness = persisted && connection
      ? this.readiness.get(this.stateKey(connection, persisted.connector)) ?? { ...UNTESTED }
      : { ...UNTESTED };
    const readiness = this.sharingReadinessView(persisted, connectorReadiness);
    const latest = snapshot ? this.options.host.latestRecordingShareAction(snapshot.hash) : null;
    const duplicateWarningRequired = snapshot
      ? this.options.host.hasVerifiedRecordingShareAction(snapshot.hash)
      : false;
    const latestAction = latest ? {
      id: latest.id,
      status: latest.status,
      receiptId: latest.receiptId ?? "",
      receiptUrl: latest.receiptUrl ?? "",
      detail: latest.detail,
    } : null;
    if (!input.recordingStem.trim() || !input.summary.trim()) {
      return {
        status: "unavailable" as const,
        detail: "A current non-empty recording summary is required",
        remediation: "Generate a current summary before sharing.",
        snapshot,
        latestAction,
        duplicateWarningRequired,
      };
    }
    if (latest?.status === "pending" || latest?.status === "unknown") {
      return {
        status: "unknown" as const,
        detail: latest.detail || "Share Action receipt verification is incomplete",
        remediation: `Do not retry. Reconcile or abandon Share Action ${latest.id} before creating another attempt.`,
        snapshot,
        latestAction,
        duplicateWarningRequired,
      };
    }
    if (!snapshot || readiness.status !== "ready") {
      return {
        status: "unavailable" as const,
        detail: readiness.detail,
        remediation: readiness.remediation || "Return to Settings > Sharing and prove the selected destination.",
        snapshot,
        latestAction,
        duplicateWarningRequired,
      };
    }
    return {
      status: "ready" as const,
      detail: "Ready for a fresh explicit Share Action",
      remediation: "",
      snapshot,
      latestAction,
      duplicateWarningRequired,
    };
  }

  async shareRecording(input: {
    actionId: string;
    recordingStem: string;
    summary: string;
    snapshotHash: string;
    duplicateConfirmed: boolean;
  }) {
    const preview = this.recordingShareView(input);
    if (!preview.snapshot || preview.snapshot.hash !== input.snapshotHash) {
      throw new Error("Share Action confirmation no longer matches the current immutable snapshot");
    }
    const replay = this.options.host.getRecordingShareAction(input.actionId);
    if (replay) {
      if (
        replay.recordingStem !== input.recordingStem || replay.summary !== input.summary ||
        replay.snapshotSha256 !== input.snapshotHash || replay.duplicateConfirmed !== input.duplicateConfirmed
      ) {
        throw new Error("Share Action id is already bound to a different immutable snapshot");
      }
      return this.recordingShareView(input);
    }
    if (preview.status === "unknown") {
      throw new Error(`Share Action ${preview.latestAction?.id ?? ""} has an Unknown Outcome; reconcile or abandon it before retrying`);
    }
    if (preview.status !== "ready") {
      throw new Error(preview.detail || "Prove Sharing Readiness before creating a Share Action");
    }
    if (preview.duplicateWarningRequired && !input.duplicateConfirmed) {
      throw new Error("This summary was already delivered to the same destination; confirm the duplicate external write to continue");
    }
    const begun = this.options.host.beginRecordingShareAction({
      id: input.actionId,
      recordingStem: preview.snapshot.recordingStem,
      summary: preview.snapshot.summary,
      summarySha256: preview.snapshot.summarySha256,
      snapshotSha256: preview.snapshot.hash,
      connectionId: preview.snapshot.connection.id,
      connectionAdapter: preview.snapshot.connection.adapter,
      connectionLabel: preview.snapshot.connection.label,
      connectionUpdatedAt: preview.snapshot.connection.updatedAt,
      connector: preview.snapshot.connector,
      destination: preview.snapshot.destination,
      duplicateConfirmed: input.duplicateConfirmed,
    });
    if (!begun.created) return this.recordingShareView(input);
    let provisional: SharingReceipt | undefined;
    try {
      const connection = this.options.host.listAgentConnectionRecords()
        .find((record) => record.id === preview.snapshot!.connection.id)!;
      provisional = await this.options.adapter.share({
        connection,
        connector: preview.snapshot.connector,
        destination: preview.snapshot.destination,
        content: preview.snapshot.summary,
      });
      this.assertReceipt(provisional, preview.snapshot.destination);
      const verified = await this.options.adapter.verifyReceipt({
        connection,
        connector: preview.snapshot.connector,
        destination: preview.snapshot.destination,
        content: preview.snapshot.summary,
        receipt: provisional,
      });
      this.assertReceipt(verified, preview.snapshot.destination, provisional);
      this.options.host.markRecordingShareActionVerified(begun.action.id, {
        receiptId: verified.receiptId,
        receiptUrl: verified.receiptUrl,
        detail: "Connector read-back matched the exact Share Action snapshot and receipt",
      });
    } catch (error) {
      const detail = this.errorMessage(error);
      if (error instanceof SharingConnectorUnknownOutcomeError || provisional) {
        this.options.host.markRecordingShareActionUnknown(begun.action.id, {
          detail,
          receiptId: provisional?.receiptId,
          receiptUrl: provisional?.receiptUrl,
        });
      } else {
        this.options.host.markRecordingShareActionFailed(begun.action.id, detail);
      }
    }
    return this.recordingShareView(input);
  }

  abandonRecordingUnknown(input: { actionId: string }) {
    const action = this.options.host.getRecordingShareAction(input.actionId);
    if (!action || action.status !== "unknown") {
      throw new Error("Only an Unknown Outcome Share Action can be abandoned");
    }
    this.options.host.abandonRecordingShareAction(action.id);
    return this.recordingShareView({
      recordingStem: action.recordingStem,
      summary: action.summary,
    });
  }

  async reconcileUnknown(input: { actionId: string; receiptId: string; receiptUrl: string }) {
    const { persisted, connection } = this.requireSelection();
    if (!persisted.destination || !persisted.destinationSavedAt) {
      throw new Error("Save and read back an explicit Share Destination before reconciling a Test Share");
    }
    const action = this.requireCurrentUnknown(input.actionId, persisted);
    const receipt = {
      destination: persisted.destination,
      receiptId: input.receiptId.trim() || action.receiptId || "",
      receiptUrl: input.receiptUrl.trim() || action.receiptUrl || "",
    };
    if (!receipt.receiptId && !receipt.receiptUrl) {
      throw new Error("Enter an external receipt ID or URL before reconciling this Unknown Outcome");
    }
    const verified = await this.options.adapter.verifyReceipt({
      connection,
      connector: persisted.connector,
      destination: persisted.destination,
      content: YULU_TEST_SHARE_CONTENT,
      receipt,
    });
    this.assertReceipt(verified, persisted.destination, receipt);
    this.options.host.markSharingTestActionVerified(action.id, {
      receiptId: verified.receiptId,
      receiptUrl: verified.receiptUrl,
      detail: "User-supplied receipt reconciled by exact connector read-back",
    });
    return this.view();
  }

  abandonUnknown(input: { actionId: string }) {
    const { persisted } = this.requireSelection();
    this.requireCurrentUnknown(input.actionId, persisted);
    this.options.host.abandonSharingTestAction(input.actionId);
    return this.view();
  }

  private sharingReadinessView(
    persisted: PersistedSharingConfiguration | null,
    connectorReadiness: OperationState,
  ): SharingReadinessView {
    if (!persisted?.destination || !persisted.destinationSavedAt) return this.untestedSharingReadiness(false);
    const identity = this.actionIdentity(persisted);
    const duplicateWarningRequired = this.options.host.hasVerifiedSharingTestAction(identity);
    const action = this.options.host.latestSharingTestAction(identity);
    if (!action || action.status === "abandoned") {
      return this.untestedSharingReadiness(duplicateWarningRequired);
    }
    const actionView = {
      id: action.id,
      receiptId: action.receiptId ?? "",
      receiptUrl: action.receiptUrl ?? "",
    };
    if (action.status === "unknown" || action.status === "pending") {
      return {
        status: "unknown",
        detail: action.detail || "Test Share receipt verification is incomplete",
        remediation: `Do not retry. Read back the external receipt, then reconcile or abandon Test Share action ${action.id}.`,
        receipt: null,
        actionId: action.id,
        action: actionView,
        duplicateWarningRequired,
      };
    }
    if (action.status === "failed") {
      const connection = this.options.host.listAgentConnectionRecords()
        .find((candidate) => candidate.id === action.connectionId);
      return {
        status: "failed",
        detail: action.detail,
        remediation: connection
          ? this.connectorRemediation(
              connection,
              action.connector,
              "start a new Test Share",
              action.detail,
            )
          : "Restore the selected Agent Connection, then return to Settings > Sharing and start a new Test Share.",
        receipt: null,
        actionId: action.id,
        action: actionView,
        duplicateWarningRequired,
      };
    }
    const selectedConnection = this.options.host.listAgentConnectionRecords()
      .find((candidate) => candidate.id === action.connectionId);
    if (
      !selectedConnection ||
      agentConnectionRevision(selectedConnection) !== action.connectionRevision
    ) {
      return {
        status: "untested",
        detail: "The selected Agent Connection changed after this Test Share was verified",
        remediation: "Prove current Connector Readiness and send a fresh meeting-free Test Share.",
        receipt: null,
        actionId: action.id,
        action: actionView,
        duplicateWarningRequired,
      };
    }
    if (connectorReadiness.status !== "ready") {
      return {
        status: connectorReadiness.status === "failed" ? "failed" : "untested",
        detail: connectorReadiness.status === "failed"
          ? `Current Connector Readiness failed: ${connectorReadiness.detail}`
          : "Re-prove current Connector Readiness before relying on the verified Test Share",
        remediation: connectorReadiness.remediation,
        receipt: null,
        actionId: action.id,
        action: actionView,
        duplicateWarningRequired,
      };
    }
    const projected = persisted.testReceipt;
    if (!projected || projected.id !== actionView.receiptId || projected.url !== actionView.receiptUrl) {
      return {
        status: "failed",
        detail: "The verified Test Share receipt was not read back from the saved configuration",
        remediation: "Return to Settings > Sharing and reconcile the verified receipt before relying on Sharing Readiness.",
        receipt: null,
        actionId: action.id,
        action: actionView,
        duplicateWarningRequired,
      };
    }
    return {
      status: "ready",
      detail: `Connector read-back verified Test Share receipt at ${projected.verifiedAt}`,
      remediation: "",
      receipt: projected,
      actionId: action.id,
      action: actionView,
      duplicateWarningRequired,
    };
  }

  private untestedSharingReadiness(duplicateWarningRequired: boolean): SharingReadinessView {
    return {
      status: "untested",
      detail: "Send and verify a meeting-free Test Share",
      remediation: "",
      receipt: null,
      actionId: null,
      action: null,
      duplicateWarningRequired,
    };
  }

  private requireCurrentUnknown(actionId: string, persisted: PersistedSharingConfiguration) {
    const action = this.options.host.getSharingTestAction(actionId);
    if (
      !action || action.status !== "unknown" || !persisted.destination ||
      action.connectionId !== persisted.connectionId || action.connector !== persisted.connector ||
      action.destination !== persisted.destination || action.contentSha256 !== TEST_SHARE_SHA256
    ) {
      throw new Error("Only the current Share Destination's Unknown Outcome can be reconciled or abandoned");
    }
    return action;
  }

  private requireSelection() {
    const persisted = this.options.host.getSharingConfiguration();
    if (!persisted) throw new Error("Select a Supported Agent Connection and connector first");
    const connection = this.options.host.listAgentConnectionRecords()
      .find((record) => record.id === persisted.connectionId && record.kind === "supported-agent");
    if (!connection) throw new Error("The selected Supported Agent Connection is unavailable");
    if (!SHARING_AGENT_ADAPTERS.has(connection.adapter)) {
      throw new Error(`${connection.label} is Conversation-only and cannot be selected for Sharing connectors`);
    }
    return { persisted, connection, key: this.stateKey(connection, persisted.connector) };
  }

  private actionIdentity(persisted: PersistedSharingConfiguration) {
    if (!persisted.destination) throw new Error("A saved Share Destination is required");
    return {
      connectionId: persisted.connectionId,
      connector: persisted.connector,
      destination: persisted.destination,
    };
  }

  private recordingSnapshot(input: {
    recordingStem: string;
    summary: string;
    summarySha256: string;
    connection: PersistedAgentConnection;
    connector: SharingConnector;
    destination: string;
  }) {
    const identity = {
      recordingStem: input.recordingStem,
      summary: input.summary,
      summarySha256: input.summarySha256,
      connection: {
        id: input.connection.id,
        adapter: input.connection.adapter,
        label: input.connection.label,
        updatedAt: input.connection.updatedAt,
      },
      connector: input.connector,
      destination: input.destination,
    };
    return {
      ...identity,
      hash: createHash("sha256").update(JSON.stringify(identity)).digest("hex"),
    };
  }

  private assertReceipt(receipt: SharingReceipt, destination: string, expected?: SharingReceipt) {
    if (
      receipt.destination.trim() !== destination ||
      (!receipt.receiptId.trim() && !receipt.receiptUrl.trim()) ||
      (expected && (
        receipt.receiptId.trim() !== expected.receiptId.trim() ||
        receipt.receiptUrl.trim() !== expected.receiptUrl.trim()
      ))
    ) {
      throw new SharingConnectorUnknownOutcomeError(
        "Connector read-back did not match the saved Test Share destination and receipt",
      );
    }
  }

  private stateKey(connection: PersistedAgentConnection, connector: SharingConnector) {
    return `${connection.id}:${agentConnectionRevision(connection)}:${connector}`;
  }

  private connectorRemediation(
    connection: PersistedAgentConnection,
    connector: SharingConnector,
    retryAction: string,
    detail: string,
  ) {
    const executable = String(connection.settings.executablePath ?? connection.adapter).trim();
    if (/guard denied (?:an unauthorized tool call|before any connector write was authorized)/i.test(detail)) {
      return `Return to Settings > Sharing and ${retryAction}; if ${connection.label} repeats an unauthorized tool call, update that Agent before retrying.`;
    }
    if (/(?:sharing guard|pre-tool authorization|hook did not|hooks? (?:is|are) (?:unavailable|unsupported))/i.test(detail)) {
      return connection.adapter === "codex"
        ? `Run "${executable} features list" and update Codex until it reports "hooks stable true", then return to Settings > Sharing and ${retryAction}.`
        : `Update ${connection.label} to a version with PreToolUse hooks enabled, then return to Settings > Sharing and ${retryAction}.`;
    }
    if (/(?:not configured|not found|missing|unavailable|no executable)/i.test(detail)) {
      return `Run "${executable} mcp" and add the ${connector} connector to ${connection.label}, then return to Settings > Sharing and ${retryAction}.`;
    }
    if (/(?:\bnetwork\b|\bdns\b|\bsocket\b|\bconnect(?:ion)? (?:failed|refused)|timed? out|timeout)/i.test(detail)) {
      return `Restore network access for ${connection.label}'s ${connector} connector, then return to Settings > Sharing and ${retryAction}.`;
    }
    return `Open ${connection.label}'s ${connector} connector authorization and reauthorize its account, then return to Settings > Sharing and ${retryAction}.`;
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
