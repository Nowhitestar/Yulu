import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import { createReadStream, statSync, existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { Readable } from "node:stream";
import { appRouter } from "./routers/_app.js";
import { ConfigManager } from "./config.js";
import { LaunchctlClient } from "./launchctl.js";
import { openDb } from "./db.js";
import { appPubSub } from "./pubsub.js";
import { paths } from "./paths.js";
import { mountWsMultiplexer } from "./ws.js";
import { startInboxWatcher } from "./inboxWatcher.js";
import { startLogTailer } from "./logTailer.js";
import { serveStaticFile } from "./staticFile.js";
import { homedir } from "node:os";
import type { AppContext } from "./trpc.js";
import { resolveAgentRuntime } from "./agentRuntime.js";
import { runAgentCliCommand } from "./agentCliRunner.js";
import { ensureBackgroundAgentSession } from "./agentSessionStore.js";
import { createCaller } from "./trpc.js";
import { handleMcpRequest, isAuthorizedToken, isMcpRequest } from "./mcp.js";
import { HostStore } from "./hostStore.js";
import { ArtifactStore } from "./artifactStore.js";
import { AgentUnavailableError } from "./agentGateway.js";
import {
  InvalidRecordingCompletionError,
  InvalidTranscriptionInputError,
  RecordingPipeline,
  RecordingPipelinePolicyDisabledError,
} from "./recordingPipeline.js";
import { startRecordingEventInbox } from "./recordingEventInbox.js";
import { migrateLegacyAgentQueue } from "./legacyQueueMigration.js";
import { acquireHostInstanceLock, type HostInstanceLock } from "./hostInstanceLock.js";
import { RealtimeTranscriptionCoordinator } from "./realtimeTranscription.js";
import { LocalCaptionManager } from "./localCaptionManager.js";
import { applyGlossaryContract, loadGlossaryContract } from "./glossaryContract.js";
import {
  KeychainProviderSecretStore,
  KeychainXaiTokenStore,
  XaiCredentialManager,
} from "./xaiCredentials.js";
import { XaiAudioClient } from "./xaiAudio.js";
import { hasCurrentXaiTranscriptionConsent } from "./transcriptionConsent.js";
import { XaiTextClient } from "./xaiText.js";
import { AudioTranscriptionService } from "./audioTranscription.js";
import { createXaiProviderReadiness } from "./routers/providers.js";
import { AgentConnectionCenter } from "./agentConnections.js";
import { discoverAgentConnectionCandidates } from "./agentConnectionDiscovery.js";
import { CodexAgentAdapter } from "./codexAgentAdapter.js";
import { CodexAppServerRuntimeClient } from "./codexAppServerClient.js";
import { ClaudeCodeAdapter } from "./claudeCodeAdapter.js";
import { ClaudeCodeCliRuntimeClient } from "./claudeCodeCliClient.js";
import { CliProxyApiAdapter, SecureGatewayTransport } from "./cliProxyApiAdapter.js";
import { ConversationOnlyAgentAdapter } from "./conversationOnlyAgentAdapter.js";
import { ConversationOnlyCliRuntimeClient } from "./conversationOnlyCliClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export interface RunningServer {
  http: HttpServer;
  address: { port: number };
  close: () => Promise<void>;
}

type RuntimePaths = typeof paths;

export async function startServer(pathOverrides: Partial<RuntimePaths> = {}): Promise<RunningServer> {
  const port = Number(process.env.YULU_UI_PORT ?? 7777);
  const host = "127.0.0.1";
  const runtimePaths = {
    ...paths,
    ...pathOverrides,
    hostDb: pathOverrides.hostDb ?? (pathOverrides.configDir ? join(pathOverrides.configDir, "host.sqlite") : paths.hostDb),
    agentTasksDir: pathOverrides.agentTasksDir ?? (pathOverrides.configDir ? join(pathOverrides.configDir, "agent-tasks") : paths.agentTasksDir),
    recordingEventsDir: pathOverrides.recordingEventsDir ?? (pathOverrides.configDir ? join(pathOverrides.configDir, "recording-events") : paths.recordingEventsDir),
    agentQueueJson: pathOverrides.agentQueueJson ?? (pathOverrides.configDir ? join(pathOverrides.configDir, "agent-queue.json") : paths.agentQueueJson),
  } as RuntimePaths;
  const launchAgents = runtimePaths.launchAgentsDir;

  const instanceLock = acquireHostInstanceLock(runtimePaths.configDir);
  try {
    return await startLockedServer(runtimePaths, { port, host, launchAgents, instanceLock });
  } catch (error) {
    instanceLock.release();
    throw error;
  }
}

