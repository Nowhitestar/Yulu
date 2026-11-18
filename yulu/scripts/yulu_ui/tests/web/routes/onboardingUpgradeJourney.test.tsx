vi.mock("../../../web/src/components/PermissionsPanel.js", () => ({ PermissionsPanel: () => null, PermissionReminder: () => null }));
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { LanguageProvider } from "../../../web/src/i18n/LanguageProvider.js";
import { HostStore } from "../../../src/hostStore.js";
import {
  onboardingRouter,
  reconcileOnboardingCompletion,
} from "../../../src/routers/onboarding.js";
import { createCaller, type AppContext } from "../../../src/trpc.js";

const onboarding = vi.hoisted(() => ({
  data: undefined as Awaited<ReturnType<ReturnType<typeof createCaller>["status"]>> | undefined,
  adoptCalendarSource: vi.fn(),
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
      adoptCalendarSource: {
        useMutation: () => ({ mutateAsync: onboarding.adoptCalendarSource, isPending: false }),
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

  it("renders preserved outcomes and completion from one upgraded Host without the retired steps", async () => {
    root = mkdtempSync(join(tmpdir(), "yulu-onboarding-upgrade-route-"));
    const dbPath = join(root, "host.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec("CREATE TABLE legacy_install_marker (id INTEGER PRIMARY KEY)");
    legacy.close();
    host = new HostStore(dbPath);
    // The previous version waited for four outcomes; this user never decided
    // Conversation, so that version had not recorded a completion.
    const previousRequirements = {
      version: "phase-13-v1",
      optionalCapabilities: ["conversation", "calendar-source", "agent-calendar-connector", "sharing"]
        .map((capability) => ({ capability, contractVersion: `${capability}-v1` })),
    };
    host.recordCoreActivationEvidence(activationEvidence(), previousRequirements);
    for (const capability of ["calendar-source", "sharing"] as const) {
      host.recordOptionalCapabilityOutcome({
        onboardingVersion: "phase-13-v1",
        capability,
        contractVersion: `${capability}-v1`,
        outcome: "deferred",
        evidence: null,
      }, previousRequirements);
    }
    host.db.prepare(`
      INSERT INTO optional_capability_outcomes (
        onboarding_version, capability, contract_version, outcome,
        evidence_kind, evidence_reference, evidence_snapshot_json, decided_at
      ) VALUES ('phase-13-v1', 'agent-calendar-connector', 'agent-calendar-connector-v1', 'deferred',
        NULL, NULL, NULL, '2026-08-29T00:10:00.000Z')
    `).run();
    expect(host.getLatestOnboardingCompletion()).toBeNull();
    const ctx = { uiMutationAuthorized: true, host } as unknown as AppContext;

    reconcileOnboardingCompletion(ctx);
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
    expect(screen.getAllByTestId(/^onboarding-capability-/)).toHaveLength(2);
    for (const capability of ["calendar-source", "sharing"]) {
      expect(within(screen.getByTestId(`onboarding-capability-${capability}`)).getByText("Deferred"))
        .toBeInTheDocument();
    }
  });
});
