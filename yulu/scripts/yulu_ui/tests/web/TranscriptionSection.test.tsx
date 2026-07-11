import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

const update = vi.fn(async () => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] }));
let recordingState = "idle";
let transcriptionHealth = { available: true, provider: "hermes", reason: null as string | null };

const schema = [
  { path: "transcription.language", category: "transcription", label: "语言", type: "select", reload: { kind: "none" } },
];

vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: () => {},
}));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    config: {
      get: { useQuery: () => ({ data: { transcription: { language: "auto" } }, isPending: false }) },
      schema: { useQuery: () => ({ data: schema, isPending: false }) },
      update: { useMutation: () => ({ mutateAsync: update }) },
    },
    agentTasks: {
      transcriptionHealth: { useQuery: () => ({ data: transcriptionHealth, isPending: false }) },
    },
    recording: { state: { useQuery: () => ({ data: { state: recordingState } }) } },
    useUtils: () => ({ config: { get: { setData: vi.fn(), invalidate: vi.fn() } } }),
  },
}));

import { TranscriptionSection } from "../../web/src/components/settings/TranscriptionSection.js";

const tracker = {
  record: vi.fn(),
  statusFor: () => null,
  clearDaemon: vi.fn(),
  daemons: new Map(),
} as never;

function mount() {
  return render(
    <MemoryRouter>
      <TranscriptionSection tracker={tracker} />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  update.mockClear();
  recordingState = "idle";
  transcriptionHealth = { available: true, provider: "hermes", reason: null };
});

describe("TranscriptionSection", () => {
  it("presents Agent-owned transcription with only product language and glossary inputs", () => {
    mount();
    expect(screen.getByText("Hermes")).toBeInTheDocument();
    expect(screen.getByText("语言")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /管理术语表/ })).toHaveAttribute("href", "/knowledge/glossary");

    for (const retired of [/MLX/i, /Whisper/i, /实时转写/i, /说话人分离/i, /说话人数/i, /本地模型/i]) {
      expect(screen.queryByText(retired)).toBeNull();
    }
  });

  it("persists the language without requesting a daemon restart", async () => {
    mount();
    const row = screen.getByText("语言").closest(".row") as HTMLElement;
    await userEvent.setup().click(within(row).getByText("auto"));
    await userEvent.setup().selectOptions(within(row).getByRole("combobox"), "zh");
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ key: "transcription.language", value: "zh" }));
  });

  it("keeps language editable while recording because Agent settings need no daemon restart", () => {
    recordingState = "recording";
    mount();
    const row = screen.getByText("语言").closest(".row") as HTMLElement;
    expect(within(row).getByText("auto")).toBeInTheDocument();
    expect(within(row).queryByText(/录音中不可改/)).toBeNull();
  });

  it("shows the Agent transcription health reason when Hermes is unavailable", () => {
    transcriptionHealth = { available: false, provider: "hermes", reason: "ffmpeg is required" };
    mount();
    expect(screen.getByText("ffmpeg is required")).toBeInTheDocument();
  });
});
