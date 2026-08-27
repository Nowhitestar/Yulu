import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeCodeCliRuntimeClient } from "../src/claudeCodeCliClient.js";

const roots: string[] = [];

function fakeClaude() {
  const root = mkdtempSync(join(tmpdir(), "yulu-fake-claude-"));
  roots.push(root);
  const executable = join(root, "claude");
  const logPath = join(root, "argv.jsonl");
  const stdinLogPath = join(root, "stdin.txt");
  writeFileSync(executable, [
    `#!${process.execPath}`,
    'import { appendFileSync } from "node:fs";',
    'const args = process.argv.slice(2);',
    'appendFileSync(process.env.YULU_FAKE_CLAUDE_LOG, `${JSON.stringify(args)}\\n`);',
    'if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_CUSTOM_HEADERS || process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX || process.env.CLAUDE_CODE_USE_FOUNDRY) {',
    '  process.stderr.write("credential or provider-routing environment leaked");',
    '  process.exit(3);',
    '}',
    'if (args.length === 1 && args[0] === "--version") {',
    '  process.stdout.write("2.1.169 (Claude Code)\\n");',
    '  process.exit(0);',
    '}',
    'if (args[0] === "auth" && args[1] === "status") {',
    '  process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }));',
    '  process.exit(0);',
    '}',
    'if (args.includes("--help")) {',
    '  process.stdout.write("--safe-mode --print --output-format stream-json --verbose --model --session-id --resume --max-turns --tools --disallowedTools --strict-mcp-config --mcp-config --disable-slash-commands --no-session-persistence --fallback-model");',
    '  process.exit(0);',
    '}',
    'if (args.includes("--print")) {',
    '  let prompt = "";',
    '  for await (const chunk of process.stdin) prompt += chunk.toString("utf8");',
    '  appendFileSync(process.env.YULU_FAKE_CLAUDE_STDIN_LOG, prompt);',
    '  const model = args[args.indexOf("--model") + 1];',
    '  const usageModel = process.env.YULU_FAKE_CLAUDE_USAGE_MODEL || model;',
    '  const sessionFlag = args.includes("--resume") ? "--resume" : "--session-id";',
    '  const sessionId = args[args.indexOf(sessionFlag) + 1];',
    '  const answer = prompt.includes("YULU_CLAUDE_PROBE_OK") ? "YULU_CLAUDE_PROBE_OK" : "Pinned Claude answer";',
    '  process.stdout.write(`${JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, model, tools: [], mcp_servers: [], uuid: "init-136" })}\\n`);',
    '  if (process.env.YULU_FAKE_CLAUDE_HANG === "1") {',
    '    process.on("SIGINT", () => {});',
    '    await new Promise((resolve) => setInterval(resolve, 1_000_000));',
    '  } else if (process.env.YULU_FAKE_CLAUDE_NO_TERMINAL === "1") {',
    '    process.exit(0);',
    '  } else {',
    '    process.stdout.write(`${JSON.stringify({ type: "assistant", session_id: sessionId, message: { content: [{ type: "text", text: answer }] } })}\\n`);',
    '    process.stdout.write(`${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: answer, session_id: sessionId, uuid: "result-136", modelUsage: { [usageModel]: {} } })}\\n`);',
    '    process.exit(0);',
    '  }',
    '}',
    'process.stderr.write("unexpected fake Claude invocation");',
    'process.exit(2);',
  ].join("\n"), { mode: 0o700 });
  chmodSync(executable, 0o700);
  return { root, executable, logPath, stdinLogPath };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Claude Code production CLI client", () => {
  it("does not access Claude or Anthropic credential environment values", async () => {
    const fake = fakeClaude();
    const env: NodeJS.ProcessEnv = {
      YULU_FAKE_CLAUDE_LOG: fake.logPath,
      YULU_FAKE_CLAUDE_STDIN_LOG: fake.stdinLogPath,
    };
    for (const name of [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "CLAUDE_CODE_OAUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_CUSTOM_HEADERS",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_FOUNDRY",
    ]) {
      Object.defineProperty(env, name, {
        enumerable: true,
        get: () => { throw new Error(`${name} must not be read`); },
      });
    }
    const client = new ClaudeCodeCliRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env,
    });

    await expect(client.inspect()).resolves.toMatchObject({
      authorized: true,
      apiProvider: "firstParty",
    });
  });

  it("inspects version, supported flags, and native auth status without a model request or credential read", async () => {
    const fake = fakeClaude();
    const client = new ClaudeCodeCliRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: {
        YULU_FAKE_CLAUDE_LOG: fake.logPath,
        YULU_FAKE_CLAUDE_STDIN_LOG: fake.stdinLogPath,
        ANTHROPIC_API_KEY: "must-not-reach-runtime",
        ANTHROPIC_AUTH_TOKEN: "must-not-reach-runtime",
        CLAUDE_CODE_OAUTH_TOKEN: "must-not-reach-runtime",
      },
    });

    await expect(client.inspect()).resolves.toEqual({
      runtimeVersion: "2.1.169",
      authorized: true,
      authorizationMethod: "claude.ai",
      apiProvider: "firstParty",
      features: [
        "auth/status",
        "safe-mode",
        "print/stream-json",
        "verbose",
        "model",
        "session-id",
        "resume",
        "probe-bounds",
        "tools/none",
        "probe-isolation",
        "fallback-model/opt-in",
      ],
    });
    const calls = readFileSync(fake.logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toEqual([
      ["--version"],
      ["--help"],
      ["auth", "status"],
    ]);
    expect(JSON.stringify(calls)).not.toContain("--print");
    expect(JSON.stringify(await client.inspect())).not.toMatch(/token|credential/i);
  });

  it("runs a bounded tool-free probe in safe mode and proves the exact model and returned session identity", async () => {
    const fake = fakeClaude();
    const client = new ClaudeCodeCliRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: {
        YULU_FAKE_CLAUDE_LOG: fake.logPath,
        YULU_FAKE_CLAUDE_STDIN_LOG: fake.stdinLogPath,
      },
      sessionIdFactory: () => "019f0000-0000-7000-8000-000000000136",
    });

    await expect(client.runConversation({
      model: "claude-sonnet-5",
      prompt: "Reply with exactly YULU_CLAUDE_PROBE_OK and do not use tools.",
      probe: true,
      timeoutMs: 10_000,
    })).resolves.toEqual({
      answer: "YULU_CLAUDE_PROBE_OK",
      nativeSessionId: "019f0000-0000-7000-8000-000000000136",
      actualModel: "claude-sonnet-5",
      requestId: "result-136",
      fallbackOccurred: false,
      toolCalls: [],
      terminalStatus: "completed",
      cancellationRequested: false,
      cancellationConfirmed: null,
    });
    const calls = readFileSync(fake.logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toEqual([[
      "--safe-mode",
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--model", "claude-sonnet-5",
      "--session-id", "019f0000-0000-7000-8000-000000000136",
      "--max-turns", "1",
      "--tools", "",
      "--disallowedTools", "*",
      "--strict-mcp-config",
      "--mcp-config", '{"mcpServers":{}}',
      "--disable-slash-commands",
      "--no-session-persistence",
    ]]);
    expect(readFileSync(fake.stdinLogPath, "utf8")).toBe(
      "Reply with exactly YULU_CLAUDE_PROBE_OK and do not use tools.",
    );
    const allArgs = calls.flat();
    expect(allArgs).not.toContain("--continue");
    expect(allArgs).not.toContain("-c");
    expect(allArgs).not.toContain("--fallback-model");
    expect(allArgs).not.toContain("--fork-session");
  });

  it("resumes only the exact pinned native session without latest, continue, or fallback modes", async () => {
    const fake = fakeClaude();
    const client = new ClaudeCodeCliRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: {
        YULU_FAKE_CLAUDE_LOG: fake.logPath,
        YULU_FAKE_CLAUDE_STDIN_LOG: fake.stdinLogPath,
      },
    });
    const nativeSessionId = "019f0000-0000-7000-8000-000000000136";

    await expect(client.runConversation({
      model: "claude-sonnet-5",
      prompt: "Continue the pinned conversation",
      probe: false,
      timeoutMs: 10_000,
      nativeSessionId,
    })).resolves.toMatchObject({ nativeSessionId, terminalStatus: "completed" });
    const calls = readFileSync(fake.logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls).toEqual([[
      "--safe-mode",
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--model", "claude-sonnet-5",
      "--resume", nativeSessionId,
    ]]);
    expect(calls.flat()).not.toEqual(expect.arrayContaining([
      "--session-id", "--continue", "-c", "--fallback-model", "--fork-session",
    ]));
  });

  it("preserves the initialized session and reports unknown when timeout cancellation is unconfirmed", async () => {
    const fake = fakeClaude();
    const nativeSessionId = "019f0000-0000-7000-8000-000000000999";
    const client = new ClaudeCodeCliRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: {
        YULU_FAKE_CLAUDE_LOG: fake.logPath,
        YULU_FAKE_CLAUDE_STDIN_LOG: fake.stdinLogPath,
        YULU_FAKE_CLAUDE_HANG: "1",
      },
      sessionIdFactory: () => nativeSessionId,
      cancellationGraceMs: 20,
    });

    await expect(client.runConversation({
      model: "claude-sonnet-5",
      prompt: "Never complete",
      probe: false,
      timeoutMs: 3_000,
    })).resolves.toMatchObject({
      nativeSessionId,
      actualModel: "claude-sonnet-5",
      terminalStatus: "unknown",
      cancellationRequested: true,
      cancellationConfirmed: false,
    });
  });

  it("classifies transport loss after init as unknown and preserves the observed native session", async () => {
    const fake = fakeClaude();
    const nativeSessionId = "019f0000-0000-7000-8000-000000000998";
    const client = new ClaudeCodeCliRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: {
        YULU_FAKE_CLAUDE_LOG: fake.logPath,
        YULU_FAKE_CLAUDE_STDIN_LOG: fake.stdinLogPath,
        YULU_FAKE_CLAUDE_NO_TERMINAL: "1",
      },
      sessionIdFactory: () => nativeSessionId,
    });

    await expect(client.runConversation({
      model: "claude-sonnet-5",
      prompt: "Lose transport after init",
      probe: false,
      timeoutMs: 10_000,
    })).resolves.toMatchObject({
      nativeSessionId,
      actualModel: "claude-sonnet-5",
      terminalStatus: "unknown",
      cancellationRequested: false,
      cancellationConfirmed: false,
    });
  });

  it("reports the actual model from terminal usage and marks a requested-model fallback", async () => {
    const fake = fakeClaude();
    const client = new ClaudeCodeCliRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: {
        YULU_FAKE_CLAUDE_LOG: fake.logPath,
        YULU_FAKE_CLAUDE_STDIN_LOG: fake.stdinLogPath,
        YULU_FAKE_CLAUDE_USAGE_MODEL: "claude-fallback",
      },
      sessionIdFactory: () => "019f0000-0000-7000-8000-000000000997",
    });

    await expect(client.runConversation({
      model: "claude-sonnet-5",
      prompt: "Do not accept fallback",
      probe: false,
      timeoutMs: 10_000,
    })).resolves.toMatchObject({
      actualModel: "claude-fallback",
      fallbackOccurred: true,
      terminalStatus: "completed",
    });
  });
});
