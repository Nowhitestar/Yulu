import { describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import {
  ConversationOnlyCliRuntimeClient,
  runCliCommand,
  type CliCommandRunner,
} from "../src/conversationOnlyCliClient.js";

function runner(results: Array<{ stdout?: string; stderr?: string; code?: number }>) {
  const run: CliCommandRunner = vi.fn(async () => {
    const result = results.shift() ?? {};
    return {
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      code: result.code ?? 0,
      timedOut: false,
      cancellationRequested: false,
      cancellationConfirmed: null,
    };
  });
  return run;
}

describe("Hermes production Conversation client", () => {
  it("uses non-model status/version/feature commands and never reads credential files", async () => {
    const run = runner([
      { stdout: "Hermes Agent v0.20.0 (2026.8.3)\n" },
      { stdout: "--model MODEL --query QUERY --resume SESSION_ID --quiet --safe-mode --toolsets SETS\n" },
      { stdout: "Model: grok-4.6\nProvider: xAI Grok OAuth (SuperGrok / Premium+)\n" },
      { stdout: "No fallback models configured.\n" },
    ]);
    const client = new ConversationOnlyCliRuntimeClient({ adapter: "hermes", executable: "/fake/hermes", cwd: "/movies", run });

    await expect(client.inspect()).resolves.toMatchObject({
      runtimeVersion: "0.20.0",
      authorized: true,
      provider: "xai",
      model: "grok-4.6",
      features: expect.arrayContaining(["status", "model", "query", "resume", "session-id", "probe-bounds"]),
    });
    expect(run).toHaveBeenNthCalledWith(1, ["/fake/hermes", "--version"], "/movies", 10_000);
    expect(run).toHaveBeenNthCalledWith(2, ["/fake/hermes", "chat", "--help"], "/movies", 10_000);
    expect(run).toHaveBeenNthCalledWith(3, ["/fake/hermes", "status"], "/movies", 10_000);
    expect(run).toHaveBeenNthCalledWith(4, ["/fake/hermes", "fallback", "list"], "/movies", 10_000);
  });

  it("uses an exact model and exact resume id, then proves model/provider from native session metadata", async () => {
    const run = runner([
      { stdout: "Hermes Agent v0.20.0 (2026.8.3)\n" },
      { stdout: "--model MODEL --query QUERY --resume SESSION_ID --quiet --safe-mode --toolsets SETS\n" },
      { stdout: "Model: grok-4.6\nProvider: xAI Grok OAuth (SuperGrok / Premium+)\n" },
      { stdout: "No fallback models configured.\n" },
      { stdout: "Pinned answer", stderr: "session_id: hermes-session-138\n" },
      { stdout: `${JSON.stringify({ id: "hermes-session-138", model: "grok-4.6", billing_provider: "xai", messages: [{ content: "private" }] })}\n` },
    ]);
    const client = new ConversationOnlyCliRuntimeClient({ adapter: "hermes", executable: "/fake/hermes", cwd: "/movies", run });

    await client.inspect();

    await expect(client.runConversation({
      model: "grok-4.6",
      prompt: "Continue",
      probe: false,
      timeoutMs: 300_000,
      nativeSessionId: "hermes-session-138",
    })).resolves.toMatchObject({
      answer: "Pinned answer",
      nativeSessionId: "hermes-session-138",
      actualProvider: "xai",
      actualModel: "grok-4.6",
      fallbackOccurred: false,
      terminalStatus: "completed",
    });
    expect(run).toHaveBeenNthCalledWith(5, [
      "/fake/hermes", "chat", "-Q", "--source", "yulu", "--model", "grok-4.6",
      "--resume", "hermes-session-138", "--query", "Continue",
    ], "/movies", 300_000);
    expect(run).toHaveBeenNthCalledWith(6, [
      "/fake/hermes", "sessions", "export", "--format", "jsonl", "--redact",
      "--session-id", "hermes-session-138", "-",
    ], "/movies", 10_000);
  });

  it("does not fabricate a resumed session when native metadata does not prove the requested id", async () => {
    const run = runner([
      { stdout: "Pinned answer", stderr: "session_id: hermes-session-other\n" },
      { stdout: `${JSON.stringify({ id: "hermes-session-other", model: "grok-4.6", billing_provider: "xai" })}\n` },
    ]);
    const client = new ConversationOnlyCliRuntimeClient({ adapter: "hermes", executable: "/fake/hermes", cwd: "/movies", run });

    await expect(client.runConversation({
      model: "grok-4.6",
      prompt: "Continue",
      probe: false,
      timeoutMs: 300_000,
      nativeSessionId: "hermes-session-138",
    })).resolves.toMatchObject({ nativeSessionId: "", actualProvider: null, actualModel: null });
  });

  it("fails closed instead of running a tool-capable probe when the CLI cannot disable tools", async () => {
    const run = runner([
      { stdout: "Hermes Agent v0.20.0 (2026.8.3)\n" },
      { stdout: "--model MODEL --query QUERY --resume SESSION_ID --quiet\n" },
      { stdout: "Model: grok-4.6\nProvider: xAI Grok OAuth (SuperGrok / Premium+)\n" },
      { stdout: "No fallback models configured.\n" },
    ]);
    const client = new ConversationOnlyCliRuntimeClient({ adapter: "hermes", executable: "/fake/hermes", cwd: "/movies", run });

    await client.inspect();
    await expect(client.runConversation({
      model: "grok-4.6",
      prompt: "Probe",
      probe: true,
      timeoutMs: 30_000,
    })).rejects.toThrow("tool-free probe unavailable");
    expect(run).toHaveBeenCalledTimes(4);
  });

  it("classifies an unstructured Hermes transport failure as Unknown Outcome", async () => {
    const run = runner([{ code: 1, stderr: "connection closed before response" }]);
    const client = new ConversationOnlyCliRuntimeClient({ adapter: "hermes", executable: "/fake/hermes", cwd: "/movies", run });

    await expect(client.runConversation({
      model: "grok-4.6",
      prompt: "Continue",
      probe: false,
      timeoutMs: 300_000,
    })).resolves.toMatchObject({ terminalStatus: "unknown", nativeSessionId: "" });
  });
});

describe("OpenClaw production Conversation client", () => {
  it("uses native status JSON and rejects configured fallback chains", async () => {
    const run = runner([
      { stdout: "OpenClaw 2026.5.12 (f066dd2)\n" },
      { stdout: "--json --model <id> --message <text> --session-id <id>\n" },
      { stdout: JSON.stringify({
        defaultModel: "openai/gpt-5.5",
        resolvedDefault: "openai/gpt-5.5",
        fallbacks: ["openrouter/openai/gpt-5.5"],
        auth: { missingProvidersInUse: [], unusableProfiles: [] },
      }) },
      { stdout: "--local --gateway --model <provider/model> --prompt <text> --json\n" },
    ]);
    const client = new ConversationOnlyCliRuntimeClient({ adapter: "openclaw", executable: "/fake/openclaw", cwd: "/movies", run });

    const inspection = await client.inspect();
    expect(inspection).toMatchObject({ runtimeVersion: "2026.5.12", authorized: true });
    expect(inspection.features).not.toContain("no-fallback");
    expect(inspection.features).toContain("infer/model-run-tool-free");
    expect(run).toHaveBeenNthCalledWith(4, [
      "/fake/openclaw", "infer", "model", "run", "--help",
    ], "/movies", 10_000);
  });

  it("does not claim authorization when native status exits unsuccessfully", async () => {
    const run = runner([
      { stdout: "OpenClaw 2026.5.12 (f066dd2)\n" },
      { stdout: "--json --model <id> --message <text> --session-id <id>\n" },
      {
        code: 1,
        stdout: JSON.stringify({
          resolvedDefault: "openai-codex/gpt-5.5",
          fallbacks: [],
          auth: { missingProvidersInUse: [], unusableProfiles: [] },
        }),
      },
      { stdout: "--local --gateway --model <provider/model> --prompt <text> --json\n" },
    ]);
    const client = new ConversationOnlyCliRuntimeClient({ adapter: "openclaw", executable: "/fake/openclaw", cwd: "/movies", run });

    await expect(client.inspect()).resolves.toMatchObject({ authorized: false });
  });

  it("uses OpenClaw's stable Gateway one-shot model surface for a tool-free probe", async () => {
    const run = runner([
      { stdout: "OpenClaw 2026.5.12 (f066dd2)\n" },
      { stdout: "--json --model <id> --message <text> --session-id <id>\n" },
      { stdout: JSON.stringify({
        resolvedDefault: "openai-codex/gpt-5.5",
        fallbacks: [],
        auth: { missingProvidersInUse: [], unusableProfiles: [] },
      }) },
      { stdout: "--local --gateway --model <provider/model> --prompt <text> --json\n" },
      { stdout: JSON.stringify({
        ok: true,
        capability: "model.run",
        transport: "gateway",
        provider: "openai-codex",
        model: "gpt-5.5",
        attempts: [],
        outputs: [{ text: "YULU_OPENCLAW_PROBE_OK", mediaUrl: null }],
      }) },
    ]);
    const client = new ConversationOnlyCliRuntimeClient({ adapter: "openclaw", executable: "/fake/openclaw", cwd: "/movies", run });
    await client.inspect();

    await expect(client.runConversation({
      model: "openai-codex/gpt-5.5",
      prompt: "Reply with exactly YULU_OPENCLAW_PROBE_OK.",
      probe: true,
      timeoutMs: 30_000,
    })).resolves.toMatchObject({
      answer: "YULU_OPENCLAW_PROBE_OK",
      nativeSessionId: "",
      actualProvider: "openai-codex",
      actualModel: "openai-codex/gpt-5.5",
      fallbackOccurred: false,
      terminalStatus: "completed",
    });
    expect(run).toHaveBeenNthCalledWith(5, [
      "/fake/openclaw", "infer", "model", "run", "--gateway",
      "--model", "openai-codex/gpt-5.5",
      "--prompt", "Reply with exactly YULU_OPENCLAW_PROBE_OK.", "--json",
    ], "/movies", 30_000);
  });

  it("rejects a tool-free probe result from the wrong OpenClaw transport", async () => {
    const run = runner([{ stdout: JSON.stringify({
      ok: true,
      capability: "model.run",
      transport: "local",
      provider: "openai-codex",
      model: "gpt-5.5",
      attempts: [],
      outputs: [{ text: "YULU_OPENCLAW_PROBE_OK" }],
    }) }]);
    const client = new ConversationOnlyCliRuntimeClient({ adapter: "openclaw", executable: "/fake/openclaw", cwd: "/movies", run });

    await expect(client.runConversation({
      model: "openai-codex/gpt-5.5",
      prompt: "Reply with exactly YULU_OPENCLAW_PROBE_OK.",
      probe: true,
      timeoutMs: 30_000,
    })).resolves.toMatchObject({ answer: "", terminalStatus: "unknown" });
  });

  it("pins the exact session and derives actual identity only from native JSON", async () => {
    const run = runner([{ stdout: JSON.stringify({
      runId: "run-138",
      status: "ok",
      result: {
        payloads: [{ text: "Pinned answer" }],
        meta: {
          transport: "gateway",
          agentMeta: {
            sessionId: "openclaw-session-138",
            provider: "openai-codex",
            model: "gpt-5.5",
            fallbackAttempts: [],
          },
        },
      },
    }) }]);
    const client = new ConversationOnlyCliRuntimeClient({ adapter: "openclaw", executable: "/fake/openclaw", cwd: "/movies", run });

    await expect(client.runConversation({
      model: "openai-codex/gpt-5.5",
      prompt: "Continue",
      probe: false,
      timeoutMs: 300_000,
      nativeSessionId: "openclaw-session-138",
    })).resolves.toMatchObject({
      answer: "Pinned answer",
      nativeSessionId: "openclaw-session-138",
      actualProvider: "openai-codex",
      actualModel: "openai-codex/gpt-5.5",
      requestId: "run-138",
      fallbackOccurred: false,
      terminalStatus: "completed",
    });
    expect(run).toHaveBeenCalledWith([
      "/fake/openclaw", "agent", "--json", "--model", "openai-codex/gpt-5.5",
      "--session-id", "openclaw-session-138", "--message", "Continue",
    ], "/movies", 300_000);
  });

  it("rejects OpenClaw latest/default-session drift on the first Conversation turn", async () => {
    const run = runner([{ stdout: JSON.stringify({
      runId: "run-mismatch",
      status: "ok",
      result: {
        payloads: [{ text: "wrong session answer" }],
        meta: { transport: "gateway", agentMeta: {
          sessionId: "openclaw-default-session",
          provider: "openai-codex",
          model: "gpt-5.5",
          fallbackAttempts: [],
        } },
      },
    }) }]);
    const client = new ConversationOnlyCliRuntimeClient({
      adapter: "openclaw",
      executable: "/fake/openclaw",
      cwd: "/movies",
      run,
      sessionIdFactory: () => "openclaw-requested-session",
    });

    await expect(client.runConversation({
      model: "openai-codex/gpt-5.5",
      prompt: "First",
      probe: false,
      timeoutMs: 300_000,
    })).resolves.toMatchObject({
      answer: "",
      nativeSessionId: "",
      terminalStatus: "unknown",
    });
    expect(run).toHaveBeenCalledWith(expect.arrayContaining([
      "--session-id", "openclaw-requested-session",
    ]), "/movies", 300_000);
  });

  it("reports OpenClaw's embedded transport fallback instead of accepting it as the Gateway", async () => {
    const run = runner([{ stdout: JSON.stringify({
      runId: "run-fallback",
      status: "ok",
      result: {
        payloads: [{ text: "fallback answer" }],
        meta: {
          transport: "embedded",
          fallbackFrom: "gateway",
          agentMeta: {
            sessionId: "openclaw-session-138",
            provider: "openai-codex",
            model: "gpt-5.5",
            fallbackAttempts: [],
          },
        },
      },
    }) }]);
    const client = new ConversationOnlyCliRuntimeClient({ adapter: "openclaw", executable: "/fake/openclaw", cwd: "/movies", run });

    await expect(client.runConversation({
      model: "openai-codex/gpt-5.5",
      prompt: "Continue",
      probe: false,
      timeoutMs: 300_000,
      nativeSessionId: "openclaw-session-138",
    })).resolves.toMatchObject({ fallbackOccurred: true, terminalStatus: "completed" });
  });

  it("does not invent a resumable session when an unknown execution returns no native identity", async () => {
    const run: CliCommandRunner = vi.fn(async () => ({
      stdout: "",
      stderr: "transport closed",
      code: 1,
      timedOut: true,
      cancellationRequested: true,
      cancellationConfirmed: false,
    }));
    const client = new ConversationOnlyCliRuntimeClient({ adapter: "openclaw", executable: "/fake/openclaw", cwd: "/movies", run });

    await expect(client.runConversation({
      model: "openai-codex/gpt-5.5",
      prompt: "Continue",
      probe: false,
      timeoutMs: 300_000,
    })).resolves.toMatchObject({
      nativeSessionId: "",
      terminalStatus: "unknown",
    });
  });

  it("distinguishes a native terminal error envelope from an ambiguous OpenClaw transport failure", async () => {
    const terminalRun = runner([{ code: 1, stdout: JSON.stringify({
      status: "error",
      error: { code: "invalid_request", message: "model rejected input" },
    }) }]);
    const terminalClient = new ConversationOnlyCliRuntimeClient({ adapter: "openclaw", executable: "/fake/openclaw", cwd: "/movies", run: terminalRun });
    await expect(terminalClient.runConversation({
      model: "openai-codex/gpt-5.5",
      prompt: "Continue",
      probe: false,
      timeoutMs: 300_000,
    })).resolves.toMatchObject({ terminalStatus: "failed" });

    const ambiguousRun = runner([{ code: 1, stderr: "gateway connection closed" }]);
    const ambiguousClient = new ConversationOnlyCliRuntimeClient({ adapter: "openclaw", executable: "/fake/openclaw", cwd: "/movies", run: ambiguousRun });
    await expect(ambiguousClient.runConversation({
      model: "openai-codex/gpt-5.5",
      prompt: "Continue",
      probe: false,
      timeoutMs: 300_000,
    })).resolves.toMatchObject({ terminalStatus: "unknown", nativeSessionId: "" });

    const timeoutRun = runner([{ code: 1, stdout: JSON.stringify({
      status: "error",
      error: { code: "timeout", message: "Gateway accepted the run but final reply timed out" },
    }) }]);
    const timeoutClient = new ConversationOnlyCliRuntimeClient({ adapter: "openclaw", executable: "/fake/openclaw", cwd: "/movies", run: timeoutRun });
    await expect(timeoutClient.runConversation({
      model: "openai-codex/gpt-5.5",
      prompt: "Continue",
      probe: false,
      timeoutMs: 300_000,
    })).resolves.toMatchObject({ terminalStatus: "unknown" });
  });

  it("does not accept a complete-looking OpenClaw success envelope when the CLI exits nonzero", async () => {
    const run = runner([{ code: 1, stdout: JSON.stringify({
      runId: "run-exit-1-138",
      status: "ok",
      result: {
        payloads: [{ text: "must not be returned" }],
        meta: {
          transport: "gateway",
          agentMeta: {
            sessionId: "openclaw-session-138",
            provider: "openai-codex",
            model: "gpt-5.5",
            fallbackAttempts: [],
          },
        },
      },
    }) }]);
    const client = new ConversationOnlyCliRuntimeClient({ adapter: "openclaw", executable: "/fake/openclaw", cwd: "/movies", run });

    await expect(client.runConversation({
      model: "openai-codex/gpt-5.5",
      prompt: "Continue",
      probe: false,
      timeoutMs: 300_000,
      nativeSessionId: "openclaw-session-138",
    })).resolves.toMatchObject({ answer: "", terminalStatus: "unknown" });
  });
});

describe("bounded native command execution", () => {
  it("force-stops a runtime that ignores the first cancellation signal", async () => {
    const startedAt = Date.now();
    const result = await runCliCommand([
      process.execPath,
      "-e",
      "process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),2000));setInterval(()=>{},1000)",
    ], tmpdir(), 150);

    expect(Date.now() - startedAt).toBeLessThan(1200);
    expect(result).toMatchObject({
      timedOut: true,
      cancellationRequested: true,
      cancellationConfirmed: false,
    });
  });
});
