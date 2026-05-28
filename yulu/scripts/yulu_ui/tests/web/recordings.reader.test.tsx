import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";

const getMock = vi.fn();
vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    recordings: {
      get: { useQuery: (...a: unknown[]) => getMock(...a) },
      transcribe: { useMutation: () => ({ mutate: vi.fn() }) },
      summarize: { useMutation: () => ({ mutate: vi.fn() }) },
    },
  },
}));
vi.mock("../../web/src/ws.js", () => ({ useWsChannel: () => {} }));
vi.mock("@tanstack/react-query", () => ({ useQueryClient: () => ({ invalidateQueries: vi.fn() }) }));
vi.mock("../../web/src/components/AudioPlayer.js", () => ({ AudioPlayer: () => <div data-testid="audio" /> }));
vi.mock("../../web/src/components/TranscriptView.js", () => ({ TranscriptView: ({ text }: { text: string }) => <div>{text}</div> }));

import { RecordingReader } from "../../web/src/routes/inbox/recordings.$stem";

function renderAt(stem: string) {
  return render(
    <MemoryRouter initialEntries={[`/inbox/${stem}`]}>
      <Routes><Route path="/inbox/:stem" element={<RecordingReader />} /></Routes>
    </MemoryRouter>
  );
}

describe("RecordingReader", () => {
  it("shows Realtime tab when hasRealtime is true (meeting)", () => {
    getMock.mockReturnValue({ data: { stem: "TeamSync_20260102_090000", type: "meeting", title: "TeamSync", mtimeMs: 1, transcript: "t", summary: "s", realtime: "r", hasRealtime: true, status: "idle" }, isPending: false });
    renderAt("TeamSync_20260102_090000");
    expect(screen.getByRole("button", { name: /realtime/i })).toBeInTheDocument();
  });

  it("hides Realtime tab when hasRealtime is false (voicemail)", () => {
    getMock.mockReturnValue({ data: { stem: "voicemail_20260101_120000", type: "voicemail", title: null, mtimeMs: 1, transcript: "t", summary: "s", realtime: null, hasRealtime: false, status: "idle" }, isPending: false });
    renderAt("voicemail_20260101_120000");
    expect(screen.queryByRole("button", { name: /realtime/i })).toBeNull();
  });

  it("renders Re-transcribe + Re-generate summary buttons", () => {
    getMock.mockReturnValue({ data: { stem: "voicemail_20260101_120000", type: "voicemail", title: null, mtimeMs: 1, transcript: "t", summary: "s", realtime: null, hasRealtime: false, status: "idle" }, isPending: false });
    renderAt("voicemail_20260101_120000");
    expect(screen.getByRole("button", { name: /Re-transcribe/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Re-generate summary/i })).toBeInTheDocument();
  });
});
