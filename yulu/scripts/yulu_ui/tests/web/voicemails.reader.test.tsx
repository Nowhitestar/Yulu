// tests/web/voicemails.reader.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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
          transcript: "Speaker A: hello\nSpeaker B: world",
          summary: "## summary\n- point one\n- point two",
        },
        isPending: false,
      }) },
    },
    glossary: { list: { useQuery: () => ({ data: [], isError: false }) } },
  },
}));

// AudioPlayer stub so tests don't need wavesurfer
vi.mock("../../web/src/components/AudioPlayer.js", () => ({
  AudioPlayer: ({ src }: { src: string }) => <div data-testid="audio-stub">{src}</div>,
}));

function mount(initialPath = "/inbox/voicemails/voicemail_20260526_120000") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: "/inbox/voicemails/:stem", Component: VoicemailReader }],
    { initialEntries: [initialPath] },
  );
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

describe("VoicemailReader", () => {
  it("renders the AudioPlayer pointed at the right /files URL", () => {
    mount();
    expect(screen.getByTestId("audio-stub")).toHaveTextContent("/files/voicemails/voicemail_20260526_120000.wav");
  });

  it("renders all three tabs: Transcript, Summary, Raw", () => {
    mount();
    expect(screen.getByRole("button", { name: "Transcript" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summary" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Raw" })).toBeInTheDocument();
  });

  it("defaults to Summary tab when summary exists", () => {
    mount();
    expect(screen.getByText(/point one/)).toBeInTheDocument();
  });

  it("clicking Transcript tab shows transcript text", async () => {
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Transcript" }));
    expect(screen.getByText(/hello/)).toBeInTheDocument();
    expect(screen.getByText(/world/)).toBeInTheDocument();
  });
});
