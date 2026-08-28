import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { HostStore } from "../src/hostStore.js";
import { onboardingHome, type OnboardingManifest } from "../src/onboarding.js";

const V1: OnboardingManifest = {
  version: "phase-13-v1",
  optionalCapabilities: [
    { id: "conversation", contractVersion: "conversation-v1", href: "/settings/llm?capability=conversation" },
    { id: "sharing", contractVersion: "sharing-v1", href: "/settings/sharing" },
  ],
};

const V1_COMPLETION = {
  version: V1.version,
  optionalCapabilities: V1.optionalCapabilities.map(({ id: capability, contractVersion }) => ({
    capability,
    contractVersion,
  })),
};

function activationEvidence() {
  return {
    recordingStem: "Activation_20260829_080000",
    taskId: "activation-task",
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

function conversationEvidence(reference = "conversation-proof-1") {
  return {
    kind: "agent-capability-probe",
    reference,
    snapshot: {
      capability: "conversation" as const,
      connectionId: "codex",
      adapter: "codex",
      provider: "codex",
      model: "gpt-5.6-sol",
      credentialSource: "runtime-oauth" as const,
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
    },
  };
}

function calendarSourceEvidence(reference = `calendar-source:${"d".repeat(64)}:2026-08-29T02:00:00.000Z`) {
  return {
    kind: "calendar-source-probe",
    reference,
    snapshot: {
      capability: "calendar-source" as const,
      source: "macos" as const,
      adapter: "eventkit" as const,
      selectionFingerprint: "d".repeat(64),
      accessGranted: true as const,
      enumerationSucceeded: true as const,
      eventCount: 0,
      window: {
        start: "2026-08-29T02:00:00.000Z",
        end: "2026-08-30T02:00:00.000Z",
      },
      testedAt: "2026-08-29T02:00:00.000Z",
    },
  };
}

describe("Onboarding durable state", () => {
  let root = "";
  let host: HostStore | undefined;

  afterEach(() => {
    host?.close();
    host = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function createHost() {
    root = mkdtempSync(join(tmpdir(), "yulu-onboarding-"));
    host = new HostStore(join(root, "host.sqlite"));
    return host;
  }

  it("persists exact-version adopted and deferred outcomes without downgrading adoption", () => {
    const store = createHost();
    const adopted = store.recordOptionalCapabilityOutcome({
      onboardingVersion: "phase-13-v1",
      capability: "conversation",
      contractVersion: "conversation-v1",
      outcome: "adopted",
      evidence: conversationEvidence(),
    });
    const deferred = store.recordOptionalCapabilityOutcome({
      onboardingVersion: "phase-13-v1",
      capability: "sharing",
      contractVersion: "sharing-v1",
      outcome: "deferred",
      evidence: null,
    });

    expect(adopted).toMatchObject({
      capability: "conversation",
      contractVersion: "conversation-v1",
      outcome: "adopted",
      evidence: { reference: "conversation-proof-1" },
      decidedAt: expect.any(String),
    });
    expect(deferred).toMatchObject({
      capability: "sharing",
      contractVersion: "sharing-v1",
      outcome: "deferred",
      evidence: null,
      decidedAt: expect.any(String),
    });

    expect(store.recordOptionalCapabilityOutcome({
      onboardingVersion: "phase-13-v1",
      capability: "conversation",
      contractVersion: "conversation-v1",
      outcome: "deferred",
      evidence: null,
    })).toEqual(adopted);

    const dbPath = join(root, "host.sqlite");
    store.close();
    host = new HostStore(dbPath);
    expect(host.listOptionalCapabilityOutcomes()).toEqual([adopted, deferred]);
  });

  it("persists exact Calendar Source probe evidence across restart, including an empty event window", () => {
    const store = createHost();
    const adopted = store.recordOptionalCapabilityOutcome({
      onboardingVersion: "phase-13-v1",
      capability: "calendar-source",
      contractVersion: "calendar-source-v1",
      outcome: "adopted",
      evidence: calendarSourceEvidence(),
    });

    expect(adopted).toMatchObject({
      capability: "calendar-source",
      outcome: "adopted",
      evidence: {
        kind: "calendar-source-probe",
        reference: `calendar-source:${"d".repeat(64)}:2026-08-29T02:00:00.000Z`,
        snapshot: {
          source: "macos",
          adapter: "eventkit",
          accessGranted: true,
          enumerationSucceeded: true,
          eventCount: 0,
        },
      },
    });

    const dbPath = join(root, "host.sqlite");
    store.close();
    host = new HostStore(dbPath);
    expect(host.listOptionalCapabilityOutcomes()).toContainEqual(adopted);
  });

  it("fails closed when stored Calendar Source adoption evidence is malformed", () => {
    const store = createHost();
    store.recordOptionalCapabilityOutcome({
      onboardingVersion: "phase-13-v1",
      capability: "calendar-source",
      contractVersion: "calendar-source-v1",
      outcome: "adopted",
      evidence: calendarSourceEvidence(),
    });
    store.db.prepare(`
      UPDATE optional_capability_outcomes
      SET evidence_reference = 'mutable-calendar-pointer'
      WHERE capability = 'calendar-source'
    `).run();
    expect(store.listOptionalCapabilityOutcomes().find((outcome) =>
      outcome.capability === "calendar-source")).toBeUndefined();
    store.db.prepare(`
      UPDATE optional_capability_outcomes
      SET evidence_reference = ?
      WHERE capability = 'calendar-source'
    `).run(calendarSourceEvidence().reference);
    store.db.prepare(`
      UPDATE optional_capability_outcomes
      SET evidence_snapshot_json = ?
      WHERE capability = 'calendar-source'
    `).run(JSON.stringify({
      ...calendarSourceEvidence().snapshot,
      source: "gog",
      adapter: "eventkit",
    }));

    expect(store.listOptionalCapabilityOutcomes().find((outcome) =>
      outcome.capability === "calendar-source")).toBeUndefined();
    expect(() => store.recordOptionalCapabilityOutcome({
      onboardingVersion: "phase-13-v1",
      capability: "calendar-source",
      contractVersion: "calendar-source-v1",
      outcome: "adopted",
      evidence: {
        ...calendarSourceEvidence("bad-window"),
        snapshot: {
          ...calendarSourceEvidence().snapshot,
          window: {
            start: "2026-08-30T02:00:00.000Z",
            end: "2026-08-29T02:00:00.000Z",
          },
        },
      },
    })).toThrow(/Calendar Source.*exact evidence snapshot/i);
    expect(() => store.recordOptionalCapabilityOutcome({
      onboardingVersion: "phase-13-v1",
      capability: "calendar-source",
      contractVersion: "calendar-source-v1",
      outcome: "adopted",
      evidence: calendarSourceEvidence("mutable-calendar-pointer"),
    })).toThrow(/Calendar Source.*exact probe evidence/i);
  });

  it("records completion only on the final authorized durable transition and keeps status reads pure", () => {
    const store = createHost();
    store.recordCoreActivationEvidence(activationEvidence(), V1_COMPLETION);
    store.recordOptionalCapabilityOutcome({
      onboardingVersion: V1.version,
      capability: "conversation",
      contractVersion: "conversation-v1",
      outcome: "adopted",
      evidence: conversationEvidence(),
    }, V1_COMPLETION);
    expect(store.getLatestOnboardingCompletion()).toBeNull();
    store.recordOptionalCapabilityOutcome({
      onboardingVersion: V1.version,
      capability: "sharing",
      contractVersion: "sharing-v1",
      outcome: "deferred",
      evidence: null,
    }, V1_COMPLETION);
    expect(store.getLatestOnboardingCompletion()).toMatchObject({ version: V1.version });

    const completed = onboardingHome(store, V1, {
      conversation: { state: "ready", detail: "Current probe passed" },
      sharing: { state: "needs_attention", detail: "Connector is offline" },
    });
    expect(completed.completion).toMatchObject({
      completed: true,
      currentVersionCompleted: true,
      version: V1.version,
      completedAt: expect.any(String),
    });
    expect(completed.optionalCapabilities.find((step) => step.id === "sharing")).toMatchObject({
      outcome: { outcome: "deferred" },
      readiness: { state: "needs_attention" },
    });

    const completionCount = store.db.prepare("SELECT count(*) AS count FROM onboarding_completions")
      .get() as { count: number };
    onboardingHome(store, V1, {});
    expect(store.db.prepare("SELECT count(*) AS count FROM onboarding_completions").get())
      .toEqual(completionCount);

    const dbPath = join(root, "host.sqlite");
    store.close();
    host = new HostStore(dbPath);
    const V2: OnboardingManifest = {
      version: "phase-13-v2",
      optionalCapabilities: [
        ...V1.optionalCapabilities,
        { id: "calendar-source", contractVersion: "calendar-source-v1", href: "/settings/integrations" },
      ],
    };
    const upgraded = onboardingHome(host, V2, {
      conversation: { state: "needs_attention", detail: "Current probe expired" },
      sharing: { state: "not_tested", detail: "Current Host has not tested Sharing" },
      "calendar-source": { state: "not_tested", detail: "Not tested" },
    });

    expect(upgraded.completion).toMatchObject({
      completed: true,
      currentVersionCompleted: false,
      version: V1.version,
      completedAt: completed.completion.completedAt,
    });
    expect(upgraded.optionalCapabilities.filter((step) => step.isNew).map((step) => step.id))
      .toEqual(["calendar-source"]);
    expect(upgraded.optionalCapabilities.find((step) => step.id === "conversation")).toMatchObject({
      outcome: { outcome: "adopted" },
      readiness: { state: "needs_attention" },
    });
  });

  it("does not materialize completion from repeated status projections", () => {
    const store = createHost();
    store.recordCoreActivationEvidence(activationEvidence(), V1_COMPLETION);
    for (const capability of V1.optionalCapabilities) {
      store.recordOptionalCapabilityOutcome({
        onboardingVersion: V1.version,
        capability: capability.id,
        contractVersion: capability.contractVersion,
        outcome: "deferred",
        evidence: null,
      });
    }

    expect(onboardingHome(store, V1, {}).completion).toMatchObject({
      completed: false,
      currentVersionCompleted: false,
    });
    expect(onboardingHome(store, V1, {}).completion).toMatchObject({ completed: false });
    expect(store.getLatestOnboardingCompletion()).toBeNull();
  });

  it("does not project a stored current completion whose Conversation adoption snapshot is invalid", () => {
    const store = createHost();
    store.recordCoreActivationEvidence(activationEvidence(), V1_COMPLETION);
    store.db.prepare(`
      INSERT INTO optional_capability_outcomes (
        onboarding_version, capability, contract_version, outcome,
        evidence_kind, evidence_reference, evidence_snapshot_json, decided_at
      ) VALUES (?, 'conversation', 'conversation-v1', 'adopted', ?, ?, NULL, ?)
    `).run(V1.version, "agent-capability-probe", "legacy-mutable-pointer", "2026-08-28T00:00:00.000Z");
    store.recordOptionalCapabilityOutcome({
      onboardingVersion: V1.version,
      capability: "sharing",
      contractVersion: "sharing-v1",
      outcome: "deferred",
      evidence: null,
    });
    store.db.prepare(`
      INSERT INTO onboarding_completions (version, completed_at) VALUES (?, ?)
    `).run(V1.version, "2026-08-28T00:05:00.000Z");

    expect(onboardingHome(store, V1, {})).toMatchObject({
      optionalCapabilities: expect.arrayContaining([
        expect.objectContaining({ id: "conversation", outcome: null }),
      ]),
      completion: { completed: false, currentVersionCompleted: false, version: null },
    });
  });

  it("requests one automatic entry only for a fresh Host database", () => {
    const store = createHost();

    expect(store.getOnboardingEntryState()).toMatchObject({
      installationKind: "fresh",
      automaticEntryAcknowledgedAt: null,
      shouldAutoEnter: true,
    });
    expect(store.acknowledgeAutomaticOnboardingEntry()).toMatchObject({
      acknowledged: true,
      state: {
        installationKind: "fresh",
        automaticEntryAcknowledgedAt: expect.any(String),
        shouldAutoEnter: false,
      },
    });
    expect(store.acknowledgeAutomaticOnboardingEntry().acknowledged).toBe(false);

    const dbPath = join(root, "host.sqlite");
    store.close();
    host = new HostStore(dbPath);
    expect(host.getOnboardingEntryState()).toMatchObject({
      installationKind: "fresh",
      automaticEntryAcknowledgedAt: expect.any(String),
      shouldAutoEnter: false,
    });
  });

  it("migrates an existing Host database to non-blocking returning entry", () => {
    root = mkdtempSync(join(tmpdir(), "yulu-onboarding-returning-"));
    const dbPath = join(root, "host.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec("CREATE TABLE legacy_install_marker (id INTEGER PRIMARY KEY)");
    legacy.close();

    host = new HostStore(dbPath);
    expect(host.getOnboardingEntryState()).toEqual({
      installationKind: "returning",
      automaticEntryAcknowledgedAt: null,
      shouldAutoEnter: false,
    });
    expect(host.listOptionalCapabilityOutcomes()).toEqual([]);
  });
});
