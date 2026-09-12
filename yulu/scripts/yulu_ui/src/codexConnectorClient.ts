import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppServerSession } from "./codexAppServerClient.js";
import { NOTION_SHARE_PAGE_TITLE, normalizeNotionShareDestination, notionSharingPageId } from "./notionSharing.js";
import type { AgentCliRunResult, ConnectorToolPolicy } from "./agentCliRunner.js";

type JsonRecord = Record<string, unknown>;

export type CodexNotionOperation =
  | { type: "recent"; limit: 1 | 10 }
  | { type: "fetch"; id: string }
  | { type: "create"; destination: string; content: string };

export interface RuntimeConnectorToolCall {
  connector: "notion";
  name: string;
  arguments: JsonRecord;
  result: unknown;
}

function record(value: unknown): JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonRecord : {};
}

const TOOL_NAMES = {
  recent: { logical: "notion_list_recent_pages", apps: ["notion.notion-list-recent-pages", "notion__notion_list_recent_pages"], standalone: ["notion_list_recent_pages"] },
  fetch: { logical: "fetch", apps: ["notion.fetch", "notion__fetch", "notion__notion_fetch"], standalone: ["fetch", "notion_fetch"] },
  create: { logical: "notion_create_pages", apps: ["notion.notion-create-pages", "notion__notion_create_pages"], standalone: ["notion_create_pages"] },
} as const;

function operationArguments(operation: CodexNotionOperation, policy: ConnectorToolPolicy): JsonRecord {
  const selected = TOOL_NAMES[operation.type];
  if (!selected || policy.connector !== "notion" || !policy.allowedTools.includes(selected.logical)) {
    throw new Error("The selected Notion operation is outside the connector authorization");
  }
  if (operation.type === "create") {
    if (!operation.content.trim() || !policy.writeGuard ||
        policy.writeGuard.content !== operation.content ||
        normalizeNotionShareDestination(policy.writeGuard.destination) !== normalizeNotionShareDestination(operation.destination)) {
      throw new Error("Notion write does not match the confirmed destination and immutable content");
    }
    return {
      parent: JSON.parse(normalizeNotionShareDestination(operation.destination)),
      pages: [{ properties: { title: NOTION_SHARE_PAGE_TITLE }, content: operation.content }],
    };
  }
  if (policy.writeGuard) throw new Error("A Notion read must not carry write authorization");
  if (operation.type === "recent") {
    if (operation.limit !== 1 && operation.limit !== 10) throw new Error("Notion discovery limit is not bounded");
    return { limit: operation.limit };
  }
  if (!notionSharingPageId(operation.id)) throw new Error("Notion receipt must have a valid page ID or trusted page URL");
  return { id: operation.id };
}

function toolPayload(result: unknown): JsonRecord {
  const envelope = record(result);
  if ((envelope.isError !== undefined && envelope.isError !== null && envelope.isError !== false) || !Array.isArray(envelope.content)) {
    throw new Error("The Codex Notion tool did not return a successful MCP result");
  }
  if (envelope.structuredContent !== undefined) return record(envelope.structuredContent);
  if (envelope.content.length !== 1) throw new Error("Notion returned an ambiguous tool result");
  const block = record(envelope.content[0]);
  if (block.type !== "text" || typeof block.text !== "string") throw new Error("Notion returned an unsupported tool result");
  return record(JSON.parse(block.text));
}

function operationOutput(operation: CodexNotionOperation, result: unknown): string {
  const payload = toolPayload(result);
  if (operation.type === "fetch") return "Fetched the exact requested Notion receipt through Codex app-server.";
  if (operation.type === "create") {
    if (!Array.isArray(payload.pages) || payload.pages.length !== 1) throw new Error("Notion returned no single-page write receipt");
    const page = record(payload.pages[0]);
    const id = notionSharingPageId(page.id);
    const url = typeof page.url === "string" ? page.url : "";
    if (!id || (url && notionSharingPageId(url) !== id)) throw new Error("Notion returned inconsistent receipt identities");
    return JSON.stringify({ status: "sent", connector: "notion", destination: operation.destination, id: page.id, url });
  }
  // The current Apps bridge returns results; older standalone tools use pages.
  if (payload.results !== undefined && payload.pages !== undefined) throw new Error("Notion returned an ambiguous recent-page list");
  const pages = payload.results ?? payload.pages;
  if (!Array.isArray(pages) || pages.length > operation.limit) throw new Error("Notion returned no bounded recent-page list");
  const options = pages.flatMap((value) => {
    const page = record(value);
    if (page.type !== undefined && page.type !== "page") return [];
    const id = notionSharingPageId(page.id ?? page.url);
    if (!id) return [];
    const title = typeof page.title === "string" ? page.title.trim().slice(0, 200) : "";
    return [{ label: title || id, value: normalizeNotionShareDestination(id) }];
  });
  return JSON.stringify({ status: "ready", connector: "notion", options, detail: `Codex verified Notion access with one read (${pages.length} recent pages).` });
}

