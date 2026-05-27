// tests/web/meetings.filters.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, Outlet } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Meetings } from "../../web/src/routes/inbox/meetings.js";
import { TopBar } from "../../web/src/components/TopBar.js";
import { ThemeProvider } from "../../web/src/theme.js";

const NOW = Date.now();
const RECENT = NOW - 1000;
const OLD = NOW - 40 * 86_400_000;

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    meetings: {
      list: { useQuery: () => ({
        data: [
          // 1: summarized + recent + realtime  → passes all filters
          { stem: "all_pass_20260526_120000",   meetingTitle: "all-pass",       recordedAt: "2026-05-26T12:00:00", firstWords: "kickoff", sizeBytes: 32_000 * 60, mtimeMs: RECENT, hasTranscript: true,  hasSummary: true,  hasRealtime: true  },
          // 2: summarized + recent + no realtime → fails has-realtime
          { stem: "no_rt_20260526_110000",      meetingTitle: "no-realtime",    recordedAt: "2026-05-26T11:00:00", firstWords: "agenda",  sizeBytes: 32_000 * 60, mtimeMs: RECENT, hasTranscript: true,  hasSummary: true,  hasRealtime: false },
          // 3: no summary + recent + realtime → fails summarized
          { stem: "no_sum_20260526_100000",     meetingTitle: "no-summary",     recordedAt: "2026-05-26T10:00:00", firstWords: null,      sizeBytes: 32_000 * 60, mtimeMs: RECENT, hasTranscript: true,  hasSummary: false, hasRealtime: true  },
          // 4: summarized + old + realtime → fails last30d
          { stem: "old_one_20260416_090000",    meetingTitle: "old-one",        recordedAt: "2026-04-16T09:00:00", firstWords: "older",   sizeBytes: 32_000 * 60, mtimeMs: OLD,    hasTranscript: true,  hasSummary: true,  hasRealtime: true  },
        ],
        isPending: false,
      }) },
    },
  },
}));

vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: () => {},
  nextBackoff: (n: number) => n,
}));

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Layout() { return (<><TopBar /><Outlet /></>); }
  const router = createMemoryRouter([
    {
      path: "/",
      Component: Layout,
      children: [{
        path: "inbox/meetings",
        Component: Meetings,
        handle: undefined,                  // filters wired by Meetings internally
        children: [{ index: true, element: null }],
      }],
    },
  ], { initialEntries: ["/inbox/meetings"] });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  );
}

describe("Meetings filters", () => {
  it("renders the 4 filter chips (All, Summarized, Last 30d, Has realtime)", () => {
    mount();
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarized" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Last 30d" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Has realtime" })).toBeInTheDocument();
  });

  it("Summarized + Last 30d both selected applies AND semantics", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Summarized" }));
    await user.click(screen.getByRole("button", { name: "Last 30d" }));
    const rows = screen.getAllByTestId("meeting-row");
    // Must satisfy both: hasSummary && within 30d
    // Row 1 (all-pass) ✓, Row 2 (no-realtime: summarized+recent) ✓
    // Row 3 (no-summary) ✗, Row 4 (old-one) ✗
    expect(rows).toHaveLength(2);
    const text = rows.map((r) => r.textContent ?? "").join("|");
    expect(text).toContain("all-pass");
    expect(text).toContain("no-realtime");
    expect(text).not.toContain("no-summary");
    expect(text).not.toContain("old-one");
  });

  it("Has realtime filters to realtime-only rows", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Has realtime" }));
    const rows = screen.getAllByTestId("meeting-row");
    // Row 1 (all-pass) ✓, Row 3 (no-summary: has realtime) ✓, Row 4 (old-one: has realtime) ✓
    // Row 2 (no-realtime) ✗
    expect(rows).toHaveLength(3);
    const text = rows.map((r) => r.textContent ?? "").join("|");
    expect(text).not.toContain("no-realtime");
  });

  it("clicking All clears active filters and restores full list", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Summarized" }));
    // Filtered down first
    expect(screen.getAllByTestId("meeting-row").length).toBeLessThan(4);
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(screen.getAllByTestId("meeting-row")).toHaveLength(4);
  });
});
