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
    providers: {
      status: { useQuery: () => ({ data: {
        connection: {
          connected: false,
          source: null,
          detail: "需要在 Yulu 中连接 xAI",
          authorization: { status: "idle", verificationUrl: "", userCode: "", message: "" },
        },
        readiness: {
          transcription: { status: "untested", model: "speech-to-text", testedAt: null },
        },
      }, error: null }) },
    },
    recording: { state: { useQuery: () => ({ data: { state: recordingState } }) } },
    useUtils: () => ({
      config: { get: { setData: vi.fn(), invalidate: vi.fn() } },
      localCaption: { status: { invalidate: vi.fn() } },
      providers: { status: { invalidate: vi.fn() } },
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
  vi.spyOn(window, "confirm").mockReturnValue(true);
  vi.spyOn(window, "open").mockReturnValue({ opener: null, close: vi.fn(), location: { href: "" } } as never);
});

describe("TranscriptionSection", () => {
  it("explains an unavailable selected engine and hides unsupported Japanese for local", async () => {
    mount();
    expect(screen.getByText(/模型尚未就绪/)).toBeInTheDocument();
    const languageRow = screen.getByText("语言").closest(".row") as HTMLElement;
    await userEvent.click(within(languageRow).getByText("auto"));
    expect(within(languageRow).queryByRole("option", { name: "ja" })).toBeNull();
  });

  it("presents one explicit audio engine and links to the shared xAI connection", () => {
    mount();
    expect(screen.getByText("音频引擎")).toBeInTheDocument();
    expect(screen.getByText("语言")).toBeInTheDocument();
    expect(screen.getByText("本地音频引擎")).toBeInTheDocument();
    expect(screen.getByText("xAI 连接")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "安装本地模型" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "打开智能服务设置" })).toHaveAttribute("href", "/settings/llm");
    expect(screen.queryByRole("button", { name: "使用 Grok 账号连接" })).toBeNull();
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

  it("keeps xAI authorization on the shared provider route", () => {
    mount();
    expect(screen.getByRole("link", { name: "打开智能服务设置" })).toHaveAttribute("href", "/settings/llm");
  });
});