async function startLockedServer(
  runtimePaths: RuntimePaths,
  options: { port: number; host: string; launchAgents: string; instanceLock: HostInstanceLock },
): Promise<RunningServer> {
  const { port, host, launchAgents, instanceLock } = options;
  const uiToken = randomBytes(32).toString("base64url");

  // Lazy DB getters so /healthz works even when the SQLite files aren't present yet
  let _prompts: ReturnType<typeof openDb> | null = null;
  let _vocab: ReturnType<typeof openDb> | null = null;
  let _search: ReturnType<typeof openDb> | null = null;
  const dbProxy: AppContext["db"] = {
    get prompts() { return (_prompts ??= openDb(runtimePaths.promptsDb)); },
    get vocab()   { return (_vocab ??= openDb(runtimePaths.vocabDb)); },
    get search()  { return (_search ??= openDb(runtimePaths.searchDb)); },
  };

  const configManager = new ConfigManager(runtimePaths.configFile);
  const hostStore = new HostStore(runtimePaths.hostDb);
  const artifactStore = new ArtifactStore(runtimePaths.moviesDir, runtimePaths.agentTasksDir);
  const retiredLegacyTaskIds = hostStore.retireLegacyImportedTasks();
  for (const taskId of retiredLegacyTaskIds) {
    try { artifactStore.cleanupWorkspace(taskId); } catch { /* best effort */ }
  }
  if (retiredLegacyTaskIds.length > 0) {
    console.warn(`[yulu_ui] retired ${retiredLegacyTaskIds.length} imported legacy queue tasks without execution`);
  }
  const activeWorkspaceStates = new Set([
    "queued", "awaiting_agent", "awaiting_policy", "running", "transcript_committed", "artifacts_committed", "sending", "delivery_reported",
    "execution_unverified",
  ]);
  const activeWorkspaceTaskIds = hostStore.listTasks(10_000)
    .filter((task) => activeWorkspaceStates.has(task.state))
    .map((task) => task.id);
  const cleanedWorkspaces = artifactStore.cleanupInactiveWorkspaces(activeWorkspaceTaskIds);
  if (cleanedWorkspaces.length > 0) {
    console.warn(`[yulu_ui] cleaned ${cleanedWorkspaces.length} inactive Agent task workspaces`);
  }
  const localCaption = new LocalCaptionManager({
    scriptDir: runtimePaths.scriptDir,
    configDir: runtimePaths.configDir,
    selected: () => configManager.read().transcription.engine === "local",
  });
  const xaiKeychainHelper = join(runtimePaths.scriptDir, "Yulu.app", "Contents", "MacOS", "xai_keychain");
  const xaiCredentials = new XaiCredentialManager({
    store: new KeychainXaiTokenStore(xaiKeychainHelper),
    apiKeyStore: new KeychainProviderSecretStore(xaiKeychainHelper, "direct.xai"),
  });
  const gatewaySecretStore = (credentialIdentity: string) =>
    new KeychainProviderSecretStore(xaiKeychainHelper, credentialIdentity);
  const gatewayTransport = new SecureGatewayTransport();
  const xaiAudio = new XaiAudioClient(xaiCredentials);
  const xaiText = new XaiTextClient(xaiCredentials);
  const xaiReadiness = createXaiProviderReadiness();
  const audioTranscription = new AudioTranscriptionService(
    configManager,
    localCaption,
    xaiAudio,
    () => hasCurrentXaiTranscriptionConsent(hostStore),
  );
  const agentConnections = new AgentConnectionCenter({
    config: configManager,
    host: hostStore,
    configDir: runtimePaths.configDir,
    credentials: xaiCredentials,
    audio: audioTranscription,
    text: xaiText,
    readiness: xaiReadiness,
    discover: discoverAgentConnectionCandidates,
    codexAdapter: (executable) => new CodexAgentAdapter({
      executable,
      client: new CodexAppServerRuntimeClient({
        executable,
        cwd: runtimePaths.moviesDir,
      }),
    }),
    claudeAdapter: (executable) => new ClaudeCodeAdapter({
      executable,
      client: new ClaudeCodeCliRuntimeClient({
        executable,
        cwd: runtimePaths.moviesDir,
      }),
    }),
    conversationOnlyAdapter: (adapter, executable) => new ConversationOnlyAgentAdapter({
      adapter,
      executable,
      client: new ConversationOnlyCliRuntimeClient({
        adapter,
        executable,
        cwd: runtimePaths.moviesDir,
      }),
    }),
    gatewaySecretStore,
    cliProxyAdapter: ({ endpoint, httpsApproved, credentialIdentity }) => new CliProxyApiAdapter({
      endpoint,
      httpsApproved,
      secrets: gatewaySecretStore(credentialIdentity),
      transport: gatewayTransport,
    }),
  });
  const supportedAgentSummaryAdapter = agentConnections.summaryAdapter();
  void xaiCredentials.status().catch(() => {});
  const recordingPipeline = new RecordingPipeline({
    store: hostStore,
    artifacts: artifactStore,
    config: configManager,
    paths: runtimePaths,
    pubsub: appPubSub,
    promptDb: () => dbProxy.prompts,
    vocabDb: () => dbProxy.vocab,
    transcription: audioTranscription,
    xaiText,
    xaiSummaryCredentialSource: () => {
      const proof = xaiReadiness.get("summary");
      return proof?.status === "ready" ? proof.credentialSource : null;
    },
    supportedAgentSummaryAdapter,
  });
  if (localCaption.status().installed && configManager.read().transcription.engine === "local") {
    void localCaption.warm().catch((error) => {
      console.warn(`[yulu_ui] local caption warm-up failed: ${(error as Error).message}`);
    });
  }
  const realtimeTranscription = new RealtimeTranscriptionCoordinator({
    pubsub: appPubSub,
    streaming: audioTranscription,
    stabilize: (text) => applyGlossaryContract(text, loadGlossaryContract(dbProxy.vocab)),
    transcribe: (audioPath, language) => recordingPipeline.transcribeOnDemand({ audioPath, language }),
    warm: async () => { await recordingPipeline.warmTranscription(); },
    translate: async (sourceText, targetLanguage, context) => {
      const configuredHome = process.env.YULU_HERMES_HOME?.trim() || process.env.HERMES_HOME?.trim();
      const hermesHome = configuredHome?.startsWith("~/")
        ? join(homedir(), configuredHome.slice(2))
        : configuredHome || join(homedir(), ".hermes");
      const python = join(hermesHome, "hermes-agent", "venv", "bin", "python");
      if (!existsSync(python)) throw new AgentUnavailableError("Hermes Agent runtime is unavailable");
      const result = await runAgentCliCommand({
        runtime: {
          provider: "custom",
          label: "Hermes live-caption translation",
          source: "auto-detected",
          command: [python, "realtime_translate.py"],
          cwd: runtimePaths.moviesDir,
          disabledReason: null,
        },
        scriptDir: runtimePaths.scriptDir,
        configDir: runtimePaths.configDir,
        timeoutMs: 10_000,
        prompt: JSON.stringify({ sourceText, targetLanguage, context }),
      });
      const translated = result.stdout.trim().replace(/^```(?:\w+)?\s*|\s*```$/g, "").trim();
      if (result.code !== 0 || !translated) {
        throw new Error((result.stderr || result.stdout || "realtime translation failed").trim());
      }
      return translated;
    },
    defaultTargetLanguage: () => configManager.read().transcription.dictation.target_language || "English",
    defaultTranslationEnabled: false,
    allowedRoots: [runtimePaths.moviesDir, join(runtimePaths.configDir, "dictation")],
  });
  try {
    const migration = migrateLegacyAgentQueue({
      queuePath: runtimePaths.agentQueueJson,
    });
    if (migration) {
      console.warn(
        `[yulu_ui] archived legacy Agent queue: retired=${migration.retiredPending} ` +
        `materialized=${migration.alreadyMaterialized} unresolvable=${migration.unresolvable} ` +
        `archive=${migration.archivePath}`,
      );
    }
  } catch (error) {
    console.warn(`[yulu_ui] legacy Agent queue migration failed; source preserved: ${(error as Error).message}`);
  }

  const ctx: AppContext = {
    config:    configManager,
    launchctl: new LaunchctlClient(launchAgents),
    pubsub:    appPubSub,
    paths:     runtimePaths,
    host:      hostStore,
    artifacts: artifactStore,
    recordingPipeline,
    localCaption,
    audioTranscription,
    xaiCredentials,
    xaiText,
    xaiReadiness,
    supportedAgentSummaryAdapter,
    agentConnections,
    db:        dbProxy,
  };

  try {
    const config = ctx.config.read();
    const runtime = resolveAgentRuntime(config, {
      scriptDir: runtimePaths.scriptDir,
      moviesDir: runtimePaths.moviesDir,
    });
    if (runtime.provider !== "none") {
      ensureBackgroundAgentSession(runtimePaths.configDir, {
        agent: runtime.provider,
        runtimeLabel: runtime.label,
      });
    }
  } catch (exc) {
    console.warn(`[yulu_ui] background Agent session not initialized: ${(exc as Error).message}`);
  }

  const app = new Hono();

  // Host header guard — even though we listen on 127.0.0.1 only, browsers
  // can rebind via DNS. Refuse anything but localhost/127.0.0.1.
  app.use("*", async (c, next) => {
    const h = c.req.header("host") ?? "";
    const hostname = h.split(":")[0] ?? "";
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return c.text("forbidden", 403);
    await next();
  });

  app.get("/healthz", (c) => c.json({ status: "ok", uptime: process.uptime() }));
  app.get("/api/ui-token", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({ token: uiToken });
  });

  const RecordingCompletionSchema = z.object({
    audioPath: z.string().min(1),
    title: z.string().max(200).optional(),
    sendToNotion: z.boolean().optional(),
    language: z.enum(["zh", "en", "ja", "auto"]).optional(),
  });
  app.post("/api/recordings/completed", async (c) => {
    if (!isAuthorizedToken(
      runtimePaths.mcpTokenJson,
      c.req.header("authorization") ?? "",
      c.req.header("x-yulu-mcp-token") ?? "",
    )) return c.json({ ok: false, error: "unauthorized" }, 401);
    let parsed: z.infer<typeof RecordingCompletionSchema>;
    try {
      parsed = RecordingCompletionSchema.parse(await c.req.json());
    } catch (error) {
      return c.json({ ok: false, error: "invalid_recording_completion", detail: (error as Error).message }, 400);
    }
    try {
      await realtimeTranscription.stop(parsed.audioPath);
      const result = recordingPipeline.enqueueCompletion(parsed);
      return c.json({
        ok: true,
        taskId: result.task.id,
        state: result.task.state,
        created: result.created,
      }, 202);
    } catch (error) {
      if (error instanceof RecordingPipelinePolicyDisabledError) {
        return c.json({
          ok: false,
          error: "recording_pipeline_policy_disabled",
          permanent: true,
          detail: error.message,
        }, 409);
      }
      if (error instanceof InvalidRecordingCompletionError) {
        return c.json({
          ok: false,
          error: "recording_completion_rejected",
          permanent: true,
          detail: error.message,
        }, 400);
      }
      return c.json({ ok: false, error: "recording_completion_failed", permanent: false, detail: (error as Error).message }, 503);
    }
  });

  const RealtimeStartSchema = z.object({
    audioPath: z.string().min(1),
    title: z.string().max(200).default(""),
    language: z.enum(["zh", "en", "ja", "auto"]),
    replaceActive: z.boolean().optional(),
  });
  const RealtimeStopSchema = z.object({ audioPath: z.string().min(1) });
  const RealtimeOptionsSchema = z.object({
    audioPath: z.string().min(1),
    targetLanguage: z.enum(["English", "日本語", "한국어", "Français", "Español", "Deutsch", "繁體中文"]),
    translationEnabled: z.boolean(),
  });
  app.post("/api/recordings/realtime/start", async (c) => {
    if (!isAuthorizedToken(runtimePaths.mcpTokenJson, c.req.header("authorization") ?? "")) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    try {
      const parsed = RealtimeStartSchema.parse(await c.req.json());
      await realtimeTranscription.start(parsed);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ ok: false, error: "realtime_start_failed", detail: (error as Error).message }, 400);
    }
  });
  app.post("/api/recordings/realtime/stop", async (c) => {
    if (!isAuthorizedToken(runtimePaths.mcpTokenJson, c.req.header("authorization") ?? "")) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    try {
      const parsed = RealtimeStopSchema.parse(await c.req.json());
      return c.json({ ok: true, result: await realtimeTranscription.stop(parsed.audioPath) });
    } catch (error) {
      return c.json({ ok: false, error: "realtime_stop_failed", detail: (error as Error).message }, 400);
    }
  });
  app.post("/api/recordings/realtime/options", async (c) => {
    if (!isAuthorizedToken(runtimePaths.mcpTokenJson, c.req.header("authorization") ?? "")) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    try {
      const parsed = RealtimeOptionsSchema.parse(await c.req.json());
      return c.json({ ok: true, result: await realtimeTranscription.updateOptions(parsed) });
    } catch (error) {
      return c.json({ ok: false, error: "realtime_options_failed", detail: (error as Error).message }, 400);
    }
  });

  const AudioTranscriptionSchema = z.object({
    audioPath: z.string().min(1),
    language: z.enum(["zh", "en", "ja", "auto"]).optional(),
  });
  app.post("/api/agent/transcription/warm", async (c) => {
    if (!isAuthorizedToken(runtimePaths.mcpTokenJson, c.req.header("authorization") ?? "")) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    try {
      const result = await recordingPipeline.warmTranscription();
      return c.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof AgentUnavailableError) {
        return c.json({ ok: false, error: "audio_engine_unavailable", detail: error.message }, 503);
      }
      return c.json({ ok: false, error: "audio_transcription_warm_failed", detail: (error as Error).message }, 502);
    }
  });

  app.post("/api/agent/transcribe", async (c) => {
    if (!isAuthorizedToken(runtimePaths.mcpTokenJson, c.req.header("authorization") ?? "")) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    let parsed: z.infer<typeof AudioTranscriptionSchema>;
    try {
      parsed = AudioTranscriptionSchema.parse(await c.req.json());
    } catch (error) {
      return c.json({ ok: false, error: "invalid_audio_transcription", detail: (error as Error).message }, 400);
    }
    try {
      const result = await recordingPipeline.transcribeOnDemand(parsed);
      return c.json({ ok: true, ...result });
    } catch (error) {
      if (error instanceof InvalidTranscriptionInputError) {
        return c.json({ ok: false, error: "invalid_audio_transcription", detail: error.message }, 400);
      }
      if (error instanceof AgentUnavailableError) {
        return c.json({ ok: false, error: "audio_engine_unavailable", detail: error.message }, 503);
      }
      return c.json({ ok: false, error: "audio_transcription_failed", detail: (error as Error).message }, 502);
    }
  });

  app.post("/api/voice-chat/ask", async (c) => {
    if (!isAuthorizedToken(runtimePaths.mcpTokenJson, c.req.header("authorization") ?? "")) {
      return c.json({ ok: false, error: "unauthorized" }, 401);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: "invalid_json" }, 400);
    }
    const input = typeof body === "object" && body !== null ? body as Record<string, unknown> : {};
    const question = String(input.question ?? "").trim();
    if (!question) return c.json({ ok: false, error: "question_required" }, 400);

    const config = ctx.config.read();
    const runtime = resolveAgentRuntime(config, {
      scriptDir: runtimePaths.scriptDir,
      moviesDir: runtimePaths.moviesDir,
    });
    const caller = createCaller(appRouter, { ...ctx, uiMutationAuthorized: true });
    const agent = runtime.provider === "none" ? "agent" : runtime.provider;
    const existingSessionId = typeof input.sessionId === "string" && input.sessionId.trim()
      ? input.sessionId.trim()
      : "";
    const defer = input.defer === true;
    const session = existingSessionId
      ? await caller.agentSessions.get({ id: existingSessionId })
      : await caller.agentSessions.create({ agent, title: question.slice(0, 48) });
    const sessionId = String(session?.id ?? existingSessionId);
    if (!sessionId) return c.json({ ok: false, error: "session_unavailable" }, 500);

    await caller.agentSessions.append({ sessionId, message: { role: "user", text: question } });
    const answerAndAppend = async () => {
      try {
        const answer = await caller.ask.ask({ question, limit: 8, sessionId });
        const assistantMessage = {
          role: "assistant" as const,
          text: String(answer.answer ?? ""),
          sources: answer.sources,
          remoteSources: answer.remoteSources,
          ...(answer.llmStatus === "error" && answer.llmError ? { error: String(answer.llmError) } : {}),
        };
        await caller.agentSessions.append({ sessionId, message: assistantMessage });
        return {
          answer: assistantMessage.text,
          llmStatus: answer.llmStatus,
          usedFallback: answer.usedFallback,
        };
      } catch (exc) {
        await caller.agentSessions.append({
          sessionId,
          message: { role: "assistant", text: "", error: (exc as Error).message },
        });
        throw exc;
      }
    };
    if (defer) {
      void answerAndAppend().catch((exc) => {
        console.error(`[voice-chat] deferred answer failed: ${(exc as Error).message}`);
      });
      return c.json({
        ok: true,
        deferred: true,
        sessionId,
        question,
        answer: "",
        url: `/voice-chat?session=${encodeURIComponent(sessionId)}`,
      });
    }
    const answer = await answerAndAppend();
    return c.json({
      ok: true,
      sessionId,
      question,
      answer: answer.answer,
      url: `/voice-chat?session=${encodeURIComponent(sessionId)}`,
      llmStatus: answer.llmStatus,
      usedFallback: answer.usedFallback,
    });
  });

  app.all("/trpc/*", (c) => fetchRequestHandler({
    endpoint: "/trpc",
    req: c.req.raw,
    router: appRouter,
    createContext: () => ({
      ...ctx,
      uiMutationAuthorized: matchesUiBearer(c.req.header("authorization") ?? "", uiToken),
    }),
    onError: ({ error, path }) => console.error(`[trpc] ${path}: ${error.message}`),
  }));

  app.get("/files/meetings/*",   (c) => streamAudio(c.req.raw, runtimePaths.moviesDir));

  // Looked up dynamically so tests can flip YULU_UI_DIST_WEB between cases.
  const distWebDir = () => process.env.YULU_UI_DIST_WEB ?? join(__dirname, "../dist/web");

  app.get("/favicon.svg", (c) => serveStaticFile(c.req.raw, distWebDir(), "favicon.svg"));
  app.get("/assets/*", (c) => serveStaticFile(c.req.raw, join(distWebDir(), "assets")));

  // SPA fallback — return index.html for any unmatched GET path so React
  // Router can handle client-side routing (e.g. /inbox, /health/daemons).
  // `app.notFound` catches everything not handled above, including deep
  // multi-segment paths where `app.get("*")` can be unreliable across Hono versions.
  app.notFound((c) => {
    if (c.req.method !== "GET") return c.text("not found", 404);
    const indexPath = join(distWebDir(), "index.html");
    if (!existsSync(indexPath)) {
      return c.text("UI not built — run `npm run build` or use `npm run dev:web`", 503);
    }
    return serveStaticFile(c.req.raw, distWebDir(), "index.html");
  });

  const http = createServer((req, res) => {
    if (isMcpRequest(req)) {
      void handleMcpRequest(req, res, ctx).catch((exc) => {
        if (!res.headersSent) res.writeHead(500);
        res.end((exc as Error).message);
      });
      return;
    }
    void bridgeNodeToFetch(req, res, (r) => Promise.resolve(app.fetch(r)));
  });

  const inboxWatcher = startInboxWatcher({
    moviesDir: runtimePaths.moviesDir,
    pubsub: appPubSub,
  });

  const logTailer = startLogTailer({
    configDir: runtimePaths.configDir,
    pubsub: appPubSub,
  });

  try {
    await listenHttp(http, port, host);
  } catch (error) {
    logTailer.stop();
    inboxWatcher.stop();
    try { await realtimeTranscription.close(); } catch { /* preserve the listen error */ }
    try { await recordingPipeline.close(); } catch { /* preserve the listen error */ }
    xaiCredentials.close();
    try { hostStore.close(); } catch { /* best effort */ }
    throw error;
  }
  let recordingEventInbox: ReturnType<typeof startRecordingEventInbox>;
  try {
    mountWsMultiplexer(http, appPubSub);
    recordingEventInbox = startRecordingEventInbox({
      dir: runtimePaths.recordingEventsDir,
      pipeline: recordingPipeline,
    });
    recordingPipeline.kick();
  } catch (error) {
    logTailer.stop();
    inboxWatcher.stop();
    try { await realtimeTranscription.close(); } catch { /* preserve the startup error */ }
    try { await recordingPipeline.close(); } catch { /* preserve the startup error */ }
    xaiCredentials.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    try { hostStore.close(); } catch { /* best effort */ }
    throw error;
  }
  const addr = http.address() as { port: number };
  let closePromise: Promise<void> | null = null;
  return {
    http,
    address: addr,
    close: () => {
      closePromise ??= (async () => {
        try {
          logTailer.stop();
          inboxWatcher.stop();
          recordingEventInbox.stop();
          await realtimeTranscription.close();
          await recordingPipeline.close();
          xaiCredentials.close();
          await new Promise<void>((resolve) => {
            let completed = false;
            const done = () => {
              if (completed) return;
              completed = true;
              clearTimeout(forceClose);
              resolve();
            };
            const forceClose = setTimeout(() => {
              http.closeAllConnections();
              done();
            }, 2_000);
            forceClose.unref();
            http.close(done);
          });
          _prompts?.close();
          _vocab?.close();
          _search?.close();
          hostStore.close();
        } finally {
          instanceLock.release();
        }
      })();
      return closePromise;
    },
  };
}

