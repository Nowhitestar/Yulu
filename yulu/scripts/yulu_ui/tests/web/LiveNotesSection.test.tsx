import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { LanguageProvider } from "../../web/src/i18n/LanguageProvider.js";

const update = vi.fn(async () => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] }));
const acceptDisclosure = vi.fn(async () => ({ accepted: true }));
const invalidateStatus = vi.fn(async () => undefined);
let status: {
  provider: "none" | "xai"; model: string; language: "zh" | "en";
  credentialSource: "oauth" | "api-key" | null;
  disclosure: { accepted: boolean; disclosureVersion: string }; active: boolean;
};

const schema = [
  { path: "transcription.live_notes", category: "transcription", label: "实时笔记", type: "text", reload: { kind: "none" } },
];

vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: () => {},
}));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    config: {
      get: { useQuery: () => ({ data: { transcription: { live_notes: { provider: status.provider } } }, isPending: false }) },
      schema: { useQuery: () => ({ data: schema, isPending: false }) },
      update: { useMutation: () => ({ mutateAsync: update }) },
    },
    liveNotes: {
      status: { useQuery: () => ({ data: status, isPending: false }) },
      acceptDisclosure: { useMutation: () => ({ mutateAsync: acceptDisclosure, isPending: false }) },
    },
    recording: { state: { useQuery: () => ({ data: { state: "idle" } }) } },
    useUtils: () => ({
      liveNotes: { status: { invalidate: invalidateStatus } },
      config: { get: { setData: vi.fn(), invalidate: vi.fn() } },
    }),
  },
}));

import { LiveNotesSection } from "../../web/src/components/settings/LiveNotesSection.js";

const tracker = { record: vi.fn(), statusFor: () => null, clearDaemon: vi.fn(), daemons: new Map() } as never;

function mount() {
  localStorage.setItem("yulu_ui.lang", "zh");
  return render(<MemoryRouter><LanguageProvider><LiveNotesSection tracker={tracker} /></LanguageProvider></MemoryRouter>);
}

beforeEach(() => {
  update.mockClear();
  acceptDisclosure.mockClear();
  invalidateStatus.mockClear();
  status = {
    provider: "none", model: "grok-4.20-0309-non-reasoning", language: "zh", credentialSource: "oauth",
    disclosure: { accepted: false, disclosureVersion: "xai-live-notes-v1" }, active: false,
  };
});

describe("LiveNotesSection", () => {
  it("asks for the data notice before the first meeting text can be sent", async () => {
    mount();
    expect(screen.getByRole("heading", { name: "实时笔记" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("switch"));
    expect(update).not.toHaveBeenCalled();
    expect(screen.getByText(/音频不会发送/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "同意并开启" }));
    expect(acceptDisclosure).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({ key: "transcription.live_notes.provider", value: "xai" });
  });

  it("turns off without asking, and turns on directly once the notice was accepted", async () => {
    status = { ...status, provider: "xai", disclosure: { ...status.disclosure, accepted: true }, active: true };
    mount();
    await userEvent.click(screen.getByRole("switch"));
    expect(update).toHaveBeenCalledWith({ key: "transcription.live_notes.provider", value: "none" });
    expect(screen.queryByText(/音频不会发送/)).toBeNull();
  });

  it("says when xAI is not connected and saves the notes language", async () => {
    status = { ...status, provider: "xai", credentialSource: null, disclosure: { ...status.disclosure, accepted: true } };
    mount();
    expect(screen.getByText("还没有连接 xAI。")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "去「连接」添加" })).toHaveAttribute("href", "/settings/connections#ai-connections");
    expect(screen.getByRole("button", { name: "中文" })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: "English" }));
    expect(update).toHaveBeenCalledWith({ key: "transcription.live_notes.language", value: "en" });
  });
});
