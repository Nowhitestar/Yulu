// tests/web/meetings.reader.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MeetingReader } from "../../web/src/routes/inbox/meetings.$stem.js";

let mockData: {
  stem: string;
  wavPath: string;
  sizeBytes: number;
  mtimeMs: number;
  transcript: string | null;
  summary: string | null;
  realtime: string | null;
} = {
  stem: "standup_20260526_120000",
  wavPath: "/x/standup_20260526_120000.wav",
  sizeBytes: 32000,
  mtimeMs: 1000003,
  transcript: "Speaker A: hello\nSpeaker B: world",
  summary: "## summary\n- point one\n- point two",
  realtime: "rough live transcript",
};

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    meetings: {
      get: { useQuery: () => ({ data: mockData, isPending: false }) },
    },
    glossary: { list: { useQuery: () => ({ data: [], isError: false }) } },
  },
}));

// AudioPlayer stub so tests don't need wavesurfer
vi.mock("../../web/src/components/AudioPlayer.js", () => ({
  AudioPlayer: ({ src }: { src: string }) => <div data-testid="audio-stub">{src}</div>,
}));

function mount(initialPath = "/inbox/meetings/standup_20260526_120000") {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{ path: "/inbox/meetings/:stem", Component: MeetingReader }],
    { initialEntries: [initialPath] },
  );
  return render(
    <QueryClientProvider client={qc}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}

describe("MeetingReader", () => {
  it("renders the 3 always-present tabs: Transcript, Summary, Raw", () => {
    mockData = {
      ...mockData,
      transcript: "Speaker A: hello\nSpeaker B: world",
      summary: "## summary\n- point one\n- point two",
      realtime: "rough live transcript",
    };
    mount();
    expect(screen.getByRole("button", { name: "Transcript" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summary" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Raw" })).toBeInTheDocument();
  });

  it("Realtime tab appears only when data.realtime is non-null", () => {
    // realtime present
    mockData = { ...mockData, realtime: "rough live transcript" };
    const { unmount } = mount();
    expect(screen.getByRole("button", { name: "Realtime" })).toBeInTheDocument();
    unmount();

    // realtime null → no Realtime tab
    mockData = { ...mockData, realtime: null };
    mount();
    expect(screen.queryByRole("button", { name: "Realtime" })).not.toBeInTheDocument();
  });

  it("clicking Realtime tab shows the realtime text", async () => {
    mockData = { ...mockData, realtime: "rough live transcript" };
    const { default: userEvent } = await import("@testing-library/user-event");
    const user = userEvent.setup();
    mount();
    await user.click(screen.getByRole("button", { name: "Realtime" }));
    expect(screen.getByText(/rough live transcript/)).toBeInTheDocument();
  });

  it("defaults to Summary tab when summary is present", () => {
    mockData = {
      ...mockData,
      transcript: "Speaker A: hello\nSpeaker B: world",
      summary: "## summary\n- point one\n- point two",
      realtime: "rough live transcript",
    };
    mount();
    expect(screen.getByText(/point one/)).toBeInTheDocument();
  });
});
