import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { LanguageProvider } from "../../web/src/i18n/LanguageProvider.js";

const calendar = vi.hoisted(() => ({
  select: vi.fn(async () => ({
    restartErrors: [],
    readiness: {
      status: "untested",
      source: "macos",
      reason: null,
      detail: "The selected Calendar Source has not been tested",
      remediation: "Run the Calendar Source test",
      evidence: null,
    },
  })),
  probe: vi.fn(async () => ({
    status: "ready",
    source: "macos",
    reason: null,
    detail: "macOS Calendar is ready (0 events in the test window)",
    remediation: "",
    evidence: {
      capability: "calendar-source",
      source: "macos",
      adapter: "eventkit",
      selectionFingerprint: "a".repeat(64),
      accessGranted: true,
      enumerationSucceeded: true,
      eventCount: 0,
      windowStart: "2026-08-29T00:00:00.000Z",
      windowEnd: "2026-08-30T00:00:00.000Z",
      testedAt: "2026-08-29T00:00:00.000Z",
    },
  })),
  adopt: vi.fn(async () => ({})),
  defer: vi.fn(async () => ({})),
  invalidateSources: vi.fn(async () => ({})),
  invalidateOnboarding: vi.fn(async () => ({})),
  accountQueryInputs: [] as unknown[],
  accountResult: { ok: true, accounts: [{ email: "me@example.com", services: ["calendar"] }] } as {
    ok: boolean;
    accounts: Array<{ email: string; services: string[] }>;
  },
}));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    integrations: {
      calendarSources: {
        useQuery: () => ({
          isPending: false,
          isError: false,
          data: {
            selectedSource: null,
            sources: [
              { id: "macos", label: "macOS Calendar", recommended: true, advanced: false, externalRuntime: false },
              { id: "gog", label: "Google Calendar via gog", recommended: false, advanced: true, externalRuntime: true },
            ],
            readiness: {
              status: "untested",
              source: null,
              reason: null,
              detail: "Select a Calendar Source",
              remediation: "Choose macOS Calendar or the advanced gog source",
              evidence: null,
            },
          },
        }),
      },
      accountList: {
        useQuery: (input: unknown, options: unknown) => {
          calendar.accountQueryInputs.push({ input, options });
          return { isPending: false, data: calendar.accountResult };
        },
      },
      selectCalendarSource: { useMutation: () => ({ mutateAsync: calendar.select, isPending: false }) },
      probeCalendarSource: { useMutation: () => ({ mutateAsync: calendar.probe, isPending: false }) },
    },
    onboarding: {
      status: { useQuery: () => ({ data: { optionalCapabilities: [{ id: "calendar-source", outcome: null }] } }) },
      adoptCalendarSource: { useMutation: () => ({ mutateAsync: calendar.adopt, isPending: false }) },
      deferOptionalCapability: { useMutation: () => ({ mutateAsync: calendar.defer, isPending: false }) },
    },
    useUtils: () => ({
      integrations: { calendarSources: { invalidate: calendar.invalidateSources } },
      onboarding: { status: { invalidate: calendar.invalidateOnboarding } },
    }),
  },
}));

import { CalendarSourceSection } from "../../web/src/components/settings/CalendarSourceSection.js";

function renderSection() {
  localStorage.setItem("yulu_ui.lang", "en");
  return render(
    <MemoryRouter>
      <LanguageProvider>
        <CalendarSourceSection />
      </LanguageProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  localStorage.clear();
  calendar.select.mockClear();
  calendar.probe.mockClear();
  calendar.adopt.mockClear();
  calendar.defer.mockClear();
  calendar.invalidateSources.mockClear();
  calendar.invalidateOnboarding.mockClear();
  calendar.accountQueryInputs.length = 0;
  calendar.accountResult = { ok: true, accounts: [{ email: "me@example.com", services: ["calendar"] }] };
});

describe("CalendarSourceSection", () => {
  it("presents macOS as the CLI-free primary path and keeps Agent Calendar Connector separate", () => {
    renderSection();

    expect(screen.getByRole("heading", { name: "Calendar Sources" })).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(screen.getByText(/No external CLI required/)).toBeInTheDocument();
    expect(screen.queryByText("Google Calendar via gog")).toBeNull();
    expect(screen.getByRole("link", { name: "Open Agent Calendar Connector" }))
      .toHaveAttribute("href", "/agent-console");
    expect(screen.getByText(/does not establish Calendar Source readiness/)).toBeInTheDocument();
  });

  it("does not discover gog accounts until the user opens the advanced source", async () => {
    const user = userEvent.setup();
    renderSection();

    expect(calendar.accountQueryInputs.at(-1)).toMatchObject({ options: { enabled: false } });
    await user.click(screen.getByRole("button", { name: "Show advanced source" }));

    expect(screen.getByText("Google Calendar via gog")).toBeInTheDocument();
    expect(calendar.accountQueryInputs.at(-1)).toMatchObject({ options: { enabled: true } });
  });

  it("gives a fresh gog user an exact native OAuth next step", async () => {
    calendar.accountResult = { ok: true, accounts: [] };
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Show advanced source" }));

    expect(screen.getByText("gog auth add <email> --services calendar")).toBeInTheDocument();
    expect(screen.getByText(/OAuth remains in gog/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use gog Calendar" })).toBeDisabled();
  });

  it("keeps an unavailable optional gog runtime distinct from incomplete OAuth", async () => {
    calendar.accountResult = { ok: false, accounts: [] };
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Show advanced source" }));

    expect(screen.getByText(/optional gog runtime is unavailable/)).toBeInTheDocument();
    expect(screen.queryByText("gog auth add <email> --services calendar")).toBeNull();
  });

  it("changes selection, probes, adopts, and defers only through explicit actions", async () => {
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Use macOS Calendar" }));
    await user.click(screen.getByRole("button", { name: "Test selected Calendar Source" }));
    await user.click(screen.getByRole("button", { name: "Adopt proven Calendar Source" }));
    await user.click(screen.getByRole("button", { name: "Defer Calendar" }));

    expect(calendar.select).toHaveBeenCalledWith({ source: "macos", account: null });
    expect(calendar.probe).toHaveBeenCalledWith();
    expect(calendar.adopt).toHaveBeenCalledWith();
    expect(calendar.defer).toHaveBeenCalledWith({ capability: "calendar-source" });
    expect(calendar.invalidateSources).toHaveBeenCalled();
    expect(calendar.invalidateOnboarding).toHaveBeenCalled();
  });

  it("blocks adoption and shows the production service activation failure", async () => {
    calendar.select.mockResolvedValueOnce({
      restartErrors: ["com.yulu.calendar: service not found"],
      readiness: {
        status: "failed",
        source: "macos",
        reason: "service_activation_failed",
        detail: "The production Calendar polling services did not activate",
        remediation: "Repair or reinstall Yulu's Calendar services",
        evidence: null,
      },
    } as never);
    const user = userEvent.setup();
    renderSection();

    await user.click(screen.getByRole("button", { name: "Use macOS Calendar" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Calendar services did not activate");
    expect(screen.getByText("The production Calendar polling services did not activate"))
      .toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adopt proven Calendar Source" })).toBeDisabled();
  });
});
