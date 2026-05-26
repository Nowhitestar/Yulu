// tests/web/voicemails.list.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Voicemails } from "../../web/src/routes/inbox/voicemails.js";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    voicemails: {
      list: { useQuery: () => ({
        data: [
          { stem: "voicemail_20260526_120000", firstWords: "hello world", sizeBytes: 1024, mtimeMs: 1000003, hasTranscript: true, hasSummary: true },
          { stem: "voicemail_20260526_110000", firstWords: null, sizeBytes: 2048, mtimeMs: 1000002, hasTranscript: false, hasSummary: false },
          { stem: "voicemail_20260526_100000", firstWords: "second message", sizeBytes: 512, mtimeMs: 1000001, hasTranscript: true, hasSummary: false },
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

function mount(initialPath = "/inbox/voicemails") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{
      path: "/inbox/voicemails",
      Component: Voicemails,
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

describe("Voicemails list", () => {
  it("renders all rows with firstWords + meta", () => {
    mount();
    expect(screen.getByText("hello world")).toBeInTheDocument();
    expect(screen.getByText("second message")).toBeInTheDocument();
    // No firstWords → stem shown
    expect(screen.getByText(/voicemail_20260526_110000/)).toBeInTheDocument();
  });

  it("renders ✓ marker when summary exists", () => {
    mount();
    const rows = screen.getAllByTestId("voicemail-row");
    expect(rows[0]).toHaveTextContent("✓");
    expect(rows[1]).not.toHaveTextContent("✓");
  });

  it("renders the outlet (no selection → 'Select a voicemail' empty state via index route)", () => {
    mount();
    expect(screen.getByText("EMPTY-SLOT")).toBeInTheDocument();
  });
});
