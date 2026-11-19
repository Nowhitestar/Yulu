// tests/web/inbox.hotkeys.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    recordings: {
      list: { useQuery: () => ({
        data: [
          { stem: "rec1", title: "Rec1", recordedAt: null, durationSeconds: null, status: "idle" },
          { stem: "rec2", title: "Rec2", recordedAt: null, durationSeconds: null, status: "idle" },
          { stem: "rec3", title: "Rec3", recordedAt: null, durationSeconds: null, status: "idle" },
        ],
        isPending: false,
      }) },
      rename: { useMutation: () => ({ mutate: vi.fn() }) },
      delete: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));

vi.mock("../../web/src/ws.js", () => ({ useWsChannel: () => {} }));

import { RecordingsList } from "../../web/src/routes/inbox/recordings.js";
import { LanguageProvider } from "../../web/src/i18n/LanguageProvider.js";

/** The list lives in the left pane, beside whichever recording the route shows. */
function mount(initialPath: string) {
  return render(
    <LanguageProvider>
      <MemoryRouter initialEntries={[initialPath]}>
        <RecordingsList />
        <Routes>
          <Route path="/inbox/:stem" element={<input data-testid="reader-field" />} />
        </Routes>
      </MemoryRouter>
    </LanguageProvider>,
  );
}

const activeTitles = () => screen.getAllByTestId("recording-row")
  .filter((row) => /\bactive\b/.test(row.className)).map((row) => row.textContent);

describe("recordings list keyboard shortcuts", () => {
  it("'j' opens the next recording", async () => {
    mount("/inbox/rec1");
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(activeTitles()).toEqual(["Rec2"]));
  });

  it("'k' opens the previous recording", async () => {
    mount("/inbox/rec2");
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(activeTitles()).toEqual(["Rec1"]));
  });

  it("'k' on the first recording stays there", async () => {
    mount("/inbox/rec1");
    fireEvent.keyDown(window, { key: "k" });
    await waitFor(() => expect(activeTitles()).toEqual(["Rec1"]));
  });

  it("'j' on the last recording stays there", async () => {
    mount("/inbox/rec3");
    fireEvent.keyDown(window, { key: "j" });
    await waitFor(() => expect(activeTitles()).toEqual(["Rec3"]));
  });

  it("leaves typing alone", () => {
    mount("/inbox/rec1");
    fireEvent.keyDown(screen.getByTestId("reader-field"), { key: "j" });
    expect(activeTitles()).toEqual(["Rec1"]);
  });
});
