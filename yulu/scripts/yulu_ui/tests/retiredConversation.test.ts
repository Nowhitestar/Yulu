import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { ConfigManager, migrateRetiredConversationConfig, XAI_TEXT_MODEL_DEFAULT } from "../src/config.js";
import { FAST_DICTATION_MODEL } from "../src/dictationPreferences.js";
import {
  carryOverRetiredConversationDisclosure,
  hasXaiDictationTextDisclosure,
  RETIRED_XAI_CONVERSATION_DISCLOSURE_VERSION,
  XAI_DICTATION_TEXT_DISCLOSURE_VERSION,
} from "../src/dictationTextDisclosure.js";
import { HostStore } from "../src/hostStore.js";
import { archiveRetiredConversationSessions } from "../src/retiredConversationData.js";
import { dictationTextRouter } from "../src/routers/dictationText.js";
import { createCaller, type AppContext } from "../src/trpc.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function tempDir(): string {
  const root = mkdtempSync(join(tmpdir(), "yulu-retired-conversation-"));
  roots.push(root);
  return root;
}

function writeConfig(config: Record<string, unknown>, mode = 0o600): { dir: string; path: string } {
  const dir = tempDir();
  const path = join(dir, "config.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode });
  return { dir, path };
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, any>;
const archives = (dir: string) => readdirSync(dir).filter((name) => name.includes(".legacy-conversation."));

/** A config as the previous version wrote it, with every setting ADR-010 retires. */
function previousVersionConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    audio: { output_dir: "~/Movies/Yulu" },
    transcription: {
      engine: "xai",
      dictation: { cleanup_enabled: true, style: "formal", voice_chat_scope: "meetings", target_language: "Japanese" },
    },
    intelligence: {
      summary: { provider: "agent", connectionId: "codex", model: "gpt-5.6-sol" },
      conversation: { provider: "xai", model: "grok-custom-pinned" },
    },
    status_agent: {
      enabled: true,
      hotkeys: {
        dictate: { key: "Fn", modifiers: [] },
        translate: { key: "Fn", modifiers: ["shift"], target_language: "English" },
        voice_chat: { key: "Space", modifiers: ["fn"] },
      },
    },
    agent_console: {
      plugins: { added: ["summary", "notion"] },
      destinations: { hermes: { notion: { target: "Meetings DB" } } },
    },
    future_forward_compatible_key: { keep: true },
    ...overrides,
  };
}

