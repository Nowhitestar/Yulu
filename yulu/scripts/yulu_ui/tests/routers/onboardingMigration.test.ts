import { afterEach, describe, expect, it } from "vitest";
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { HostStore } from "../../src/hostStore.js";
import { onboardingRouter, reconcileOnboardingCompletion } from "../../src/routers/onboarding.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { startServer } from "../../src/server.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function activationEvidence() {
  return {
    recordingStem: "Existing_20260829_080000",
    taskId: "existing-activation-task",
    transcriptionProvider: "local",
    summaryProvider: "codex",
    summaryModel: "gpt-5.6-sol",
    artifacts: {
      audio: { sha256: "a".repeat(64), bytes: 45 },
      transcript: { sha256: "b".repeat(64), bytes: 20 },
      summary: { sha256: "c".repeat(64), bytes: 30 },
    },
    completedAt: "2026-08-29T00:05:00.000Z",
  };
}

/**
 * The previous version required four Optional Capability Outcomes. Its
 * requirements are spelled out here so a database can be left exactly as that
 * version would have: Core Activation recorded, but no Onboarding Completion
 * while Conversation or the Agent Calendar Connector was undecided.
 */
const PREVIOUS_COMPLETION_REQUIREMENTS = {
  version: "phase-13-v1",
  optionalCapabilities: [
    { capability: "conversation", contractVersion: "conversation-v1" },
    { capability: "calendar-source", contractVersion: "calendar-source-v1" },
    { capability: "agent-calendar-connector", contractVersion: "agent-calendar-connector-v1" },
    { capability: "sharing", contractVersion: "sharing-v1" },
  ],
};

