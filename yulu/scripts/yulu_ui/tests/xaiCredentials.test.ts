import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/executables.js", () => ({
  envWithFallbackPath: (env: NodeJS.ProcessEnv = process.env) => env,
  resolveExecutable: (command: string) => command,
}));

import { XaiCredentialManager } from "../src/xaiCredentials.js";

describe("XaiCredentialManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks xAI unavailable when neither Hermes nor OpenClaw is installed", async () => {
    const manager = new XaiCredentialManager();

    await expect(manager.status()).resolves.toMatchObject({
      sources: [
        { source: "hermes", installed: false, connected: false },
        { source: "openclaw", installed: false, connected: false },
      ],
    });
    await expect(manager.resolve("auto")).rejects.toThrow(
      "Hermes/OpenClaw 均没有可用的 xAI OAuth",
    );
  });
});
