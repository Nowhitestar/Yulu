import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { LanguageProvider } from "../../../web/src/i18n/LanguageProvider.js";

const onboarding = vi.hoisted(() => ({
  adoptConversation: vi.fn(async () => ({})),
  adoptCalendarSource: vi.fn(async () => ({})),
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
      adoptConversation: {
        useMutation: () => ({ mutateAsync: onboarding.adoptConversation, isPending: false }),
      },
      adoptCalendarSource: {
        useMutation: () => ({ mutateAsync: onboarding.adoptCalendarSource, isPending: false }),
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
  onboarding.adoptConversation.mockClear();
  onboarding.adoptCalendarSource.mockClear();
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

  it("explicitly adopts a selected and proven Conversation without changing its settings", async () => {
    const conversation = onboarding.data.optionalCapabilities[0]!;
    const savedOutcome = conversation.outcome;
    const savedReadiness = conversation.readiness;
    conversation.outcome = null as never;
    conversation.readiness = { state: "ready", detail: "Exact Codex probe passed" };
    const user = userEvent.setup();
    renderRoute();

    const card = screen.getByTestId("onboarding-capability-conversation");
    await user.click(screen.getByRole("button", { name: "Adopt proven Conversation" }));

    expect(onboarding.adoptConversation).toHaveBeenCalledWith();
    expect(onboarding.invalidate).toHaveBeenCalledOnce();
    expect(card.querySelector('a[href="/settings/llm?capability=conversation"]')).not.toBeNull();
    conversation.outcome = savedOutcome;
    conversation.readiness = savedReadiness;
  });

  it("explicitly adopts a selected and proven Calendar Source", async () => {
    const calendarSource = onboarding.data.optionalCapabilities[2]!;
    calendarSource.readiness = { state: "ready", detail: "EventKit enumeration passed with 0 events" };
    const user = userEvent.setup();
    renderRoute();

    await user.click(screen.getByRole("button", { name: "Adopt proven Calendar Source" }));

    expect(onboarding.adoptCalendarSource).toHaveBeenCalledWith();
    expect(onboarding.invalidate).toHaveBeenCalledOnce();
  });
});
