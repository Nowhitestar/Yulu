import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { resolveHermesAgentRuntime } from "../src/agentRuntime.js";

describe("resolveHermesAgentRuntime", () => {
  let root = "";
  const originalPath = process.env.PATH;

  afterEach(() => {
    process.env.PATH = originalPath;
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
  });

  function installFakeHermes(): void {
    root = mkdtempSync(join(tmpdir(), "yulu-hermes-runtime-"));
    const hermes = join(root, "hermes");
    writeFileSync(hermes, "#!/bin/sh\nexit 0\n");
    chmodSync(hermes, 0o755);
    process.env.PATH = `${root}${delimiter}${originalPath ?? ""}`;
  }

  it("uses only the direct Hermes executable and ignores Agent Console wrappers", () => {
    installFakeHermes();
    const runtime = resolveHermesAgentRuntime({
      llm: {
        enabled: true,
        command: ["/custom/hermes-wrapper", "--profile", "work"],
        agent: { provider: "hermes" },
      },
    }, { scriptDir: "/scripts", moviesDir: "/movies" });

    expect(runtime).toMatchObject({
      provider: "hermes",
      source: "auto-detected",
      command: ["hermes"],
      cwd: "/movies",
      disabledReason: null,
    });
  });

  it("does not couple recording Hermes capability to llm.enabled or chat provider", () => {
    installFakeHermes();
    const runtime = resolveHermesAgentRuntime({
      llm: { enabled: false, agent: { provider: "codex" }, command: ["codex", "exec"] },
    }, { scriptDir: "/scripts", moviesDir: "/movies" });

    expect(runtime).toMatchObject({ provider: "hermes", command: ["hermes"], disabledReason: null });
  });
});
