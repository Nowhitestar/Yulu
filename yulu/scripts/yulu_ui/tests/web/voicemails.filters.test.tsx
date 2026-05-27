// tests/web/voicemails.filters.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, Outlet } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Voicemails } from "../../web/src/routes/inbox/voicemails.js";
import { TopBar } from "../../web/src/components/TopBar.js";
import { ThemeProvider } from "../../web/src/theme.js";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    voicemails: {
      list: { useQuery: () => ({
        data: [
          { stem: "voicemail_20260526_120000", firstWords: "with summary", sizeBytes: 1024, mtimeMs: Date.now() - 1000, hasTranscript: true, hasSummary: true },
          { stem: "voicemail_20260526_110000", firstWords: "no summary", sizeBytes: 1024, mtimeMs: Date.now() - 1000, hasTranscript: true, hasSummary: false },
          { stem: "voicemail_20260520_100000", firstWords: "old one", sizeBytes: 1024, mtimeMs: Date.now() - 30 * 86_400_000, hasTranscript: true, hasSummary: true },
        ],
        isPending: false,
      }) },
    },
    // GlobalSearch (now rendered inside TopBar) calls this — gate via disabled state.
    search: {
      run: { useQuery: () => ({ data: undefined, isFetching: false }) },
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
        path: "inbox/voicemails",
        Component: Voicemails,
        handle: undefined,                  // filters wired by Voicemails internally
        children: [{ index: true, element: null }],
      }],
    },
  ], { initialEntries: ["/inbox/voicemails"] });
  return render(
    <ThemeProvider>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ThemeProvider>
  );
}

describe("Voicemails filters", () => {
  it("renders the 3 filter chips in TopBar (All, Summarized, Last 7d)", () => {
    mount();
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarized" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Last 7d" })).toBeInTheDocument();
  });

  it("clicking Summarized filters list to summarized rows only", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Summarized" }));
    const rows = screen.getAllByTestId("voicemail-row");
    expect(rows).toHaveLength(2); // with summary + old one (also has summary)
    expect(rows.every((r) => r.textContent?.includes("✓"))).toBe(true);
  });

  it("clicking Last 7d filters out older rows", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Last 7d" }));
    const rows = screen.getAllByTestId("voicemail-row");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.textContent?.includes("old one"))).toBe(true);
  });
});