function matchesUiBearer(authorization: string, expected: string): boolean {
  const candidate = /^Bearer\s+(.+)$/i.exec(authorization)?.[1]?.trim() ?? "";
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function listenHttp(http: HttpServer, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      http.off("error", onError);
      resolve();
    };
    const onError = (error: Error) => {
      http.off("listening", onListening);
      reject(error);
    };
    http.once("error", onError);
    http.once("listening", onListening);
    http.listen(port, host);
  });
}

/**
 * Stream an audio file by name from baseDir, honoring HTTP Range requests
 * so the browser <audio> element can seek without re-downloading.
 */
function streamAudio(req: Request, baseDir: string): Response {
  const url = new URL(req.url);
  const file = basename(url.pathname);
  const path = join(baseDir, file);
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  const stat = statSync(path);
  const range = req.headers.get("range");
  if (!range) {
    const body = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
    return new Response(body, {
      status: 200,
      headers: {
        "Content-Length": String(stat.size),
        "Content-Type": "audio/wav",
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-cache",
      },
    });
  }
  const m = /bytes=(\d+)-(\d*)/.exec(range);
  const start = m ? Number(m[1]) : 0;
  const end   = m && m[2] ? Number(m[2]) : stat.size - 1;
  const body = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream;
  return new Response(body, {
    status: 206,
    headers: {
      "Content-Range":  `bytes ${start}-${end}/${stat.size}`,
      "Accept-Ranges":  "bytes",
      "Content-Length": String(end - start + 1),
      "Content-Type":   "audio/wav",
      "Cache-Control":  "no-cache",
    },
  });
}

