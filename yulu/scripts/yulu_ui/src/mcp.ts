import type { IncomingMessage, ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { appRouter } from "./routers/_app.js";
import { createCaller, type AppContext } from "./trpc.js";
import { ipcSend } from "./ipc.js";
import { isTrustedNotionUrl, isValidNotionPageId } from "./notionDelivery.js";
import { RecordingPipelinePolicyDisabledError } from "./recordingPipeline.js";
import { applyGlossaryContract, loadGlossaryContract } from "./glossaryContract.js";

const exec = promisify(execFile) as (cmd: string, args: string[], opts?: object) => Promise<{ stdout: string; stderr: string }>;

export const YULU_MCP_PATH = "/mcp";
export const RECORDING_ARTIFACT_MCP_PATH = "/mcp/recording-artifact";
export const RECORDING_DELIVERY_MCP_PATH = "/mcp/recording-delivery";

function mcpRequestPath(req: IncomingMessage): string {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`).pathname;
}

export function isMcpRequest(req: IncomingMessage): boolean {
  return [YULU_MCP_PATH, RECORDING_ARTIFACT_MCP_PATH, RECORDING_DELIVERY_MCP_PATH]
    .includes(mcpRequestPath(req));
}

export async function handleMcpRequest(req: IncomingMessage, res: ServerResponse, ctx: AppContext): Promise<void> {
  if (!isLocalHost(req) || !isAuthorized(req, ctx.paths.mcpTokenJson)) {
    res.writeHead(isLocalHost(req) ? 401 : 403, { "WWW-Authenticate": "Bearer" });
    res.end(isLocalHost(req) ? "unauthorized" : "forbidden");
    return;
  }
  if (req.method === "GET" || req.method === "DELETE") {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }));
    return;
  }

  const path = mcpRequestPath(req);
  const server = path === RECORDING_ARTIFACT_MCP_PATH
    ? recordingArtifactMcpServer(ctx)
    : path === RECORDING_DELIVERY_MCP_PATH
      ? recordingDeliveryMcpServer(ctx)
      : yuluMcpServer(ctx);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
  } catch (exc) {
    if (!res.headersSent) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: (exc as Error).message }, id: null }));
    }
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

export function yuluMcpServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: "yulu", version: "1.0.0" });
  const caller = createCaller(appRouter, ctx);
  const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
  const resource = (uri: string, value: unknown, mimeType = "application/json") => ({
    contents: [{ uri, mimeType, text: mimeType === "application/json" ? JSON.stringify(value, null, 2) : String(value ?? "") }],
  });
  const safeRecording = (value: Record<string, unknown>) => {
    const { wavPath: _wavPath, ...rest } = value;
    return rest;
  };

  server.registerTool("recording_status", { description: "Get live recording status." }, async () => {
    try { return json(await ipcSend(ctx.paths.audioDaemonSock, { action: "status" })); }
    catch { return json(await caller.recording.state()); }
  });
  server.registerTool("recording_start", {
    description: "Start a Yulu recording.",
    inputSchema: { title: z.string().max(200).optional() },
  }, async ({ title }) => json(await runRecordAudio(ctx, ["start", title?.trim() || "未命名会议"])));
  server.registerTool("recording_stop", { description: "Stop the active Yulu recording." }, async () =>
    json(await stopRecordingAndEnqueue(ctx)));

  server.registerTool("recordings_list", {
    description: "List recordings.",
    inputSchema: { limit: z.number().int().positive().max(500).optional(), since: z.number().int().nonnegative().optional() },
  }, async (input) => json(await caller.recordings.list(input)));
  server.registerTool("recording_get", {
    description: "Read recording metadata, transcript, summary, tags, speakers, durable Agent task, and delivery state. Audio bytes are not returned.",
    inputSchema: { stem: z.string().min(1) },
  }, async ({ stem }) => json(safeRecording(await caller.recordings.get({ stem }))));
  registerRecordingTaskGet(server, ctx, json);
  registerRecordingArtifactTools(server, ctx, json);
  registerRecordingDeliveryTools(server, ctx, json);
  server.registerTool("recording_search", {
    description: "Search Yulu transcripts and summaries.",
    inputSchema: {
      query: z.string().min(1).max(200),
      since: z.string().optional(),
      kinds: z.array(z.enum(["meeting_summary", "meeting_transcript"])).optional(),
      limit: z.number().int().positive().max(100).optional(),
    },
  }, async (input) => json(await caller.search.run(input)));

  server.registerTool("recording_rename", { inputSchema: { stem: z.string().min(1), title: z.string().max(200) } }, async (input) => json(await caller.recordings.rename(input)));
  server.registerTool("recording_set_tags", { inputSchema: { stem: z.string().min(1), tags: z.array(z.string()).max(50) } }, async (input) => json(await caller.recordings.setTags(input)));
  server.registerTool("speaker_rename", { inputSchema: { stem: z.string().min(1), speakerId: z.string().min(1), displayName: z.string().max(80) } }, async (input) => json(await caller.recordings.renameSpeaker(input)));
  server.registerTool("speaker_merge", { inputSchema: { stem: z.string().min(1), fromSpeakerId: z.string().min(1), toSpeakerId: z.string().min(1) } }, async (input) => json(await caller.recordings.mergeSpeakers(input)));
  server.registerTool("speaker_assign_segment", { inputSchema: { stem: z.string().min(1), segmentIndex: z.number().int().nonnegative(), speakerId: z.string().min(1) } }, async (input) => json(await caller.recordings.assignSegmentSpeaker(input)));
  server.registerTool("prompts_list", { inputSchema: { category: z.enum(["summary", "cleanup", "voice"]).optional() } }, async (input) => json(await caller.prompts.list(input)));
  server.registerTool("prompt_get", { inputSchema: { id: z.string().min(1) } }, async (input) => json(await caller.prompts.get(input)));
  server.registerTool("prompt_create", { inputSchema: { slug: z.string(), name: z.string().min(1), category: z.enum(["summary", "cleanup", "voice"]), content: z.string().min(1), isAutoRun: z.boolean().optional() } }, async (input) => json(await caller.prompts.create(input)));
  server.registerTool("prompt_update", { inputSchema: { id: z.string().min(1), name: z.string().optional(), slug: z.string().optional(), category: z.enum(["summary", "cleanup", "voice"]).optional(), content: z.string().optional(), isAutoRun: z.boolean().optional() } }, async (input) => json(await caller.prompts.update(input)));
  server.registerTool("prompt_delete", { inputSchema: { id: z.string().min(1) } }, async (input) => json(await caller.prompts.delete(input)));

  server.registerTool("glossary_list", {}, async () => json(await caller.glossary.list()));
  server.registerTool("glossary_add", { inputSchema: { term: z.string().min(1).max(200), canonical: z.string().min(1).max(200).optional(), scope: z.enum(["prompt", "replace", "both"]).optional(), notes: z.string().optional() } }, async (input) => json(await caller.glossary.add(input)));
  server.registerTool("glossary_update", { inputSchema: { id: z.string().min(1), term: z.string().optional(), canonical: z.string().optional(), scope: z.enum(["prompt", "replace", "both"]).optional(), notes: z.string().nullable().optional() } }, async (input) => json(await caller.glossary.update(input)));
  server.registerTool("glossary_delete", { inputSchema: { id: z.string().min(1) } }, async (input) => json(await caller.glossary.delete(input)));

  server.registerTool("health_check", {}, async () => json(await caller.doctor.run()));

  server.registerResource("recordings", "yulu://recordings", { mimeType: "application/json" }, async (uri) => resource(uri.href, await caller.recordings.list({ limit: 100 })));
  server.registerResource("prompts", "yulu://prompts", { mimeType: "application/json" }, async (uri) => resource(uri.href, await caller.prompts.list({})));
  server.registerResource("glossary", "yulu://glossary", { mimeType: "application/json" }, async (uri) => resource(uri.href, await caller.glossary.list()));
  server.registerResource("health", "yulu://health", { mimeType: "application/json" }, async (uri) => resource(uri.href, await caller.doctor.run()));
  server.registerResource("search", new ResourceTemplate("yulu://search{?q}", { list: undefined }), { mimeType: "application/json" }, async (uri) => {
    const q = uri.searchParams.get("q")?.trim();
    return resource(uri.href, q ? await caller.search.run({ query: q, limit: 20 }) : { hits: [] });
  });
  server.registerResource("recording", new ResourceTemplate("yulu://recordings/{stem}", { list: undefined }), { mimeType: "application/json" }, async (uri, vars) =>
    resource(uri.href, safeRecording(await caller.recordings.get({ stem: String(vars.stem ?? "") }))));
  server.registerResource("recording_transcript", new ResourceTemplate("yulu://recordings/{stem}/transcript", { list: undefined }), { mimeType: "text/plain" }, async (uri, vars) => {
    const rec = await caller.recordings.get({ stem: String(vars.stem ?? "") });
    return resource(uri.href, rec.transcript ?? rec.realtime ?? "", "text/plain");
  });
  server.registerResource("recording_summary", new ResourceTemplate("yulu://recordings/{stem}/summary", { list: undefined }), { mimeType: "text/markdown" }, async (uri, vars) => {
    const rec = await caller.recordings.get({ stem: String(vars.stem ?? "") });
    return resource(uri.href, rec.summary ?? "", "text/markdown");
  });

  return server;
}

type McpJsonResult = { content: Array<{ type: "text"; text: string }> };

function taskJson(ctx: AppContext, taskId: string): Record<string, unknown> {
  const task = ctx.host.getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  return {
    id: task.id,
    recordingStem: task.recordingStem,
    state: task.state,
    phase: task.phase,
    sendToNotion: task.sendToNotion,
    destinationHint: task.destinationHint,
    attempt: task.attempt,
    error: task.error,
  };
}

function requireTaskLease(ctx: AppContext, taskId: string, leaseToken: string) {
  const task = ctx.host.getTask(taskId);
  if (!task) throw new Error(`task not found: ${taskId}`);
  if (!task.leaseToken || task.leaseToken !== leaseToken) {
    throw new Error(`stale lease for task ${taskId}`);
  }
  return task;
}

function registerRecordingTaskGet(
  server: McpServer,
  ctx: AppContext,
  json: (value: unknown) => McpJsonResult,
): void {
  server.registerTool("recording_task_get", {
    description: "Get the durable state of a Yulu Agent task.",
    inputSchema: { taskId: z.string().uuid() },
  }, async ({ taskId }) => json(taskJson(ctx, taskId)));
}

function registerRecordingArtifactTools(
  server: McpServer,
  ctx: AppContext,
  json: (value: unknown) => McpJsonResult,
): void {
  server.registerTool("recording_task_progress", {
    description: "Report semantic progress for the active leased recording task.",
    inputSchema: {
      taskId: z.string().uuid(),
      leaseToken: z.string().uuid(),
      phase: z.enum(["transcribing", "summarizing", "committing_artifacts"]),
      message: z.string().max(1000).optional(),
    },
  }, async ({ taskId, leaseToken, phase, message }) =>
    json(ctx.host.recordProgress(taskId, leaseToken, phase, message)));
  server.registerTool("recording_task_transcript_read", {
    description: "Read only this leased task's Host-staged transcript. No filesystem path is exposed.",
    inputSchema: { taskId: z.string().uuid(), leaseToken: z.string().uuid() },
  }, async ({ taskId, leaseToken }) => {
    const task = requireTaskLease(ctx, taskId, leaseToken);
    if (!["running", "transcript_committed"].includes(task.state)) {
      throw new Error(`task ${taskId} cannot read its transcript from ${task.state}`);
    }
    return json({ taskId, transcript: ctx.artifacts.readStagedTranscript(taskId) });
  });
  server.registerTool("recording_task_summary_stage", {
    description: "Stage the final Markdown summary for this leased task through the Host.",
    inputSchema: {
      taskId: z.string().uuid(),
      leaseToken: z.string().uuid(),
      summary: z.string().min(1).max(2 * 1024 * 1024),
    },
  }, async ({ taskId, leaseToken, summary }) => {
    const task = requireTaskLease(ctx, taskId, leaseToken);
    if (!["running", "transcript_committed"].includes(task.state)) {
      throw new Error(`task ${taskId} cannot stage a summary from ${task.state}`);
    }
    const corrected = applyGlossaryContract(summary, loadGlossaryContract(ctx.db?.vocab));
    ctx.artifacts.writeStagedSummary(taskId, corrected);
    return json({ ok: true, taskId, bytes: Buffer.byteLength(corrected.trim() + "\n", "utf8") });
  });
  server.registerTool("recording_artifact_commit", {
    description: "Atomically commit the fixed task-scoped transcript.txt and summary.md staging files into Yulu.",
    inputSchema: {
      taskId: z.string().uuid(),
      leaseToken: z.string().uuid(),
      provenance: z.record(z.unknown()).optional(),
    },
  }, async ({ taskId, leaseToken, provenance }) => {
    const task = ctx.host.recordProgress(taskId, leaseToken, "committing_artifacts", "Agent requested artifact commit");
    const {
      nativeSessionId: _nativeSessionId,
      artifactSessionId: _artifactSessionId,
      deliverySessionId: _deliverySessionId,
      ...safeProvenance
    } = provenance ?? {};
    const records = ctx.artifacts.commitFromWorkspace(task, {
      ...safeProvenance,
      agentProvider: task.agentProvider,
      committedBy: "yulu-host",
    });
    const updated = ctx.host.recordArtifacts(taskId, leaseToken, records);
    ctx.pubsub.publish("recordings-changed", { reason: "changed" });
    return json({
      ok: true,
      taskId,
      state: updated.state,
      artifacts: records.map((record) => ({ kind: record.kind, sha256: record.sha256, bytes: record.bytes })),
    });
  });
}

function registerRecordingDeliveryTools(
  server: McpServer,
  ctx: AppContext,
  json: (value: unknown) => McpJsonResult,
): void {
  server.registerTool("recording_committed_summary_read", {
    description: "Read the committed summary only after verifying its Host artifact record and SHA-256 hash.",
    inputSchema: { taskId: z.string().uuid(), leaseToken: z.string().uuid() },
  }, async ({ taskId, leaseToken }) => {
    const task = requireTaskLease(ctx, taskId, leaseToken);
    if (!["artifacts_committed", "sending"].includes(task.state)) {
      throw new Error(`task ${taskId} cannot read its committed summary from ${task.state}`);
    }
    const summary = ctx.host.listArtifacts(taskId).find((record) => record.kind === "summary");
    if (!summary) throw new Error("committed summary artifact record is missing");
    return json({ taskId, summary: ctx.artifacts.readCommittedSummary(task, summary), sha256: summary.sha256 });
  });
  server.registerTool("recording_begin_notion_delivery", {
    description: "Authorize the active leased task to begin its configured Notion side effect after artifacts are committed.",
    inputSchema: { taskId: z.string().uuid(), leaseToken: z.string().uuid() },
  }, async ({ taskId, leaseToken }) => json(ctx.host.beginNotionDelivery(taskId, leaseToken)));
  server.registerTool("recording_commit_notion_delivery", {
    description: "Record a Notion delivery result after Hermes' own Notion connector reports success.",
    inputSchema: {
      taskId: z.string().uuid(),
      leaseToken: z.string().uuid(),
      url: z.string().url().max(2000).refine(isTrustedNotionUrl, "URL must use HTTPS on an approved Notion host").optional(),
      pageId: z.string().max(36).refine(isValidNotionPageId, "page ID must be 32-character hex or UUID").optional(),
      detail: z.string().max(2000).optional(),
    },
  }, async ({ taskId, leaseToken, url, pageId, detail }) =>
    json(ctx.host.recordNotionDelivery(taskId, leaseToken, { url, pageId, detail })));
}

function phaseJson(value: unknown): McpJsonResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function recordingArtifactMcpServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: "yulu-recording-artifact", version: "1.0.0" });
  registerRecordingTaskGet(server, ctx, phaseJson);
  registerRecordingArtifactTools(server, ctx, phaseJson);
  return server;
}

export function recordingDeliveryMcpServer(ctx: AppContext): McpServer {
  const server = new McpServer({ name: "yulu-recording-delivery", version: "1.0.0" });
  registerRecordingTaskGet(server, ctx, phaseJson);
  registerRecordingDeliveryTools(server, ctx, phaseJson);
  return server;
}

function isLocalHost(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  const hostname = host.split(":")[0] ?? "";
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

function isAuthorized(req: IncomingMessage, tokenPath: string): boolean {
  return isAuthorizedToken(
    tokenPath,
    headerValue(req.headers.authorization),
    headerValue(req.headers["x-yulu-mcp-token"]),
  );
}

export function isAuthorizedToken(tokenPath: string, authorization = "", xToken = ""): boolean {
  if (!existsSync(tokenPath)) return false;
  let token = "";
  try {
    const raw = JSON.parse(readFileSync(tokenPath, "utf8")) as { token?: unknown };
    token = typeof raw.token === "string" ? raw.token : "";
  } catch {
    return false;
  }
  const candidate = bearerToken(authorization) || xToken.trim();
  if (!token || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

function bearerToken(value: string | string[] | undefined): string {
  const text = headerValue(value);
  const match = /^Bearer\s+(.+)$/i.exec(text);
  return match?.[1]?.trim() ?? "";
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

async function runRecordAudio(ctx: AppContext, args: string[]) {
  const { stdout, stderr } = await exec("python3", [join(ctx.paths.scriptDir, "record_audio.py"), ...args], {
    env: { ...process.env, PYTHONPATH: ctx.paths.scriptDir },
    cwd: process.env.HOME,
  });
  return { ok: true as const, stdout, stderr };
}

type RecordingStopContext = Pick<AppContext, "config" | "recordingPipeline">;
type RecordingStopResult = { ok: true; stdout: string; stderr: string };

function finalRecordingPath(stdout: string): string | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("FINAL_RECORDING_PATH=")) continue;
    const path = line.slice("FINAL_RECORDING_PATH=".length).trim();
    if (path) return path;
  }
  return undefined;
}

function autoSendNotion(ctx: RecordingStopContext): boolean {
  return ctx.config.read().agent_pipeline.auto_send_notion;
}

export async function stopRecordingAndEnqueue(
  ctx: AppContext,
  stopRecording: () => Promise<RecordingStopResult> = () => runRecordAudio(ctx, ["stop"]),
) {
  const result = await stopRecording();
  const audioPath = finalRecordingPath(result.stdout);
  if (!audioPath) throw new Error("recording stopped but FINAL_RECORDING_PATH was missing");
  const sendToNotion = autoSendNotion(ctx);
  let enqueued;
  try {
    enqueued = ctx.recordingPipeline.enqueueCompletion({ audioPath, sendToNotion });
  } catch (error) {
    if (error instanceof RecordingPipelinePolicyDisabledError) {
      return {
        ...result,
        pipeline: {
          accepted: false as const,
          permanent: true as const,
          reason: error.message,
          sendToNotion,
        },
      };
    }
    throw error;
  }
  return {
    ...result,
    pipeline: {
      taskId: enqueued.task.id,
      state: enqueued.task.state,
      created: enqueued.created,
      sendToNotion,
    },
  };
}
