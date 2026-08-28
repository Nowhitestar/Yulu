import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { LanguageProvider } from "../../../web/src/i18n/LanguageProvider.js";

const onboarding = vi.hoisted(() => ({
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
        id: "conversation",
        contractVersion: "conversation-v1",
        href: "/settings/llm?capability=conversation",
        outcome: { outcome: "adopted", decidedAt: "2026-08-29T00:06:00.000Z" },
        readiness: { state: "needs_attention", detail: "Current probe expired" },
        isNew: false,
      },
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
        href: null,
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
  onboarding.deferActivation.mockClear();
  onboarding.invalidate.mockClear();
});

describe("/onboarding", () => {
  it("keeps durable outcomes separate from current readiness and marks a new capability", () => {
    renderRoute();

    expect(screen.getByRole("heading", { name: "Onboarding Home" })).toBeInTheDocument();
    expect(screen.getByText("Previously completed · new options available")).toBeInTheDocument();

    const conversation = screen.getByTestId("onboarding-capability-conversation");
    expect(conversation).toHaveTextContent("Adopted");
    expect(conversation).toHaveTextContent("Current readiness: Needs attention");
    expect(conversation).toHaveTextContent("Current probe expired");
    expect(conversation.querySelector('a[href="/settings/llm?capability=conversation"]')).not.toBeNull();

    const sharing = screen.getByTestId("onboarding-capability-sharing");
    expect(sharing).toHaveTextContent("Deferred");
    expect(sharing).toHaveTextContent("Current readiness: Ready");

    expect(screen.getByTestId("onboarding-capability-calendar-source")).toHaveTextContent("New");
    expect(screen.getByTestId("onboarding-capability-calendar-source").querySelector("a")).toBeNull();
  });

  it("defers only the selected optional step and refreshes the home", async () => {
    const user = userEvent.setup();
    renderRoute();

    await user.click(screen.getByTestId("onboarding-capability-calendar-source")
      .querySelector("button")!);

    expect(onboarding.deferOptional).toHaveBeenCalledWith({ capability: "calendar-source" });
    expect(onboarding.invalidate).toHaveBeenCalledOnce();
  });
});
