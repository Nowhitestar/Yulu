import { describe, it, expect, afterAll, beforeAll, vi } from "vitest";
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { request as httpRequest } from "node:http";
import Database from "better-sqlite3";
import { startServer, type RunningServer } from "../src/server.js";
import { HostStore } from "../src/hostStore.js";
import { RecordingPipeline } from "../src/recordingPipeline.js";
import { AgentUnavailableError } from "../src/agentGateway.js";
import { RealtimeTranscriptionCoordinator } from "../src/realtimeTranscription.js";
import { XaiAudioClient } from "../src/xaiAudio.js";

function rawHttp(port: number, path: string, hostHeader: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers: { Host: hostHeader } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (b) => chunks.push(b));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
    });
    req.on("error", reject);
    req.end();
  });
}

const HERE = dirname(fileURLToPath(import.meta.url));

let env: { root: string; cleanup: () => void; server: RunningServer; baseUrl: string };

function pcmWav(): Buffer {
  const wav = Buffer.alloc(45);
  wav.write("RIFF", 0);
  wav.writeUInt32LE(37, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16_000, 24);
  wav.writeUInt32LE(32_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(1, 40);
  wav[44] = 1;
  return wav;
}

beforeAll(async () => {
  const root = mkdtempSync(join(tmpdir(), "yulu_srv_"));
  const configDir = join(root, ".config", "yulu");
  mkdirSync(configDir, { recursive: true });
  cpSync(join(HERE, "fixtures/config.json"), join(configDir, "config.json"));
  const configPath = join(configDir, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.llm = { ...(config.llm as Record<string, unknown>), enabled: false };
  writeFileSync(configPath, JSON.stringify(config));

  // Stub minimum DBs so lazy openDb doesn't fail if accessed
  for (const f of ["prompts.sqlite", "vocab.sqlite", "search.sqlite"]) {
    const db = new Database(join(configDir, f));
    db.close();
  }

  const moviesDir = join(root, "Movies", "Yulu");
  mkdirSync(moviesDir, { recursive: true });
  process.env.HOME = root;
  process.env.YULU_UI_PORT = "0";
  const server = await startServer({
    configDir,
    configFile: join(configDir, "config.json"),
    promptsDb: join(configDir, "prompts.sqlite"),
    vocabDb: join(configDir, "vocab.sqlite"),
    searchDb: join(configDir, "search.sqlite"),
    moviesDir,
    agentQueueJson: join(configDir, "agent-queue.json"),
    mcpTokenJson: join(configDir, "mcp-token.json"),
  });
  const port = server.address.port;
  const baseUrl = `http://127.0.0.1:${port}`;
  env = { root, cleanup: () => rmSync(root, { recursive: true, force: true }), server, baseUrl };
});

afterAll(async () => { await env.server.close(); env.cleanup(); });

describe("server", () => {
  it("/healthz returns ok", async () => {
    const r = await fetch(`${env.baseUrl}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ status: "ok" });
  });

  it("/trpc/system.version returns version", async () => {
    const r = await fetch(`${env.baseUrl}/trpc/system.version`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { result: { data: { name: string } } };
    expect(body.result.data.name).toBe("yulu-ui");
  });

  it("requires the process-local UI bearer for activation mutations", async () => {
    const crossSite = new FormData();
    crossSite.set("input", JSON.stringify({ json: null }));
    const rejected = await fetch(`${env.baseUrl}/trpc/activation.defer`, {
      method: "POST",
      headers: { Origin: "https://attacker.example" },
      body: crossSite,
    });
    expect(rejected.ok).toBe(false);

    const configDir = join(env.root, ".config", "yulu");
    const store = new HostStore(join(configDir, "host.sqlite"));
    expect(store.getActivationJourneyState().deferredAt).toBeNull();

    const tokenResponse = await fetch(`${env.baseUrl}/api/ui-token`);
    expect(tokenResponse.status).toBe(200);
    expect(tokenResponse.headers.get("cache-control")).toContain("no-store");
    const { token } = await tokenResponse.json() as { token: string };
    const accepted = await fetch(`${env.baseUrl}/trpc/activation.defer`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ json: null }),
    });
    expect(accepted.status).toBe(200);
    expect(store.getActivationJourneyState().deferredAt).toEqual(expect.any(String));
    store.db.prepare("DELETE FROM activation_journey_state").run();
    store.close();
  });

  it("rejects non-localhost via Host header guard", async () => {
    const r = await rawHttp(env.server.address.port, "/healthz", "evil.com:7777");
    expect(r.status).toBe(403);
  });

  it("/mcp requires the Yulu bearer token", async () => {
    const r = await fetch(`${env.baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
  });

  it("/mcp rejects a wrong bearer token", async () => {
    const configDir = join(env.root, ".config", "yulu");
    writeFileSync(join(configDir, "mcp-token.json"), JSON.stringify({ token: "test-token" }));
    const r = await fetch(`${env.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
        "Authorization": "Bearer wrong-token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(r.status).toBe(401);
  });

  it("protects compatibility audio transcription endpoints with the Bearer token", async () => {
    const configDir = join(env.root, ".config", "yulu");
    writeFileSync(join(configDir, "mcp-token.json"), JSON.stringify({ token: "test-token" }));
    for (const path of ["/api/agent/transcription/warm", "/api/agent/transcribe"]) {
      const response = await fetch(`${env.baseUrl}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Yulu-MCP-Token": "test-token" },
        body: path.endsWith("/transcribe") ? JSON.stringify({ audioPath: "/tmp/input.wav" }) : undefined,
      });
      expect(response.status).toBe(401);
    }
  });

  it("returns selected-engine warm and on-demand transcription results to authenticated callers", async () => {
    const configDir = join(env.root, ".config", "yulu");
    const audioPath = join(env.root, "Movies", "Yulu", "Dictation_20260711_130000.wav");
    writeFileSync(join(configDir, "mcp-token.json"), JSON.stringify({ token: "test-token" }));
    writeFileSync(audioPath, Buffer.alloc(44));
    const warmSpy = vi.spyOn(RecordingPipeline.prototype, "warmTranscription")
      .mockResolvedValueOnce({ provider: "local" });
    const transcribeSpy = vi.spyOn(RecordingPipeline.prototype, "transcribeOnDemand")
      .mockResolvedValueOnce({ transcript: "hello dictation", provider: "xai", chunks: 1 });
    const headers = { "Content-Type": "application/json", "Authorization": "Bearer test-token" };
    try {
      const warm = await fetch(`${env.baseUrl}/api/agent/transcription/warm`, { method: "POST", headers });
      expect(warm.status).toBe(200);
      expect(await warm.json()).toEqual({ ok: true, provider: "local" });

      const transcribe = await fetch(`${env.baseUrl}/api/agent/transcribe`, {
        method: "POST",
        headers,
        body: JSON.stringify({ audioPath, language: "ja" }),
      });
      expect(transcribe.status).toBe(200);
      expect(await transcribe.json()).toEqual({
        ok: true,
        transcript: "hello dictation",
        provider: "xai",
        chunks: 1,
      });
      expect(transcribeSpy).toHaveBeenCalledWith({ audioPath, language: "ja" });
    } finally {
      warmSpy.mockRestore();
      transcribeSpy.mockRestore();
    }
  });

  it("protects and forwards realtime recording start/stop requests", async () => {
    const configDir = join(env.root, ".config", "yulu");
    const audioPath = join(env.root, "Movies", "Yulu", "Realtime_20260714_160000.wav");
    writeFileSync(join(configDir, "mcp-token.json"), JSON.stringify({ token: "test-token" }));
    writeFileSync(audioPath, Buffer.alloc(44));
    const startSpy = vi.spyOn(RealtimeTranscriptionCoordinator.prototype, "start").mockResolvedValueOnce();
    const stopSpy = vi.spyOn(RealtimeTranscriptionCoordinator.prototype, "stop").mockResolvedValueOnce(null);
    const optionsSpy = vi.spyOn(RealtimeTranscriptionCoordinator.prototype, "updateOptions").mockResolvedValueOnce({
      status: "transcribing",
      stem: "Realtime_20260714_160000",
      language: "zh",
      text: "",
      coveredMs: 0,
      trusted: false,
    });
    const headers = { "Content-Type": "application/json", "Authorization": "Bearer test-token" };
    try {
      const unauthorized = await fetch(`${env.baseUrl}/api/recordings/realtime/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audioPath, title: "Realtime", language: "zh" }),
      });
      expect(unauthorized.status).toBe(401);

      const started = await fetch(`${env.baseUrl}/api/recordings/realtime/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({ audioPath, title: "Realtime", language: "zh" }),
      });
      expect(started.status).toBe(200);
      expect(startSpy).toHaveBeenCalledWith({ audioPath, title: "Realtime", language: "zh" });

      const stopped = await fetch(`${env.baseUrl}/api/recordings/realtime/stop`, {
        method: "POST",
        headers,
        body: JSON.stringify({ audioPath }),
      });
      expect(stopped.status).toBe(200);
      expect(stopSpy).toHaveBeenCalledWith(audioPath);

      const options = await fetch(`${env.baseUrl}/api/recordings/realtime/options`, {
        method: "POST",
        headers,
        body: JSON.stringify({ audioPath, targetLanguage: "日本語", translationEnabled: true }),
      });
      expect(options.status).toBe(200);
      expect(optionsSpy).toHaveBeenCalledWith({ audioPath, targetLanguage: "日本語", translationEnabled: true });
    } finally {
      startSpy.mockRestore();
      stopSpy.mockRestore();
      optionsSpy.mockRestore();
    }
  });

  it("rejects out-of-scope transcription paths before contacting the audio engine", async () => {
    const configDir = join(env.root, ".config", "yulu");
    writeFileSync(join(configDir, "mcp-token.json"), JSON.stringify({ token: "test-token" }));
    const outside = join(env.root, "outside.wav");
    writeFileSync(outside, Buffer.alloc(44));
    const response = await fetch(`${env.baseUrl}/api/agent/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer test-token" },
      body: JSON.stringify({ audioPath: outside }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: "invalid_audio_transcription" });
  });

  it("surfaces an unavailable selected audio engine without falling back", async () => {
    const configDir = join(env.root, ".config", "yulu");
    const moviesDir = join(env.root, "Movies", "Yulu");
    writeFileSync(join(configDir, "mcp-token.json"), JSON.stringify({ token: "test-token" }));
    const audioPath = join(moviesDir, "Dictation_20260711_120000.wav");
    writeFileSync(audioPath, Buffer.alloc(44));
    const headers = { "Content-Type": "application/json", "Authorization": "Bearer test-token" };

    const warmSpy = vi.spyOn(RecordingPipeline.prototype, "warmTranscription")
      .mockRejectedValueOnce(new AgentUnavailableError("selected audio engine offline"));
    const transcribeSpy = vi.spyOn(RecordingPipeline.prototype, "transcribeOnDemand")
      .mockRejectedValueOnce(new AgentUnavailableError("selected audio engine offline"));
    try {
      const warm = await fetch(`${env.baseUrl}/api/agent/transcription/warm`, { method: "POST", headers });
      expect(warm.status).toBe(503);
      expect(await warm.json()).toMatchObject({ ok: false, error: "audio_engine_unavailable" });

      const transcribe = await fetch(`${env.baseUrl}/api/agent/transcribe`, {
        method: "POST",
        headers,
        body: JSON.stringify({ audioPath }),
      });
      expect(transcribe.status).toBe(503);
      expect(await transcribe.json()).toMatchObject({ ok: false, error: "audio_engine_unavailable" });
    } finally {
      warmSpy.mockRestore();
      transcribeSpy.mockRestore();
    }
  });

  it("rejects undisclosed xAI audio at realtime, on-demand, and scheduled production boundaries", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-xai-consent-guard-"));
    const configDir = join(root, ".config", "yulu");
    const moviesDir = join(root, "Movies", "Yulu");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(moviesDir, { recursive: true });
    const configFile = join(configDir, "config.json");
    const config = JSON.parse(readFileSync(join(HERE, "fixtures/config.json"), "utf8"));
    config.transcription = { ...config.transcription, engine: "xai" };
    config.intelligence = {
      ...config.intelligence,
      summary: { provider: "agent", model: "runtime-managed" },
    };
    config.agent_pipeline = { ...config.agent_pipeline, enabled: true, auto_process_recordings: true };
    writeFileSync(configFile, JSON.stringify(config));
    writeFileSync(join(configDir, "mcp-token.json"), JSON.stringify({ token: "consent-guard-token" }));
    const audioPath = join(moviesDir, "Scheduled_20260711_140000.wav");
    writeFileSync(audioPath, pcmWav());
    const xaiStart = vi.spyOn(XaiAudioClient.prototype, "start");
    const xaiTranscribe = vi.spyOn(XaiAudioClient.prototype, "transcribeFile");
    const server = await startServer({
      configDir,
      configFile,
      moviesDir,
      hostDb: join(configDir, "host.sqlite"),
      agentTasksDir: join(configDir, "agent-tasks"),
      recordingEventsDir: join(configDir, "recording-events"),
      agentQueueJson: join(configDir, "agent-queue.json"),
      mcpTokenJson: join(configDir, "mcp-token.json"),
    });
    const headers = {
      "Content-Type": "application/json",
      "Authorization": "Bearer consent-guard-token",
    };
    try {
      const baseUrl = `http://127.0.0.1:${server.address.port}`;
      const realtime = await fetch(`${baseUrl}/api/recordings/realtime/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({ audioPath, title: "Scheduled", language: "zh" }),
      });
      expect(realtime.status).toBe(400);
      expect(await realtime.json()).toMatchObject({
        ok: false,
        error: "realtime_start_failed",
        detail: expect.stringContaining("current Cloud Transcription Consent"),
      });

      const onDemand = await fetch(`${baseUrl}/api/agent/transcribe`, {
        method: "POST",
        headers,
        body: JSON.stringify({ audioPath, language: "zh" }),
      });
      expect(onDemand.status).toBe(503);
      expect(await onDemand.json()).toMatchObject({
        ok: false,
        error: "audio_engine_unavailable",
        detail: expect.stringContaining("current Cloud Transcription Consent"),
      });

      const completed = await fetch(`${baseUrl}/api/recordings/completed`, {
        method: "POST",
        headers,
        body: JSON.stringify({ audioPath, title: "Scheduled" }),
      });
      const { taskId } = await completed.json() as { taskId: string };
      const store = new HostStore(join(configDir, "host.sqlite"));
      try {
        await vi.waitFor(() => expect(store.getTask(taskId)).toMatchObject({
          state: "awaiting_agent",
          error: expect.stringContaining("current Cloud Transcription Consent"),
        }));
      } finally {
        store.close();
      }
      expect(xaiStart).not.toHaveBeenCalled();
      expect(xaiTranscribe).not.toHaveBeenCalled();
    } finally {
      xaiStart.mockRestore();
      xaiTranscribe.mockRestore();
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("/mcp initializes with the correct token", async () => {
    const configDir = join(env.root, ".config", "yulu");
    writeFileSync(join(configDir, "mcp-token.json"), JSON.stringify({ token: "test-token" }));
    const body = await mcpPost("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    }) as { result?: { serverInfo?: { name?: string } } };
    expect(body.result?.serverInfo?.name).toBe("yulu");
  });

  it("/mcp lists Yulu tools without destructive delete tools", async () => {
    const configDir = join(env.root, ".config", "yulu");
    writeFileSync(join(configDir, "mcp-token.json"), JSON.stringify({ token: "test-token" }));
    const body = await mcpPost("tools/list") as { result?: { tools?: Array<{ name: string }> } };
    const names = body.result?.tools?.map((tool) => tool.name) ?? [];
    expect(names).toContain("recording_get");
    expect(names).toContain("recording_artifact_commit");
    expect(names).toContain("recording_begin_notion_delivery");
    expect(names).toContain("recording_commit_notion_delivery");
    expect(names).not.toContain("recording_transcribe");
    expect(names).not.toContain("recording_summarize");
    expect(names).not.toContain("summary_send");
    expect(names).not.toContain("recording_delete");
  });

  it("exposes separate minimal artifact and delivery MCP capability sets", async () => {
    const configDir = join(env.root, ".config", "yulu");
    writeFileSync(join(configDir, "mcp-token.json"), JSON.stringify({ token: "test-token" }));
    const initialized = await mcpPost("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1.0" },
    }, "/mcp/recording-artifact") as { result?: { serverInfo?: { name?: string } } };
    expect(initialized.result?.serverInfo?.name).toBe("yulu-recording-artifact");

    const body = await mcpPost("tools/list", undefined, "/mcp/recording-artifact") as {
      result?: { tools?: Array<{ name: string }> };
    };
    const names = body.result?.tools?.map((tool) => tool.name).sort() ?? [];
    expect(names).toEqual([
      "recording_artifact_commit",
      "recording_task_get",
      "recording_task_progress",
      "recording_task_summary_stage",
      "recording_task_transcript_read",
    ]);
    expect(names).not.toContain("recording_start");
    expect(names).not.toContain("recording_stop");
    expect(names.some((name) => name.startsWith("prompt"))).toBe(false);
    expect(names.some((name) => name.startsWith("glossary"))).toBe(false);

    const delivery = await mcpPost("tools/list", undefined, "/mcp/recording-delivery") as {
      result?: { tools?: Array<{ name: string }> };
    };
    expect(delivery.result?.tools?.map((tool) => tool.name).sort()).toEqual([
      "recording_begin_notion_delivery",
      "recording_commit_notion_delivery",
      "recording_committed_summary_read",
      "recording_task_get",
    ]);
  });

  it("accepts an authenticated recording completion once and exposes its durable task", async () => {
    const configDir = join(env.root, ".config", "yulu");
    const moviesDir = join(env.root, "Movies", "Yulu");
    const token = "test-token";
    writeFileSync(join(configDir, "mcp-token.json"), JSON.stringify({ token }));
    const audioPath = join(moviesDir, "Pipeline_20260711_120000.wav");
    writeFileSync(audioPath, Buffer.alloc(44));

    const unauthorized = await fetch(`${env.baseUrl}/api/recordings/completed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioPath, title: "Pipeline", sendToNotion: true }),
    });
    expect(unauthorized.status).toBe(401);

    const post = () => fetch(`${env.baseUrl}/api/recordings/completed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ audioPath, title: "Pipeline", sendToNotion: true }),
    });
    const first = await post();
    expect(first.status).toBe(202);
    const firstBody = await first.json() as { taskId: string; created: boolean };
    expect(firstBody.created).toBe(true);
    const secondBody = await (await post()).json() as { taskId: string; created: boolean };
    expect(secondBody).toEqual({ taskId: firstBody.taskId, created: false, ok: true, state: expect.any(String) });

    const taskCall = await mcpPost("tools/call", {
      name: "recording_task_get",
      arguments: { taskId: firstBody.taskId },
    }) as { result?: { content?: Array<{ text?: string }> } };
    const task = JSON.parse(taskCall.result?.content?.[0]?.text ?? "{}");
    expect(task).toMatchObject({ id: firstBody.taskId, recordingStem: "Pipeline_20260711_120000", sendToNotion: true });
  });

  it("returns a permanent policy result instead of creating a disabled completion task", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-policy-disabled-"));
    const configDir = join(root, ".config", "yulu");
    const moviesDir = join(root, "Movies", "Yulu");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(moviesDir, { recursive: true });
    const configFile = join(configDir, "config.json");
    const config = JSON.parse(readFileSync(join(HERE, "fixtures/config.json"), "utf8")) as Record<string, unknown>;
    config.agent_pipeline = {
      ...(config.agent_pipeline as Record<string, unknown>),
      enabled: false,
      auto_process_recordings: true,
    };
    writeFileSync(configFile, JSON.stringify(config));
    writeFileSync(join(configDir, "mcp-token.json"), JSON.stringify({ token: "policy-token" }));
    const audioPath = join(moviesDir, "Paused_20260711_130000.wav");
    writeFileSync(audioPath, Buffer.alloc(44));
    const server = await startServer({
      configDir,
      configFile,
      moviesDir,
      hostDb: join(configDir, "host.sqlite"),
      agentTasksDir: join(configDir, "agent-tasks"),
      recordingEventsDir: join(configDir, "recording-events"),
      agentQueueJson: join(configDir, "agent-queue.json"),
      mcpTokenJson: join(configDir, "mcp-token.json"),
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.address.port}/api/recordings/completed`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer policy-token" },
        body: JSON.stringify({ audioPath, title: "Paused" }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        ok: false,
        error: "recording_pipeline_policy_disabled",
        permanent: true,
        detail: "Agent recording pipeline is disabled by policy",
      });
      const store = new HostStore(join(configDir, "host.sqlite"));
      expect(store.listTasks()).toEqual([]);
      store.close();
    } finally {
      await server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("commits task-scoped artifacts before allowing a Notion delivery report", async () => {
    const configDir = join(env.root, ".config", "yulu");
    const moviesDir = join(env.root, "Movies", "Yulu");
    const token = "test-token";
    writeFileSync(join(configDir, "mcp-token.json"), JSON.stringify({ token }));
    await mcpPost("tools/call", {
      name: "glossary_add",
      arguments: { term: "阿法学院", canonical: "阿尔法学院", scope: "both" },
    });
    const audioPath = join(moviesDir, "Commit_20260711_120000.wav");
    writeFileSync(audioPath, Buffer.alloc(44));
    const response = await fetch(`${env.baseUrl}/api/recordings/completed`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${token}` },
      body: JSON.stringify({ audioPath, title: "Commit", sendToNotion: true }),
    });
    const { taskId } = await response.json() as { taskId: string };

    const secondWriter = new HostStore(join(configDir, "host.sqlite"));
    const claimed = secondWriter.claim(taskId);
    expect(claimed?.id).toBe(taskId);
    const workspace = join(configDir, "agent-tasks", taskId);
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(workspace, "transcript.txt"), "committed transcript");
    const transcriptRead = await mcpPost("tools/call", {
      name: "recording_task_transcript_read",
      arguments: { taskId, leaseToken: claimed!.leaseToken },
    }, "/mcp/recording-artifact") as { result?: { content?: Array<{ text?: string }> } };
    expect(JSON.parse(transcriptRead.result?.content?.[0]?.text ?? "{}").transcript).toContain("committed transcript");
    await mcpPost("tools/call", {
      name: "recording_task_summary_stage",
      arguments: { taskId, leaseToken: claimed!.leaseToken, summary: "# 阿法学院 summary" },
    }, "/mcp/recording-artifact");

    const commit = await mcpPost("tools/call", {
      name: "recording_artifact_commit",
      arguments: { taskId, leaseToken: claimed!.leaseToken, provenance: { transcriptionProvider: "test" } },
    }, "/mcp/recording-artifact") as { result?: { content?: Array<{ text?: string }> } };
    expect(JSON.parse(commit.result?.content?.[0]?.text ?? "{}").state).toBe("artifacts_committed");

    const begin = await mcpPost("tools/call", {
      name: "recording_begin_notion_delivery",
      arguments: { taskId, leaseToken: claimed!.leaseToken },
    }, "/mcp/recording-delivery") as { result?: { content?: Array<{ text?: string }> } };
    expect(JSON.parse(begin.result?.content?.[0]?.text ?? "{}").status).toBe("sending");
    const committedSummary = await mcpPost("tools/call", {
      name: "recording_committed_summary_read",
      arguments: { taskId, leaseToken: claimed!.leaseToken },
    }, "/mcp/recording-delivery") as { result?: { content?: Array<{ text?: string }> } };
    expect(JSON.parse(committedSummary.result?.content?.[0]?.text ?? "{}").summary).toContain("阿尔法学院 summary");
    await mcpPost("tools/call", {
      name: "recording_commit_notion_delivery",
      arguments: {
        taskId,
        leaseToken: claimed!.leaseToken,
        url: "https://www.notion.so/test-page",
      },
    }, "/mcp/recording-delivery");
    expect(secondWriter.getTask(taskId)?.state).toBe("delivery_reported");
    expect(readFileSync(join(moviesDir, "Commit_20260711_120000.transcript.txt"), "utf8")).toContain("committed transcript");
    expect(readFileSync(join(moviesDir, "Commit_20260711_120000.summary.md"), "utf8")).toContain("阿尔法学院 summary");
    secondWriter.close();
  });

  it("/mcp exposes recording text without WAV bytes", async () => {
    const configDir = join(env.root, ".config", "yulu");
    const moviesDir = join(env.root, "Movies", "Yulu");
    writeFileSync(join(configDir, "mcp-token.json"), JSON.stringify({ token: "test-token" }));
    writeFileSync(join(moviesDir, "McpRec_20260101_120000.wav"), Buffer.alloc(44));
    writeFileSync(join(moviesDir, "McpRec_20260101_120000.transcript.txt"), "hello transcript");
    writeFileSync(join(moviesDir, "McpRec_20260101_120000.summary.md"), "# hello summary");

    const call = await mcpPost("tools/call", { name: "recording_get", arguments: { stem: "McpRec_20260101_120000" } }) as {
      result?: { content?: Array<{ text?: string }> };
    };
    const recording = JSON.parse(call.result?.content?.[0]?.text ?? "{}");
    expect(recording.transcript).toBe("hello transcript");
    expect(recording.summary).toBe("# hello summary");
    expect(recording.wavPath).toBeUndefined();

    const list = await mcpPost("tools/call", { name: "recordings_list", arguments: { limit: 5 } }) as {
      result?: { content?: Array<{ text?: string }> };
    };
    expect(JSON.parse(list.result?.content?.[0]?.text ?? "[]").some((row: { stem?: string }) => row.stem === "McpRec_20260101_120000")).toBe(true);

    const summary = await mcpPost("resources/read", { uri: "yulu://recordings/McpRec_20260101_120000/summary" }) as {
      result?: { contents?: Array<{ text?: string }> };
    };
    expect(summary.result?.contents?.[0]?.text).toBe("# hello summary");
  });

  it("serves /assets/* from dist/web/assets with the right Content-Type", async () => {
    // Bootstrap a fake built UI directory for this test
    const distWeb = join(env.root, "dist/web/assets");
    mkdirSync(distWeb, { recursive: true });
    writeFileSync(join(distWeb, "smoke.css"), ".x{color:red}");
    process.env.YULU_UI_DIST_WEB = join(env.root, "dist/web");

    const r = await fetch(`${env.baseUrl}/assets/smoke.css`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/css/);
    expect(await r.text()).toContain("color:red");
  });

  it("serves the built favicon instead of the SPA fallback", async () => {
    const distWeb = join(env.root, "dist/web");
    mkdirSync(distWeb, { recursive: true });
    writeFileSync(join(distWeb, "favicon.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    process.env.YULU_UI_DIST_WEB = distWeb;

    const r = await fetch(`${env.baseUrl}/favicon.svg`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("image/svg+xml");
    expect(await r.text()).toContain("<svg");
  });

  it("falls back to index.html for unknown SPA paths", async () => {
    // Ensure index.html exists
    const distWeb = join(env.root, "dist/web");
    mkdirSync(distWeb, { recursive: true });
    writeFileSync(join(distWeb, "index.html"), "<!doctype html><html><body>SPA</body></html>");
    process.env.YULU_UI_DIST_WEB = distWeb;

    const r = await fetch(`${env.baseUrl}/inbox/voicemails`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/text\/html/);
    expect(await r.text()).toContain("SPA");
  });

  it("503s when SPA index.html is missing (dev-without-build scenario)", async () => {
    // Point at a path guaranteed not to contain an index.html so we don't
    // rely on the package's actual `dist/web` being absent (it isn't, in dev).
    process.env.YULU_UI_DIST_WEB = join(env.root, "definitely-no-build-here");
    const r = await fetch(`${env.baseUrl}/some/unknown/path`);
    expect(r.status).toBe(503);
    expect(await r.text()).toMatch(/UI not built/);
  });

  it("/api/voice-chat/ask creates and continues a chat session", async () => {
    const configDir = join(env.root, ".config", "yulu");
    const config = JSON.parse(readFileSync(join(configDir, "config.json"), "utf8"));
    config.llm = { enabled: false, command: null };
    writeFileSync(join(configDir, "config.json"), JSON.stringify(config, null, 2));

    const r = await fetch(`${env.baseUrl}/api/voice-chat/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "hello agent" }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; sessionId: string; url: string };
    expect(body.ok).toBe(true);
    expect(body.sessionId).toBeTruthy();
    expect(body.url).toBe(`/voice-chat?session=${encodeURIComponent(body.sessionId)}`);

    const next = await fetch(`${env.baseUrl}/api/voice-chat/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "second turn", sessionId: body.sessionId }),
    });
    expect(next.status).toBe(200);
    const nextBody = await next.json() as { ok: boolean; sessionId: string; url: string };
    expect(nextBody.ok).toBe(true);
    expect(nextBody.sessionId).toBe(body.sessionId);
    expect(nextBody.url).toBe(body.url);

    const store = JSON.parse(readFileSync(join(configDir, "agent-sessions.json"), "utf8"));
    const session = store.sessions.find((item: { id: string }) => item.id === body.sessionId);
    expect(session.messages.map((m: { role: string }) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("/api/voice-chat/ask can return immediately and answer in the background", async () => {
    const configDir = join(env.root, ".config", "yulu");
    const r = await fetch(`${env.baseUrl}/api/voice-chat/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "deferred hello", defer: true }),
    });
    expect(r.status).toBe(200);
    const body = await r.json() as { ok: boolean; deferred: boolean; sessionId: string; answer: string; url: string };
    expect(body.ok).toBe(true);
    expect(body.deferred).toBe(true);
    expect(body.answer).toBe("");
    expect(body.url).toBe(`/voice-chat?session=${encodeURIComponent(body.sessionId)}`);

    let roles: string[] = [];
    for (let i = 0; i < 20; i++) {
      const store = JSON.parse(readFileSync(join(configDir, "agent-sessions.json"), "utf8"));
      const session = store.sessions.find((item: { id: string }) => item.id === body.sessionId);
      roles = session?.messages.map((m: { role: string }) => m.role) ?? [];
      if (roles.length >= 2) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(roles).toEqual(["user", "assistant"]);
  });

  it("falls back to index.html for deep multi-segment SPA paths", async () => {
    const distWeb = join(env.root, "dist/web");
    mkdirSync(distWeb, { recursive: true });
    writeFileSync(join(distWeb, "index.html"), "<!doctype html><html><body>SPA</body></html>");
    process.env.YULU_UI_DIST_WEB = distWeb;

    for (const p of ["/inbox/voicemails", "/health/daemons", "/a/b/c/d/e"]) {
      const r = await fetch(`${env.baseUrl}${p}`);
      expect(r.status, `path ${p}`).toBe(200);
      expect(r.headers.get("content-type")).toMatch(/text\/html/);
      expect(await r.text()).toContain("SPA");
    }
  });

});

function parseMcpResponse(text: string): unknown {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  return JSON.parse(dataLine ? dataLine.slice(6) : text);
}

async function mcpPost(method: string, params?: unknown, path = "/mcp"): Promise<unknown> {
  const r = await fetch(`${env.baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "Authorization": "Bearer test-token",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  expect(r.status).toBe(200);
  return parseMcpResponse(await r.text());
}
