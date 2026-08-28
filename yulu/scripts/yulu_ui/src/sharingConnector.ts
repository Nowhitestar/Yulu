import { randomUUID } from "node:crypto";
import {
  runAgentCliCommand,
  type AgentCliRunResult,
  type ConnectorToolPolicy,
} from "./agentCliRunner.js";
import type { AgentRuntime } from "./agentRuntime.js";
import type { PersistedAgentConnection, SharingConnector } from "./hostStore.js";
import {
  SharingConnectorUnknownOutcomeError,
  YULU_TEST_SHARE_CONTENT,
  type ConnectorDestinationOption,
  type SharingConnectorAdapter,
} from "./sharingConfiguration.js";

type ConnectorRunner = (input: Parameters<typeof runAgentCliCommand>[0]) => Promise<AgentCliRunResult>;
interface AuditedConnectorToolCall {
  connector: string;
  name: string;
  argumentsText: string;
  resultText: string;
  success: boolean;
}

export { SharingConnectorUnknownOutcomeError };

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function parseObject(output: string): Record<string, unknown> {
  const trimmed = output.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)?.[1] ?? trimmed;
  try {
    return asRecord(JSON.parse(fenced));
  } catch {
    throw new Error("Agent connector returned invalid JSON");
  }
}

function boundedString(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function boundedIdentifier(value: unknown, max: number): string {
  if (typeof value === "string") return value.trim().slice(0, max);
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? String(value).slice(0, max)
    : "";
}

function serialized(value: unknown): string {
  if (typeof value === "string") return value;
  try { return JSON.stringify(value ?? ""); }
  catch { return ""; }
}

function parsedJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) return value;
  try { return JSON.parse(trimmed) as unknown; }
  catch { return value; }
}

function decodedValue(text: string): unknown {
  let value: unknown = parsedJson(text);
  for (let depth = 0; depth < 3 && typeof value === "string"; depth += 1) {
    const next = parsedJson(value);
    if (next === value) break;
    value = next;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function notionParentIdentity(value: unknown): { page_id: string } | { data_source_id: string } | null {
  const record = asRecord(decodedChild(value));
  const pageId = boundedString(record.page_id, 500);
  const dataSourceId = boundedString(record.data_source_id, 500);
  if (pageId && !dataSourceId && (record.type === undefined || record.type === "page_id")) {
    return { page_id: pageId };
  }
  if (dataSourceId && !pageId && (record.type === undefined || record.type === "data_source_id")) {
    return { data_source_id: dataSourceId };
  }
  return null;
}

function canonicalNotionDestination(value: string): string | null {
  const identity = notionParentIdentity(value);
  return identity ? canonicalJson(identity) : null;
}

function decodedChild(value: unknown): unknown {
  return typeof value === "string" ? decodedValue(value) : value;
}

function pathValue(value: unknown, path: readonly string[]): { found: boolean; value: unknown } {
  let current = decodedChild(value);
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !(key in current)) {
      return { found: false, value: undefined };
    }
    current = decodedChild((current as Record<string, unknown>)[key]);
  }
  return { found: true, value: current };
}

function firstPathValue(value: unknown, paths: readonly (readonly string[])[]): unknown {
  for (const path of paths) {
    const observed = pathValue(value, path);
    if (observed.found) return observed.value;
  }
  return undefined;
}

function exactIdentifier(value: unknown, expected: string): boolean {
  return (typeof value === "string" && value === expected) ||
    (typeof value === "number" && Number.isSafeInteger(value) && String(value) === expected);
}

function exactZulipDestination(value: unknown, expected: string): boolean {
  const expectedValue = decodedChild(expected);
  if (!expectedValue || typeof expectedValue !== "object" || Array.isArray(expectedValue)) return false;
  const record = asRecord(decodedChild(value));
  const observed = record.type === "stream"
    ? { type: "stream", to: record.to, topic: record.topic }
    : { type: record.type, to: record.to };
  return canonicalJson(observed) === canonicalJson(expectedValue);
}

