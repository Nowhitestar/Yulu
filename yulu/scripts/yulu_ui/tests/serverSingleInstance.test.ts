import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { HostStore } from "../src/hostStore.js";
import { hostInstanceLockPath } from "../src/hostInstanceLock.js";
import { startServer, type RunningServer } from "../src/server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
const originalPort = process.env.YULU_UI_PORT;

function makeRuntime() {
  const root = mkdtempSync(join(tmpdir(), "yulu_single_server_"));
  roots.push(root);
  const configDir = join(root, ".config", "yulu");
  const moviesDir = join(root, "Movies", "Yulu");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(moviesDir, { recursive: true });
  cpSync(join(HERE, "fixtures/config.json"), join(configDir, "config.json"));
  const configPath = join(configDir, "config.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  config.llm = { ...(config.llm as Record<string, unknown>), enabled: false };
  writeFileSync(configPath, JSON.stringify(config));
  for (const filename of ["prompts.sqlite", "vocab.sqlite", "search.sqlite"]) {
    new Database(join(configDir, filename)).close();
  }
  return {
    root,
    configDir,
    paths: {
      configDir,
      configFile: configPath,
      promptsDb: join(configDir, "prompts.sqlite"),
      vocabDb: join(configDir, "vocab.sqlite"),
      searchDb: join(configDir, "search.sqlite"),
      moviesDir,
      agentQueueJson: join(configDir, "agent-queue.json"),
      mcpTokenJson: join(configDir, "mcp-token.json"),
    },
  };
}

function closeHttp(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

afterEach(() => {
  if (originalPort === undefined) delete process.env.YULU_UI_PORT;
  else process.env.YULU_UI_PORT = originalPort;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("server single-instance lifecycle", () => {
  it("rejects the same configDir before Host recovery and can restart after close", async () => {
    process.env.YULU_UI_PORT = "0";
    const runtime = makeRuntime();
    const recoverSpy = vi.spyOn(
      HostStore.prototype as unknown as Record<string, () => void>,
      "recoverInterrupted",
    );
    let first: RunningServer | null = null;
    let restarted: RunningServer | null = null;
    try {
      first = await startServer(runtime.paths);
      recoverSpy.mockClear();

      await expect(startServer(runtime.paths)).rejects.toMatchObject({
        code: "YULU_HOST_ALREADY_RUNNING",
      });
      expect(recoverSpy).not.toHaveBeenCalled();

      await first.close();
      first = null;
      restarted = await startServer(runtime.paths);
      expect(recoverSpy).toHaveBeenCalledOnce();
    } finally {
      await restarted?.close();
      await first?.close();
    }
  });

  it("rejects EADDRINUSE and releases the startup lock for a retry", async () => {
    const blocker = createHttpServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const address = blocker.address();
    if (!address || typeof address === "string") throw new Error("blocker did not bind a TCP port");

    const runtime = makeRuntime();
    process.env.YULU_UI_PORT = String(address.port);
    let retry: RunningServer | null = null;
    try {
      await expect(startServer(runtime.paths)).rejects.toMatchObject({ code: "EADDRINUSE" });
      expect(existsSync(hostInstanceLockPath(runtime.configDir))).toBe(false);

      process.env.YULU_UI_PORT = "0";
      retry = await startServer(runtime.paths);
      expect(retry.address.port).toBeGreaterThan(0);
    } finally {
      await retry?.close();
      await closeHttp(blocker);
    }
  });
});
