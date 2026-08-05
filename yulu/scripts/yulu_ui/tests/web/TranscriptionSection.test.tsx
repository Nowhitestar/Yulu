import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";

const update = vi.fn(async () => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] }));
let recordingState = "idle";
let localInstalled = false;
const installLocal = vi.fn();
const uninstallLocal = vi.fn();
const testLocal = vi.fn();
const authorizeXai = vi.fn();
const cancelXaiAuthorization = vi.fn();
const logoutXai = vi.fn();
const testXai = vi.fn();

const schema = [
  { path: "transcription.engine", category: "transcription", label: "音频引擎", type: "select", reload: { kind: "none" } },
  { path: "transcription.language", category: "transcription", label: "语言", type: "select", reload: { kind: "none" } },
];

vi.mock("../../web/src/ws.js", () => ({
  WsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useWsChannel: () => {},
}));

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    config: {
      get: { useQuery: () => ({ data: { transcription: { engine: "local", language: "auto" } }, isPending: false }) },
      schema: { useQuery: () => ({ data: schema, isPending: false }) },
      update: { useMutation: () => ({ mutateAsync: update }) },
    },
    localCaption: {
      status: { useQuery: () => ({ data: {
        installed: localInstalled,
        ready: localInstalled,
        operation: "idle",
        runtimeBytes: localInstalled ? 80_000_000 : 0,
        modelBytes: localInstalled ? 240_000_000 : 0,
        sessionActive: false,
        message: null,
        error: null,
      } }) },
      install: { useMutation: () => ({ mutate: installLocal, isPending: false, error: null }) },
      uninstall: { useMutation: () => ({ mutate: uninstallLocal, isPending: false, error: null }) },
      test: { useMutation: () => ({ mutate: testLocal, isPending: false, error: null }) },
    },
    xaiAudio: {
      status: { useQuery: () => ({ data: {
        connected: false,
        detail: "需要在 Yulu 中授权 xAI",
        authorization: { status: "idle", verificationUrl: "", userCode: "", message: "" },
      }, error: null }) },
      authorize: { useMutation: () => ({ mutate: authorizeXai, isPending: false, error: null }) },
      cancelAuthorization: { useMutation: () => ({ mutate: cancelXaiAuthorization, isPending: false, error: null }) },
      logout: { useMutation: () => ({ mutate: logoutXai, isPending: false, error: null }) },
      test: { useMutation: () => ({ mutate: testXai, isPending: false, error: null, data: null }) },
    },
    recording: { state: { useQuery: () => ({ data: { state: recordingState } }) } },
    useUtils: () => ({
      config: { get: { setData: vi.fn(), invalidate: vi.fn() } },
      localCaption: { status: { invalidate: vi.fn() } },
      xaiAudio: { status: { invalidate: vi.fn() } },
    }),
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
  localInstalled = false;
  installLocal.mockClear();
  uninstallLocal.mockClear();
  testLocal.mockClear();
  authorizeXai.mockClear();
  cancelXaiAuthorization.mockClear();
  logoutXai.mockClear();
  testXai.mockClear();
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "open").mockReturnValue({ opener: null, close: vi.fn(), location: { href: "" } } as never);
});

describe("TranscriptionSection", () => {
  it("presents one explicit audio engine and Yulu-owned xAI authorization", () => {
    mount();
    expect(screen.getByText("音频引擎")).toBeInTheDocument();
    expect(screen.getByText("语言")).toBeInTheDocument();
    expect(screen.getByText("本地音频引擎")).toBeInTheDocument();
    expect(screen.getByText("xAI OAuth 授权")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "安装本地模型" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "授权 xAI" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /管理术语表/ })).toHaveAttribute("href", "/knowledge/glossary");

    for (const retired of [/MLX/i, /说话人分离/i, /说话人数/i]) {
      expect(screen.queryByText(retired)).toBeNull();
    }
  });

  it("starts local model installation from the settings module", async () => {
    mount();
    await userEvent.setup().click(screen.getByRole("button", { name: "安装本地模型" }));
    expect(installLocal).toHaveBeenCalledOnce();
  });

  it("shows model test and confirms uninstall after installation", async () => {
    localInstalled = true;
    mount();
    expect(screen.getByRole("button", { name: "测试模型" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "卸载" }));
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(uninstallLocal).toHaveBeenCalledOnce();
  });

  it("persists the language without requesting a daemon restart", async () => {
    mount();
    const row = screen.getByText("语言").closest(".row") as HTMLElement;
    await userEvent.setup().click(within(row).getByText("auto"));
    await userEvent.setup().selectOptions(within(row).getByRole("combobox"), "zh");
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ key: "transcription.language", value: "zh" }));
  });

  it("keeps language editable while recording because the selected engine reads it directly", () => {
    recordingState = "recording";
    mount();
    const row = screen.getByText("语言").closest(".row") as HTMLElement;
    expect(within(row).getByText("auto")).toBeInTheDocument();
    expect(within(row).queryByText(/录音中不可改/)).toBeNull();
  });

  it("starts xAI OAuth directly from Yulu", async () => {
    mount();
    await userEvent.setup().click(screen.getByRole("button", { name: "授权 xAI" }));
    expect(authorizeXai).toHaveBeenCalledOnce();
    expect(authorizeXai.mock.calls[0]?.[0]).toBeUndefined();
  });
});
