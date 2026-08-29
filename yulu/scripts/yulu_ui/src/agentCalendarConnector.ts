import { createHash, randomUUID } from "node:crypto";
import { runAgentCliCommand, type AgentCliRunResult } from "./agentCliRunner.js";
import type { AgentRuntime } from "./agentRuntime.js";
import type { HostStore, PersistedAgentConnection } from "./hostStore.js";
import { connectorMatches, extractConnectorToolCalls, parseObject } from "./sharingConnector.js";

export type AgentCalendarConnectorFailure =
  | "runtime"
  | "connector"
  | "authorization"
  | "external_service";

export type AgentCalendarConnectorFailureOrigin =
  | "agent_runtime"
  | "connector_configuration"
  | "connector_call";

export class AgentCalendarConnectorProbeError extends Error {
  constructor(
    public readonly failure: AgentCalendarConnectorFailure,
    message: string,
    public readonly origin: AgentCalendarConnectorFailureOrigin = failure === "runtime"
      ? "agent_runtime"
      : failure === "connector"
        ? "connector_configuration"
        : "connector_call",
  ) {
    super(message);
    this.name = "AgentCalendarConnectorProbeError";
  }
}

export interface AgentCalendarConnectorProbeResult {
  detail: string;
  operation: string;
  testedAt: string;
}

export interface AgentCalendarConnectorAdapter {
  probe(input: {
    connection: PersistedAgentConnection;
    connector: string;
  }): Promise<AgentCalendarConnectorProbeResult>;
}

type ConnectorRunner = (input: Parameters<typeof runAgentCliCommand>[0]) => Promise<AgentCliRunResult>;

const CALENDAR_READ_TOOLS = [
  "list_calendars",
  "get_calendars",
  "list_events",
  "get_events",
  "search_events",
  "calendar_list",
  "events_list",
] as const;

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function connectorRuntime(connection: PersistedAgentConnection, workDir: string): AgentRuntime {
  const executable = boundedString(connection.settings.executablePath, 1_000);
  if (!executable) {
    throw new AgentCalendarConnectorProbeError("runtime", `${connection.label} has no executable path`);
  }
  const command = connection.adapter === "codex"
    ? [executable, "exec", "--sandbox", "read-only", "--skip-git-repo-check"]
    : connection.adapter === "claude-code"
      ? [executable, "--print", "--output-format", "stream-json", "--verbose"]
      : [];
  const provider = connection.adapter === "claude-code" ? "claude" : connection.adapter;
  if (command.length === 0 || !["codex", "claude"].includes(provider)) {
    throw new AgentCalendarConnectorProbeError(
      "runtime",
      `${connection.label} does not have a supported read-only Calendar connector adapter`,
    );
  }
  return {
    provider: provider as AgentRuntime["provider"],
    label: connection.label,
    source: "configured-command",
    command,
    cwd: workDir,
    disabledReason: null,
  };
}

function failureFromDetail(
  detail: string,
  origin: "agent_runtime" | "connector_call",
): AgentCalendarConnectorFailure {
  if (/(?:unauthori[sz]ed|forbidden|oauth|login required|not authenticated|permission denied|access denied)/i.test(detail)) {
    return "authorization";
  }
  if (origin === "connector_call" && /(?:service unavailable|\b5\d\d\b|rate limit|network|\bdns\b|connection (?:failed|refused)|timed? out|timeout)/i.test(detail)) {
    return "external_service";
  }
  if (/(?:connector|mcp server).*(?:not configured|not found|missing|unavailable)|no (?:matching )?calendar (?:connector|tool)/i.test(detail)) {
    return "connector";
  }
  return "runtime";
}

export class AgentCalendarConnectorRuntimeAdapter implements AgentCalendarConnectorAdapter {
  private readonly run: ConnectorRunner;
  private readonly now: () => string;

  constructor(private readonly options: {
    scriptDir: string;
    configDir: string;
    run?: ConnectorRunner;
    now?: () => string;
  }) {
    this.run = options.run ?? runAgentCliCommand;
    this.now = options.now ?? (() => new Date().toISOString());
  }

