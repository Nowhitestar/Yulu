import { afterEach, describe, expect, it, vi } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { HostStore } from "../src/hostStore.js";
import { createAgentSession } from "../src/agentSessionStore.js";
import { prepareHostDurableData } from "../src/hostDataMigration.js";
import { isAuthorizedToken } from "../src/mcp.js";
import { resolveHostPaths } from "../src/paths.js";
import { startServer, type RunningServer } from "../src/server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
const originalPort = process.env.YULU_UI_PORT;
const originalDevelopmentSmoke = process.env.YULU_DEV_SMOKE;

afterEach(() => {
  if (originalPort === undefined) delete process.env.YULU_UI_PORT;
  else process.env.YULU_UI_PORT = originalPort;
  if (originalDevelopmentSmoke === undefined) delete process.env.YULU_DEV_SMOKE;
  else process.env.YULU_DEV_SMOKE = originalDevelopmentSmoke;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("Host durable-data migration", () => {
  it("rejects standard file and directory symlink authorities", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-host-authority-symlinks-"));
    roots.push(root);
    const cases = [
      { name: "config", destination: "configFile", targetType: "file" },
      { name: "host database", destination: "hostDb", targetType: "file" },
      { name: "Agent tasks", destination: "agentTasksDir", targetType: "directory" },
      { name: "Models", destination: "modelsDir", targetType: "directory" },
    ] as const;

    for (const testCase of cases) {
      const caseRoot = join(root, testCase.name.replaceAll(" ", "-"));
      const paths = resolveHostPaths({ homeDir: caseRoot, environment: {} });
      mkdirSync(paths.durableDataDir, { recursive: true });
      const external = join(caseRoot, "external", testCase.targetType === "file" ? "value" : "root");
      if (testCase.targetType === "file") {
        mkdirSync(dirname(external), { recursive: true });
        writeFileSync(external, "external authority");
      } else {
        mkdirSync(external, { recursive: true });
      }
      symlinkSync(external, paths[testCase.destination]);

      await expect(prepareHostDurableData(paths), testCase.name)
        .rejects.toThrow(/authority|symbolic|unsafe/i);
      if (testCase.targetType === "file") {
        expect(readFileSync(external, "utf8")).toBe("external authority");
      } else {
        expect(existsSync(join(external, "unexpected-write"))).toBe(false);
      }
    }
  });

  it("rejects legacy file and directory symlink authorities", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-host-source-symlinks-"));
    roots.push(root);
    const cases = [
      { name: "config.json", targetType: "file" },
      { name: "host.sqlite", targetType: "sqlite" },
      { name: "agent-tasks", targetType: "directory" },
      { name: "models", targetType: "directory" },
    ] as const;

    for (const testCase of cases) {
      const caseRoot = join(root, testCase.name.replaceAll(".", "-"));
      const paths = resolveHostPaths({ homeDir: caseRoot, environment: {} });
      mkdirSync(paths.legacyReadOnlyDataDir, { recursive: true });
      const external = join(caseRoot, "external", testCase.name);
      mkdirSync(dirname(external), { recursive: true });
      if (testCase.targetType === "directory") {
        mkdirSync(external, { recursive: true });
      } else if (testCase.targetType === "sqlite") {
        const externalHost = new HostStore(external);
        externalHost.close();
      } else {
        writeFileSync(external, "{}\n");
      }
      symlinkSync(external, join(paths.legacyReadOnlyDataDir, testCase.name));

      await expect(prepareHostDurableData(paths), testCase.name)
        .rejects.toThrow(/authority|symbolic|unsafe/i);
    }
  });

  it("rejects wrong-type and invalid existing standard authorities", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-host-authority-invalid-"));
    roots.push(root);

    for (const destination of ["configFile", "agentTasksDir", "modelsDir"] as const) {
      const caseRoot = join(root, destination);
      const paths = resolveHostPaths({ homeDir: caseRoot, environment: {} });
      mkdirSync(paths.durableDataDir, { recursive: true });
      if (destination === "configFile") mkdirSync(paths[destination]);
      else writeFileSync(paths[destination], "not a directory");
      await expect(prepareHostDurableData(paths), destination)
        .rejects.toThrow(/authority|regular file|directory|unsafe/i);
    }

    const corruptPaths = resolveHostPaths({ homeDir: join(root, "corrupt-sqlite"), environment: {} });
    mkdirSync(corruptPaths.durableDataDir, { recursive: true });
    writeFileSync(corruptPaths.hostDb, "not sqlite");
    await expect(prepareHostDurableData(corruptPaths)).rejects.toThrow(/SQLite|integrity|authority/i);

    const wrongSchemaPaths = resolveHostPaths({ homeDir: join(root, "wrong-schema"), environment: {} });
    mkdirSync(wrongSchemaPaths.durableDataDir, { recursive: true });
    const wrongSchema = new Database(wrongSchemaPaths.hostDb);
    wrongSchema.exec("CREATE TABLE unrelated (value TEXT)");
    wrongSchema.close();
    await expect(prepareHostDurableData(wrongSchemaPaths)).rejects.toThrow(/SQLite|schema|authority/i);
  });

  it("rejects a symbolic SQLite sidecar before opening the database", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-host-sidecar-symlink-"));
    roots.push(root);
    const paths = resolveHostPaths({ homeDir: root, environment: {} });
    const standardHost = new HostStore(paths.hostDb);
    standardHost.close();
    const external = join(root, "external-shm");
    writeFileSync(external, "external sidecar target");
    symlinkSync(external, `${paths.hostDb}-shm`);

    await expect(prepareHostDurableData(paths)).rejects.toThrow(/authority|symbolic|unsafe/i);
    expect(readFileSync(external, "utf8")).toBe("external sidecar target");
  });

  it("rejects a standard root that canonically aliases the legacy root", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-host-authority-alias-"));
    roots.push(root);
    const resolved = resolveHostPaths({ homeDir: root, environment: {} });
    mkdirSync(resolved.legacyReadOnlyDataDir, { recursive: true });
    const legacySentinel = join(resolved.legacyReadOnlyDataDir, "sentinel");
    writeFileSync(legacySentinel, "legacy remains read-only\n");
    chmodSync(resolved.legacyReadOnlyDataDir, 0o755);
    const legacyModeBefore = statSync(resolved.legacyReadOnlyDataDir).mode & 0o777;
    const alias = join(root, "standard-alias");
    symlinkSync(resolved.legacyReadOnlyDataDir, alias);
    const paths = {
      ...resolved,
      durableDataDir: alias,
      configFile: join(alias, "config.json"),
      promptsDb: join(alias, "prompts.sqlite"),
      vocabDb: join(alias, "vocab.sqlite"),
      searchDb: join(alias, "search.sqlite"),
      hostDb: join(alias, "host.sqlite"),
      agentTasksDir: join(alias, "agent-tasks"),
      modelsDir: join(alias, "Models"),
      mcpTokenJson: join(alias, "mcp-token.json"),
    };

    await expect(prepareHostDurableData(paths)).rejects.toThrow(/alias|authority|overlap|unsafe/i);
    expect(readFileSync(legacySentinel, "utf8")).toBe("legacy remains read-only\n");
    expect(statSync(resolved.legacyReadOnlyDataDir).mode & 0o777).toBe(legacyModeBefore);
  });

  it("redacts MCP token paths when legacy token preparation fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-host-token-redaction-"));
    roots.push(root);
    const paths = resolveHostPaths({ homeDir: root, environment: {} });
    mkdirSync(join(paths.legacyReadOnlyDataDir, "mcp-token.json"), { recursive: true });

    let error: unknown;
    try {
      await startServer(paths);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("MCP token migration failed");
    expect((error as Error).message).not.toContain(paths.mcpTokenJson);
    expect((error as Error).message).not.toContain(paths.legacyReadOnlyDataDir);
  });

  it("starts from a live legacy SQLite snapshot and writes only standard durable state", async () => {
    const root = mkdtempSync(join(tmpdir(), "yulu-host-data-migration-"));
    roots.push(root);
    const paths = resolveHostPaths({ homeDir: root, environment: {} });
    const legacy = paths.legacyReadOnlyDataDir;
    mkdirSync(legacy, { recursive: true });
    mkdirSync(paths.moviesDir, { recursive: true });

    const legacyConfig = join(legacy, "config.json");
    const originalConfig = readFileSync(join(HERE, "fixtures/config.json"), "utf8");
    writeFileSync(legacyConfig, originalConfig, { mode: 0o600 });
    const token = "migration-secret-token";
    const legacyToken = join(legacy, "mcp-token.json");
    writeFileSync(legacyToken, JSON.stringify({ token }), { mode: 0o600 });
    chmodSync(legacyToken, 0o600);

    const legacyHost = new HostStore(join(legacy, "host.sqlite"));
    legacyHost.deferActivationJourney();
    legacyHost.close();

    const legacySession = createAgentSession(legacy, {
      provider: "codex",
      model: "gpt-5.6-sol",
      title: "Legacy conversation",
      purpose: "ask",
    });
    const legacySessionsBefore = readFileSync(join(legacy, "agent-sessions.json"), "utf8");
    const legacyTaskId = "11111111-1111-4111-8111-111111111111";
    const legacyTaskFile = join(legacy, "agent-tasks", legacyTaskId, "transcript.txt");
    mkdirSync(dirname(legacyTaskFile), { recursive: true });
    writeFileSync(legacyTaskFile, "legacy task workspace\n", { mode: 0o600 });

    const livePrompts = new Database(join(legacy, "prompts.sqlite"));
    livePrompts.pragma("journal_mode = WAL");
    livePrompts.pragma("wal_autocheckpoint = 0");
    livePrompts.exec(`
      CREATE TABLE prompts (id TEXT PRIMARY KEY);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta(key, value) VALUES ('schema_version', '1');
      CREATE TABLE migration_probe (value TEXT NOT NULL);
    `);
    livePrompts.prepare("INSERT INTO migration_probe (value) VALUES (?)").run("from-live-wal");
    expect(existsSync(join(legacy, "prompts.sqlite-wal"))).toBe(true);
    const legacyVocab = new Database(join(legacy, "vocab.sqlite"));
    legacyVocab.exec(`
      CREATE TABLE custom_words (id TEXT PRIMARY KEY);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta(key, value) VALUES ('schema_version', '1');
    `);
    legacyVocab.close();
    const legacySearch = new Database(join(legacy, "search.sqlite"));
    legacySearch.exec(`
      CREATE TABLE docs (body TEXT);
      CREATE TABLE docs_meta (source_path TEXT PRIMARY KEY);
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta(key, value) VALUES ('schema_version', '1');
    `);
    legacySearch.close();

    const legacyModel = join(legacy, "models", "test-model", "model.bin");
    mkdirSync(dirname(legacyModel), { recursive: true });
    writeFileSync(legacyModel, "legacy-model");

    const output: string[] = [];
    vi.spyOn(console, "warn").mockImplementation((...args) => { output.push(args.join(" ")); });
    vi.spyOn(console, "error").mockImplementation((...args) => { output.push(args.join(" ")); });
    process.env.YULU_UI_PORT = "0";
    process.env.YULU_DEV_SMOKE = "1";
    let server: RunningServer | null = null;
    try {
      await prepareHostDurableData(paths);
      expect(readFileSync(join(paths.durableDataDir, "agent-sessions.json"), "utf8"))
        .toBe(legacySessionsBefore);
      expect(readFileSync(join(paths.agentTasksDir, legacyTaskId, "transcript.txt"), "utf8"))
        .toBe("legacy task workspace\n");

      const { agentTasksDir: _resolvedAgentTasksDir, ...serverPaths } = paths;
      server = await startServer(serverPaths);

      expect(JSON.parse(readFileSync(paths.configFile, "utf8")).audio)
        .toEqual(JSON.parse(originalConfig).audio);
      expect(readFileSync(legacyConfig, "utf8")).toBe(originalConfig);
      expect(existsSync(`${paths.promptsDb}-wal`)).toBe(false);
      expect(existsSync(`${paths.promptsDb}-shm`)).toBe(false);
      expect(existsSync(join(legacy, "prompts.sqlite-wal"))).toBe(true);

      const migratedPrompts = new Database(paths.promptsDb, { readonly: true });
      try {
        expect(migratedPrompts.prepare("SELECT value FROM migration_probe").pluck().get())
          .toBe("from-live-wal");
      } finally {
        migratedPrompts.close();
      }

      const migratedHost = new Database(paths.hostDb, { readonly: true });
      try {
        expect(migratedHost.prepare(
          "SELECT deferred_at FROM activation_journey_state WHERE id = 1",
        ).pluck().get()).toEqual(expect.any(String));
      } finally {
        migratedHost.close();
      }
      const rollbackHost = new Database(join(legacy, "host.sqlite"), { readonly: true });
      try {
        expect(rollbackHost.prepare(
          "SELECT deferred_at FROM activation_journey_state WHERE id = 1",
        ).pluck().get()).toEqual(expect.any(String));
      } finally {
        rollbackHost.close();
      }

      expect(readFileSync(join(paths.modelsDir, "test-model", "model.bin"), "utf8"))
        .toBe("legacy-model");
      expect(readFileSync(legacyModel, "utf8")).toBe("legacy-model");
      expect(isAuthorizedToken(paths.mcpTokenJson, `Bearer ${token}`)).toBe(true);
      expect(statSync(paths.mcpTokenJson).mode & 0o777).toBe(0o600);
      expect(output.join("\n")).not.toContain(token);
      expect(output.join("\n")).not.toContain(paths.mcpTokenJson);

      const baseUrl = `http://127.0.0.1:${server.address.port}`;
      const status = await fetch(`${baseUrl}/trpc/system.version`);
      const statusBody = await status.text();
      expect(statusBody).not.toContain(token);
      expect(statusBody).not.toContain(paths.mcpTokenJson);

      const uiTokenResponse = await fetch(`${baseUrl}/api/ui-token`);
      const uiToken = (await uiTokenResponse.json() as { token: string }).token;
      const rename = await fetch(`${baseUrl}/trpc/agentSessions.rename`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ id: legacySession.id, title: "Standard conversation" }),
      });
      const renameBody = await rename.text();
      expect(rename.status, renameBody).toBe(200);
      const standardSessions = JSON.parse(
        readFileSync(join(paths.durableDataDir, "agent-sessions.json"), "utf8"),
      ) as { sessions: { id: string; title: string }[] };
      expect(standardSessions.sessions.find(({ id }) => id === legacySession.id)?.title)
        .toBe("Standard conversation");
      expect(readFileSync(join(legacy, "agent-sessions.json"), "utf8"))
        .toBe(legacySessionsBefore);
      expect(readFileSync(legacyTaskFile, "utf8")).toBe("legacy task workspace\n");

      const update = await fetch(`${baseUrl}/trpc/config.update`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ key: "ui.language", value: "en" }),
      });
      const updateBody = await update.text();
      expect(update.status, updateBody).toBe(200);
      expect(JSON.parse(readFileSync(paths.configFile, "utf8")).ui.language).toBe("en");
      expect(readFileSync(legacyConfig, "utf8")).toBe(originalConfig);
    } finally {
      await server?.close();
      livePrompts.close();
    }
  });
});