describe("retired conversation settings (ADR-010)", () => {
  it("archives every retired setting privately and keeps dictation cleanup on its pinned xAI model", () => {
    const { dir, path } = writeConfig(previousVersionConfig(), 0o640);

    const result = migrateRetiredConversationConfig(path);

    expect(result.changed).toBe(true);
    const active = readJson(path);
    expect(active.intelligence).toEqual({ summary: { provider: "agent", connectionId: "codex", model: "gpt-5.6-sol" } });
    expect(active.agent_console).toBeUndefined();
    expect(active.status_agent.hotkeys).toEqual({
      dictate: { key: "Fn", modifiers: [] },
      translate: { key: "Fn", modifiers: ["shift"], target_language: "English" },
    });
    expect(active.transcription.dictation).toEqual({
      cleanup_enabled: true,
      style: "formal",
      target_language: "Japanese",
      text_provider: "xai",
      text_model: "grok-custom-pinned",
    });
    expect(active.future_forward_compatible_key).toEqual({ keep: true });
    expect(statSync(path).mode & 0o777).toBe(0o640);

    expect(archives(dir)).toHaveLength(1);
    const archivePath = join(dir, archives(dir)[0]!);
    expect(result.archivePath).toBe(archivePath);
    expect(statSync(archivePath).mode & 0o777).toBe(0o600);
    expect(readJson(archivePath)).toMatchObject({
      version: 1,
      sourcePath: path,
      intelligence: { conversation: { provider: "xai", model: "grok-custom-pinned" } },
      transcription: { dictation: { voice_chat_scope: "meetings" } },
      status_agent: { hotkeys: { voice_chat: { key: "Space", modifiers: ["fn"] } } },
      agent_console: { plugins: { added: ["summary", "notion"] } },
    });
  });

  it("is idempotent and leaves a current config byte-for-byte untouched", () => {
    const { dir, path } = writeConfig(previousVersionConfig());
    expect(migrateRetiredConversationConfig(path).changed).toBe(true);
    const migrated = readFileSync(path, "utf8");

    expect(migrateRetiredConversationConfig(path)).toEqual({ changed: false, archivePath: null });
    expect(readFileSync(path, "utf8")).toBe(migrated);
    expect(archives(dir)).toHaveLength(1);
  });

  it.each([
    {
      name: "an Agent Conversation Provider never sent dictated text, so cleanup stays off",
      conversation: { provider: "agent", connectionId: "claude-code", model: "claude-sonnet-5" },
      cleanupModel: undefined,
      expected: { text_provider: "none" },
    },
    {
      name: "the default Conversation selection never sent dictated text",
      conversation: { provider: "agent" },
      cleanupModel: "conversation",
      expected: { text_provider: "none" },
    },
    {
      name: "an explicit fast model is kept even while cleanup could not run",
      conversation: { provider: "agent", model: "runtime-managed", disabled: true },
      cleanupModel: FAST_DICTATION_MODEL,
      expected: { text_provider: "none", text_model: FAST_DICTATION_MODEL },
    },
    {
      name: "an explicit fast model stays the model for a working xAI selection",
      conversation: { provider: "xai", model: "grok-custom-pinned" },
      cleanupModel: FAST_DICTATION_MODEL,
      expected: { text_provider: "xai", text_model: FAST_DICTATION_MODEL },
    },
    {
      name: "\"conversation\" resolves to the model that was pinned",
      conversation: { provider: "xai", model: "grok-custom-pinned" },
      cleanupModel: "conversation",
      expected: { text_provider: "xai", text_model: "grok-custom-pinned" },
    },
    {
      name: "an xAI selection without a model keeps the documented default",
      conversation: { provider: "xai" },
      cleanupModel: undefined,
      expected: { text_provider: "xai", text_model: XAI_TEXT_MODEL_DEFAULT },
    },
  ])("derives the dictation text selection: $name", ({ conversation, cleanupModel, expected }) => {
    const { path } = writeConfig({
      transcription: { dictation: { ...(cleanupModel ? { cleanup_model: cleanupModel } : {}) } },
      intelligence: { conversation },
    });

    migrateRetiredConversationConfig(path);

    const dictation = readJson(path).transcription.dictation;
    expect(dictation).toEqual(expected);
    // New values go only into new keys so the previous App can still read the file.
    expect(dictation).not.toHaveProperty("cleanup_model");
  });

  it("never turns dictation text on from a Conversation selection that reappears later", () => {
    const { path } = writeConfig({
      transcription: { dictation: { text_provider: "none" } },
      // As written by the previous App after an update rollback.
      intelligence: { conversation: { provider: "xai", model: "grok-4.6" } },
    });

    migrateRetiredConversationConfig(path);

    const active = readJson(path);
    expect(active.transcription.dictation.text_provider).toBe("none");
    expect(active.intelligence).toEqual({});
  });

  it("loads a config written by the previous version and exposes only current settings", () => {
    const { dir, path } = writeConfig(previousVersionConfig());

    const config = new ConfigManager(path).read();

    expect(config.intelligence).toEqual({ summary: { provider: "agent", connectionId: "codex", model: "gpt-5.6-sol" } });
    expect(config.transcription.dictation).toMatchObject({ text_provider: "xai", text_model: "grok-custom-pinned" });
    expect(config).not.toHaveProperty("agent_console");
    expect(archives(dir)).toHaveLength(1);
    // A second start finds nothing left to archive.
    new ConfigManager(path).read();
    expect(archives(dir)).toHaveLength(1);
  });

  it("does nothing for a missing config and refuses a config that is not an object", () => {
    const dir = tempDir();
    expect(migrateRetiredConversationConfig(join(dir, "absent.json"))).toEqual({ changed: false, archivePath: null });
    const path = join(dir, "config.json");
    writeFileSync(path, "[]\n");
    expect(() => migrateRetiredConversationConfig(path)).toThrow(/must contain a JSON object/);
  });
});

