import { beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync } from "node:fs";
import { runCodexNotionOperation, type CodexNotionOperation } from "../src/codexConnectorClient.js";
import { AgentSharingConnectorAdapter, SharingConnectorUnknownOutcomeError } from "../src/sharingConnector.js";
import type { PersistedAgentConnection } from "../src/hostStore.js";
import type { ConnectorToolPolicy } from "../src/agentCliRunner.js";

const session = vi.hoisted(() => ({
  initialize: vi.fn(), request: vi.fn(), close: vi.fn(), options: [] as Array<Record<string, any>>,
}));
vi.mock("../src/codexAppServerClient.js", () => ({
  AppServerSession: class {
    constructor(options: Record<string, any>) { session.options.push(options); }
    initialize = session.initialize;
    request = session.request;
    close = session.close;
  },
}));

const parentId = "01234567-89ab-cdef-0123-456789abcdef";
const pageId = "11234567-89ab-cdef-0123-456789abcdef";
const url = `https://app.notion.com/p/${pageId.replaceAll("-", "")}?pvs=204`;
const destination = JSON.stringify({ page_id: parentId });
const summary = "# Synthetic QA\nNever auto-share.";
const receipt = { destination, receiptId: pageId, receiptUrl: url };
const connection: PersistedAgentConnection = {
  id: "codex", kind: "supported-agent", adapter: "codex", label: "Codex",
  lifecycle: "available", settings: { executablePath: "/selected/codex", conversationModel: "gpt-5.6-sol" },
  createdAt: "2026-09-12T01:00:00Z", updatedAt: "2026-09-12T01:00:00Z",
};
const schema = (keys: string[], required = keys) => ({
  inputSchema: { type: "object", properties: Object.fromEntries(keys.map((key) => [key, {}])), required },
});
const inventory = () => ({
  data: [{ name: "codex_apps", tools: {
    "notion.notion-list-recent-pages": schema(["limit"], []),
    "notion.fetch": schema(["id"]),
    "notion.notion-create-pages": schema(["parent", "pages"], ["pages"]),
    "notion.notion-delete-page": schema(["id"]),
    "notion_evil.fetch": schema(["id"]),
  } }], nextCursor: null,
});
const envelope = (payload: unknown) => ({ content: [{ type: "text", text: JSON.stringify(payload) }], isError: false });
const fetched = () => ({
  metadata: { type: "page" }, url,
  text: `<page url="${url}">\n<ancestor-path>\n<parent-page url="https://app.notion.com/p/${parentId.replaceAll("-", "")}"/>\n</ancestor-path>\n<properties>\n{"title":"Yulu Share"}\n</properties>\n<content>\n${summary}\n</content>\n</page>`,
});

function respond(method: string, params: any): any {
  if (method === "thread/start") return { thread: { id: "thread-qa" }, model: params.model, modelProvider: "openai" };
  if (method === "mcpServerStatus/list") return inventory();
  if (method === "mcpServer/tool/call") {
    if (params.tool === "notion.fetch") return envelope(fetched());
    if (params.tool === "notion.notion-create-pages") return envelope({ pages: [{ id: pageId, url }] });
    return envelope({ results: [{ type: "page", title: "Synthetic QA", url }], nextCursor: null });
  }
  throw new Error(`Unexpected RPC ${method}`);
}