/** Invoke only a fixed tool through the selected runtime; never start a model turn.
 * Codex owns discovery, transport and credentials. The Host owns the exact request,
 * one-call authorization, observed response and the existing durable outcome fence.
 */
export async function runCodexNotionOperation(input: {
  executable: string;
  model: string;
  operation: CodexNotionOperation;
  policy: ConnectorToolPolicy;
  timeoutMs: number;
  env?: NodeJS.ProcessEnv;
}): Promise<AgentCliRunResult> {
  let cwd: string | undefined;
  let session: AppServerSession | undefined;
  let timer: NodeJS.Timeout | undefined;
  let writePosted = false;
  let expired = false;
  let stage = "authorization";
  const runtimeConnectorToolCalls: RuntimeConnectorToolCall[] = [];
  try {
    const args = operationArguments(input.operation, input.policy);
    if (!input.executable || !input.model.trim()) throw new Error("Choose an explicit Codex runtime and model before using Sharing");
    cwd = mkdtempSync(join(tmpdir(), "yulu-codex-connector-"));
    const env = { ...process.env, ...input.env };
    // A nested developer invocation must not proxy tools into its supervising app.
    // Do not change CODEX_HOME, authentication, sandbox or network restrictions.
    delete env.CODEX_APP_TOOLS_PIPE_PATH;
    session = new AppServerSession({
      executable: input.executable, cwd, env,
      rpcTimeoutMs: Math.min(120_000, Math.max(1, input.timeoutMs)),
      rejectServerRequests: true,
    });
    timer = setTimeout(() => { expired = true; session?.close(); }, input.timeoutMs + 60_000);
    stage = "runtime initialization";
    await session.initialize();
    const started = record(await session.request("thread/start", {
      cwd, model: input.model, modelProvider: "openai", allowProviderModelFallback: false,
      ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
    }));
    const threadId = record(started.thread).id;
    if (typeof threadId !== "string" || !threadId || started.model !== input.model || started.modelProvider !== "openai") {
      throw new Error("Codex did not retain the selected runtime/model identity");
    }
    stage = "connector discovery";
    const selected = TOOL_NAMES[input.operation.type];
    const matches: Array<{ server: string; name: string; schema: JsonRecord }> = [];
    const cursors = new Set<string>();
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const inventory = record(await session.request("mcpServerStatus/list", { threadId, detail: "toolsAndAuthOnly", limit: 100, cursor }));
      if (!Array.isArray(inventory.data)) throw new Error("Codex returned an invalid connector inventory");
      for (const value of inventory.data) {
        const server = record(value);
        const allowed: readonly string[] = server.name === "codex_apps" ? selected.apps : server.name === "notion" ? selected.standalone : [];
        for (const [name, tool] of Object.entries(record(server.tools))) {
          if (allowed.includes(name)) matches.push({ server: server.name as string, name, schema: record(record(tool).inputSchema) });
        }
      }
      if (!inventory.nextCursor) break;
      if (typeof inventory.nextCursor !== "string" || cursors.has(inventory.nextCursor) || page === 9) {
        throw new Error("Codex connector inventory exceeded its pagination bound");
      }
      cursor = inventory.nextCursor;
      cursors.add(cursor);
    }
    if (matches.length !== 1) throw new Error("Codex must expose exactly one supported Notion tool for this operation; no fallback was attempted");
    const target = matches[0]!;
    const properties = record(target.schema.properties);
    const required = target.schema.required ?? [];
    if (target.schema.type !== "object" || Object.keys(args).some((key) => !(key in properties)) ||
        !Array.isArray(required) || required.some((key) => typeof key !== "string" || !(key in args))) {
      throw new Error("The Codex Notion tool schema is incompatible with the exact authorized request");
    }
    stage = "tool call";
    // No retry after this boundary, even on timeout, disconnect or a tool error.
    writePosted = input.operation.type === "create";
    const result = await session.request("mcpServer/tool/call", { threadId, server: target.server, tool: target.name, arguments: args });
    runtimeConnectorToolCalls.push({ connector: "notion", name: selected.logical, arguments: args, result });
    stage = "tool result validation";
    return {
      code: 0, stderr: "", stdout: operationOutput(input.operation, result), runtimeConnectorToolCalls,
      connectorWriteState: writePosted ? "authorized" : "not-started",
    };
  } catch (error) {
    return {
      code: 1, stdout: "", stderr: `Codex Notion ${stage} failed: ${error instanceof Error ? error.message : "unknown runtime error"}`,
      connectorWriteState: writePosted ? "unknown" : "not-started",
      runtimeConnectorToolCalls, ...(expired ? { timedOut: true } : {}),
    };
  } finally {
    if (timer) clearTimeout(timer);
    session?.close();
    if (cwd) rmSync(cwd, { recursive: true, force: true });
  }
}