/**
 * Bridge Node's IncomingMessage/ServerResponse to a fetch-style handler.
 * Forwards method, headers, and body (for non-GET/HEAD).
 */
async function bridgeNodeToFetch(
  req: IncomingMessage,
  res: ServerResponse,
  fetchHandler: (req: Request) => Promise<Response>,
): Promise<void> {
  try {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (Array.isArray(v)) v.forEach((vi) => headers.append(k, vi));
      else headers.set(k, v);
    }
    const method = req.method ?? "GET";
    const hasBody = method !== "GET" && method !== "HEAD";
    const init: RequestInit & { duplex?: "half" } = { method, headers };
    if (hasBody) {
      init.body = Readable.toWeb(req) as unknown as ReadableStream;
      init.duplex = "half";
    }
    const request = new Request(url.toString(), init);
    const response = await fetchHandler(request);
    res.statusCode = response.status;
    response.headers.forEach((v, k) => res.setHeader(k, v));
    if (!response.body) { res.end(); return; }
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
    res.end();
  } catch (e) {
    res.statusCode = 500;
    res.end((e as Error).message);
  }
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer().then((server) => {
    console.log(`[yulu_ui] listening on http://127.0.0.1:${server.address.port}`);
    let stopping = false;
    const shutdown = () => {
      if (stopping) return;
      stopping = true;
      void server.close()
        .then(() => process.exit(0))
        .catch((error) => {
          console.error(`[yulu_ui] shutdown failed: ${(error as Error).message}`);
          process.exit(1);
        });
    };
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
  }).catch((error) => {
    console.error(`[yulu_ui] failed to start: ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