function run(operation: CodexNotionOperation, policy?: ConnectorToolPolicy) {
  return runCodexNotionOperation({
    executable: "/selected/codex", model: "gpt-5.6-sol", operation, timeoutMs: 1_000,
    env: { CODEX_APP_TOOLS_PIPE_PATH: "do-not-inherit", CODEX_SANDBOX_NETWORK_DISABLED: "1" },
    policy: policy ?? (operation.type === "create"
      ? { connector: "notion", allowedTools: ["notion_create_pages"], writeGuard: { destination, content: summary } }
      : { connector: "notion", allowedTools: ["fetch", "notion_list_recent_pages"] }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  session.options.length = 0;
  session.initialize.mockResolvedValue(undefined);
  session.request.mockImplementation(respond);
});

describe("deterministic Codex Notion connector", () => {
  it("reads the exact receipt using the selected runtime without a model turn or credential calls", async () => {
    const result = await run({ type: "fetch", id: pageId });
    expect(result.code).toBe(0);
    expect(session.request.mock.calls.map(([method]) => method)).toEqual([
      "thread/start", "mcpServerStatus/list", "mcpServer/tool/call",
    ]);
    expect(session.request).toHaveBeenLastCalledWith("mcpServer/tool/call", {
      threadId: "thread-qa", server: "codex_apps", tool: "notion.fetch", arguments: { id: pageId },
    });
    expect(session.options[0]).toMatchObject({ executable: "/selected/codex", rejectServerRequests: true });
    expect(session.options[0]!.env.CODEX_APP_TOOLS_PIPE_PATH).toBeUndefined();
    expect(session.options[0]!.env.CODEX_SANDBOX_NETWORK_DISABLED).toBe("1");
    expect(session.request.mock.calls[0]![1]).toMatchObject({
      model: "gpt-5.6-sol", modelProvider: "openai", allowProviderModelFallback: false,
      ephemeral: true, sandbox: "read-only", approvalPolicy: "never",
    });
    expect(result.runtimeConnectorToolCalls).toEqual([{ connector: "notion", name: "fetch", arguments: { id: pageId }, result: envelope(fetched()) }]);
    expect(result.connectorWriteState).toBe("not-started");
    expect(existsSync(session.options[0]!.cwd)).toBe(false);
    expect(session.close).toHaveBeenCalledTimes(1);
  });

  it("uses the actual recent-pages envelope and does not follow its next cursor", async () => {
    session.request.mockImplementation((method, params) => method === "mcpServer/tool/call"
      ? envelope({ results: [{ type: "page", title: "QA", url }], nextCursor: "more-pages" }) : respond(method, params));
    const result = await run({ type: "recent", limit: 1 });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "ready", options: [{ label: "QA", value: JSON.stringify({ page_id: pageId }) }] });
    expect(session.request.mock.calls.filter(([method]) => method === "mcpServer/tool/call")).toHaveLength(1);
  });

  it("budgets runtime discovery separately without extending the tool-call timeout", async () => {
    await run({ type: "recent", limit: 1 });
    expect(session.options[0]!.rpcTimeoutMs).toBe(1_000);
    expect(session.request).toHaveBeenCalledWith("mcpServerStatus/list", {
      threadId: "thread-qa", detail: "toolsAndAuthOnly", limit: 100, cursor: null,
    }, 60_000);
    expect(session.request).toHaveBeenLastCalledWith("mcpServer/tool/call", {
      threadId: "thread-qa", server: "codex_apps", tool: "notion.notion-list-recent-pages", arguments: { limit: 1 },
    });
  });

  it("writes exactly one fixed-title page with the confirmed parent and unchanged summary", async () => {
    const result = await run({ type: "create", destination, content: summary });
    expect(result.code).toBe(0);
    expect(result.connectorWriteState).toBe("authorized");
    expect(session.request).toHaveBeenLastCalledWith("mcpServer/tool/call", {
      threadId: "thread-qa", server: "codex_apps", tool: "notion.notion-create-pages",
      arguments: { parent: { page_id: parentId }, pages: [{ properties: { title: "Yulu Share" }, content: summary }] },
    });
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "sent", destination, id: pageId, url });
  });

  it.each([
    { type: "create", destination, content: "changed summary" },
    { type: "create", destination: JSON.stringify({ page_id: pageId }), content: summary },
    { type: "create", destination: JSON.stringify({ page_id: parentId, workspace: true }), content: summary },
    { type: "fetch", id: "https://example.invalid/private" },
    { type: "recent", limit: 100 },
  ])("rejects changed or unbounded input before starting a runtime: %j", async (operation) => {
    const result = await run(operation as CodexNotionOperation);
    expect(result).toMatchObject({ code: 1, connectorWriteState: "not-started" });
    expect(session.options).toHaveLength(0);
  });

  it("rejects a write lacking the exact operation authorization", async () => {
    const result = await run({ type: "create", destination, content: summary }, { connector: "notion", allowedTools: ["fetch"] });
    expect(result.code).toBe(1);
    expect(session.options).toHaveLength(0);
  });

  it.each(["foreign", "duplicate", "schema", "model", "pagination"])("fails closed before any tool call when %s is incompatible", async (mode) => {
    session.request.mockImplementation((method, params) => {
      if (method === "thread/start" && mode === "model") return { thread: { id: "thread-qa" }, model: "another-model", modelProvider: "openai" };
      if (method === "mcpServerStatus/list") {
        const value = inventory();
        if (mode === "foreign") value.data[0]!.name = "notion_evil";
        if (mode === "duplicate") value.data.push(value.data[0]!);
        if (mode === "schema") value.data[0]!.tools["notion.notion-create-pages"] = schema(["parent", "pages", "anotherRequiredField"]);
        if (mode === "pagination") return { ...value, nextCursor: "repeated" };
        return value;
      }
      return respond(method, params);
    });
    const result = await run({ type: "create", destination, content: summary });
    expect(result).toMatchObject({ code: 1, connectorWriteState: "not-started" });
    expect(session.request.mock.calls.filter(([method]) => method === "mcpServer/tool/call")).toHaveLength(0);
  });

  it.each(["disconnected", "tool-error", "missing-receipt", "conflicting-id"])("retains an unknown outcome without retry after %s", async (mode) => {
    session.request.mockImplementation((method, params) => {
      if (method !== "mcpServer/tool/call") return respond(method, params);
      if (mode === "disconnected") throw new Error("transport disconnected");
      if (mode === "tool-error") return { ...envelope({ error: "unavailable" }), isError: true };
      if (mode === "missing-receipt") return envelope({ pages: [] });
      return envelope({ pages: [{ id: parentId, url }] });
    });
    const result = await run({ type: "create", destination, content: summary });
    expect(result).toMatchObject({ code: 1, connectorWriteState: "unknown" });
    expect(session.request.mock.calls.filter(([method]) => method === "mcpServer/tool/call")).toHaveLength(1);
  });

  it("routes normal Sharing through exact RPC observations, including write and read-back validation", async () => {
    const adapter = new AgentSharingConnectorAdapter({ scriptDir: "/app/scripts", configDir: "/unused/config" });
    await expect(adapter.probe({ connection, connector: "notion" })).resolves.toHaveProperty("detail");
    const discovery = await adapter.discover({ connection, connector: "notion" });
    expect(discovery.options).toHaveLength(1);
    await expect(adapter.share({ connection, connector: "notion", destination, content: summary })).resolves.toEqual(receipt);
    await expect(adapter.verifyReceipt({ connection, connector: "notion", destination, content: summary, receipt })).resolves.toEqual(receipt);
    const calls = session.request.mock.calls.filter(([method]) => method === "mcpServer/tool/call");
    expect(calls.map(([, params]) => params.tool)).toEqual([
      "notion.notion-list-recent-pages", "notion.notion-list-recent-pages", "notion.notion-create-pages", "notion.fetch",
    ]);
    expect(session.request.mock.calls.some(([method]) => method === "turn/start")).toBe(false);
  });

  it("keeps receipt reconciliation unknown if the actual fetched content changed", async () => {
    session.request.mockImplementation((method, params) => method === "mcpServer/tool/call"
      ? envelope({ ...fetched(), text: fetched().text.replace(summary, "changed content") }) : respond(method, params));
    const adapter = new AgentSharingConnectorAdapter({ scriptDir: "/app/scripts", configDir: "/unused/config" });
    await expect(adapter.verifyReceipt({ connection, connector: "notion", destination, content: summary, receipt })).rejects.toBeInstanceOf(SharingConnectorUnknownOutcomeError);
    expect(session.request).toHaveBeenLastCalledWith("mcpServer/tool/call", expect.objectContaining({ tool: "notion.fetch" }));
  });

  it("does not interpret recent-page titles as connector transport failures", async () => {
    session.request.mockImplementation((method, params) => method === "mcpServer/tool/call"
      ? envelope({ results: [{ type: "page", title: "Request failed: review the error budget", url }], nextCursor: null }) : respond(method, params));
    const adapter = new AgentSharingConnectorAdapter({ scriptDir: "/app/scripts", configDir: "/unused/config" });
    await expect(adapter.probe({ connection, connector: "notion" })).resolves.toHaveProperty("detail");
  });
});
