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

const exec = promisify(execFile) as (cmd: string, args: string[], opts?: object) => Promise<{ stdout: string; stderr: string }>;

export function isMcpRequest(req: IncomingMessage): boolean {
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`).pathname === "/mcp";
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

  const server = yuluMcpServer(ctx);
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
  server.registerTool("recording_stop", { description: "Stop the active Yulu recording." }, async () => json(await runRecordAudio(ctx, ["stop"])));

  server.registerTool("recordings_list", {
    description: "List recordings.",
    inputSchema: { limit: z.number().int().positive().max(500).optional(), since: z.number().int().nonnegative().optional() },
  }, async (input) => json(await caller.recordings.list(input)));
  server.registerTool("recording_get", {
    description: "Read recording metadata, transcript, realtime transcript, summary, tags, speakers, and share state. Audio bytes are not returned.",
    inputSchema: { stem: z.string().min(1) },
  }, async ({ stem }) => json(safeRecording(await caller.recordings.get({ stem }))));
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
  server.registerTool("recording_transcribe", {
    inputSchema: {
      stem: z.string().min(1),
      diarizationNumSpeakers: z.number().int().min(1).max(8).nullable().optional(),
      transcriptionModel: z.object({ engine: z.enum(["mlx", "whisper", "hermes"]), model: z.string().min(1).optional() }).nullable().optional(),
    },
  }, async (input) => json(await caller.recordings.transcribe(input)));
  server.registerTool("recording_summarize", { inputSchema: { stem: z.string().min(1), promptId: z.string().nullable().optional() } }, async (input) => json(await caller.recordings.summarize(input)));
  server.registerTool("summary_send", { inputSchema: { stem: z.string().min(1), channel: z.enum(["notion", "zulip"]) } }, async (input) => json(await caller.recordings.sendSummary(input)));

  server.registerTool("prompts_list", { inputSchema: { category: z.enum(["summary", "cleanup", "voice"]).optional() } }, async (input) => json(await caller.prompts.list(input)));
  server.registerTool("prompt_get", { inputSchema: { id: z.string().min(1) } }, async (input) => json(await caller.prompts.get(input)));
  server.registerTool("prompt_create", { inputSchema: { slug: z.string(), name: z.string().min(1), category: z.enum(["summary", "cleanup", "voice"]), content: z.string().min(1), isAutoRun: z.boolean().optional() } }, async (input) => json(await caller.prompts.create(input)));
  server.registerTool("prompt_update", { inputSchema: { id: z.string().min(1), name: z.string().optional(), slug: z.string().optional(), category: z.enum(["summary", "cleanup", "voice"]).optional(), content: z.string().optional(), isAutoRun: z.boolean().optional() } }, async (input) => json(await caller.prompts.update(input)));
  server.registerTool("prompt_delete", { inputSchema: { id: z.string().min(1) } }, async (input) => json(await caller.prompts.delete(input)));

  server.registerTool("glossary_list", {}, async () => json(await caller.glossary.list()));
  server.registerTool("glossary_add", { inputSchema: { term: z.string().min(1).max(200), canonical: z.string().min(1).max(200).optional(), scope: z.enum(["prompt", "replace", "both"]).optional(), notes: z.string().optional() } }, async (input) => json(await caller.glossary.add(input)));
  server.registerTool("glossary_update", { inputSchema: { id: z.string().min(1), term: z.string().optional(), canonical: z.string().optional(), scope: z.enum(["prompt", "replace", "both"]).optional(), notes: z.string().nullable().optional() } }, async (input) => json(await caller.glossary.update(input)));
  server.registerTool("glossary_delete", { inputSchema: { id: z.string().min(1) } }, async (input) => json(await caller.glossary.delete(input)));

  server.registerTool("queue_list", {}, async () => json(await caller.queue.list()));
  server.registerTool("queue_retry", { inputSchema: { id: z.string().min(1) } }, async (input) => json(await caller.queue.retry(input)));
  server.registerTool("queue_cancel", { inputSchema: { id: z.string().min(1) } }, async (input) => json(await caller.queue.cancel(input)));
  server.registerTool("queue_clear_stale", {}, async () => json(await caller.queue.clearStale()));
  server.registerTool("health_check", {}, async () => json(await caller.doctor.run()));

  server.registerResource("recordings", "yulu://recordings", { mimeType: "application/json" }, async (uri) => resource(uri.href, await caller.recordings.list({ limit: 100 })));
  server.registerResource("prompts", "yulu://prompts", { mimeType: "application/json" }, async (uri) => resource(uri.href, await caller.prompts.list({})));
  server.registerResource("glossary", "yulu://glossary", { mimeType: "application/json" }, async (uri) => resource(uri.href, await caller.glossary.list()));
  server.registerResource("queue", "yulu://queue", { mimeType: "application/json" }, async (uri) => resource(uri.href, await caller.queue.list()));
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

function isLocalHost(req: IncomingMessage): boolean {
  const host = req.headers.host ?? "";
  const hostname = host.split(":")[0] ?? "";
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

function isAuthorized(req: IncomingMessage, tokenPath: string): boolean {
  if (!existsSync(tokenPath)) return false;
  let token = "";
  try {
    const raw = JSON.parse(readFileSync(tokenPath, "utf8")) as { token?: unknown };
    token = typeof raw.token === "string" ? raw.token : "";
  } catch {
    return false;
  }
  const candidate = bearerToken(req.headers.authorization) || headerValue(req.headers["x-yulu-mcp-token"]);
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
  return { ok: true, stdout, stderr };
}