function exactNotionParent(value: unknown, expected: string): boolean {
  const wanted = notionParentIdentity(expected);
  const observed = notionParentIdentity(value);
  return Boolean(wanted && observed && canonicalJson(observed) === canonicalJson(wanted));
}

function toolResultPayload(value: unknown): unknown {
  const decoded = decodedChild(value);
  if (Array.isArray(decoded)) {
    if (decoded.length !== 1) return undefined;
    const block = asRecord(decoded[0]);
    if (block.type !== "text" || typeof block.text !== "string") return undefined;
    const parsed = decodedChild(block.text);
    return parsed === block.text ? undefined : parsed;
  }
  const record = asRecord(decoded);
  if (record.structuredContent !== undefined) return decodedChild(record.structuredContent);
  if (!Array.isArray(record.content)) return decoded;
  if (record.content.length !== 1) return undefined;
  const block = asRecord(record.content[0]);
  if (block.type !== "text" || typeof block.text !== "string") return undefined;
  const parsed = decodedChild(block.text);
  return parsed === block.text ? undefined : parsed;
}

function exactWriteDestination(value: unknown, connector: SharingConnector, expected: string): boolean {
  const record = asRecord(decodedChild(value));
  return connector === "notion"
    ? exactNotionParent(record.parent, expected)
    : exactZulipDestination(record, expected);
}

function exactReceiptDestination(value: unknown, connector: SharingConnector, expected: string): boolean {
  const payload = toolResultPayload(value);
  if (connector === "notion") {
    const parent = firstPathValue(payload, [
      ["parent"], ["page", "parent"], ["result", "parent"], ["data", "parent"],
    ]);
    return exactNotionParent(parent, expected);
  }
  const root = asRecord(payload);
  const record = [root.message, root.result, root.data]
    .map((candidate) => asRecord(decodedChild(candidate)))
    .find((candidate) => candidate.type !== undefined || candidate.to !== undefined) ?? root;
  return exactZulipDestination(record, expected);
}

function exactWriteContent(value: unknown, connector: SharingConnector, expected: string): boolean {
  const record = asRecord(decodedChild(value));
  if (connector === "notion") {
    const pages = decodedChild(record.pages);
    if (!Array.isArray(pages) || pages.length !== 1) return false;
    const page = asRecord(decodedChild(pages[0]));
    return page.content === expected && contentStrings(record).length === 1;
  }
  return record.content === expected && contentStrings(record).length === 1;
}

function exactReceiptContent(value: unknown, connector: SharingConnector, expected: string): boolean {
  const payload = toolResultPayload(value);
  const paths = connector === "notion"
    ? [["content"], ["page", "content"], ["result", "content"], ["data", "content"]]
    : [["content"], ["message", "content"], ["result", "content"], ["data", "content"]];
  return firstPathValue(payload, paths) === expected;
}

function exactReceiptIdentity(
  value: unknown,
  connector: SharingConnector,
  receiptId: string,
  receiptUrl: string,
): boolean {
  const payload = toolResultPayload(value);
  if (connector === "notion") {
    const pages = pathValue(payload, ["pages"]);
    if (pages.found) {
      if (!Array.isArray(pages.value) || pages.value.length !== 1) return false;
      const page = asRecord(decodedChild(pages.value[0]));
      return (!receiptId || exactIdentifier(page.id, receiptId)) &&
        (!receiptUrl || page.url === receiptUrl);
    }
  }
  const envelopes = connector === "notion" ? ["page", "result", "data"] : ["message", "result", "data"];
  const idPaths = [["id"], ...envelopes.map((key) => [key, "id"] as const)];
  const urlPaths = [["url"], ...envelopes.map((key) => [key, "url"] as const)];
  return (!receiptId || exactIdentifier(firstPathValue(payload, idPaths), receiptId)) &&
    (!receiptUrl || firstPathValue(payload, urlPaths) === receiptUrl);
}