describe("retired conversation session store (ADR-010)", () => {
  it("renames the store to a private archive without parsing it", () => {
    const dir = tempDir();
    const source = join(dir, "agent-sessions.json");
    writeFileSync(source, "{ this is not JSON", { mode: 0o644 });

    const archive = archiveRetiredConversationSessions(dir);

    expect(archive).toMatch(/agent-sessions\.retired\.\d{8}T\d{9}Z\.json$/);
    expect(existsSync(source)).toBe(false);
    expect(readFileSync(archive!, "utf8")).toBe("{ this is not JSON");
    expect(statSync(archive!).mode & 0o777).toBe(0o600);
    expect(archiveRetiredConversationSessions(dir)).toBeNull();
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("does nothing when no session store exists", () => {
    const dir = tempDir();
    expect(archiveRetiredConversationSessions(dir)).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });
});

function hostWithLegacyConversationReceipt(decision: "accepted" | "declined" | null, version = "xai-conversation-v1") {
  const dir = tempDir();
  const hostPath = join(dir, "host.sqlite");
  const host = new HostStore(hostPath);
  host.upsertAgentConnectionRecord({
    id: "direct-xai",
    kind: "direct-provider",
    adapter: "direct-xai",
    label: "xAI",
    lifecycle: "available",
    settings: { credentialSource: "oauth" },
  });
  if (decision) {
    // The previous version wrote this row; the current Host has no API that can.
    const legacy = new Database(hostPath);
    legacy.prepare(`
      INSERT INTO agent_connection_disclosures (connection_id, capability, disclosure_version, decision, decided_at)
      VALUES ('direct-xai', 'conversation', ?, ?, '2026-09-01T08:00:00.000Z')
    `).run(version, decision);
    legacy.close();
  }
  return { dir, host };
}

function configReader(textProvider: "none" | "xai", engine: "local" | "xai" = "xai") {
  const { path } = writeConfig({
    transcription: { engine, dictation: { text_provider: textProvider, text_model: "grok-custom-pinned" } },
  });
  return new ConfigManager(path);
}

describe("dictation text disclosure (ADR-010)", () => {
  it("carries the accepted xAI Conversation receipt over once for a migrated xAI selection", () => {
    const { host } = hostWithLegacyConversationReceipt("accepted");
    const config = configReader("xai");
    expect(hasXaiDictationTextDisclosure(host)).toBe(false);

    expect(carryOverRetiredConversationDisclosure(host, config)).toBe(true);

    expect(host.getDictationTextDisclosure("xai")).toEqual({
      provider: "xai",
      disclosureVersion: RETIRED_XAI_CONVERSATION_DISCLOSURE_VERSION,
      decision: "accepted",
      decidedAt: "2026-09-01T08:00:00.000Z",
    });
    expect(hasXaiDictationTextDisclosure(host)).toBe(true);
    expect(carryOverRetiredConversationDisclosure(host, config)).toBe(false);
    host.close();
  });

  it.each([
    { name: "dictation text was not selected", provider: "none" as const, decision: "accepted" as const, version: "xai-conversation-v1" },
    { name: "the receipt was declined", provider: "xai" as const, decision: "declined" as const, version: "xai-conversation-v1" },
    { name: "the receipt is for another version", provider: "xai" as const, decision: "accepted" as const, version: "xai-conversation-v0" },
    { name: "there is no receipt", provider: "xai" as const, decision: null, version: "xai-conversation-v1" },
  ])("does not create consent when $name, and does not retry later", ({ provider, decision, version }) => {
    const { host } = hostWithLegacyConversationReceipt(decision, version);

    expect(carryOverRetiredConversationDisclosure(host, configReader(provider))).toBe(false);
    expect(hasXaiDictationTextDisclosure(host)).toBe(false);

    // Turning the provider on afterwards requires the dictation disclosure itself.
    expect(carryOverRetiredConversationDisclosure(host, configReader("xai"))).toBe(false);
    expect(hasXaiDictationTextDisclosure(host)).toBe(false);
    host.close();
  });

  it("never replaces a dictation receipt the user already accepted", () => {
    const { host } = hostWithLegacyConversationReceipt("accepted");
    const accepted = host.recordDictationTextDisclosure("xai", XAI_DICTATION_TEXT_DISCLOSURE_VERSION);

    carryOverRetiredConversationDisclosure(host, configReader("xai"));

    expect(host.getDictationTextDisclosure("xai")).toEqual(accepted);
    host.close();
  });

  it("reports why dictation text is or is not active and records an explicit acceptance", async () => {
    const { host } = hostWithLegacyConversationReceipt(null);
    let credentialSource: "oauth" | null = "oauth";
    const context = (config: ConfigManager, authorized: boolean) => ({
      uiMutationAuthorized: authorized,
      host,
      config,
      agentConnections: { selectedXaiCredentialSource: () => credentialSource },
    }) as unknown as AppContext;

    const off = createCaller(dictationTextRouter, context(configReader("none"), true));
    await expect(off.status()).resolves.toMatchObject({
      provider: "none",
      audioEngine: "xai",
      active: false,
      disclosure: {
        disclosureVersion: XAI_DICTATION_TEXT_DISCLOSURE_VERSION,
        data: "dictated_text",
        destination: "xAI",
        accepted: false,
        acceptedVersion: null,
      },
    });

    const selected = configReader("xai");
    await expect(createCaller(dictationTextRouter, context(selected, false)).acceptDisclosure())
      .rejects.toThrow(/UI mutation bearer required/);
    const on = createCaller(dictationTextRouter, context(selected, true));
    await expect(on.status()).resolves.toMatchObject({ provider: "xai", model: "grok-custom-pinned", active: false });

    await expect(on.acceptDisclosure()).resolves.toMatchObject({
      accepted: true,
      disclosureVersion: XAI_DICTATION_TEXT_DISCLOSURE_VERSION,
    });
    await expect(on.status()).resolves.toMatchObject({
      active: true,
      credentialSource: "oauth",
      disclosure: { accepted: true, acceptedVersion: XAI_DICTATION_TEXT_DISCLOSURE_VERSION },
    });

    credentialSource = null;
    await expect(on.status()).resolves.toMatchObject({ active: false, credentialSource: null });
    credentialSource = "oauth";
    const localAudio = createCaller(dictationTextRouter, context(configReader("xai", "local"), true));
    await expect(localAudio.status()).resolves.toMatchObject({ audioEngine: "local", active: false });
    host.close();
  });
});
