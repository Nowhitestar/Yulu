import { afterEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { HostStore } from "../../src/hostStore.js";
import {
  migrateExistingOnboardingOutcomes,
  onboardingRouter,
} from "../../src/routers/onboarding.js";
import { CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS } from "../../src/onboarding.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { startServer } from "../../src/server.js";
import { ConversationAdoptionEvidenceUnavailableError } from "../../src/agentConnections.js";

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

function exactConversationProof() {
  return {
    kind: "agent-capability-probe" as const,
    reference: "00000000-0000-4000-8000-000000000154",
    connectionId: "codex",
    adapter: "codex",
    provider: "codex",
    model: "gpt-5.6-sol",
    credentialSource: null,
    testedAt: "2026-08-29T00:10:00.000Z",
    runtimeEvidence: {
      adapter: "codex",
      transport: "codex-app-server-stdio",
      runtimeVersion: "0.144.4",
      authorizationClass: "chatgpt" as const,
      requestedProvider: "openai",
      requestedModel: "gpt-5.6-sol",
      actualProvider: "openai",
      actualModel: "gpt-5.6-sol",
      requestId: "turn-154",
      sessionId: "thread-154",
      terminalStatus: "ready" as const,
      fallbackOccurred: false,
    },
  };
}

describe("existing Onboarding outcome migration", () => {
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

  function context(store: HostStore, conversationAdoptionEvidence = vi.fn(async () => exactConversationProof())) {
    return {
      uiMutationAuthorized: true,
      host: store,
      agentConnections: {
        view: vi.fn(async () => ({
          selections: { conversation: { connectionId: "codex", model: "gpt-5.6-sol" } },
          connections: [{
            id: "codex",
            capabilities: [{
              capability: "conversation",
              currentReadiness: {
                status: "failed",
                model: "gpt-5.6-sol",
                detail: "The selected runtime is currently unavailable",
              },
            }],
          }],
        })),
        conversationAdoptionEvidence,
      },
    } as unknown as AppContext;
  }

  it("adopts only exact existing Conversation proof and keeps readiness loss separate", async () => {
    const store = returningHost();
    const ctx = context(store);
    store.recordCoreActivationEvidence(
      activationEvidence(),
      CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS,
    );
    for (const capability of ["calendar-source", "agent-calendar-connector", "sharing"] as const) {
      store.recordOptionalCapabilityOutcome({
        onboardingVersion: "phase-13-v1",
        capability,
        contractVersion: `${capability}-v1`,
        outcome: "deferred",
        evidence: null,
      }, CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS);
    }

    await expect(migrateExistingOnboardingOutcomes(ctx)).resolves.toMatchObject({
      status: "completed",
      conversation: "adopted",
    });

    const journey = await createCaller(onboardingRouter, ctx).status();
    expect(journey).toMatchObject({
      entry: { installationKind: "returning", shouldAutoEnter: false },
      coreActivation: { completed: true, evidence: { taskId: "existing-activation-task" } },
      completion: { completed: true, currentVersionCompleted: true },
      optionalCapabilities: expect.arrayContaining([expect.objectContaining({
        id: "conversation",
        outcome: expect.objectContaining({ outcome: "adopted" }),
        readiness: {
          state: "needs_attention",
          detail: "The selected runtime is currently unavailable",
        },
      })]),
    });
  });

  it("fails closed on a legacy Conversation row that only points at configuration", async () => {
    const store = returningHost();
    const conversationAdoptionEvidence = vi.fn(async () => {
      throw new ConversationAdoptionEvidenceUnavailableError("No exact selected production probe exists");
    });
    const ctx = context(store, conversationAdoptionEvidence);
    store.db.prepare(`
      INSERT INTO optional_capability_outcomes (
        onboarding_version, capability, contract_version, outcome,
        evidence_kind, evidence_reference, evidence_snapshot_json, decided_at
      ) VALUES (?, 'conversation', 'conversation-v1', 'adopted', ?, ?, ?, ?)
    `).run(
      "phase-13-v1",
      "legacy-configuration",
      "selected-agent",
      JSON.stringify({
        capability: "conversation",
        connectionId: "codex",
        adapter: "codex",
        provider: "codex",
        model: "gpt-5.6-sol",
        credentialSource: "runtime-oauth",
        testedAt: "2026-08-29T00:10:00.000Z",
        runtimeEvidence: exactConversationProof().runtimeEvidence,
      }),
      "2026-08-29T00:10:00.000Z",
    );

    await expect(migrateExistingOnboardingOutcomes(ctx)).resolves.toMatchObject({
      status: "completed",
      conversation: "unresolved",
    });
    await expect(createCaller(onboardingRouter, ctx).status()).resolves.toMatchObject({
      optionalCapabilities: expect.arrayContaining([
        expect.objectContaining({ id: "conversation", outcome: null }),
      ]),
    });

  });

  it("rejects a malformed deferral row that carries hidden legacy evidence", async () => {
    const store = returningHost();
    const conversationAdoptionEvidence = vi.fn(async () => exactConversationProof());
    const ctx = context(store, conversationAdoptionEvidence);
    store.db.prepare(`
      INSERT INTO optional_capability_outcomes (
        onboarding_version, capability, contract_version, outcome,
        evidence_kind, evidence_reference, evidence_snapshot_json, decided_at
      ) VALUES (?, 'conversation', 'conversation-v1', 'deferred', NULL, NULL, ?, ?)
    `).run(
      "phase-13-v1",
      JSON.stringify({ legacySelectedAgent: "hermes" }),
      "2026-08-29T00:10:00.000Z",
    );

    await expect(migrateExistingOnboardingOutcomes(ctx)).resolves.toMatchObject({
      status: "completed",
      conversation: "unresolved",
    });
    expect(conversationAdoptionEvidence).not.toHaveBeenCalled();
    await expect(createCaller(onboardingRouter, ctx).status()).resolves.toMatchObject({
      optionalCapabilities: expect.arrayContaining([
        expect.objectContaining({ id: "conversation", outcome: null }),
      ]),
    });

    await expect(createCaller(onboardingRouter, ctx).deferOptionalCapability({
      capability: "conversation",
    })).resolves.toMatchObject({ outcome: "deferred", evidence: null });
    await expect(createCaller(onboardingRouter, ctx).status()).resolves.toMatchObject({
      optionalCapabilities: expect.arrayContaining([
        expect.objectContaining({ id: "conversation", outcome: expect.objectContaining({
          outcome: "deferred",
          evidence: null,
        }) }),
      ]),
    });
  });

  it("fails closed on a malformed legacy Onboarding Completion", async () => {
    const store = returningHost();
    const ctx = context(store, vi.fn(async () => {
      throw new ConversationAdoptionEvidenceUnavailableError("No exact selected production probe exists");
    }));
    store.db.prepare(`
      INSERT INTO onboarding_completions (version, completed_at) VALUES (?, ?)
    `).run("phase-12-legacy", "sometime-before-upgrade");

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
    store.recordCoreActivationEvidence(
      activationEvidence(),
      CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS,
    );
    for (const capability of ["calendar-source", "agent-calendar-connector", "sharing"] as const) {
      store.recordOptionalCapabilityOutcome({
        onboardingVersion: "phase-13-v1",
        capability,
        contractVersion: `${capability}-v1`,
        outcome: "deferred",
        evidence: null,
      }, CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS);
    }
    store.db.prepare(`
      INSERT INTO onboarding_completions (version, completed_at) VALUES (?, ?)
    `).run("phase-13-v1", "malformed-current-completion");

    await expect(migrateExistingOnboardingOutcomes(ctx)).resolves.toMatchObject({
      status: "completed",
      conversation: "adopted",
    });
    await expect(createCaller(onboardingRouter, ctx).status()).resolves.toMatchObject({
      completion: { completed: true, currentVersionCompleted: true, version: "phase-13-v1" },
    });
    expect(store.db.prepare(`
      SELECT completed_at FROM onboarding_completions WHERE version = 'phase-13-v1'
    `).get()).not.toEqual({ completed_at: "malformed-current-completion" });
  });

  it("preserves a prior explicit deferral and never upgrades it from later probe history", async () => {
    const store = returningHost();
    const conversationAdoptionEvidence = vi.fn(async () => exactConversationProof());
    const ctx = context(store, conversationAdoptionEvidence);
    const deferred = store.recordOptionalCapabilityOutcome({
      onboardingVersion: "phase-13-v1",
      capability: "conversation",
      contractVersion: "conversation-v1",
      outcome: "deferred",
      evidence: null,
    });

    await expect(migrateExistingOnboardingOutcomes(ctx)).resolves.toMatchObject({
      status: "completed",
      conversation: "preserved",
    });
    expect(conversationAdoptionEvidence).not.toHaveBeenCalled();
    await expect(createCaller(onboardingRouter, ctx).status()).resolves.toMatchObject({
      optionalCapabilities: expect.arrayContaining([
        expect.objectContaining({ id: "conversation", outcome: deferred }),
      ]),
    });
    await expect(migrateExistingOnboardingOutcomes(ctx)).resolves.toMatchObject({
      status: "already_completed",
    });
  });

  it("keeps fresh Onboarding untouched by returning-user migration", async () => {
    const store = freshHost();
    const conversationAdoptionEvidence = vi.fn(async () => exactConversationProof());
    const ctx = context(store, conversationAdoptionEvidence);

    await expect(migrateExistingOnboardingOutcomes(ctx)).resolves.toEqual({
      status: "skipped",
      conversation: "fresh",
    });
    expect(conversationAdoptionEvidence).not.toHaveBeenCalled();
    await expect(createCaller(onboardingRouter, ctx).status()).resolves.toMatchObject({
      entry: { installationKind: "fresh", shouldAutoEnter: true },
      coreActivation: { completed: false, evidence: null },
      completion: { completed: false, currentVersionCompleted: false },
    });
  });

  it("does not auto-adopt optional capabilities from weak legacy activity", async () => {
    const store = returningHost();
    const conversationAdoptionEvidence = vi.fn(async () => {
      throw new ConversationAdoptionEvidenceUnavailableError(
        "Configuration and history are not exact adoption evidence",
      );
    });
    const ctx = context(store, conversationAdoptionEvidence);
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
      agentCalendarConnector: {
        view: () => ({ readiness: { status: "ready", detail: "Legacy connector configuration was found" } }),
      },
      sharing: {
        view: () => ({ sharingReadiness: { status: "ready", detail: "Historical delivery was logged" } }),
      },
    });

    await migrateExistingOnboardingOutcomes(ctx);
    const journey = await createCaller(onboardingRouter, ctx).status();
    expect(journey.optionalCapabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "conversation", outcome: null }),
      expect.objectContaining({ id: "calendar-source", outcome: null }),
      expect.objectContaining({ id: "agent-calendar-connector", outcome: null }),
      expect.objectContaining({ id: "sharing", outcome: null }),
    ]));
    expect(store.listOptionalCapabilityOutcomes()).toEqual([]);
  });

  it("retries after a transient evidence read instead of permanently marking it unresolved", async () => {
    const store = returningHost();
    const conversationAdoptionEvidence = vi.fn()
      .mockRejectedValueOnce(new Error("Host evidence read temporarily failed"))
      .mockResolvedValueOnce(exactConversationProof());
    const ctx = context(store, conversationAdoptionEvidence);

    await expect(migrateExistingOnboardingOutcomes(ctx))
      .rejects.toThrow("Host evidence read temporarily failed");
    expect(store.hasOnboardingOutcomeMigration("phase-13-onboarding-outcomes-v1")).toBe(false);

    await expect(migrateExistingOnboardingOutcomes(ctx)).resolves.toMatchObject({
      status: "completed",
      conversation: "adopted",
    });
    expect(store.hasOnboardingOutcomeMigration("phase-13-onboarding-outcomes-v1")).toBe(true);
  });

  it("runs the returning-user outcome migration before serving Onboarding", async () => {
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
    config.intelligence = {
      summary: { provider: "xai", model: "grok-summary-exact" },
      conversation: { provider: "xai", model: "grok-conversation-exact" },
    };
    writeFileSync(configFile, JSON.stringify(config));
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
    store.recordCoreActivationEvidence(
      activationEvidence(),
      CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS,
    );
    for (const capability of ["calendar-source", "agent-calendar-connector", "sharing"] as const) {
      store.recordOptionalCapabilityOutcome({
        onboardingVersion: "phase-13-v1",
        capability,
        contractVersion: `${capability}-v1`,
        outcome: "deferred",
        evidence: null,
      }, CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS);
    }
    store.upsertAgentConnectionRecord({
      id: "direct-xai",
      kind: "direct-provider",
      adapter: "direct-xai",
      label: "xAI",
      lifecycle: "available",
      settings: { credentialSource: "oauth" },
    });
    store.recordAgentConnectionDisclosure({
      connectionId: "direct-xai",
      capability: "conversation",
      disclosureVersion: "xai-conversation-v1",
      decision: "accepted",
    });
    const runtimeEvidence = {
      adapter: "direct-xai" as const,
      transport: "xai-http" as const,
      runtimeVersion: null,
      requestedProvider: "xai",
      requestedModel: "grok-conversation-exact",
      actualProvider: "xai",
      actualModel: "grok-conversation-exact",
      requestId: null,
      sessionId: null,
      terminalStatus: "ready" as const,
      fallbackOccurred: false,
      cancellationRequested: false,
      cancellationConfirmed: null,
    };
    store.recordAgentConnectionReadiness({
      connectionId: "direct-xai",
      capability: "conversation",
      status: "ready",
      model: "grok-conversation-exact",
      credentialSource: "oauth",
      detail: "Exact production probe passed",
      reason: null,
      runtimeEvidence,
      testedAt: "2026-08-29T00:10:00.000Z",
    });
    store.recordAgentConnectionReadiness({
      connectionId: "direct-xai",
      capability: "conversation",
      status: "failed",
      model: "grok-conversation-exact",
      credentialSource: "oauth",
      detail: "The selected runtime is currently unavailable",
      reason: "readiness_failed",
      runtimeEvidence: { ...runtimeEvidence, terminalStatus: "failed" },
      testedAt: "2026-08-29T00:11:00.000Z",
    });
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
      expect(await response.json()).toMatchObject({
        result: { data: {
          entry: { installationKind: "returning", shouldAutoEnter: false },
          coreActivation: {
            completed: true,
            evidence: { taskId: "existing-activation-task" },
          },
          completion: { completed: true, currentVersionCompleted: true },
          optionalCapabilities: expect.arrayContaining([
            expect.objectContaining({
              id: "conversation",
              outcome: expect.objectContaining({ outcome: "adopted" }),
              readiness: {
                state: "needs_attention",
                detail: "The selected runtime is currently unavailable",
              },
            }),
            expect.objectContaining({ id: "sharing", outcome: expect.objectContaining({ outcome: "deferred" }) }),
          ]),
        } },
      });
      host = new HostStore(dbPath);
      expect(host.db.prepare("SELECT count(*) AS count FROM onboarding_outcome_migrations")
        .get()).toEqual({ count: 1 });
    } finally {
      host?.close();
      host = undefined;
      await server.close();
      if (previousPort === undefined) delete process.env.YULU_UI_PORT;
      else process.env.YULU_UI_PORT = previousPort;
    }
  });
});
