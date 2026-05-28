// tests/web/inbox.hotkeys.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    recordings: {
      list: { useQuery: () => ({
        data: [
          { stem: "vm1", type: "voicemail", title: null, recordedAt: null, mtimeMs: 3, hasTranscript: true, hasSummary: false, hasRealtime: false, firstWords: "a", status: "idle" },
          { stem: "vm2", type: "voicemail", title: null, recordedAt: null, mtimeMs: 2, hasTranscript: true, hasSummary: false, hasRealtime: false, firstWords: "b", status: "idle" },
          { stem: "vm3", type: "voicemail", title: null, recordedAt: null, mtimeMs: 1, hasTranscript: true, hasSummary: false, hasRealtime: false, firstWords: "c", status: "idle" },
        ],
        isPending: false,
      }) },
      get: { useQuery: () => ({ data: null, isPending: false }) },
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
import { RecordingsList } from "../../web/src/routes/inbox/recordings.js";

function mount(initialPath = "/inbox/vm2") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/inbox" element={<InboxLayout />}>
            <Route element={<RecordingsList />}>
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
    mount("/inbox/vm1");
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => {
      // The active row in DOM should switch from vm1 to vm2 (via NavLink active)
      const rows = screen.getAllByTestId("recording-row");
      expect(rows[1]?.className).toMatch(/active/);
    });
  });

  it("'k' navigates to previous stem", async () => {
    mount("/inbox/vm2");
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => {
      const rows = screen.getAllByTestId("recording-row");
      expect(rows[0]?.className).toMatch(/active/);
    });
  });

  it("'k' on first stem stays on first (no wrap)", async () => {
    mount("/inbox/vm1");
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => {
      const rows = screen.getAllByTestId("recording-row");
      expect(rows[0]?.className).toMatch(/active/);
    });
  });
});
