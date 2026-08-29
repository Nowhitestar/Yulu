import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { LanguageProvider } from "../../web/src/i18n/LanguageProvider.js";

const calendarConnector = vi.hoisted(() => ({
  select: vi.fn(async () => ({
    selection: { connectionId: "codex", connector: "google_calendar" },
    readiness: { status: "untested", failure: null, detail: "Not tested", remediation: "", evidence: null },
  })),
  probe: vi.fn(async () => ({
    selection: { connectionId: "codex", connector: "google_calendar" },
    readiness: {
      status: "ready",
      failure: null,
      detail: "Calendar list access verified",
      remediation: "",
      evidence: { operation: "list_calendars" },
    },
  })),
  adopt: vi.fn(async () => ({})),
  defer: vi.fn(async () => ({})),
  invalidateConnector: vi.fn(async () => ({})),
  invalidateOnboarding: vi.fn(async () => ({})),
  query: { isPending: false, isError: false },
  data: {
    connections: [{ id: "codex", adapter: "codex", label: "Codex" }],
    selection: null as { connectionId: string; connector: string } | null,
    readiness: {
      status: "untested" as "untested" | "ready" | "failed",
      failure: null as null | "runtime" | "connector" | "authorization" | "external_service",
      detail: "The selected Agent Calendar Connector has not been tested",
      remediation: "Run the read-only Connector Readiness test.",
      evidence: null,
    },
  },
}));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    agentCalendarConnector: {
      view: {
        useQuery: () => ({
          data: calendarConnector.query.isPending ? undefined : calendarConnector.data,
          isPending: calendarConnector.query.isPending,
          isError: calendarConnector.query.isError,
        }),
      },
      select: { useMutation: () => ({ mutateAsync: calendarConnector.select, isPending: false }) },
      probe: { useMutation: () => ({ mutateAsync: calendarConnector.probe, isPending: false }) },
    },
    onboarding: {
      status: {
        useQuery: () => ({ data: { optionalCapabilities: [{ id: "agent-calendar-connector", outcome: null }] } }),
      },
      adoptAgentCalendarConnector: {
        useMutation: () => ({ mutateAsync: calendarConnector.adopt, isPending: false }),
      },
      deferOptionalCapability: {
        useMutation: () => ({ mutateAsync: calendarConnector.defer, isPending: false }),
      },
    },
    useUtils: () => ({
      agentCalendarConnector: { view: { invalidate: calendarConnector.invalidateConnector } },
      onboarding: { status: { invalidate: calendarConnector.invalidateOnboarding } },
    }),
  },
}));

import { AgentCalendarConnectorSection } from "../../web/src/components/settings/AgentCalendarConnectorSection.js";

function renderSection() {
  localStorage.setItem("yulu_ui.lang", "en");
  return render(
    <MemoryRouter>
      <LanguageProvider>
        <AgentCalendarConnectorSection />
      </LanguageProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  localStorage.clear();
  calendarConnector.select.mockClear();
  calendarConnector.probe.mockClear();
  calendarConnector.adopt.mockClear();
  calendarConnector.defer.mockClear();
  calendarConnector.invalidateConnector.mockClear();
  calendarConnector.invalidateOnboarding.mockClear();
  calendarConnector.query.isPending = false;
  calendarConnector.query.isError = false;
  calendarConnector.data.selection = null;
  calendarConnector.data.readiness = {
    status: "untested",
    failure: null,
    detail: "The selected Agent Calendar Connector has not been tested",
    remediation: "Run the read-only Connector Readiness test.",
    evidence: null,
  };
});

describe("AgentCalendarConnectorSection", () => {
  it("selects an Agent Connection, runs only the read-only probe, and adopts or defers independently", async () => {
    const user = userEvent.setup();
    renderSection();

    expect(screen.getByRole("heading", { name: "Agent Calendar Connector" })).toBeInTheDocument();
    expect(screen.getByText(/never creates, updates, or deletes calendar content/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Adopt proven Agent Calendar Connector" })).toBeDisabled();

    await user.selectOptions(screen.getByLabelText("Agent Connection"), "codex");
    await user.clear(screen.getByLabelText("Calendar connector name"));
    await user.type(screen.getByLabelText("Calendar connector name"), "google_calendar");
    await user.click(screen.getByRole("button", { name: "Use this Agent Calendar Connector" }));
    await user.click(screen.getByRole("button", { name: "Test read-only connector access" }));
    await user.click(screen.getByRole("button", { name: "Adopt proven Agent Calendar Connector" }));
    await user.click(screen.getByRole("button", { name: "Defer Agent Calendar Connector" }));

    expect(calendarConnector.select).toHaveBeenCalledWith({ connectionId: "codex", connector: "google_calendar" });
    expect(calendarConnector.probe).toHaveBeenCalledWith();
    expect(calendarConnector.adopt).toHaveBeenCalledWith();
    expect(calendarConnector.defer).toHaveBeenCalledWith({ capability: "agent-calendar-connector" });
  });

  it("shows the exact failure scope and actionable remediation", () => {
    calendarConnector.data.selection = { connectionId: "codex", connector: "google_calendar" };
    calendarConnector.data.readiness = {
      status: "failed",
      failure: "authorization",
      detail: "Calendar connector authorization was denied",
      remediation: "Reauthorize google_calendar through Codex's native flow.",
      evidence: null,
    };
    renderSection();

    expect(screen.getByText("Authorization failure")).toBeInTheDocument();
    expect(screen.getByText("Calendar connector authorization was denied")).toBeInTheDocument();
    expect(screen.getByText(/Reauthorize google_calendar through Codex's native flow/)).toBeInTheDocument();
  });

  it("hydrates the form with a persisted explicit selection after loading", () => {
    calendarConnector.query.isPending = true;
    calendarConnector.data.selection = { connectionId: "codex", connector: "google_calendar" };
    const rendered = renderSection();
    expect(screen.queryByLabelText("Agent Connection")).not.toBeInTheDocument();

    calendarConnector.query.isPending = false;
    rendered.rerender(
      <MemoryRouter>
        <LanguageProvider>
          <AgentCalendarConnectorSection />
        </LanguageProvider>
      </MemoryRouter>,
    );

    expect(screen.getByLabelText("Agent Connection")).toHaveValue("codex");
    expect(screen.getByLabelText("Calendar connector name")).toHaveValue("google_calendar");
  });
});
