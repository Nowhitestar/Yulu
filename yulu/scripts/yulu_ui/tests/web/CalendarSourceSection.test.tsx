import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { LanguageProvider } from "../../web/src/i18n/LanguageProvider.js";
import type { CalendarSourceReadiness, SelectedCalendarSource } from "../../src/calendarSources.js";

const calendar = vi.hoisted(() => {
  const untested: CalendarSourceReadiness = { status: "untested", source: null, reason: null, detail: "Select a source", remediation: "", testedAt: null, evidence: null };
  const ready: CalendarSourceReadiness = {
    ...untested, status: "ready", source: "macos", detail: "Access verified", testedAt: "2026-09-17T00:00:00Z",
    evidence: { capability: "calendar-source", source: "macos", adapter: "eventkit", selectionFingerprint: "a".repeat(64), accessGranted: true, enumerationSucceeded: true, eventCount: 0, window: { start: "2026-09-17T00:00:00Z", end: "2026-09-18T00:00:00Z" }, testedAt: "2026-09-17T00:00:00Z" },
  };
  return {
    untested, ready,
    view: { selectedSource: null as SelectedCalendarSource | null, readiness: untested, sources: [] },
    select: vi.fn(async (selection: SelectedCalendarSource) => ({ selection, restartErrors: [] as string[], readiness: { ...untested, source: selection.source } })),
    probe: vi.fn(async () => ready),
    adopt: vi.fn(async () => ({})),
    invalidate: vi.fn(async () => ({})),
    accountQueryInputs: [] as unknown[],
    accountResult: { ok: true, accounts: [{ email: "me@example.com", services: ["calendar"] }] },
    refreshAccounts: vi.fn(),
    schedule: { updatedAt: new Date().toISOString(), schedulerStatus: { pid: 123 }, calendarStatus: { pid: 456 } },
  };
});

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    integrations: {
      calendarSources: { useQuery: () => ({ isPending: false, isError: false, data: calendar.view, refetch: calendar.invalidate }) },
      accountList: { useQuery: (_input: unknown, options: unknown) => {
        calendar.accountQueryInputs.push(options);
        return { isPending: false, data: calendar.accountResult, refetch: calendar.refreshAccounts };
      } },
      selectCalendarSource: { useMutation: () => ({ mutateAsync: calendar.select }) },
      probeCalendarSource: { useMutation: () => ({ mutateAsync: calendar.probe }) },
    },
    scheduler: { overview: { useQuery: () => ({ data: calendar.schedule }) } },
    onboarding: { adoptCalendarSource: { useMutation: () => ({ mutateAsync: calendar.adopt }) } },
    useUtils: () => ({
      integrations: { calendarSources: { invalidate: calendar.invalidate, setData: (_input: unknown, updater: (view: typeof calendar.view) => typeof calendar.view) => { calendar.view = updater(calendar.view); } } },
      scheduler: { overview: { invalidate: calendar.invalidate } },
      onboarding: { status: { invalidate: calendar.invalidate } },
    }),
  },
}));

import { CalendarSourceSection } from "../../web/src/components/settings/CalendarSourceSection.js";

function mount() {
  localStorage.setItem("yulu_ui.lang", "en");
  return render(<MemoryRouter><LanguageProvider><CalendarSourceSection /></LanguageProvider></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  calendar.view = { selectedSource: null, readiness: calendar.untested, sources: [] };
  calendar.accountQueryInputs.length = 0;
  calendar.accountResult = { ok: true, accounts: [{ email: "me@example.com", services: ["calendar"] }] };
  calendar.schedule = { updatedAt: new Date().toISOString(), schedulerStatus: { pid: 123 }, calendarStatus: { pid: 456 } };
});

describe("Calendar connection flow", () => {
  it("does not mutate or discover Google accounts until an explicit action", () => {
    mount();
    expect(screen.getByRole("button", { name: "Connect macOS Calendar" })).toBeVisible();
    expect(calendar.accountQueryInputs.at(-1)).toMatchObject({ enabled: false });
    expect(calendar.select).not.toHaveBeenCalled();
    expect(calendar.probe).not.toHaveBeenCalled();
    expect(calendar.adopt).not.toHaveBeenCalled();
    expect(screen.queryByText(/Onboarding outcome/)).toBeNull();
  });

  it("connects, verifies and adopts sequentially with one action; zero events are valid", async () => {
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Connect macOS Calendar" }));
    await waitFor(() => expect(calendar.adopt).toHaveBeenCalledOnce());
    expect(calendar.select).toHaveBeenCalledWith({ source: "macos", account: null });
    expect(calendar.select.mock.invocationCallOrder[0]).toBeLessThan(calendar.probe.mock.invocationCallOrder[0]!);
    expect(calendar.probe.mock.invocationCallOrder[0]).toBeLessThan(calendar.adopt.mock.invocationCallOrder[0]!);
    expect(await screen.findByText("Connection checked")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect macOS Calendar" })).toBeNull();
  });

  it("rechecks an existing source without reselecting or restarting it", async () => {
    calendar.view.selectedSource = { source: "macos", account: null };
    mount();
    expect(screen.getByText("Configured · connection not checked")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Check connection" }));
    await waitFor(() => expect(calendar.adopt).toHaveBeenCalledOnce());
    expect(calendar.select).not.toHaveBeenCalled();
  });

  it("shows a useful permission failure and never adopts a failed probe", async () => {
    calendar.probe.mockResolvedValueOnce({ ...calendar.untested, status: "failed", source: "macos", reason: "authorization_denied", detail: "Access denied" });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Connect macOS Calendar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Privacy & Security");
    expect(calendar.adopt).not.toHaveBeenCalled();
    expect(screen.getByText("Connection needs attention")).toBeVisible();
  });

  it("stops before probing or adopting when reminder services fail to start", async () => {
    calendar.select.mockResolvedValueOnce({ selection: { source: "macos", account: null }, restartErrors: ["com.yulu.calendar: not_running"], readiness: { ...calendar.untested, status: "failed", source: "macos", reason: "service_activation_failed" } });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Connect macOS Calendar" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not finish connecting");
    expect(calendar.probe).not.toHaveBeenCalled();
    expect(calendar.adopt).not.toHaveBeenCalled();
  });

  it("never adopts a probe for a different selection", async () => {
    calendar.probe.mockResolvedValueOnce({ ...calendar.ready, source: "gog" });
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Connect macOS Calendar" }));
    await waitFor(() => expect(calendar.invalidate).toHaveBeenCalled());
    expect(calendar.adopt).not.toHaveBeenCalled();
  });

  it("keeps account discovery on demand and provides a refresh after OAuth", async () => {
    calendar.accountResult = { ok: true, accounts: [] };
    mount();
    await userEvent.click(screen.getByRole("button", { name: "Connect Google Calendar directly" }));
    expect(calendar.accountQueryInputs.at(-1)).toMatchObject({ enabled: true });
    expect(screen.getByText("gog auth add <email> --services calendar")).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect Google Calendar" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Refresh accounts" }));
    expect(calendar.refreshAccounts).toHaveBeenCalledOnce();
  });

  it("shows existing Google selection, and reports a stale schedule independently from connection readiness", () => {
    calendar.view = { selectedSource: { source: "gog", account: "me@example.com" }, sources: [], readiness: { ...calendar.ready, source: "gog" } };
    calendar.schedule.updatedAt = "2020-01-01T00:00:00Z";
    mount();
    expect(screen.getByText("me@example.com")).toBeVisible();
    expect(screen.getByText("Connection checked")).toBeVisible();
    expect(screen.getByText(/schedule has not updated recently/)).toBeVisible();
  });
});
