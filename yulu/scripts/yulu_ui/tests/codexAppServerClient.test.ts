import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CodexAppServerRuntimeClient } from "../src/codexAppServerClient.js";

const roots: string[] = [];

function fakeCodexRuntime(mode = "normal") {
  const root = mkdtempSync(join(tmpdir(), "yulu-fake-codex-"));
  roots.push(root);
  const executable = join(root, "codex");
  const runtime = join(root, "runtime.mjs");
  const audit = join(root, "audit.jsonl");
  const envAudit = join(root, "env-audit.jsonl");
  writeFileSync(executable, `#!/bin/sh\nexec "${process.execPath}" "${runtime}" "$@"\n`);
  chmodSync(executable, 0o755);
  writeFileSync(runtime, `
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.env.YULU_FAKE_CODEX_ENV_AUDIT) {
  appendFileSync(process.env.YULU_FAKE_CODEX_ENV_AUDIT, JSON.stringify({
    notionCredentialPresent: Boolean(process.env.NOTION_TOKEN),
    xaiCredentialPresent: Boolean(process.env.XAI_API_KEY),
    cloudCredentialPresent: Boolean(process.env.AWS_SECRET_ACCESS_KEY),
    projectContextPresent: Boolean(process.env.YULU_PROJECT_CONTEXT),
    pwdIsIsolated: /\\/yulu-codex-(?:inspect|isolated)-/.test(process.env.PWD ?? ""),
    homePresent: Boolean(process.env.HOME),
    pathPresent: Boolean(process.env.PATH),
  }) + "\\n");
}

if (process.argv.includes("--version")) {
  process.stdout.write("codex-cli 0.144.4\\n");
  process.exit(0);
}

const audit = process.env.YULU_FAKE_CODEX_AUDIT;
const mode = process.env.YULU_FAKE_CODEX_MODE;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  appendFileSync(audit, JSON.stringify(message) + "\\n");
  if (message.method === "initialized") continue;
  if (message.method === "initialize") send({ id: message.id, result: { userAgent: "fake" } });
  if (message.method === "account/read" && mode === "hang-account") continue;
  if (message.method === "account/read") send({ id: message.id, result: {
    account: { type: "chatgpt", email: "private@example.test", accessToken: "never-project-this" },
    requiresOpenaiAuth: true,
  } });
  if (message.method === "model/list") send({ id: message.id, result: {
    data: [{ id: "gpt-5.6-sol", model: "gpt-5.6-sol", hidden: false }],
    nextCursor: null,
  } });
  if (message.method === "experimentalFeature/list") send({ id: message.id, result: {
    data: [
      "apps", "browser_use", "browser_use_external", "browser_use_full_cdp_access",
      "computer_use", "enable_mcp_apps", "goals", "hooks", "image_generation",
      "in_app_browser", "memories", "multi_agent", "plugins", "remote_plugin",
      "shell_tool", "skill_mcp_dependency_install", "unified_exec",
    ]
      .filter((name) => !(mode === "missing-feature" && name === "hooks"))
      .map((name) => ({ name, enabled: mode === "enabled-feature" && name === "hooks" })),
    nextCursor: null,
  } });
  if (message.method === "mcpServerStatus/list") send({ id: message.id, result: {
    data: (
      (mode === "global-mcp" && !message.params.threadId) ||
      (mode === "thread-mcp" && message.params.threadId)
    ) ? [{ name: "inherited", tools: {}, resources: [], resourceTemplates: [] }] : [],
    nextCursor: null,
  } });
  if (message.method === "app/list") send({ id: message.id, result: {
    data: mode === "disabled-app"
      ? [{ id: "disabled", isEnabled: false }]
      : mode === "enabled-app"
        ? [{ id: "enabled", isEnabled: true }]
        : mode === "app-status-missing"
          ? [{ id: "unknown" }]
          : [],
    nextCursor: null,
  } });
  if (message.method === "thread/start" || message.method === "thread/resume") {
    const threadId = message.method === "thread/resume"
      ? message.params.threadId
      : "019f0000-0000-7000-8000-000000000135";
    send({ id: message.id, result: {
      thread: { id: threadId },
      model: message.params.model,
      modelProvider: "openai",
      instructionSources: mode === "inherited-instructions" ||
        (mode === "project-instructions" && message.params.config?.project_doc_max_bytes !== 0)
        ? [{ type: "agentsMd", path: "/private/AGENTS.md" }]
        : [],
    } });
  }
  if (message.method === "turn/start") {
    if (mode === "reject-turn-start") {
      send({ id: message.id, error: { code: -32602, message: "invalid turn shape" } });
      continue;
    }
    if (mode === "drop-turn-start") continue;
    const prompt = message.params.input[0].text;
    const answer = prompt.includes("YULU_CODEX_PROBE_OK") ? "YULU_CODEX_PROBE_OK" : "Pinned answer";
    send({ id: message.id, result: { turn: { id: "turn-135", status: "inProgress", items: [] } } });
    if (mode === "never-complete") continue;
    send({ method: "turn/completed", params: {
      threadId: message.params.threadId,
      turn: {
        id: "turn-135",
        status: "completed",
        error: null,
        items: [{ type: "agentMessage", id: "item-135", text: answer, phase: null, memoryCitation: null }],
      },
    } });
  }
  if (message.method === "turn/interrupt" && mode !== "never-complete") send({ id: message.id, result: {} });
}
`);
  return { root, executable, audit, envAudit, mode };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Codex app-server stdio client", () => {
  it("uses only non-secret account/read plus model/list for runtime inspection", async () => {
    const fake = fakeCodexRuntime();
    const client = new CodexAppServerRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: { YULU_FAKE_CODEX_AUDIT: fake.audit },
    });

    await expect(client.inspect()).resolves.toEqual({
      runtimeVersion: "0.144.4",
      authorized: true,
      models: ["gpt-5.6-sol"],
    });

    const messages = readFileSync(fake.audit, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "account/read",
      "model/list",
    ]);
    expect(messages.find((message) => message.method === "account/read")?.params).toEqual({ refreshToken: false });
    expect(JSON.stringify(await client.inspect())).not.toContain("private@example.test");
    expect(JSON.stringify(await client.inspect())).not.toContain("never-project-this");
  });

  it("creates a bounded tool-free probe with exact model and fallback disabled", async () => {
    const fake = fakeCodexRuntime();
    const client = new CodexAppServerRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: { YULU_FAKE_CODEX_AUDIT: fake.audit },
    });

    await expect(client.runTurn({
      model: "gpt-5.6-sol",
      prompt: "Reply with exactly YULU_CODEX_PROBE_OK and do not use tools.",
      probe: true,
      timeoutMs: 30_000,
    })).resolves.toMatchObject({
      answer: "YULU_CODEX_PROBE_OK",
      nativeSessionId: "019f0000-0000-7000-8000-000000000135",
      actualProvider: "openai",
      actualModel: "gpt-5.6-sol",
      requestId: "turn-135",
      fallbackOccurred: false,
      toolCalls: [],
      terminalStatus: "completed",
    });

    const messages = readFileSync(fake.audit, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const threadStart = messages.find((message) => message.method === "thread/start")?.params;
    expect(threadStart).toMatchObject({
      model: "gpt-5.6-sol",
      allowProviderModelFallback: false,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: true,
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      config: {
        "features.apps": false,
        "features.hooks": false,
        "features.multi_agent": false,
        "features.plugins": false,
        "features.shell_tool": false,
        "features.unified_exec": false,
        "hooks": {},
        "project_doc_max_bytes": 0,
        "project_root_markers": [],
        "skills.bundled.enabled": false,
        "skills.config": [],
        "skills.include_instructions": false,
        "tools.view_image": false,
        "tools.web_search": false,
        "web_search": "disabled",
      },
    });
    expect(messages.find((message) => message.method === "turn/start")?.params).toMatchObject({
      threadId: "019f0000-0000-7000-8000-000000000135",
      input: [{ type: "text", text: expect.stringContaining("YULU_CODEX_PROBE_OK"), text_elements: [] }],
    });
    const methods = messages.map((message) => message.method);
    expect(methods.indexOf("mcpServerStatus/list")).toBeGreaterThan(methods.indexOf("thread/start"));
    expect(methods.indexOf("mcpServerStatus/list")).toBeLessThan(methods.indexOf("turn/start"));
    expect(methods.indexOf("experimentalFeature/list")).toBeLessThan(methods.indexOf("turn/start"));
    expect(methods.indexOf("app/list")).toBeLessThan(methods.indexOf("turn/start"));
  });

  it("uses the same machine-proven isolated thread for production Summary turns", async () => {
    const fake = fakeCodexRuntime();
    const client = new CodexAppServerRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: { YULU_FAKE_CODEX_AUDIT: fake.audit },
    });

    await expect(client.runTurn({
      model: "gpt-5.6-sol",
      prompt: "selected instructions\ncommitted transcript",
      probe: false,
      toolFree: true,
      timeoutMs: 30_000,
    })).resolves.toMatchObject({
      answer: "Pinned answer",
      actualProvider: "openai",
      actualModel: "gpt-5.6-sol",
      fallbackOccurred: false,
      toolCalls: [],
      terminalStatus: "completed",
    });

    const messages = readFileSync(fake.audit, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const threadStart = messages.find((message) => message.method === "thread/start")?.params;
    expect(threadStart).toMatchObject({
      model: "gpt-5.6-sol",
      allowProviderModelFallback: false,
      ephemeral: true,
      environments: [],
      dynamicTools: [],
      selectedCapabilityRoots: [],
      config: expect.objectContaining({
        "features.hooks": false,
        "features.plugins": false,
        "features.shell_tool": false,
        "features.unified_exec": false,
        "project_doc_max_bytes": 0,
        "skills.include_instructions": false,
      }),
    });
    expect(threadStart.cwd).toMatch(/^\/.*\/yulu-codex-isolated-/);
    expect(threadStart.cwd).not.toBe(fake.root);
    expect(existsSync(threadStart.cwd)).toBe(false);
    const methods = messages.map((message) => message.method);
    expect(methods.indexOf("experimentalFeature/list")).toBeLessThan(methods.indexOf("turn/start"));
    expect(methods.indexOf("mcpServerStatus/list")).toBeLessThan(methods.indexOf("turn/start"));
    expect(methods.indexOf("app/list")).toBeLessThan(methods.indexOf("turn/start"));
  });

  it("removes unrelated credentials and project context from Summary inspection and execution", async () => {
    const fake = fakeCodexRuntime();
    const previous = {
      NOTION_TOKEN: process.env.NOTION_TOKEN,
      XAI_API_KEY: process.env.XAI_API_KEY,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      YULU_PROJECT_CONTEXT: process.env.YULU_PROJECT_CONTEXT,
    };
    process.env.NOTION_TOKEN = "test-notion-secret";
    process.env.XAI_API_KEY = "test-xai-secret";
    process.env.AWS_SECRET_ACCESS_KEY = "test-cloud-secret";
    process.env.YULU_PROJECT_CONTEXT = "test-project-context";
    try {
      const client = new CodexAppServerRuntimeClient({
        executable: fake.executable,
        cwd: fake.root,
        env: {
          YULU_FAKE_CODEX_AUDIT: fake.audit,
          YULU_FAKE_CODEX_ENV_AUDIT: fake.envAudit,
        },
      });

      await client.inspect({ toolFree: true });
      await client.runTurn({
        model: "gpt-5.6-sol",
        prompt: "selected instructions\ncommitted transcript",
        probe: false,
        toolFree: true,
        timeoutMs: 30_000,
      });

      const environments = readFileSync(fake.envAudit, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(environments.length).toBeGreaterThanOrEqual(3);
      expect(environments).toEqual(expect.arrayContaining([expect.objectContaining({
        notionCredentialPresent: false,
        xaiCredentialPresent: false,
        cloudCredentialPresent: false,
        projectContextPresent: false,
        pwdIsIsolated: true,
        homePresent: true,
        pathPresent: true,
      })]));
      expect(environments.every((environment) =>
        !environment.notionCredentialPresent && !environment.xaiCredentialPresent &&
        !environment.cloudCredentialPresent && !environment.projectContextPresent && environment.pwdIsIsolated
      )).toBe(true);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("fails closed before the probe turn when inherited instructions are reported", async () => {
    const fake = fakeCodexRuntime("inherited-instructions");
    const client = new CodexAppServerRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: { YULU_FAKE_CODEX_AUDIT: fake.audit, YULU_FAKE_CODEX_MODE: fake.mode },
    });

    await expect(client.runTurn({
      model: "gpt-5.6-sol",
      prompt: "Reply with exactly YULU_CODEX_PROBE_OK.",
      probe: true,
      timeoutMs: 100,
    })).rejects.toMatchObject({
      name: "CodexRuntimePreDispatchError",
      stage: "thread-isolation",
      modelRequestSent: false,
      message: expect.stringMatching(/inherited instructions/i),
    });

    const messages = readFileSync(fake.audit, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(messages.some((message) => message.method === "turn/start")).toBe(false);
  });

  it("disables project instruction discovery with a request-scoped zero-byte limit", async () => {
    const fake = fakeCodexRuntime("project-instructions");
    const client = new CodexAppServerRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: { YULU_FAKE_CODEX_AUDIT: fake.audit, YULU_FAKE_CODEX_MODE: fake.mode },
    });

    await expect(client.runTurn({
      model: "gpt-5.6-sol",
      prompt: "Reply with exactly YULU_CODEX_PROBE_OK.",
      probe: true,
      timeoutMs: 100,
    })).resolves.toMatchObject({ terminalStatus: "completed" });

    const messages = readFileSync(fake.audit, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(messages.find((message) => message.method === "thread/start")?.params.config)
      .toMatchObject({ project_doc_max_bytes: 0 });
  });

  it("allows global MCP configuration when the probe thread proves it was cleared", async () => {
    const fake = fakeCodexRuntime("global-mcp");
    const client = new CodexAppServerRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: { YULU_FAKE_CODEX_AUDIT: fake.audit, YULU_FAKE_CODEX_MODE: fake.mode },
    });

    await expect(client.runTurn({
      model: "gpt-5.6-sol",
      prompt: "Reply with exactly YULU_CODEX_PROBE_OK.",
      probe: true,
      timeoutMs: 100,
    })).resolves.toMatchObject({ terminalStatus: "completed" });

    const messages = readFileSync(fake.audit, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(messages.filter((message) => message.method === "mcpServerStatus/list"))
      .toEqual([expect.objectContaining({ params: expect.objectContaining({
        threadId: "019f0000-0000-7000-8000-000000000135",
      }) })]);
  });

  it("fails closed before the model turn when the probe thread still exposes MCP", async () => {
    const fake = fakeCodexRuntime("thread-mcp");
    const client = new CodexAppServerRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: { YULU_FAKE_CODEX_AUDIT: fake.audit, YULU_FAKE_CODEX_MODE: fake.mode },
    });

    await expect(client.runTurn({
      model: "gpt-5.6-sol",
      prompt: "Reply with exactly YULU_CODEX_PROBE_OK.",
      probe: true,
      timeoutMs: 100,
    })).rejects.toThrow(/inherited MCP/i);

    const messages = readFileSync(fake.audit, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(messages.some((message) => message.method === "thread/start")).toBe(true);
    expect(messages.some((message) => message.method === "turn/start")).toBe(false);
  });

  it("allows installed apps only when the probe thread reports them disabled", async () => {
    const fake = fakeCodexRuntime("disabled-app");
    const client = new CodexAppServerRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: { YULU_FAKE_CODEX_AUDIT: fake.audit, YULU_FAKE_CODEX_MODE: fake.mode },
    });

    await expect(client.runTurn({
      model: "gpt-5.6-sol",
      prompt: "Reply with exactly YULU_CODEX_PROBE_OK.",
      probe: true,
      timeoutMs: 100,
    })).resolves.toMatchObject({ terminalStatus: "completed" });
  });

  it.each(["enabled-feature", "missing-feature"])(
    "fails closed before the model turn when a required disabled feature is %s",
    async (mode) => {
      const fake = fakeCodexRuntime(mode);
      const client = new CodexAppServerRuntimeClient({
        executable: fake.executable,
        cwd: fake.root,
        env: { YULU_FAKE_CODEX_AUDIT: fake.audit, YULU_FAKE_CODEX_MODE: fake.mode },
      });

      await expect(client.runTurn({
        model: "gpt-5.6-sol",
        prompt: "Reply with exactly YULU_CODEX_PROBE_OK.",
        probe: true,
        timeoutMs: 100,
      })).rejects.toMatchObject({
        name: "CodexRuntimePreDispatchError",
        stage: "thread-isolation",
        modelRequestSent: false,
      });

      const messages = readFileSync(fake.audit, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(messages.some((message) => message.method === "turn/start")).toBe(false);
    },
  );

  it.each(["enabled-app", "app-status-missing"])(
    "fails closed before the model turn when an app is %s",
    async (mode) => {
      const fake = fakeCodexRuntime(mode);
      const client = new CodexAppServerRuntimeClient({
        executable: fake.executable,
        cwd: fake.root,
        env: { YULU_FAKE_CODEX_AUDIT: fake.audit, YULU_FAKE_CODEX_MODE: fake.mode },
      });

      await expect(client.runTurn({
        model: "gpt-5.6-sol",
        prompt: "Reply with exactly YULU_CODEX_PROBE_OK.",
        probe: true,
        timeoutMs: 100,
      })).rejects.toMatchObject({
        name: "CodexRuntimePreDispatchError",
        stage: "thread-isolation",
        modelRequestSent: false,
      });

      const messages = readFileSync(fake.audit, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(messages.some((message) => message.method === "turn/start")).toBe(false);
    },
  );

  it("bounds inspection RPCs instead of hanging on runtime status", async () => {
    const fake = fakeCodexRuntime("hang-account");
    const client = new CodexAppServerRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: { YULU_FAKE_CODEX_AUDIT: fake.audit, YULU_FAKE_CODEX_MODE: fake.mode },
      rpcTimeoutMs: 2_000,
    });

    await expect(client.inspect()).rejects.toThrow(/account\/read timed out/i);
  });

  it("classifies a post-send timeout as unknown and bounds cancellation", async () => {
    const fake = fakeCodexRuntime("never-complete");
    const client = new CodexAppServerRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: { YULU_FAKE_CODEX_AUDIT: fake.audit, YULU_FAKE_CODEX_MODE: fake.mode },
      rpcTimeoutMs: 2_000,
    });

    await expect(client.runTurn({
      model: "gpt-5.6-sol",
      prompt: "bounded",
      probe: false,
      timeoutMs: 25,
    })).resolves.toMatchObject({
      nativeSessionId: "019f0000-0000-7000-8000-000000000135",
      requestId: "turn-135",
      terminalStatus: "unknown",
      cancellationRequested: true,
      cancellationConfirmed: false,
    });

    const messages = readFileSync(fake.audit, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(messages.some((message) => message.method === "turn/interrupt")).toBe(true);
  });

  it("classifies a lost turn/start response as unknown while preserving the thread", async () => {
    const fake = fakeCodexRuntime("drop-turn-start");
    const client = new CodexAppServerRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: { YULU_FAKE_CODEX_AUDIT: fake.audit, YULU_FAKE_CODEX_MODE: fake.mode },
      rpcTimeoutMs: 2_000,
    });

    await expect(client.runTurn({
      model: "gpt-5.6-sol",
      prompt: "bounded",
      probe: false,
      timeoutMs: 25,
    })).resolves.toMatchObject({
      nativeSessionId: "019f0000-0000-7000-8000-000000000135",
      requestId: null,
      terminalStatus: "unknown",
      cancellationRequested: false,
      cancellationConfirmed: null,
    });
  });

  it("classifies a terminal turn/start rejection as failed instead of Unknown Outcome", async () => {
    const fake = fakeCodexRuntime("reject-turn-start");
    const client = new CodexAppServerRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: { YULU_FAKE_CODEX_AUDIT: fake.audit, YULU_FAKE_CODEX_MODE: fake.mode },
      rpcTimeoutMs: 2_000,
    });

    await expect(client.runTurn({
      model: "gpt-5.6-sol",
      prompt: "bounded",
      probe: false,
      timeoutMs: 25,
    })).resolves.toMatchObject({
      nativeSessionId: "019f0000-0000-7000-8000-000000000135",
      terminalStatus: "failed",
      failureStage: "turn_start_rejected",
      requestId: null,
    });
  });

  it("resumes only the exact pinned thread without latest-thread fallback", async () => {
    const fake = fakeCodexRuntime();
    const client = new CodexAppServerRuntimeClient({
      executable: fake.executable,
      cwd: fake.root,
      env: { YULU_FAKE_CODEX_AUDIT: fake.audit },
    });
    const nativeSessionId = "019f0000-0000-7000-8000-000000000999";

    await expect(client.runTurn({
      model: "gpt-5.6-sol",
      prompt: "continue",
      probe: false,
      timeoutMs: 300_000,
      nativeSessionId,
    })).resolves.toMatchObject({ nativeSessionId, actualModel: "gpt-5.6-sol" });

    const messages = readFileSync(fake.audit, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const resume = messages.find((message) => message.method === "thread/resume");
    expect(resume?.params).toMatchObject({
      threadId: nativeSessionId,
      model: "gpt-5.6-sol",
      approvalPolicy: "never",
      sandbox: "read-only",
      excludeTurns: true,
    });
    expect(messages.some((message) => JSON.stringify(message).includes("--last"))).toBe(false);
  });
});
