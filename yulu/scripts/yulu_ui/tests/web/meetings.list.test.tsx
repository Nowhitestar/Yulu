// tests/web/meetings.list.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Meetings } from "../../web/src/routes/inbox/meetings.js";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    meetings: {
      list: { useQuery: () => ({
        data: [
          { stem: "standup_20260526_120000", meetingTitle: "standup",   recordedAt: "2026-05-26T12:00:00", sizeBytes: 32_000 * 65,       mtimeMs: 1000003, hasTranscript: true,  hasSummary: true,  hasRealtime: true,  firstWords: "kickoff" },
          { stem: "design_20260526_110000",  meetingTitle: "design",    recordedAt: "2026-05-26T11:00:00", sizeBytes: 32_000 * 3600,     mtimeMs: 1000002, hasTranscript: false, hasSummary: false, hasRealtime: false, firstWords: null },
          { stem: "review_20260526_100000",  meetingTitle: "review",    recordedAt: "2026-05-26T10:00:00", sizeBytes: 32_000 * 45,       mtimeMs: 1000001, hasTranscript: true,  hasSummary: false, hasRealtime: false, firstWords: "agenda" },
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

function mount(initialPath = "/inbox/meetings") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{
      path: "/inbox/meetings",
      Component: Meetings,
      children: [{ index: true, element: <div>EMPTY-SLOT</div> }],
    }],
    { initialEntries: [initialPath] }
  );
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

describe("Meetings list", () => {
  it("renders all rows with meetingTitle", () => {
    mount();
    expect(screen.getByText("standup")).toBeInTheDocument();
    expect(screen.getByText("design")).toBeInTheDocument();
    expect(screen.getByText("review")).toBeInTheDocument();
  });

  it("renders ✓ marker only on rows with summary", () => {
    mount();
    const rows = screen.getAllByTestId("meeting-row");
    expect(rows[0]).toHaveTextContent("✓");
    expect(rows[1]).not.toHaveTextContent("✓");
    expect(rows[2]).not.toHaveTextContent("✓");
  });

  it("renders the outlet (no selection → index empty slot)", () => {
    mount();
    expect(screen.getByText("EMPTY-SLOT")).toBeInTheDocument();
  });
});
