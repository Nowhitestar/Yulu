vi.mock("../../../web/src/components/PermissionsPanel.js", () => ({ PermissionsPanel: () => null, PermissionReminder: () => null }));
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { LanguageProvider } from "../../../web/src/i18n/LanguageProvider.js";

const onboarding = vi.hoisted(() => ({
  adoptCalendarSource: vi.fn(async () => ({})),
  adoptSharing: vi.fn(async () => ({})),
  deferOptional: vi.fn(async () => ({})),
  deferActivation: vi.fn(async () => ({})),
  invalidate: vi.fn(async () => ({})),
  data: {
    version: "phase-13-v2",
    entry: {
      installationKind: "returning",
      automaticEntryAcknowledgedAt: null,
      shouldAutoEnter: false,
    },
    coreActivation: {
      completed: true,
      href: "/activate",
      evidence: { completedAt: "2026-08-29T00:05:00.000Z" },
      journey: { deferredAt: null },
      attempt: null,
    },
    completion: {
      completed: true,
      currentVersionCompleted: false,
      version: "phase-13-v1",
      completedAt: "2026-08-29T00:06:00.000Z",
    },
    optionalCapabilities: [
      {
        id: "sharing",
        contractVersion: "sharing-v1",
        href: "/settings/sharing",
        outcome: { outcome: "deferred", decidedAt: "2026-08-29T00:06:00.000Z" },
        readiness: { state: "ready", detail: "Current Test Share is ready" },
        isNew: false,
      },
      {
        id: "calendar-source",
        contractVersion: "calendar-source-v1",
        href: "/settings/integrations",
        outcome: null,
        readiness: { state: "not_tested", detail: "Not tested" },
        isNew: true,
      },
    ],
  },
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

function renderRoute() {
  localStorage.setItem("yulu_ui.lang", "en");
  const router = createMemoryRouter(
    [{ path: "/onboarding", element: <OnboardingHome /> }],
    { initialEntries: ["/onboarding"] },
  );
  return render(
    <LanguageProvider>
      <RouterProvider router={router} />
    </LanguageProvider>,
  );
}

afterEach(() => {
  localStorage.clear();
  onboarding.deferOptional.mockClear();
  onboarding.adoptCalendarSource.mockClear();
  onboarding.adoptSharing.mockClear();
  onboarding.deferActivation.mockClear();
  onboarding.invalidate.mockClear();
});

describe("/onboarding", () => {
  it("keeps durable outcomes separate from current readiness and marks a new capability", () => {
    renderRoute();

    expect(screen.getByRole("heading", { name: "Onboarding Home" })).toBeInTheDocument();
    expect(screen.getByText("Previously completed · new options available")).toBeInTheDocument();

    // Calendar Source and Sharing are the only optional steps (ADR-010).
    expect(screen.getAllByTestId(/^onboarding-capability-/).map((card) => card.getAttribute("data-testid")))
      .toEqual(["onboarding-capability-sharing", "onboarding-capability-calendar-source"]);
    expect(screen.queryByRole("button", { name: /Conversation|Agent Calendar Connector/ })).toBeNull();

    const sharing = screen.getByTestId("onboarding-capability-sharing");
    expect(sharing).toHaveTextContent("Deferred");
    expect(sharing).toHaveTextContent("Current readiness: Ready");

    expect(screen.getByTestId("onboarding-capability-calendar-source")).toHaveTextContent("New");
    expect(screen.getByTestId("onboarding-capability-calendar-source")
      .querySelector('a[href="/settings/integrations"]')).not.toBeNull();
  });

  it("defers only the selected optional step and refreshes the home", async () => {
    const user = userEvent.setup();
    renderRoute();

    await user.click(screen.getByTestId("onboarding-capability-calendar-source")
      .querySelectorAll("button")[1]!);

    expect(onboarding.deferOptional).toHaveBeenCalledWith({ capability: "calendar-source" });
    expect(onboarding.invalidate).toHaveBeenCalledOnce();
  });

  it("explicitly adopts a selected and proven Calendar Source", async () => {
    const calendarSource = onboarding.data.optionalCapabilities.find(({ id }) => id === "calendar-source")!;
    calendarSource.readiness = { state: "ready", detail: "EventKit enumeration passed with 0 events" };
    const user = userEvent.setup();
    renderRoute();

    await user.click(screen.getByRole("button", { name: "Adopt proven Calendar Source" }));

    expect(onboarding.adoptCalendarSource).toHaveBeenCalledWith();
    expect(onboarding.invalidate).toHaveBeenCalledOnce();
  });

  it("opens the authoritative Sharing surface and explicitly adopts its verified Test Share", async () => {
    const sharing = onboarding.data.optionalCapabilities.find(({ id }) => id === "sharing")!;
    const savedOutcome = sharing.outcome;
    const savedReadiness = sharing.readiness;
    sharing.outcome = null as never;
    sharing.readiness = { state: "ready", detail: "Current Test Share receipt verified" };
    const user = userEvent.setup();
    renderRoute();

    const card = screen.getByTestId("onboarding-capability-sharing");
    expect(card.querySelector('a[href="/settings/sharing"]')).not.toBeNull();
    await user.click(screen.getByRole("button", { name: "Adopt proven Sharing" }));

    expect(onboarding.adoptSharing).toHaveBeenCalledWith();
    expect(onboarding.invalidate).toHaveBeenCalledOnce();
    expect(onboarding.deferOptional).not.toHaveBeenCalled();
    sharing.outcome = savedOutcome;
    sharing.readiness = savedReadiness;
  });
});
