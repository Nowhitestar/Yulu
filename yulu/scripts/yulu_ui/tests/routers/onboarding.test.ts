import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostStore } from "../../src/hostStore.js";
import { onboardingRouter } from "../../src/routers/onboarding.js";
import { CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS } from "../../src/onboarding.js";
import { createCaller, type AppContext } from "../../src/trpc.js";

interface ProjectedOptionalCapability {
  id: string;
  outcome: { outcome: "adopted" | "deferred" } | null;
  readiness: { state: string; detail: string };
}

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

describe("onboarding router", () => {
  let root = "";
  let host: HostStore | undefined;

  afterEach(() => {
    host?.close();
    host = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  function setup() {
    root = mkdtempSync(join(tmpdir(), "yulu-onboarding-router-"));
    host = new HostStore(join(root, "host.sqlite"));
    let conversationStatus: "ready" | "failed" | "untested" = "ready";
    let sharingStatus: "ready" | "failed" | "untested" | "unknown" = "ready";
    const ctx = {
      uiMutationAuthorized: true,
      host,
      agentConnections: {
        view: vi.fn(async () => ({
          selections: { conversation: { connectionId: "codex", model: "gpt-5.6-sol" } },
          connections: [{
            id: "codex",
            label: "Codex",
            capabilities: [{
              capability: "conversation",
              currentReadiness: {
                status: conversationStatus,
                model: "gpt-5.6-sol",
                detail: conversationStatus === "ready" ? "Current probe passed" : "Current probe needs attention",
              },
            }],
          }],
        })),
      },
      sharing: {
        view: vi.fn(() => ({
          sharingReadiness: {
            status: sharingStatus,
            detail: sharingStatus === "ready" ? "Current Test Share is ready" : "Current Sharing needs attention",
          },
        })),
      },
    } as unknown as AppContext;
    return {
      ctx,
      caller: () => createCaller(onboardingRouter, ctx),
      setConversationStatus: (status: typeof conversationStatus) => { conversationStatus = status; },
      setSharingStatus: (status: typeof sharingStatus) => { sharingStatus = status; },
    };
  }

  function completeCurrentOnboarding(store: HostStore) {
    store.recordCoreActivationEvidence(activationEvidence(), CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS);
    for (const capability of [
      ["conversation", "conversation-v1"],
      ["calendar-source", "calendar-source-v1"],
      ["agent-calendar-connector", "agent-calendar-connector-v1"],
      ["sharing", "sharing-v1"],
    ] as const) {
      store.recordOptionalCapabilityOutcome({
        onboardingVersion: "phase-13-v1",
        capability: capability[0],
        contractVersion: capability[1],
        outcome: capability[0] === "conversation" ? "adopted" : "deferred",
        evidence: capability[0] === "conversation"
          ? { kind: "agent-capability-probe", reference: "conversation-proof-1" }
          : null,
      }, CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS);
    }
  }

  it("reports current readiness separately without revoking durable completion", async () => {
    const { caller, setConversationStatus, setSharingStatus } = setup();
    completeCurrentOnboarding(host!);

    const ready = await caller().status();
    const readySteps = ready.optionalCapabilities as ProjectedOptionalCapability[];
    expect(ready.completion).toMatchObject({
      completed: true,
      currentVersionCompleted: true,
      version: "phase-13-v1",
    });
    expect(readySteps.find((step) => step.id === "conversation")).toMatchObject({
      outcome: { outcome: "adopted" },
      readiness: { state: "ready", detail: "Current probe passed" },
    });
    expect(readySteps.find((step) => step.id === "sharing")).toMatchObject({
      outcome: { outcome: "deferred" },
      readiness: { state: "ready", detail: "Current Test Share is ready" },
    });

    setConversationStatus("failed");
    setSharingStatus("untested");
    const degraded = await caller().status();
    const degradedSteps = degraded.optionalCapabilities as ProjectedOptionalCapability[];
    expect(degraded.completion).toMatchObject({
      completed: true,
      currentVersionCompleted: true,
      version: "phase-13-v1",
    });
    expect(degradedSteps.find((step) => step.id === "conversation")).toMatchObject({
      outcome: { outcome: "adopted" },
      readiness: { state: "needs_attention" },
    });
    expect(degradedSteps.find((step) => step.id === "sharing")).toMatchObject({
      outcome: { outcome: "deferred" },
      readiness: { state: "not_tested" },
    });
  });

  it("defers exact current steps and resumes the same Activation Attempt after restart", async () => {
    const { ctx, caller } = setup();
    const attempt = host!.beginActivationAttempt().attempt;

    await expect(caller().deferOptionalCapability({ capability: "calendar-source" })).resolves.toMatchObject({
      onboardingVersion: "phase-13-v1",
      capability: "calendar-source",
      contractVersion: "calendar-source-v1",
      outcome: "deferred",
      evidence: null,
    });
    await expect(caller().deferActivationJourney()).resolves.toMatchObject({
      journey: { deferredAt: expect.any(String) },
      attempt: { id: attempt.id },
    });

    const dbPath = join(root, "host.sqlite");
    host!.close();
    host = new HostStore(dbPath);
    ctx.host = host;
    await expect(caller().status()).resolves.toMatchObject({
      coreActivation: {
        completed: false,
        journey: { deferredAt: expect.any(String) },
        attempt: { id: attempt.id },
      },
    });
  });

  it("acknowledges a fresh automatic entry exactly once", async () => {
    const { caller } = setup();

    await expect(caller().status()).resolves.toMatchObject({
      entry: { installationKind: "fresh", shouldAutoEnter: true },
    });
    await expect(caller().acknowledgeAutomaticEntry()).resolves.toMatchObject({
      acknowledged: true,
      entry: { shouldAutoEnter: false },
    });
    await expect(caller().acknowledgeAutomaticEntry()).resolves.toMatchObject({ acknowledged: false });
  });
});