describe("Onboarding Completion after Conversation was retired (ADR-010)", () => {
  let root = "";
  let host: HostStore | undefined;

  afterEach(() => {
    host?.close();
    host = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function returningHost() {
    root = mkdtempSync(join(tmpdir(), "yulu-onboarding-migration-"));
    const dbPath = join(root, "host.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec("CREATE TABLE legacy_install_marker (id INTEGER PRIMARY KEY)");
    legacy.close();
    host = new HostStore(dbPath);
    return host;
  }

  function freshHost() {
    root = mkdtempSync(join(tmpdir(), "yulu-onboarding-fresh-"));
    host = new HostStore(join(root, "host.sqlite"));
    return host;
  }

  function context(store: HostStore) {
    return { uiMutationAuthorized: true, host: store } as unknown as AppContext;
  }

  function defer(store: HostStore, capability: "calendar-source" | "sharing") {
    // Recorded against the previous requirements, as the previous version did.
    return store.recordOptionalCapabilityOutcome({
      onboardingVersion: "phase-13-v1",
      capability,
      contractVersion: `${capability}-v1`,
      outcome: "deferred",
      evidence: null,
    }, PREVIOUS_COMPLETION_REQUIREMENTS);
  }

  function storeRetiredOutcome(store: HostStore, capability: "conversation" | "agent-calendar-connector") {
    store.db.prepare(`
      INSERT INTO optional_capability_outcomes (
        onboarding_version, capability, contract_version, outcome,
        evidence_kind, evidence_reference, evidence_snapshot_json, decided_at
      ) VALUES ('phase-13-v1', ?, ?, 'deferred', NULL, NULL, NULL, '2026-08-29T00:10:00.000Z')
    `).run(capability, `${capability}-v1`);
  }

  it("completes a returning user whose only undecided steps were the retired ones", async () => {
    const store = returningHost();
    store.recordCoreActivationEvidence(activationEvidence(), PREVIOUS_COMPLETION_REQUIREMENTS);
    defer(store, "calendar-source");
    defer(store, "sharing");
    const ctx = context(store);
    await expect(createCaller(onboardingRouter, ctx).status()).resolves.toMatchObject({
      completion: { completed: false, currentVersionCompleted: false, version: null },
    });

    const completion = reconcileOnboardingCompletion(ctx);

    expect(completion).toEqual({ version: "phase-13-v1", completedAt: expect.any(String) });
    await expect(createCaller(onboardingRouter, ctx).status()).resolves.toMatchObject({
      completion: {
        completed: true,
        currentVersionCompleted: true,
        version: "phase-13-v1",
        completedAt: completion!.completedAt,
      },
    });
    // A later start keeps the first completion.
    expect(reconcileOnboardingCompletion(ctx)).toEqual(completion);
    expect(store.db.prepare("SELECT count(*) AS count FROM onboarding_completions").get()).toEqual({ count: 1 });
  });

  it("keeps an existing completion and ignores stored outcomes of the retired steps", async () => {
    const store = returningHost();
    store.recordCoreActivationEvidence(activationEvidence(), PREVIOUS_COMPLETION_REQUIREMENTS);
    storeRetiredOutcome(store, "conversation");
    storeRetiredOutcome(store, "agent-calendar-connector");
    defer(store, "calendar-source");
    defer(store, "sharing");
    // The previous version recorded this once all four of its steps were decided.
    store.db.prepare("INSERT INTO onboarding_completions (version, completed_at) VALUES (?, ?)")
      .run("phase-13-v1", "2026-08-29T00:12:00.000Z");
    const before = store.getLatestOnboardingCompletion();
    expect(before).toEqual({ version: "phase-13-v1", completedAt: "2026-08-29T00:12:00.000Z" });
    const ctx = context(store);

    expect(reconcileOnboardingCompletion(ctx)).toEqual(before);

    const status = await createCaller(onboardingRouter, ctx).status();
    expect(status.completion).toMatchObject({ completed: true, currentVersionCompleted: true });
    expect(status.optionalCapabilities.map(({ id }: { id: string }) => id)).toEqual(["calendar-source", "sharing"]);
    expect(store.db.prepare("SELECT count(*) AS count FROM optional_capability_outcomes").get())
      .toEqual({ count: 4 });
  });

  it.each([
    ["Core Activation Evidence", { activation: false, calendar: true, sharing: true }],
    ["a Calendar Source outcome", { activation: true, calendar: false, sharing: true }],
    ["a Sharing outcome", { activation: true, calendar: true, sharing: false }],
  ] as const)("does not complete onboarding without %s, whatever the retired steps recorded", async (_name, has) => {
    const store = returningHost();
    if (has.activation) store.recordCoreActivationEvidence(activationEvidence(), PREVIOUS_COMPLETION_REQUIREMENTS);
    storeRetiredOutcome(store, "conversation");
    storeRetiredOutcome(store, "agent-calendar-connector");
    if (has.calendar) defer(store, "calendar-source");
    if (has.sharing) defer(store, "sharing");
    const ctx = context(store);

    expect(reconcileOnboardingCompletion(ctx)).toBeNull();

    await expect(createCaller(onboardingRouter, ctx).status()).resolves.toMatchObject({
      completion: { completed: false, currentVersionCompleted: false },
    });
    expect(store.listOptionalCapabilityOutcomes().map(({ capability }) => capability))
      .toEqual([...(has.calendar ? ["calendar-source"] : []), ...(has.sharing ? ["sharing"] : [])]);
  });

  it("leaves a fresh install untouched", async () => {
    const store = freshHost();
    const ctx = context(store);

    expect(reconcileOnboardingCompletion(ctx)).toBeNull();

    await expect(createCaller(onboardingRouter, ctx).status()).resolves.toMatchObject({
      entry: { installationKind: "fresh", shouldAutoEnter: true },
      coreActivation: { completed: false, evidence: null },
      completion: { completed: false, currentVersionCompleted: false },
    });
    expect(store.listOptionalCapabilityOutcomes()).toEqual([]);
  });

  it("rejects a malformed deferral row that carries hidden legacy evidence", async () => {
    const store = returningHost();
    const ctx = context(store);
    store.db.prepare(`
      INSERT INTO optional_capability_outcomes (
        onboarding_version, capability, contract_version, outcome,
        evidence_kind, evidence_reference, evidence_snapshot_json, decided_at
      ) VALUES (?, 'sharing', 'sharing-v1', 'deferred', NULL, NULL, ?, ?)
    `).run(
      "phase-13-v1",
      JSON.stringify({ legacyAutomaticDelivery: "hermes" }),
      "2026-08-29T00:10:00.000Z",
    );

    expect(reconcileOnboardingCompletion(ctx)).toBeNull();
    await expect(createCaller(onboardingRouter, ctx).status()).resolves.toMatchObject({
      optionalCapabilities: expect.arrayContaining([
        expect.objectContaining({ id: "sharing", outcome: null }),
      ]),
    });

    await expect(createCaller(onboardingRouter, ctx).deferOptionalCapability({
      capability: "sharing",
    })).resolves.toMatchObject({ outcome: "deferred", evidence: null });
    await expect(createCaller(onboardingRouter, ctx).status()).resolves.toMatchObject({
      optionalCapabilities: expect.arrayContaining([
        expect.objectContaining({ id: "sharing", outcome: expect.objectContaining({
          outcome: "deferred",
          evidence: null,
        }) }),
      ]),
    });
  });

  it("fails closed on a malformed legacy Onboarding Completion", async () => {
    const store = returningHost();
    const ctx = context(store);
    store.db.prepare(`
      INSERT INTO onboarding_completions (version, completed_at) VALUES (?, ?)
    `).run("phase-12-legacy", "sometime-before-upgrade");

    expect(reconcileOnboardingCompletion(ctx)).toBeNull();
    await expect(createCaller(onboardingRouter, ctx).status()).resolves.toMatchObject({
      coreActivation: { completed: false, evidence: null },
      completion: {
        completed: false,
        currentVersionCompleted: false,
        version: null,
        completedAt: null,
      },
    });
  });

  it("repairs a malformed current completion only after exact requirements are satisfied", async () => {
    const store = returningHost();
    const ctx = context(store);
    store.recordCoreActivationEvidence(activationEvidence(), PREVIOUS_COMPLETION_REQUIREMENTS);
    defer(store, "calendar-source");
    store.db.prepare(`
      INSERT INTO onboarding_completions (version, completed_at) VALUES (?, ?)
    `).run("phase-13-v1", "malformed-current-completion");

    expect(reconcileOnboardingCompletion(ctx)).toBeNull();
    expect(store.db.prepare(`
      SELECT completed_at FROM onboarding_completions WHERE version = 'phase-13-v1'
    `).get()).toEqual({ completed_at: "malformed-current-completion" });
    await expect(createCaller(onboardingRouter, ctx).status()).resolves.toMatchObject({
      completion: { completed: false, currentVersionCompleted: false },
    });

    defer(store, "sharing");
    expect(reconcileOnboardingCompletion(ctx)).toMatchObject({ version: "phase-13-v1" });
    await expect(createCaller(onboardingRouter, ctx).status()).resolves.toMatchObject({
      completion: { completed: true, currentVersionCompleted: true, version: "phase-13-v1" },
    });
    expect(store.db.prepare(`
      SELECT completed_at FROM onboarding_completions WHERE version = 'phase-13-v1'
    `).get()).not.toEqual({ completed_at: "malformed-current-completion" });
  });

  it("does not adopt optional capabilities from weak legacy activity", async () => {
    const store = returningHost();
    const ctx = context(store);
    store.upsertAgentConnectionCandidate({
      id: "candidate:hermes",
      adapter: "hermes",
      label: "Hermes",
      source: "migrated",
      detectedPath: "/legacy/hermes",
      settings: { migratedFromExplicitSelection: true },
    });
    store.upsertAgentConnectionRecord({
      id: "legacy-custom:migrated",
      kind: "legacy-custom",
      adapter: "legacy-command",
      label: "Hermes",
      lifecycle: "legacy",
      settings: { executable: "hermes" },
    });
    Object.assign(ctx, {
      calendarSources: {
        view: () => ({ readiness: { status: "ready", detail: "Legacy calendar setting is reachable" } }),
      },
      sharing: {
        view: () => ({ sharingReadiness: { status: "ready", detail: "Historical delivery was logged" } }),
      },
    });

    expect(reconcileOnboardingCompletion(ctx)).toBeNull();
    const journey = await createCaller(onboardingRouter, ctx).status();
    expect(journey.optionalCapabilities).toEqual([
      expect.objectContaining({ id: "calendar-source", outcome: null, readiness: expect.objectContaining({ state: "ready" }) }),
      expect.objectContaining({ id: "sharing", outcome: null, readiness: expect.objectContaining({ state: "ready" }) }),
    ]);
    expect(store.listOptionalCapabilityOutcomes()).toEqual([]);
  });

  it("starts on the previous version's data, archives what Conversation left, and completes onboarding", async () => {
    const store = returningHost();
    const configDir = join(root, ".config", "yulu");
    const moviesDir = join(root, "Movies", "Yulu");
    const scriptDir = join(root, "scripts");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(moviesDir, { recursive: true });
    mkdirSync(join(scriptDir, "Yulu.app", "Contents", "MacOS"), { recursive: true });
    const dbPath = join(root, "host.sqlite");
    const configFile = join(configDir, "config.json");
    const config = JSON.parse(readFileSync(join(HERE, "../fixtures/config.json"), "utf8"));
    // Everything the previous version wrote for its Conversation capability.
    config.transcription = {
      ...config.transcription,
      engine: "xai",
      dictation: { ...config.transcription?.dictation, voice_chat_scope: "meetings", cleanup_model: "conversation" },
    };
    config.intelligence = {
      summary: { provider: "xai", model: "grok-summary-exact" },
      conversation: { provider: "xai", model: "grok-conversation-exact" },
    };
    config.status_agent = {
      ...config.status_agent,
      hotkeys: { ...config.status_agent?.hotkeys, voice_chat: { key: "Space", modifiers: ["fn"] } },
    };
    config.agent_console = { plugins: { added: ["summary"] }, destinations: {} };
    writeFileSync(configFile, JSON.stringify(config));
    const sessionStore = join(configDir, "agent-sessions.json");
    writeFileSync(sessionStore, "{ \"version\": 9, \"sessions\": [ truncated", { mode: 0o644 });
    const keychainHelper = join(scriptDir, "Yulu.app", "Contents", "MacOS", "xai_keychain");
    writeFileSync(keychainHelper, `#!/bin/sh
if [ "$1" = "read" ] && [ "$#" = "1" ]; then
  printf '%s\\n' '{"version":1,"accessToken":"fixture","refreshToken":"fixture","expiresAt":4102444800000,"tokenEndpoint":"https://auth.x.ai/oauth2/token"}'
  exit 0
fi
if [ "$1" = "read" ]; then exit 44; fi
exit 0
`);
    chmodSync(keychainHelper, 0o700);
    store.recordCoreActivationEvidence(activationEvidence(), PREVIOUS_COMPLETION_REQUIREMENTS);
    defer(store, "calendar-source");
    defer(store, "sharing");
    storeRetiredOutcome(store, "agent-calendar-connector");
    store.upsertAgentConnectionRecord({
      id: "direct-xai",
      kind: "direct-provider",
      adapter: "direct-xai",
      label: "xAI",
      lifecycle: "available",
      settings: { credentialSource: "oauth" },
    });
    store.db.prepare(`
      INSERT INTO agent_connection_disclosures (connection_id, capability, disclosure_version, decision, decided_at)
      VALUES ('direct-xai', 'conversation', 'xai-conversation-v1', 'accepted', '2026-08-29T00:09:00.000Z')
    `).run();
    expect(store.getLatestOnboardingCompletion()).toBeNull();
    store.close();
    host = undefined;
    const previousPort = process.env.YULU_UI_PORT;
    process.env.YULU_UI_PORT = "0";
    const server = await startServer({
      configDir,
      configFile,
      moviesDir,
      hostDb: dbPath,
      agentTasksDir: join(configDir, "agent-tasks"),
      recordingEventsDir: join(configDir, "recording-events"),
      agentQueueJson: join(configDir, "agent-queue.json"),
      mcpTokenJson: join(configDir, "mcp-token.json"),
      scriptDir,
    });
    try {
      const response = await fetch(`http://127.0.0.1:${server.address.port}/trpc/onboarding.status`);
      expect(response.status).toBe(200);
      const body = await response.json() as { result: { data: { optionalCapabilities: Array<{ id: string }> } } };
      expect(body).toMatchObject({
        result: { data: {
          entry: { installationKind: "returning", shouldAutoEnter: false },
          coreActivation: {
            completed: true,
            evidence: { taskId: "existing-activation-task" },
          },
          completion: { completed: true, currentVersionCompleted: true },
          optionalCapabilities: [
            expect.objectContaining({ id: "calendar-source", outcome: expect.objectContaining({ outcome: "deferred" }) }),
            expect.objectContaining({ id: "sharing", outcome: expect.objectContaining({ outcome: "deferred" }) }),
          ],
        } },
      });

      // Retired settings are archived privately and gone from the active config.
      const active = JSON.parse(readFileSync(configFile, "utf8"));
      expect(active.intelligence).toEqual({ summary: { provider: "xai", model: "grok-summary-exact" } });
      expect(active).not.toHaveProperty("agent_console");
      expect(active.status_agent.hotkeys).not.toHaveProperty("voice_chat");
      expect(active.transcription.dictation).toMatchObject({
        text_provider: "xai",
        text_model: "grok-conversation-exact",
      });
      expect(active.transcription.dictation).not.toHaveProperty("voice_chat_scope");
      expect(active.transcription.dictation).not.toHaveProperty("cleanup_model");
      const configArchives = readdirSync(configDir).filter((name) => name.includes(".legacy-conversation."));
      expect(configArchives).toHaveLength(1);
      expect(statSync(join(configDir, configArchives[0]!)).mode & 0o777).toBe(0o600);

      // The session store is archived unread; a truncated file does not stop the Host.
      expect(existsSync(sessionStore)).toBe(false);
      const sessionArchives = readdirSync(configDir).filter((name) => name.startsWith("agent-sessions.retired."));
      expect(sessionArchives).toHaveLength(1);
      expect(statSync(join(configDir, sessionArchives[0]!)).mode & 0o777).toBe(0o600);
      expect(readFileSync(join(configDir, sessionArchives[0]!), "utf8"))
        .toBe("{ \"version\": 9, \"sessions\": [ truncated");

      // Dictation cleanup already ran under the accepted receipt, so it keeps running.
      const dictation = await fetch(`http://127.0.0.1:${server.address.port}/trpc/dictationText.status`);
      expect(await dictation.json()).toMatchObject({
        result: { data: {
          provider: "xai",
          model: "grok-conversation-exact",
          audioEngine: "xai",
          disclosure: { accepted: true, acceptedVersion: "xai-conversation-v1" },
          active: true,
        } },
      });

      // The voice-chat endpoint is gone rather than answering.
      const voiceChat = await fetch(`http://127.0.0.1:${server.address.port}/api/voice-chat/ask`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: "What did we decide?" }),
      });
      expect(voiceChat.status).toBe(404);
    } finally {
      await server.close();
      if (previousPort === undefined) delete process.env.YULU_UI_PORT;
      else process.env.YULU_UI_PORT = previousPort;
    }
  });
});
