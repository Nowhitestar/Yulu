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
      evidence: {
        kind: "agent-capability-probe",
        reference: "conversation-proof-1",
      },
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

  it("records completion only on the final authorized durable transition and keeps status reads pure", () => {
    const store = createHost();
    store.recordCoreActivationEvidence(activationEvidence(), V1_COMPLETION);
    store.recordOptionalCapabilityOutcome({
      onboardingVersion: V1.version,
      capability: "conversation",
      contractVersion: "conversation-v1",
      outcome: "adopted",
      evidence: { kind: "agent-capability-probe", reference: "conversation-proof-1" },
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