function exactReceiptReadArgument(
  value: unknown,
  connector: SharingConnector,
  receiptId: string,
  receiptUrl: string,
): boolean {
  const record = asRecord(decodedChild(value));
  if (connector === "notion") {
    return Boolean((receiptId && exactIdentifier(record.id, receiptId)) ||
      (receiptUrl && record.id === receiptUrl));
  }
  return Boolean(receiptId && exactIdentifier(record.message_id ?? record.id, receiptId));
}

const CONTENT_KEY_RE = /(?:^|_)(?:content|text|message|body|markdown|plain_text|rich_text)(?:_|$)/i;
const MEETING_DATA_KEY_RE = /(?:meeting|transcript|summary|participant|attendee)/i;

function contentStrings(value: unknown, key = ""): string[] {
  if (typeof value === "string") {
    const parsed = parsedJson(value);
    if (parsed !== value) return contentStrings(parsed, key);
    return CONTENT_KEY_RE.test(key) ? [value] : [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => contentStrings(item, key));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>)
    .flatMap(([childKey, child]) => contentStrings(child, childKey));
}

function containsMeetingData(value: unknown, expectedContent: string, key = ""): boolean {
  if (typeof value === "string") {
    const parsed = parsedJson(value);
    if (parsed !== value) return containsMeetingData(parsed, expectedContent, key);
    if (value === expectedContent) return false;
    return MEETING_DATA_KEY_RE.test(key) || MEETING_DATA_KEY_RE.test(value);
  }
  if (Array.isArray(value)) {
    return value.some((item) => containsMeetingData(item, expectedContent, key));
  }
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>)
    .some(([childKey, child]) => containsMeetingData(child, expectedContent, childKey));
}

function hasFailedStatus(value: unknown, key = ""): boolean {
  if (typeof value === "string") {
    const parsed = parsedJson(value);
    if (parsed !== value) return hasFailedStatus(parsed, key);
    if (/^(?:status|state|outcome)$/i.test(key) && /^(?:failed|failure|error|rejected|denied)$/i.test(value.trim())) {
      return true;
    }
    return false;
  }
  if (Array.isArray(value)) return value.some((item) => hasFailedStatus(item, key));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value as Record<string, unknown>).some(([childKey, child]) => {
    if (/^(?:ok|success)$/i.test(childKey) && child === false) return true;
    if (/^(?:is_error|isError)$/i.test(childKey) && child === true) return true;
    if (/^(?:error|errors)$/i.test(childKey)) {
      if (child !== null && child !== false && child !== "" &&
        !(Array.isArray(child) && child.length === 0) &&
        !(typeof child === "object" && child !== null && Object.keys(child).length === 0)) return true;
    }
    return hasFailedStatus(child, childKey);
  });
}

const SUCCESS_OUTCOME_RE = /^(?:ok|success|succeeded|completed|ready|sent|verified|created|connected|found)$/i;
const FAILURE_TEXT_RE = /\b(?:failed|failure|error|timeout|timed out|partial|rejected|denied|unauthorized|forbidden)\b/i;
const OUTCOME_KEY_RE = /^(?:status|state|outcome)$/i;

function hasNonSuccessEnvelope(value: unknown, key = ""): boolean {
  if (typeof value === "string") {
    const parsed = parsedJson(value);
    if (parsed !== value) return hasNonSuccessEnvelope(parsed, key);
    if (OUTCOME_KEY_RE.test(key) && !SUCCESS_OUTCOME_RE.test(value.trim())) return true;
    return FAILURE_TEXT_RE.test(value.trim());
  }
  if (Array.isArray(value)) return value.some((item) => hasNonSuccessEnvelope(item, key));
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return Object.entries(record).some(([childKey, child]) => (
    (OUTCOME_KEY_RE.test(childKey) && (
      typeof child !== "string" || !SUCCESS_OUTCOME_RE.test(child.trim())
    )) || hasNonSuccessEnvelope(child, childKey)
  ));
}

