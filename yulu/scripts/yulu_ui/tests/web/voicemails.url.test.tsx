// tests/web/voicemails.url.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { VoicemailReader } from "../../web/src/routes/inbox/voicemails.$stem.js";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    voicemails: {
      get: { useQuery: () => ({
        data: {
          stem: "voicemail_20260526_120000",
          wavPath: "/x/voicemail_20260526_120000.wav",
          sizeBytes: 32000,
          mtimeMs: 1000003,
          transcript: "alpha beta gamma OKR delta epsilon",
          summary: null,
          status: "idle",
        },
        isPending: false,
      }) },
      transcribe: { useMutation: () => ({ mutate: vi.fn() }) },
      summarize:  { useMutation: () => ({ mutate: vi.fn() }) },
    },
    glossary: { list: { useQuery: () => ({ data: [], isError: false }) } },
  },
}));

vi.mock("../../web/src/ws.js", () => ({ useWsChannel: () => {} }));

vi.mock("../../web/src/components/AudioPlayer.js", () => ({
  AudioPlayer: ({ initialSeek }: { initialSeek?: number }) => <div data-testid="audio-stub" data-seek={initialSeek ?? "none"} />,
}));

function mountAt(path: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: "/inbox/voicemails/:stem", Component: VoicemailReader }],
    { initialEntries: [path] },
  );
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

describe("Voicemails URL state", () => {
  it("passes ?seek= as initialSeek to AudioPlayer", () => {
    mountAt("/inbox/voicemails/voicemail_20260526_120000?seek=12.3");
    expect(screen.getByTestId("audio-stub")).toHaveAttribute("data-seek", "12.3");
  });

  it("?snippet= scrolls the first match into view + applies highlight class", async () => {
    mountAt("/inbox/voicemails/voicemail_20260526_120000?tab=transcript&snippet=OKR");
    await waitFor(() => {
      const highlighted = document.querySelector(".search-highlight");
      expect(highlighted).not.toBeNull();
      expect(highlighted?.textContent).toContain("OKR");
    });
  });

  it("?snippet= silently skips if no match", () => {
    mountAt("/inbox/voicemails/voicemail_20260526_120000?tab=transcript&snippet=zzznosuch");
    expect(document.querySelector(".search-highlight")).toBeNull();
  });
});
