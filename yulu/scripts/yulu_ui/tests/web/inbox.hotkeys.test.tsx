// tests/web/inbox.hotkeys.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    voicemails: {
      list: { useQuery: () => ({
        data: [
          { stem: "vm1", firstWords: "a", sizeBytes: 1024, mtimeMs: 3, hasTranscript: true, hasSummary: false },
          { stem: "vm2", firstWords: "b", sizeBytes: 1024, mtimeMs: 2, hasTranscript: true, hasSummary: false },
          { stem: "vm3", firstWords: "c", sizeBytes: 1024, mtimeMs: 1, hasTranscript: true, hasSummary: false },
        ],
        isPending: false,
      }) },
      get: { useQuery: () => ({ data: null, isPending: false }) },
    },
    meetings: {
      list: { useQuery: () => ({ data: [], isPending: false }) },
    },
    glossary: { list: { useQuery: () => ({ data: [], isError: false }) } },
  },
}));

vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: () => {},
  nextBackoff: (n: number) => n,
}));

import { InboxLayout } from "../../web/src/routes/inbox/_layout.js";
import { Voicemails } from "../../web/src/routes/inbox/voicemails.js";

function mount(initialPath = "/inbox/voicemails/vm2") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/inbox" element={<InboxLayout />}>
            <Route path="voicemails" element={<Voicemails />}>
              <Route index element={<div>INDEX</div>} />
              <Route path=":stem" element={<div data-testid="reader" />} />
            </Route>
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

describe("Inbox keyboard shortcuts", () => {
  it("'j' navigates to next stem", async () => {
    mount("/inbox/voicemails/vm1");
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => {
      // The active row in DOM should switch from vm1 to vm2 (via NavLink active)
      const rows = screen.getAllByTestId("voicemail-row");
      expect(rows[1]?.className).toMatch(/active/);
    });
  });

  it("'k' navigates to previous stem", async () => {
    mount("/inbox/voicemails/vm2");
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => {
      const rows = screen.getAllByTestId("voicemail-row");
      expect(rows[0]?.className).toMatch(/active/);
    });
  });

  it("'k' on first stem stays on first (no wrap)", async () => {
    mount("/inbox/voicemails/vm1");
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => {
      const rows = screen.getAllByTestId("voicemail-row");
      expect(rows[0]?.className).toMatch(/active/);
    });
  });
});