  async probe(input: {
    connection: PersistedAgentConnection;
    connector: string;
  }): Promise<AgentCalendarConnectorProbeResult> {
    const runtime = connectorRuntime(input.connection, this.options.scriptDir);
    let result: AgentCliRunResult;
    try {
      result = await this.run({
        runtime,
        scriptDir: this.options.scriptDir,
        configDir: this.options.configDir,
        timeoutMs: 30_000,
        yuluSessionId: randomUUID(),
        connectorToolPolicy: {
          connector: input.connector,
          allowedTools: CALENDAR_READ_TOOLS,
          readGuard: {
            maxResults: 1,
            maxWindowHours: 24,
            timeWindowTools: ["list_events", "get_events", "search_events", "events_list"],
          },
        },
        prompt: [
          `Run one bounded, read-only calendar access probe through only the configured "${input.connector}" connector.`,
          "Read at most one calendar or one event. An empty result is successful access.",
          "Set result limit 1. For event list/search tools, set an explicit UTC start/end window no wider than 24-hour.",
          "Do not create, update, delete, send, or write any calendar, event, attendee, or external content.",
          `Return only JSON: {"status":"ready","connector":"${input.connector}","operation":"exact tool name","detail":"what read access was verified"}.`,
        ].join("\n"),
      });
    } catch (error) {
      if (error instanceof AgentCalendarConnectorProbeError) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      const failure = failureFromDetail(detail, "agent_runtime");
      throw new AgentCalendarConnectorProbeError(
        failure,
        detail,
        failure === "connector" ? "connector_configuration" : "agent_runtime",
      );
    }
    const calls = extractConnectorToolCalls(result.rawStdout ?? "");
    const foreign = calls.find((call) => !connectorMatches(call.connector, input.connector));
    if (foreign) {
      throw new AgentCalendarConnectorProbeError(
        "runtime",
        `Agent attempted connector ${foreign.connector} outside selected connector ${input.connector}`,
      );
    }
    const selected = calls.filter((call) => connectorMatches(call.connector, input.connector));
    const unexpected = selected.find((call) => !CALENDAR_READ_TOOLS.includes(
      call.name as typeof CALENDAR_READ_TOOLS[number],
    ));
    if (unexpected) {
      throw new AgentCalendarConnectorProbeError(
        "runtime",
        `Read-only guard rejected unexpected Calendar connector tool ${unexpected.name}`,
      );
    }
    if (selected.length > 1) {
      throw new AgentCalendarConnectorProbeError(
        "runtime",
        `Agent runtime attempted ${selected.length} Calendar connector operations instead of exactly one`,
      );
    }
    const observed = selected[0];
    if (observed?.transportError === true) {
      const detail = observed.resultText || `Connector ${input.connector} read operation failed`;
      throw new AgentCalendarConnectorProbeError(failureFromDetail(detail, "connector_call"), detail, "connector_call");
    }
    if (result.code !== 0 || !result.stdout.trim()) {
      const detail = (result.stderr || result.stdout || "Agent runtime ended before Connector Readiness was proven").trim();
      const failure = failureFromDetail(detail, "agent_runtime");
      throw new AgentCalendarConnectorProbeError(
        failure,
        detail,
        failure === "connector" ? "connector_configuration" : "agent_runtime",
      );
    }
    if (!observed) {
      throw new AgentCalendarConnectorProbeError(
        "runtime",
        `Agent runtime returned no auditable read operation for connector ${input.connector}`,
      );
    }
    if (observed.transportError !== false) {
      throw new AgentCalendarConnectorProbeError(
        "runtime",
        `Agent runtime returned no terminal tool result for connector ${input.connector}`,
      );
    }
    let value: Record<string, unknown>;
    try {
      value = parseObject(result.stdout);
    } catch (error) {
      throw new AgentCalendarConnectorProbeError("runtime", (error as Error).message);
    }
    const operation = boundedString(value.operation, 100);
    if (value.status !== "ready" || value.connector !== input.connector || operation !== observed.name) {
      throw new AgentCalendarConnectorProbeError(
        "runtime",
        boundedString(value.detail ?? value.error, 1_000) || "Agent runtime returned mismatched Calendar connector evidence",
      );
    }
    return {
      detail: boundedString(value.detail, 1_000) || `${input.connector} calendar read access verified`,
      operation,
      testedAt: this.now(),
    };
  }
}

interface Selection {
  connectionId: string;
  connector: string;
}

interface ReadyEvidence {
  capability: "agent-calendar-connector";
  connectionId: string;
  adapter: "codex" | "claude-code";
  connector: string;
  connectionRevision: string;
  operation: string;
  testedAt: string;
}

type Readiness = {
  status: "untested" | "ready" | "failed";
  failure: AgentCalendarConnectorFailure | null;
  detail: string;
  remediation: string;
  evidence: ReadyEvidence | null;
};

const UNTESTED: Readiness = {
  status: "untested",
  failure: null,
  detail: "The selected Agent Calendar Connector has not been tested in this Host process",
  remediation: "Run the read-only Connector Readiness test.",
  evidence: null,
};

const CONNECTOR_ID_RE = /^[a-z0-9][a-z0-9_.-]{0,99}$/;
const SUPPORTED_ADAPTERS = new Set(["codex", "claude-code"]);

function connectionRevision(connection: PersistedAgentConnection): string {
  return createHash("sha256").update(JSON.stringify({
    id: connection.id,
    adapter: connection.adapter,
    lifecycle: connection.lifecycle,
    executablePath: boundedString(connection.settings.executablePath, 1_000),
    updatedAt: connection.updatedAt,
  })).digest("hex");
}

