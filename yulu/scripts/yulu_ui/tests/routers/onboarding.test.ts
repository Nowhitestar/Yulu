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

function conversationEvidence() {
  return {
    kind: "agent-capability-probe",
    reference: "conversation-proof-1",
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
    let calendarStatus: "ready" | "failed" | "untested" = "untested";
    let connectorStatus: "ready" | "failed" | "untested" = "untested";
    const sharingAdoptionEvidence = vi.fn(() => ({
      kind: "sharing-test-share" as const,
      reference: "sharing-test-share:00000000-0000-4000-8000-000000000157",
      snapshot: {
        capability: "sharing" as const,
        connectionId: "codex",
        adapter: "codex" as const,
        connectionRevision: "f".repeat(64),
        connector: "notion" as const,
        destination: "Product Notes",
        destinationSavedAt: "2026-08-29T04:00:00.000Z",
        actionId: "00000000-0000-4000-8000-000000000157",
        contentSha256: "6efa1b2d90a7d7946bd0942ebdb55bef26b6ee71b37489b77a9592b723f9ebde",
        receiptId: "page-adoption-1",
        receiptUrl: "https://notion.so/page-adoption-1",
        verifiedAt: "2026-08-29T04:01:00.000Z",
      },
    }));
    const calendarSnapshot = {
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
    };
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
        conversationAdoptionEvidence: vi.fn(async () => ({
          kind: "agent-capability-probe" as const,
          reference: "readiness-proof-154",
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
            authorizationClass: "chatgpt",
            requestedProvider: "openai",
            requestedModel: "gpt-5.6-sol",
            actualProvider: "openai",
            actualModel: "gpt-5.6-sol",
            requestId: "turn-154",
            sessionId: "thread-154",
            terminalStatus: "ready",
            fallbackOccurred: false,
          },
        })),
      },
      sharing: {
        view: vi.fn(() => ({
          sharingReadiness: {
            status: sharingStatus,
            detail: sharingStatus === "ready" ? "Current Test Share is ready" : "Current Sharing needs attention",
          },
        })),
        adoptionEvidence: sharingAdoptionEvidence,
      },
      calendarSources: {
        view: vi.fn(() => ({
          readiness: {
            status: calendarStatus,
            source: "macos",
            detail: calendarStatus === "ready"
              ? "EventKit enumeration passed with 0 events"
              : "Calendar needs attention",
            evidence: calendarStatus === "ready" ? calendarSnapshot : null,
          },
        })),
        adoptionEvidence: vi.fn(async () => ({
          kind: "calendar-source-probe",
          reference: `calendar-source:${calendarSnapshot.selectionFingerprint}:${calendarSnapshot.testedAt}`,
          snapshot: calendarSnapshot,
        })),
      },
      agentCalendarConnector: {
        view: vi.fn(() => ({
          readiness: {
            status: connectorStatus,
            failure: connectorStatus === "failed" ? "authorization" : null,
            detail: connectorStatus === "ready"
              ? "Calendar connector read access verified"
              : connectorStatus === "failed"
                ? "Calendar connector authorization was denied"
                : "Calendar connector has not been tested",
            remediation: connectorStatus === "failed" ? "Reauthorize through the Agent native flow" : "",
            evidence: connectorStatus === "ready" ? {
              capability: "agent-calendar-connector",
              connectionId: "codex",
              adapter: "codex",
              connector: "google_calendar",
              connectionRevision: "e".repeat(64),
              operation: "list_calendars",
              testedAt: "2026-08-29T04:00:00.000Z",
            } : null,
          },
        })),
        adoptionEvidence: vi.fn(() => ({
          kind: "agent-calendar-connector-probe",
          reference: `agent-calendar-connector:${"e".repeat(64)}:2026-08-29T04:00:00.000Z`,
          snapshot: {
            capability: "agent-calendar-connector",
            connectionId: "codex",
            adapter: "codex",
            connector: "google_calendar",
            connectionRevision: "e".repeat(64),
            operation: "list_calendars",
            testedAt: "2026-08-29T04:00:00.000Z",
          },
        })),
      },
    } as unknown as AppContext;
    return {
      ctx,
      caller: () => createCaller(onboardingRouter, ctx),
      setConversationStatus: (status: typeof conversationStatus) => { conversationStatus = status; },
      setSharingStatus: (status: typeof sharingStatus) => { sharingStatus = status; },
      setCalendarStatus: (status: typeof calendarStatus) => { calendarStatus = status; },
      setConnectorStatus: (status: typeof connectorStatus) => { connectorStatus = status; },
      sharingAdoptionEvidence,
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
        evidence: capability[0] === "conversation" ? conversationEvidence() : null,
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

  it("adopts Conversation only from exact production evidence and preserves it across restart", async () => {
    const { ctx, caller, setConversationStatus } = setup();
    host!.recordCoreActivationEvidence(activationEvidence(), CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS);
    for (const capability of ["calendar-source", "agent-calendar-connector", "sharing"] as const) {
      await caller().deferOptionalCapability({ capability });
    }

    await expect(caller().adoptConversation()).resolves.toMatchObject({
      outcome: {
        onboardingVersion: "phase-13-v1",
        capability: "conversation",
        contractVersion: "conversation-v1",
        outcome: "adopted",
        evidence: { kind: "agent-capability-probe", reference: "readiness-proof-154" },
      },
      proof: {
        connectionId: "codex",
        provider: "codex",
        model: "gpt-5.6-sol",
        runtimeEvidence: {
          authorizationClass: "chatgpt",
          terminalStatus: "ready",
          fallbackOccurred: false,
        },
      },
    });
    await expect(caller().status()).resolves.toMatchObject({
      completion: { completed: true, currentVersionCompleted: true },
      optionalCapabilities: expect.arrayContaining([expect.objectContaining({
        id: "conversation",
        outcome: expect.objectContaining({ outcome: "adopted" }),
        readiness: { state: "ready", detail: "Current probe passed" },
      })]),
    });

    setConversationStatus("untested");
    const dbPath = join(root, "host.sqlite");
    host!.close();
    host = new HostStore(dbPath);
    ctx.host = host;
    const restarted = await caller().status();
    expect(restarted.completion).toMatchObject({ completed: true, currentVersionCompleted: true });
    expect(restarted.optionalCapabilities.find((capability: ProjectedOptionalCapability) =>
      capability.id === "conversation"))
      .toMatchObject({
        outcome: { outcome: "adopted" },
        readiness: { state: "not_tested" },
      });
    expect(JSON.stringify(restarted)).not.toMatch(/oauth.*token|access_token|refresh_token/i);
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

  it("adopts Calendar Source only from the exact ready production probe and keeps readiness separate", async () => {
    const { caller, setCalendarStatus } = setup();
    setCalendarStatus("ready");

    await expect(caller().adoptCalendarSource()).resolves.toMatchObject({
      outcome: {
        capability: "calendar-source",
        contractVersion: "calendar-source-v1",
        outcome: "adopted",
        evidence: {
          kind: "calendar-source-probe",
          reference: `calendar-source:${"d".repeat(64)}:2026-08-29T02:00:00.000Z`,
          snapshot: { source: "macos", adapter: "eventkit", eventCount: 0 },
        },
      },
    });
    await expect(caller().status()).resolves.toMatchObject({
      optionalCapabilities: expect.arrayContaining([expect.objectContaining({
        id: "calendar-source",
        outcome: expect.objectContaining({ outcome: "adopted" }),
        readiness: { state: "ready", detail: "EventKit enumeration passed with 0 events" },
      })]),
    });

    setCalendarStatus("untested");
    await expect(caller().status()).resolves.toMatchObject({
      optionalCapabilities: expect.arrayContaining([expect.objectContaining({
        id: "calendar-source",
        outcome: expect.objectContaining({ outcome: "adopted" }),
        readiness: { state: "not_tested", detail: "Calendar needs attention" },
      })]),
    });
  });

  it("keeps Calendar Source and Agent Calendar Connector readiness and adoption independent", async () => {
    const { caller, setCalendarStatus, setConnectorStatus } = setup();
    setCalendarStatus("ready");

    let current = await caller().status();
    expect(current.optionalCapabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "calendar-source", readiness: expect.objectContaining({ state: "ready" }) }),
      expect.objectContaining({ id: "agent-calendar-connector", readiness: expect.objectContaining({ state: "not_tested" }) }),
    ]));

    setCalendarStatus("failed");
    setConnectorStatus("ready");
    current = await caller().status();
    expect(current.optionalCapabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "calendar-source", readiness: expect.objectContaining({ state: "needs_attention" }) }),
      expect.objectContaining({ id: "agent-calendar-connector", readiness: expect.objectContaining({ state: "ready" }) }),
    ]));

    await expect(caller().adoptAgentCalendarConnector()).resolves.toMatchObject({
      outcome: {
        capability: "agent-calendar-connector",
        contractVersion: "agent-calendar-connector-v1",
        outcome: "adopted",
        evidence: {
          kind: "agent-calendar-connector-probe",
          snapshot: {
            connectionId: "codex",
            connector: "google_calendar",
            operation: "list_calendars",
          },
        },
      },
    });
    current = await caller().status();
    expect(current.optionalCapabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "calendar-source", outcome: null }),
      expect.objectContaining({
        id: "agent-calendar-connector",
        outcome: expect.objectContaining({ outcome: "adopted" }),
      }),
    ]));
  });

  it("adopts Sharing only from the authoritative verified Test Share evidence", async () => {
    const { caller, setSharingStatus, sharingAdoptionEvidence } = setup();
    host!.upsertAgentConnectionRecord({
      id: "codex",
      kind: "supported-agent",
      adapter: "codex",
      label: "Codex",
      lifecycle: "available",
      settings: { executablePath: "/fake/codex" },
    });
    host!.selectSharingConfiguration({ connectionId: "codex", connector: "notion" });
    host!.saveShareDestination({
      connectionId: "codex",
      connector: "notion",
      destination: "Product Notes",
    });
    const begun = host!.beginSharingTestAction({
      id: "00000000-0000-4000-8000-000000000157",
      connectionId: "codex",
      connectionAdapter: "codex",
      connectionLabel: "Codex",
      connector: "notion",
      destination: "Product Notes",
      contentSha256: "6efa1b2d90a7d7946bd0942ebdb55bef26b6ee71b37489b77a9592b723f9ebde",
      duplicateConfirmed: false,
    });
    host!.markSharingTestActionVerified("00000000-0000-4000-8000-000000000157", {
      receiptId: "page-adoption-1",
      receiptUrl: "https://notion.so/page-adoption-1",
      detail: "Connector read-back matched the exact Test Share destination, content, and receipt",
    });
    const saved = host!.getSharingConfiguration()!;
    sharingAdoptionEvidence.mockReturnValue({
      kind: "sharing-test-share",
      reference: "sharing-test-share:00000000-0000-4000-8000-000000000157",
      snapshot: {
        capability: "sharing",
        connectionId: "codex",
        adapter: "codex",
        connectionRevision: begun.action.connectionRevision,
        connector: "notion",
        destination: "Product Notes",
        destinationSavedAt: saved.destinationSavedAt!,
        actionId: "00000000-0000-4000-8000-000000000157",
        contentSha256: "6efa1b2d90a7d7946bd0942ebdb55bef26b6ee71b37489b77a9592b723f9ebde",
        receiptId: "page-adoption-1",
        receiptUrl: "https://notion.so/page-adoption-1",
        verifiedAt: saved.testReceipt!.verifiedAt,
      },
    });
    setSharingStatus("ready");

    await expect(caller().adoptSharing()).resolves.toMatchObject({
      outcome: {
        capability: "sharing",
        contractVersion: "sharing-v1",
        outcome: "adopted",
        evidence: {
          kind: "sharing-test-share",
          reference: "sharing-test-share:00000000-0000-4000-8000-000000000157",
          snapshot: {
            connectionId: "codex",
            connector: "notion",
            destination: "Product Notes",
            actionId: "00000000-0000-4000-8000-000000000157",
            receiptId: "page-adoption-1",
          },
        },
      },
    });
    expect(sharingAdoptionEvidence).toHaveBeenCalledOnce();

    setSharingStatus("untested");
    await expect(caller().status()).resolves.toMatchObject({
      optionalCapabilities: expect.arrayContaining([expect.objectContaining({
        id: "sharing",
        outcome: expect.objectContaining({ outcome: "adopted" }),
        readiness: { state: "not_tested", detail: "Current Sharing needs attention" },
      })]),
    });
  });

  it("defers Sharing without claiming proof or changing current readiness", async () => {
    const { caller, setSharingStatus, sharingAdoptionEvidence } = setup();
    setSharingStatus("ready");

    await expect(caller().deferOptionalCapability({ capability: "sharing" })).resolves.toMatchObject({
      capability: "sharing",
      contractVersion: "sharing-v1",
      outcome: "deferred",
      evidence: null,
    });
    await expect(caller().status()).resolves.toMatchObject({
      optionalCapabilities: expect.arrayContaining([expect.objectContaining({
        id: "sharing",
        outcome: expect.objectContaining({ outcome: "deferred", evidence: null }),
        readiness: { state: "ready", detail: "Current Test Share is ready" },
      })]),
    });
    expect(sharingAdoptionEvidence).not.toHaveBeenCalled();
  });

  it("requires the process-local UI bearer before adopting Sharing", async () => {
    const { ctx, caller, sharingAdoptionEvidence } = setup();
    ctx.uiMutationAuthorized = false;

    await expect(caller().adoptSharing()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(sharingAdoptionEvidence).not.toHaveBeenCalled();
    expect(host!.listOptionalCapabilityOutcomes()).toEqual([]);
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

  it("preserves only exact Core Activation Evidence across an ordinary upgrade", async () => {
    const { ctx, caller } = setup();
    host!.recordCoreActivationEvidence(
      activationEvidence(),
      CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS,
    );
    const dbPath = join(root, "host.sqlite");
    host!.close();
    host = new HostStore(dbPath);
    ctx.host = host;

    await expect(caller().status()).resolves.toMatchObject({
      coreActivation: {
        completed: true,
        evidence: {
          taskId: "activation-task",
          artifacts: {
            audio: { sha256: "a".repeat(64), bytes: 45 },
            transcript: { sha256: "b".repeat(64), bytes: 20 },
            summary: { sha256: "c".repeat(64), bytes: 30 },
          },
        },
      },
      entry: { installationKind: "fresh", shouldAutoEnter: true },
    });

    host.db.prepare(`
      UPDATE core_activation_evidence
      SET audio_sha256 = 'legacy-mutable-pointer'
      WHERE id = 1
    `).run();

    await expect(caller().status()).resolves.toMatchObject({
      coreActivation: { completed: false, evidence: null },
    });
  });
});