function jsonLines(raw: string): Array<Record<string, unknown>> {
  return raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).flatMap((line) => {
    try {
      const value = JSON.parse(line) as unknown;
      if (Array.isArray(value)) {
        return value.filter((item): item is Record<string, unknown> => (
          typeof item === "object" && item !== null && !Array.isArray(item)
        ));
      }
      return typeof value === "object" && value !== null
        ? [value as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
}

function connectorToolIdentity(name: string): { connector: string; tool: string } | null {
  const double = /^mcp__([A-Za-z0-9.-]+)__(.+)$/.exec(name);
  if (double) return { connector: double[1]!, tool: double[2]! };
  const single = /^mcp_([A-Za-z0-9.-]+)_(.+)$/.exec(name);
  return single ? { connector: single[1]!, tool: single[2]! } : null;
}

function connectorMatches(actual: string, selected: SharingConnector): boolean {
  const normalized = actual.toLowerCase();
  return selected === "zulip"
    ? normalized === "zulip" || normalized === "zulipchat"
    : normalized === selected;
}

function toolResultSucceeded(result: string, isError = false): boolean {
  const value = result.trim();
  const decoded = decodedValue(value);
  return Boolean(value) && !isError && !hasFailedStatus(decoded) && !hasNonSuccessEnvelope(decoded) && !(
    /<tool_error\b/i.test(value) ||
    /"(?:ok|success)"\s*:\s*false/i.test(value) ||
    /"is_error"\s*:\s*true/i.test(value) ||
    /"error"\s*:\s*(?!null\b|false\b|""|\[\]|\{\})/i.test(value) ||
    /\b(?:permission denied|unauthorized|forbidden|request failed)\b/i.test(value)
  );
}

function extractConnectorToolCalls(raw: string): AuditedConnectorToolCall[] {
  const rows = jsonLines(raw);
  const calls: AuditedConnectorToolCall[] = [];
  const byId = new Map<string, AuditedConnectorToolCall>();

  for (const row of rows) {
    const item = asRecord(row.item);
    if (item.type === "mcp_tool_call") {
      const connector = boundedString(item.server, 100);
      const name = boundedString(item.tool, 200);
      const resultText = serialized(item.result);
      if (connector && name) {
        calls.push({
          connector,
          name,
          argumentsText: serialized(item.arguments),
          resultText,
          success: item.status === "completed" && !item.error && toolResultSucceeded(resultText),
        });
      }
    }

    const topLevelMessages = Array.isArray(row.messages) ? row.messages : [row];
    for (const rawMessage of topLevelMessages) {
      const message = asRecord(rawMessage);
      const role = boundedString(message.role, 40) || boundedString(message.type, 40);
      const messageBody = asRecord(message.message);
      const content = Array.isArray(messageBody.content)
        ? messageBody.content
        : Array.isArray(message.content) ? message.content : [];
      if (role === "assistant") {
        for (const rawContent of content) {
          const block = asRecord(rawContent);
          if (block.type !== "tool_use") continue;
          const id = boundedString(block.id, 200);
          const identity = connectorToolIdentity(boundedString(block.name, 300));
          if (!id || !identity) continue;
          const call = {
            connector: identity.connector,
            name: identity.tool,
            argumentsText: serialized(block.input),
            resultText: "",
            success: false,
          };
          calls.push(call);
          byId.set(id, call);
        }
      }
      for (const rawContent of content) {
        const block = asRecord(rawContent);
        if (block.type !== "tool_result") continue;
        const call = byId.get(boundedString(block.tool_use_id, 200));
        if (!call) continue;
        call.resultText = serialized(block.content);
        call.success = toolResultSucceeded(call.resultText, block.is_error === true);
      }

      const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
      for (const rawCall of toolCalls) {
        const callValue = asRecord(rawCall);
        const fn = asRecord(callValue.function);
        const identity = connectorToolIdentity(boundedString(fn.name, 300));
        const id = boundedString(callValue.id, 200);
        if (!identity || !id) continue;
        const call = {
          connector: identity.connector,
          name: identity.tool,
          argumentsText: serialized(fn.arguments),
          resultText: "",
          success: false,
        };
        calls.push(call);
        byId.set(id, call);
      }
      if (role === "tool") {
        const call = byId.get(boundedString(message.tool_call_id, 200));
        if (call) {
          call.resultText = serialized(message.content);
          call.success = toolResultSucceeded(call.resultText);
        }
      }
    }
  }
  return calls;
}

const READ_TOOL_RE = /(?:^|[_-])(?:search|fetch|get|list|read|retrieve|query)(?:[_-]|$)/i;
const WRITE_TOOL_RE = /(?:^|[_-])(?:create|send|post|update|append|write|publish|delete|remove|archive|move|rename|edit)(?:[_-]|$)/i;

const CONNECTOR_TOOLS: Record<SharingConnector, {
  read: readonly string[];
  write: readonly string[];
}> = {
  notion: {
    read: ["notion_search", "notion_fetch", "search", "fetch"],
    write: ["notion_create_pages"],
  },
  zulip: {
    read: [
      "get_messages", "get_message", "search_messages", "get_streams", "get_stream",
      "get_topics", "get_users", "get_user",
    ],
    write: ["send_message"],
  },
};

function operationPolicy(
  connector: SharingConnector,
  mode: "read" | "write",
  writeGuard?: { destination: string; content: string },
): ConnectorToolPolicy {
  return { connector, allowedTools: CONNECTOR_TOOLS[connector][mode], ...(writeGuard ? { writeGuard } : {}) };
}

function connectionRuntime(connection: PersistedAgentConnection, workDir: string): AgentRuntime {
  if (connection.kind !== "supported-agent") {
    throw new Error("Sharing requires a Supported Agent Connection");
  }
  const executable = boundedString(connection.settings.executablePath, 1_000);
  if (!executable) throw new Error(`${connection.label} has no executable path`);
  const command = connection.adapter === "codex"
    ? [executable, "exec", "--sandbox", "read-only", "--skip-git-repo-check"]
    : connection.adapter === "claude-code"
      ? [executable, "--print", "--output-format", "stream-json", "--verbose"]
      : [];
  const provider = connection.adapter === "claude-code" ? "claude" : connection.adapter;
  if (connection.adapter === "openclaw") {
    throw new Error("OpenClaw is Conversation-only and cannot be selected for Sharing connectors");
  }
  if (connection.adapter === "hermes") {
    throw new Error("Hermes does not provide the required Sharing pre-tool authorization boundary");
  }
  if (command.length === 0 || !["codex", "claude"].includes(provider)) {
    throw new Error(`${connection.label} does not have a supported Sharing connector adapter`);
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

export class AgentSharingConnectorAdapter implements SharingConnectorAdapter {
  private readonly run: ConnectorRunner;

  constructor(private readonly options: {
    scriptDir: string;
    configDir: string;
    run?: ConnectorRunner;
  }) {
    this.run = options.run ?? runAgentCliCommand;
  }

  async discover(input: {
    connection: PersistedAgentConnection;
    connector: SharingConnector;
  }): Promise<{ options: ConnectorDestinationOption[]; detail: string }> {
    const result = await this.invoke(input.connection, input.connector, 60_000, [
      `Use only the configured ${input.connector} connector for this read-only destination discovery.`,
      "Do not write, create, update, or delete anything.",
      "List destinations that can receive a Yulu Test Share.",
      ...(input.connector === "notion" ? [
        'For each Notion value use canonical JSON matching notion_create_pages parent exactly: {"page_id":"..."} or {"data_source_id":"..."}.',
      ] : []),
      ...(input.connector === "zulip" ? [
        'For each Zulip value use canonical JSON: {"type":"stream","to":"stream name","topic":"topic name"} or {"type":"private","to":["user@example.com"]}.',
      ] : []),
      'Return only JSON: {"options":[{"label":"Human label","value":"exact destination"}],"detail":"what was discovered"}.',
    ].join("\n"), "read");
    this.requireReadEvidence(result, input.connector, "destination discovery");
    const value = parseObject(result.stdout);
    const rawOptions = Array.isArray(value.options) ? value.options : [];
    const options = rawOptions.slice(0, 100).flatMap((raw): ConnectorDestinationOption[] => {
      const option = asRecord(raw);
      const value = boundedString(option.value, 500);
      if (!value) return [];
      const destination = input.connector === "notion" ? canonicalNotionDestination(value) : value;
      if (!destination) return [];
      return [{ label: boundedString(option.label, 200) || destination, value: destination }];
    });
    return {
      options,
      detail: boundedString(value.detail, 1_000) || `Found ${options.length} ${input.connector} destinations`,
    };
  }

  async probe(input: {
    connection: PersistedAgentConnection;
    connector: SharingConnector;
  }): Promise<{ detail: string }> {
    const result = await this.invoke(input.connection, input.connector, 30_000, [
      `Run one bounded, read-only ${input.connector} connector readiness probe.`,
      "Prove that runtime-owned authorization can access the connector without relying on configuration files alone.",
      "Do not create, update, or delete any external content.",
      `Return only JSON: {"status":"ready","connector":"${input.connector}","detail":"what access was verified"}.`,
    ].join("\n"), "read");
    this.requireReadEvidence(result, input.connector, "Connector Readiness probe");
    const value = parseObject(result.stdout);
    if (boundedString(value.status, 20).toLowerCase() !== "ready" || value.connector !== input.connector) {
      throw new Error(boundedString(value.detail ?? value.error, 1_000) || `${input.connector} access was not verified`);
    }
    return { detail: boundedString(value.detail, 1_000) || `${input.connector} read access verified` };
  }

  async testShare(input: {
    connection: PersistedAgentConnection;
    connector: SharingConnector;
    destination: string;
    content: string;
  }): Promise<{ destination: string; receiptId: string; receiptUrl: string }> {
    if (input.content !== YULU_TEST_SHARE_CONTENT) {
      throw new Error("Test Share content must be the fixed meeting-free verification message");
    }
    const prompt = [
      `Use only the configured ${input.connector} connector to perform exactly one external Test Share write.`,
      `Destination: ${input.destination}`,
      `Content: ${YULU_TEST_SHARE_CONTENT}`,
      "This payload has no meeting title, transcript, summary, participant, or meeting metadata. Do not add any.",
      ...(input.connector === "notion" ? [
        "Pass the saved destination object as the exact top-level parent and create exactly one page whose content is the exact fixed message.",
      ] : []),
      `Return only JSON: {"status":"sent","connector":"${input.connector}","destination":"${input.destination}","id":"external receipt id","url":"external receipt URL if available"}.`,
    ].join("\n");
    const runtime = connectionRuntime(input.connection, this.options.scriptDir);
    let result: AgentCliRunResult;
    try {
      result = await this.runWithRuntime(runtime, input.connector, 120_000, prompt, "write", {
        destination: input.destination,
        content: input.content,
      });
    } catch (error) {
      throw new SharingConnectorUnknownOutcomeError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (result.code !== 0 || !result.stdout.trim()) {
      const detail = (result.stderr || result.stdout || "Test Share transport ended without a receipt").trim();
      if (result.connectorWriteState === "not-started") throw new Error(detail);
      throw new SharingConnectorUnknownOutcomeError(detail);
    }
    let value: Record<string, unknown>;
    try {
      value = parseObject(result.stdout);
    } catch (error) {
      throw new SharingConnectorUnknownOutcomeError((error as Error).message);
    }
    const status = boundedString(value.status, 20).toLowerCase();
    const destination = boundedString(value.destination, 500);
    const receiptId = boundedIdentifier(value.id, 500);
    const receiptUrl = boundedString(value.url, 2_000);
    if (
      !["sent", "success"].includes(status) || value.connector !== input.connector ||
      destination !== input.destination || (!receiptId && !receiptUrl)
    ) {
      throw new SharingConnectorUnknownOutcomeError(
        boundedString(value.error ?? value.detail, 1_000) || "Agent returned no matching Test Share receipt",
      );
    }
    try {
      this.requireWriteEvidence(result, input.connector, {
        destination: input.destination,
        content: input.content,
        receiptId,
        receiptUrl,
      });
    } catch (error) {
      throw new SharingConnectorUnknownOutcomeError(this.errorMessage(error));
    }
    return { destination, receiptId, receiptUrl };
  }

  async verifyReceipt(input: {
    connection: PersistedAgentConnection;
    connector: SharingConnector;
    destination: string;
    content: string;
    receipt: { destination: string; receiptId: string; receiptUrl: string };
  }): Promise<{ destination: string; receiptId: string; receiptUrl: string }> {
    let result: AgentCliRunResult;
    try {
      result = await this.runOperation(input.connection, input.connector, 60_000, [
        `Use only the configured ${input.connector} connector to read back this external Test Share receipt.`,
        "This is a read-only verification. Do not write, create, update, or delete anything.",
        `Saved destination: ${input.destination}`,
        `Receipt ID: ${input.receipt.receiptId}`,
        `Receipt URL: ${input.receipt.receiptUrl}`,
        'Return only JSON: {"status":"verified","connector":"' + input.connector +
          '","destination":"observed destination","content":"observed exact content","id":"observed id","url":"observed URL"}.',
      ].join("\n"), "read");
    } catch (error) {
      throw new SharingConnectorUnknownOutcomeError(error instanceof Error ? error.message : String(error));
    }
    if (result.code !== 0 || !result.stdout.trim()) {
      throw new SharingConnectorUnknownOutcomeError(
        (result.stderr || result.stdout || "Receipt read-back ended without verification").trim(),
      );
    }
    let value: Record<string, unknown>;
    try {
      value = parseObject(result.stdout);
    } catch (error) {
      throw new SharingConnectorUnknownOutcomeError((error as Error).message);
    }
    const destination = boundedString(value.destination, 500);
    const receiptId = boundedIdentifier(value.id, 500);
    const receiptUrl = boundedString(value.url, 2_000);
    if (
      value.status !== "verified" || value.connector !== input.connector ||
      destination !== input.destination || value.content !== input.content ||
      receiptId !== input.receipt.receiptId || receiptUrl !== input.receipt.receiptUrl
    ) {
      throw new SharingConnectorUnknownOutcomeError("Connector read-back did not match the Test Share receipt and payload");
    }
    try {
      this.requireReadBackEvidence(result, input.connector, input);
    } catch (error) {
      throw new SharingConnectorUnknownOutcomeError(this.errorMessage(error));
    }
    return { destination, receiptId, receiptUrl };
  }

  private async invoke(
    connection: PersistedAgentConnection,
    connector: SharingConnector,
    timeoutMs: number,
    prompt: string,
    mode: "read" | "write",
  ) {
    const result = await this.runOperation(connection, connector, timeoutMs, prompt, mode);
    if (result.code !== 0 || !result.stdout.trim()) {
      throw new Error((result.stderr || result.stdout || `Agent connector exited ${result.code}`).trim());
    }
    return result;
  }

  private runOperation(
    connection: PersistedAgentConnection,
    connector: SharingConnector,
    timeoutMs: number,
    prompt: string,
    mode: "read" | "write",
  ) {
    const runtime = connectionRuntime(connection, this.options.scriptDir);
    return this.runWithRuntime(runtime, connector, timeoutMs, prompt, mode);
  }

  private async runWithRuntime(
    runtime: AgentRuntime,
    connector: SharingConnector,
    timeoutMs: number,
    prompt: string,
    mode: "read" | "write",
    writeGuard?: { destination: string; content: string },
  ) {
    const result = await this.run({
      runtime,
      scriptDir: this.options.scriptDir,
      configDir: this.options.configDir,
      prompt,
      timeoutMs,
      yuluSessionId: randomUUID(),
      connectorToolPolicy: operationPolicy(connector, mode, writeGuard),
    });
    return result;
  }

  private requireReadEvidence(
    result: AgentCliRunResult,
    connector: SharingConnector,
    operation: string,
  ) {
    const calls = this.selectedConnectorCalls(result, connector);
    if (calls.some((call) => WRITE_TOOL_RE.test(call.name))) {
      throw new Error(`${operation} attempted a selected-connector mutation tool-call`);
    }
    if (!calls.some((call) => call.success && READ_TOOL_RE.test(call.name) && !WRITE_TOOL_RE.test(call.name))) {
      throw new Error(`${operation} returned no successful selected-connector read tool-call evidence`);
    }
  }

  private requireWriteEvidence(
    result: AgentCliRunResult,
    connector: SharingConnector,
    expected: { destination: string; content: string; receiptId: string; receiptUrl: string },
  ) {
    const writes = this.selectedConnectorCalls(result, connector)
      .filter((call) => WRITE_TOOL_RE.test(call.name));
    if (writes.length !== 1 || !writes[0]!.success) {
      throw new Error("Test Share returned no single successful selected-connector write tool-call evidence");
    }
    const write = writes[0]!;
    const argumentsValue = decodedValue(write.argumentsText);
    const resultValue = decodedValue(write.resultText);
    if (
      !exactWriteDestination(argumentsValue, connector, expected.destination) ||
      !exactWriteContent(argumentsValue, connector, expected.content) ||
      containsMeetingData(argumentsValue, expected.content) ||
      !exactReceiptIdentity(resultValue, connector, expected.receiptId, expected.receiptUrl)
    ) {
      throw new Error("Test Share connector write evidence did not match its destination, exact content, and receipt");
    }
  }

  private requireReadBackEvidence(
    result: AgentCliRunResult,
    connector: SharingConnector,
    input: {
      destination: string;
      content: string;
      receipt: { receiptId: string; receiptUrl: string };
    },
  ) {
    const calls = this.selectedConnectorCalls(result, connector);
    if (calls.some((call) => WRITE_TOOL_RE.test(call.name))) {
      throw new Error("Receipt verification attempted a selected-connector mutation tool-call");
    }
    const reads = calls
      .filter((call) => call.success && READ_TOOL_RE.test(call.name) && !WRITE_TOOL_RE.test(call.name));
    const matched = reads.some((call) => {
      const argumentsValue = decodedValue(call.argumentsText);
      const resultValue = decodedValue(call.resultText);
      return exactReceiptReadArgument(
        argumentsValue,
        connector,
        input.receipt.receiptId,
        input.receipt.receiptUrl,
      ) &&
        exactReceiptDestination(resultValue, connector, input.destination) &&
        exactReceiptContent(resultValue, connector, input.content) &&
        !containsMeetingData(resultValue, input.content) &&
        exactReceiptIdentity(
          resultValue,
          connector,
          input.receipt.receiptId,
          input.receipt.receiptUrl,
        );
    });
    if (!matched) {
      throw new Error("Receipt verification returned no successful matching selected-connector read tool-call evidence");
    }
  }

  private selectedConnectorCalls(result: AgentCliRunResult, connector: SharingConnector) {
    const calls = extractConnectorToolCalls(result.rawStdout ?? "");
    const foreign = calls.filter((call) => !connectorMatches(call.connector, connector));
    if (foreign.length > 0) {
      throw new Error(`Agent used connector ${foreign[0]!.connector} outside selected connector ${connector}`);
    }
    return calls.filter((call) => connectorMatches(call.connector, connector));
  }

  private errorMessage(error: unknown) {
    return error instanceof Error ? error.message : String(error);
  }
}
