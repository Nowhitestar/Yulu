import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { LanguageProvider } from "../../web/src/i18n/LanguageProvider.js";

const update = vi.fn(async () => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] }));
let recordingState = "idle";
let localInstalled = false;
let engine = "local";
let sessionActive = false;
let captionStatus: {
  provider: "none" | "xai"; model: string; audioEngine: "local" | "xai";
  credentialSource: "oauth" | "api-key" | null;
  disclosure: { accepted: boolean; disclosureVersion: string }; active: boolean;
} | undefined;
const acceptCaptionDisclosure = vi.fn(async () => ({ accepted: true }));
const invalidateCaptionStatus = vi.fn(async () => undefined);
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
      get: { useQuery: () => ({ data: { transcription: { engine, language: "auto" } }, isPending: false }) },
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
        sessionActive,
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
    captionTranslation: {
      status: { useQuery: () => ({ data: captionStatus, isPending: false }) },
      acceptDisclosure: { useMutation: () => ({ mutateAsync: acceptCaptionDisclosure, isPending: false }) },
    },
    recording: { state: { useQuery: () => ({ data: { state: recordingState } }) } },
    useUtils: () => ({
      captionTranslation: { status: { invalidate: invalidateCaptionStatus } },
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

function mount(lang?: "zh" | "en") {
  if (lang) localStorage.setItem("yulu_ui.lang", lang);
  const section = <TranscriptionSection tracker={tracker} />;
  return render(
    <MemoryRouter>
      {lang ? <LanguageProvider>{section}</LanguageProvider> : section}
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.removeItem("yulu_ui.lang");
  update.mockClear();
  recordingState = "idle";
  localInstalled = false;
  engine = "local";
  sessionActive = false;
  captionStatus = {
    provider: "none", model: "grok-4.20-0309-non-reasoning", audioEngine: "local", credentialSource: null,
    disclosure: { accepted: false, disclosureVersion: "xai-caption-text-v1" }, active: false,
  };
  acceptCaptionDisclosure.mockClear();
  invalidateCaptionStatus.mockClear();
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
    await userEvent.click(within(languageRow).getByText("自动识别"));
    expect(within(languageRow).queryByRole("option", { name: "日语" })).toBeNull();
  });

  it("presents one explicit audio engine and links to the shared xAI connection", () => {
    mount();
    expect(screen.getByText("音频引擎")).toBeInTheDocument();
    expect(screen.getByText("语言")).toBeInTheDocument();
    expect(screen.getByText("本地音频引擎")).toBeInTheDocument();
    expect(screen.queryByText("xAI 连接")).toBeNull();
    expect(screen.getByRole("button", { name: "安装本地模型" })).toBeInTheDocument();
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
    await userEvent.setup().click(screen.getByText("模型维护"));
    expect(screen.getByRole("button", { name: "测试模型" })).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "卸载" }));
    expect(window.confirm).toHaveBeenCalledOnce();
    expect(uninstallLocal).toHaveBeenCalledOnce();
  });

  it("keeps uninstall unavailable during an active recording", async () => {
    localInstalled = true;
    sessionActive = true;
    mount();
    await userEvent.setup().click(screen.getByText("模型维护"));
    expect(screen.getByRole("button", { name: "卸载" })).toBeDisabled();
    expect(uninstallLocal).not.toHaveBeenCalled();
  });

  it("persists the language without requesting a daemon restart", async () => {
    mount();
    const row = screen.getByText("语言").closest(".row") as HTMLElement;
    await userEvent.setup().click(within(row).getByText("自动识别"));
    await userEvent.setup().selectOptions(within(row).getByRole("combobox"), "zh");
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ key: "transcription.language", value: "zh" }));
  });

  it("keeps language editable while recording because the selected engine reads it directly", () => {
    recordingState = "recording";
    mount();
    const row = screen.getByText("语言").closest(".row") as HTMLElement;
    expect(within(row).getByText("自动识别")).toBeInTheDocument();
    expect(within(row).queryByText(/录音中不可改/)).toBeNull();
  });

  it("keeps xAI authorization on the shared provider route", () => {
    engine = "xai";
    mount();
    expect(screen.getByRole("link", { name: "打开 AI 服务设置" })).toHaveAttribute("href", "/settings/connections?connection=direct-xai&capability=transcription#ai-connections");
  });

  it("keeps the compact xAI projection localized without rendering backend detail", () => {
    engine = "xai";
    mount("en");

    expect(screen.getByText("xAI connection")).toBeInTheDocument();
    expect(screen.getByText("Not connected")).toBeInTheDocument();
    expect(screen.getByText("Not tested")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open AI services" })).toHaveAttribute("href", "/settings/connections?connection=direct-xai&capability=transcription#ai-connections");
    expect(screen.queryByText("需要在 Yulu 中连接 xAI")).toBeNull();
  });
  it("keeps caption translation off and shows its own disclosure before sending caption text", async () => {
    engine = "xai";
    mount("zh");
    const user = userEvent.setup();
    expect(screen.getByText(/字幕翻译已关闭/)).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "使用 xAI 翻译字幕" }));
    const disclosure = screen.getByRole("group", { name: /字幕文字数据路径说明 · xai-caption-text-v1/ });
    expect(disclosure).toHaveTextContent("会议中其他人说的话");
    expect(update).not.toHaveBeenCalled();
    expect(acceptCaptionDisclosure).not.toHaveBeenCalled();

    await user.click(within(disclosure).getByRole("button", { name: "确认并开启" }));
    expect(acceptCaptionDisclosure).toHaveBeenCalledOnce();
    expect(update).toHaveBeenCalledWith({ key: "transcription.captions.translation_provider", value: "xai" });
    expect(invalidateCaptionStatus).toHaveBeenCalled();
  });

  it("says caption translation needs the xAI audio engine while local audio is selected", () => {
    captionStatus = { ...captionStatus!, provider: "xai", audioEngine: "xai",
      disclosure: { accepted: true, disclosureVersion: "xai-caption-text-v1" }, credentialSource: "oauth" };
    mount("zh");
    // The live config engine wins over a stale status answer.
    expect(screen.getByText(/字幕翻译仅在使用 xAI 转写引擎时运行/)).toBeInTheDocument();
  });

  it.each([
    [{ disclosure: { accepted: false, disclosureVersion: "xai-caption-text-v1" }, credentialSource: "oauth" as const }, /请先确认字幕文字如何发送给 xAI/],
    [{ disclosure: { accepted: true, disclosureVersion: "xai-caption-text-v1" }, credentialSource: null }, /请先在「设置 › 连接」的 AI 服务中连接 xAI/],
  ])("explains what caption translation is waiting for: %o", (change, message) => {
    engine = "xai";
    captionStatus = { ...captionStatus!, provider: "xai", audioEngine: "xai", ...change };
    mount("zh");
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it("turns caption translation off without asking again", async () => {
    engine = "xai";
    captionStatus = { ...captionStatus!, provider: "xai", audioEngine: "xai", credentialSource: "oauth",
      disclosure: { accepted: true, disclosureVersion: "xai-caption-text-v1" }, active: true };
    mount("zh");
    expect(screen.queryByText(/字幕翻译(已关闭|仅在|尚未生效)/)).toBeNull();
    await userEvent.setup().click(screen.getByRole("switch", { name: "使用 xAI 翻译字幕" }));
    expect(update).toHaveBeenCalledWith({ key: "transcription.captions.translation_provider", value: "none" });
    expect(acceptCaptionDisclosure).not.toHaveBeenCalled();
  });
});
