import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { LanguageProvider } from "../../../web/src/i18n/LanguageProvider.js";
import { HostStore } from "../../../src/hostStore.js";
import { CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS } from "../../../src/onboarding.js";
import {
  migrateExistingOnboardingOutcomes,
  onboardingRouter,
} from "../../../src/routers/onboarding.js";
import { createCaller, type AppContext } from "../../../src/trpc.js";

const onboarding = vi.hoisted(() => ({
  data: undefined as Awaited<ReturnType<ReturnType<typeof createCaller>["status"]>> | undefined,
  adoptConversation: vi.fn(),
  adoptCalendarSource: vi.fn(),
  adoptAgentCalendarConnector: vi.fn(),
  adoptSharing: vi.fn(),
  deferOptional: vi.fn(),
  deferActivation: vi.fn(),
  invalidate: vi.fn(),
}));

vi.mock("../../../web/src/trpc.js", () => ({
  trpc: {
    onboarding: {
      status: { useQuery: () => ({ data: onboarding.data, isPending: false, isError: false }) },
      deferOptionalCapability: {
        useMutation: () => ({ mutateAsync: onboarding.deferOptional, isPending: false }),
      },
      adoptConversation: {
        useMutation: () => ({ mutateAsync: onboarding.adoptConversation, isPending: false }),
      },
      adoptCalendarSource: {
        useMutation: () => ({ mutateAsync: onboarding.adoptCalendarSource, isPending: false }),
      },
      adoptAgentCalendarConnector: {
        useMutation: () => ({ mutateAsync: onboarding.adoptAgentCalendarConnector, isPending: false }),
      },
      adoptSharing: {
        useMutation: () => ({ mutateAsync: onboarding.adoptSharing, isPending: false }),
      },
      deferActivationJourney: {
        useMutation: () => ({ mutateAsync: onboarding.deferActivation, isPending: false }),
      },
    },
    useUtils: () => ({ onboarding: { status: { invalidate: onboarding.invalidate } } }),
  },
}));

import { OnboardingHome } from "../../../web/src/routes/onboarding.js";

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

describe("upgraded Onboarding user journey", () => {
  let root = "";
  let host: HostStore | undefined;

  afterEach(() => {
    localStorage.clear();
    onboarding.data = undefined;
    host?.close();
    host = undefined;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("renders preserved, migrated, attention, completion, and non-blocking outcomes from one upgraded Host", async () => {
    root = mkdtempSync(join(tmpdir(), "yulu-onboarding-upgrade-route-"));
    const dbPath = join(root, "host.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec("CREATE TABLE legacy_install_marker (id INTEGER PRIMARY KEY)");
    legacy.close();
    host = new HostStore(dbPath);
    host.recordCoreActivationEvidence(
      activationEvidence(),
      CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS,
    );
    for (const capability of ["calendar-source", "agent-calendar-connector", "sharing"] as const) {
      host.recordOptionalCapabilityOutcome({
        onboardingVersion: "phase-13-v1",
        capability,
        contractVersion: `${capability}-v1`,
        outcome: "deferred",
        evidence: null,
      }, CURRENT_ONBOARDING_COMPLETION_REQUIREMENTS);
    }
    const ctx = {
      uiMutationAuthorized: true,
      host,
      agentConnections: {
        conversationAdoptionEvidence: vi.fn(async () => ({
          kind: "agent-capability-probe" as const,
          reference: "00000000-0000-4000-8000-000000000158",
          connectionId: "codex",
          adapter: "codex",
          provider: "codex",
          model: "gpt-5.6-sol",
          credentialSource: null,
          testedAt: "2026-08-29T00:10:00.000Z",
          runtimeEvidence: {
            adapter: "codex" as const,
            transport: "codex-app-server-stdio" as const,
            runtimeVersion: "0.144.4",
            authorizationClass: "chatgpt" as const,
            requestedProvider: "openai",
            requestedModel: "gpt-5.6-sol",
            actualProvider: "openai",
            actualModel: "gpt-5.6-sol",
            requestId: "turn-158",
            sessionId: "thread-158",
            terminalStatus: "ready" as const,
            fallbackOccurred: false,
          },
        })),
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
      },
    } as unknown as AppContext;

    await migrateExistingOnboardingOutcomes(ctx);
    onboarding.data = await createCaller(onboardingRouter, ctx).status();
    expect(onboarding.data).toMatchObject({
      entry: { installationKind: "returning", shouldAutoEnter: false },
      coreActivation: { completed: true, evidence: { taskId: "existing-activation-task" } },
      completion: { completed: true, currentVersionCompleted: true },
    });

    localStorage.setItem("yulu_ui.lang", "en");
    const router = createMemoryRouter(
      [{ path: "/onboarding", element: <OnboardingHome /> }],
      { initialEntries: ["/onboarding"] },
    );
    render(
      <LanguageProvider>
        <RouterProvider router={router} />
      </LanguageProvider>,
    );

    expect(screen.getByText("Onboarding complete for this version")).toBeInTheDocument();
    expect(screen.getByTestId("onboarding-core-activation")).toHaveTextContent("Complete");
    const conversation = screen.getByTestId("onboarding-capability-conversation");
    expect(conversation).toHaveTextContent("Adopted");
    expect(conversation).toHaveTextContent("Current readiness: Needs attention");
    expect(conversation).toHaveTextContent("The selected runtime is currently unavailable");
    for (const capability of ["calendar-source", "agent-calendar-connector", "sharing"]) {
      expect(within(screen.getByTestId(`onboarding-capability-${capability}`)).getByText("Deferred"))
        .toBeInTheDocument();
    }
  });
});