export class AgentCalendarConnector {
  private readonly readiness = new Map<string, Readiness>();

  constructor(private readonly options: {
    host: HostStore;
    adapter: AgentCalendarConnectorAdapter;
  }) {}

  view() {
    const connections = this.options.host.listAgentConnectionRecords()
      .filter((connection) => connection.kind === "supported-agent" && SUPPORTED_ADAPTERS.has(connection.adapter))
      .map(({ id, adapter, label }) => ({ id, adapter, label }));
    const current = this.currentSelection();
    return {
      connections,
      selection: current?.selection ?? null,
      readiness: current ? this.readiness.get(current.key) ?? { ...UNTESTED } : { ...UNTESTED },
    };
  }

  select(input: Selection) {
    const connection = this.options.host.listAgentConnectionRecords().find((candidate) =>
      candidate.id === input.connectionId && candidate.kind === "supported-agent"
    );
    if (!connection) throw new Error("Agent Calendar Connector requires a Supported Agent Connection");
    if (!SUPPORTED_ADAPTERS.has(connection.adapter)) {
      throw new Error(`${connection.label} does not provide the required read-only connector authorization boundary`);
    }
    const connector = input.connector.trim();
    if (!CONNECTOR_ID_RE.test(connector)) throw new Error("Agent Calendar Connector name is invalid");
    this.options.host.selectAgentCalendarConnector({ connectionId: connection.id, connector });
    return this.view();
  }

  async probe() {
    const current = this.currentSelection();
    if (!current) throw new Error("Select a Supported Agent Connection and Calendar connector first");
    try {
      const result = await this.options.adapter.probe({
        connection: current.connection,
        connector: current.selection.connector,
      });
      this.readiness.set(current.key, {
        status: "ready",
        failure: null,
        detail: result.detail,
        remediation: "",
        evidence: {
          capability: "agent-calendar-connector",
          connectionId: current.connection.id,
          adapter: current.connection.adapter as ReadyEvidence["adapter"],
          connector: current.selection.connector,
          connectionRevision: current.revision,
          operation: result.operation,
          testedAt: result.testedAt,
        },
      });
    } catch (error) {
      const failure = error instanceof AgentCalendarConnectorProbeError ? error.failure : "runtime";
      const origin = error instanceof AgentCalendarConnectorProbeError ? error.origin : "agent_runtime";
      const detail = error instanceof Error ? error.message : String(error);
      this.readiness.set(current.key, {
        status: "failed",
        failure,
        detail,
        remediation: this.remediation(current.connection, current.selection.connector, failure, origin),
        evidence: null,
      });
    }
    return this.view();
  }

  adoptionEvidence() {
    const current = this.currentSelection();
    const evidence = current ? this.readiness.get(current.key)?.evidence : null;
    if (!current || !evidence) {
      throw new Error("Adoption requires current Agent Calendar Connector Readiness");
    }
    return {
      kind: "agent-calendar-connector-probe",
      reference: `agent-calendar-connector:${evidence.connectionRevision}:${evidence.testedAt}`,
      snapshot: evidence,
    };
  }

  private remediation(
    connection: PersistedAgentConnection,
    connector: string,
    failure: AgentCalendarConnectorFailure,
    origin: AgentCalendarConnectorFailureOrigin,
  ) {
    const executable = String(connection.settings.executablePath ?? connection.adapter).trim();
    if (failure === "runtime") {
      return `Repair or update ${connection.label} at ${executable}, then return and run the read-only Calendar connector test again.`;
    }
    if (failure === "connector") {
      return `Open ${connection.label} connector settings and configure "${connector}", then return and test Connector Readiness again.`;
    }
    if (failure === "authorization") {
      if (origin === "agent_runtime") {
        return `Reauthenticate ${connection.label} through its native flow, then return and test again. Yulu does not access or store its OAuth token.`;
      }
      return `Reauthorize "${connector}" through ${connection.label}'s native flow, then return and test again. Yulu does not access or store its OAuth token.`;
    }
    return `Restore access to the external calendar service used by "${connector}", then return and test it through ${connection.label} again.`;
  }

  private currentSelection() {
    const selection = this.options.host.getAgentCalendarConnectorSelection();
    if (!selection) return null;
    const connection = this.options.host.listAgentConnectionRecords().find((candidate) =>
      candidate.id === selection.connectionId && candidate.kind === "supported-agent"
    );
    if (!connection) return null;
    const revision = connectionRevision(connection);
    return {
      selection: { connectionId: selection.connectionId, connector: selection.connector },
      connection,
      revision,
      key: `${connection.id}:${revision}:${selection.connector}`,
    };
  }
}
