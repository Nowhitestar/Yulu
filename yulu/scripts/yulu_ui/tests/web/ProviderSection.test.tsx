import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { LanguageProvider } from "../../web/src/i18n/LanguageProvider.js";

const { configUpdate, setApiKey, probe, acceptDataPathDisclosure, providerStatus, providerConfig, providerMutationErrors } = vi.hoisted(() => ({
  configUpdate: vi.fn(async () => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] })),
  setApiKey: vi.fn(),
  probe: vi.fn(),
  acceptDataPathDisclosure: vi.fn(async () => ({ accepted: true })),
  providerMutationErrors: { disclosure: null as Error | null, probe: null as Error | null },
  providerConfig: {
    transcription: { engine: "local", language: "zh" },
    intelligence: {
      summary: { provider: "agent", model: "runtime-managed" },
      conversation: { provider: "xai", model: "grok-4.6" },
    },
  },
  providerStatus: {
    connection: {
      connected: true,
      source: "oauth" as const,
      oauthConnected: true,
      apiKeyConfigured: false,
      detail: "xAI OAuth 已连接",
      authorization: { status: "idle", verificationUrl: "", userCode: "", message: "" },
    },
    readiness: {
      transcription: { capability: "transcription", status: "untested", model: "speech-to-text", testedAt: null, detail: "尚未测试", credentialSource: null },
      summary: { capability: "summary", status: "untested", model: "grok-4.6", testedAt: null, detail: "尚未测试", credentialSource: null },
      conversation: { capability: "conversation", status: "ready", model: "grok-4.6", testedAt: "2026-08-24T12:00:00.000Z", detail: "已通过真实请求测试", credentialSource: "oauth" },
    },
    disclosures: {
      transcription: { required: true, disclosureVersion: "xai-audio-v1", data: "recording_audio", destination: "xAI" },
      summary: { required: true, disclosureVersion: "xai-summary-v1", data: "transcript_text", destination: "xAI" },
    },
  },
}));

vi.mock("../../web/src/ws.js", () => ({
  useWsChannel: () => {},
}));

vi.mock("../../web/src/trpc.js", () => {
  const mutation = (fn = vi.fn()) => ({
    mutate: (input?: unknown, options?: { onSuccess?: (value: unknown) => void }) => {
      fn(input);
      options?.onSuccess?.(providerStatus.connection);
    },
    mutateAsync: async (input?: unknown) => fn(input),
    isPending: false,
    error: null,
    data: null,
    variables: undefined,
  });
  return {
    trpc: {
      config: {
        get: { useQuery: () => ({ data: providerConfig }) },
        schema: { useQuery: () => ({ data: [
          { path: "transcription.engine", label: "音频引擎", reload: { kind: "none" } },
          { path: "intelligence.summary", label: "摘要服务", reload: { kind: "none" } },
          { path: "intelligence.conversation", label: "对话服务", reload: { kind: "none" } },
        ] }) },
        update: { useMutation: () => ({ mutateAsync: configUpdate }) },
      },
      recording: { state: { useQuery: () => ({ data: { state: "idle" }, dataUpdatedAt: 1 }) } },
      providers: {
        status: { useQuery: () => ({ data: providerStatus, error: null }) },
        authorize: { useMutation: () => mutation() },
        cancelAuthorization: { useMutation: () => mutation() },
        logoutOAuth: { useMutation: () => mutation() },
        setApiKey: { useMutation: () => mutation(setApiKey) },
        clearApiKey: { useMutation: () => mutation() },
        probe: { useMutation: () => ({ ...mutation(probe), error: providerMutationErrors.probe }) },
        acceptDataPathDisclosure: { useMutation: () => ({
          ...mutation(acceptDataPathDisclosure),
          error: providerMutationErrors.disclosure,
        }) },
      },
      useUtils: () => ({
        config: { get: { setData: vi.fn(), invalidate: vi.fn() } },
        providers: { status: { invalidate: vi.fn() } },
        daemons: { health: { invalidate: vi.fn() } },
      }),
    },
  };
});

import { ProviderSection } from "../../web/src/components/settings/ProviderSection.js";

const tracker = {
  record: vi.fn(),
  statusFor: () => null,
  clearDaemon: vi.fn(),
  daemons: new Map(),
} as never;

function mount(lang: "zh" | "en" = "zh") {
  localStorage.setItem("yulu_ui.lang", lang);
  return render(
    <MemoryRouter>
      <LanguageProvider>
        <ProviderSection tracker={tracker} />
      </LanguageProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.removeItem("yulu_ui.lang");
  configUpdate.mockClear();
  setApiKey.mockClear();
  probe.mockClear();
  acceptDataPathDisclosure.mockClear();
  acceptDataPathDisclosure.mockResolvedValue({ accepted: true });
  providerMutationErrors.disclosure = null;
  providerMutationErrors.probe = null;
  providerConfig.transcription.engine = "local";
  providerConfig.intelligence.summary = { provider: "agent", model: "runtime-managed" };
  providerConfig.intelligence.conversation = { provider: "xai", model: "grok-4.6" };
  providerStatus.disclosures.transcription.required = true;
  providerStatus.disclosures.summary.required = true;
  providerStatus.readiness.summary.status = "untested";
  providerStatus.connection.authorization.status = "idle";
  providerStatus.connection.authorization.message = "";
});

describe("ProviderSection", () => {
  it("renders one shared connection and three independent accessible readiness rows", () => {
    mount();

    expect(screen.getByRole("heading", { name: "智能服务" })).toBeInTheDocument();
    expect(screen.getByText("xAI 连接")).toBeInTheDocument();
    expect(screen.getByLabelText("转写服务")).toHaveValue("local");
    expect(screen.getByLabelText("摘要服务")).toHaveValue("agent");
    expect(screen.getByLabelText("对话服务")).toHaveValue("xai");
    expect(screen.queryByText(/录音音频会离开这台电脑/)).toBeNull();
    expect(screen.queryByText(/转写文本会发送给 xAI/)).toBeNull();
    expect(screen.getAllByTestId(/^provider-readiness-/)).toHaveLength(3);
    expect(screen.getByText(/2026-08-24.*grok-4.6/)).toBeInTheDocument();
    expect(within(screen.getByTestId("provider-readiness-conversation")).getByRole("status"))
      .toHaveClass("provider-readiness-status--ok");
    expect(screen.queryByText(/oauth-secret|api-key-secret/)).toBeNull();
  });

  it("changes one capability, submits an API key once, and probes only the chosen row", async () => {
    mount();
    const user = userEvent.setup();

    await user.selectOptions(screen.getByLabelText("摘要服务"), "xai");
    expect(configUpdate).toHaveBeenCalledWith({
      key: "intelligence.summary",
      value: { provider: "xai", model: "grok-4.6" },
    });
    expect(configUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ key: "intelligence.conversation" }));

    const input = screen.getByLabelText("xAI API Key");
    expect(input).toHaveAttribute("type", "password");
    await user.type(input, "submitted-once");
    await user.click(screen.getByRole("button", { name: "保存 API Key" }));
    expect(setApiKey).toHaveBeenCalledWith({ apiKey: "submitted-once" });
    expect(input).toHaveValue("");
    expect(screen.queryByText("submitted-once")).toBeNull();

    const summaryRow = screen.getByTestId("provider-readiness-summary");
    await user.click(within(summaryRow).getByRole("button", { name: "测试摘要" }));
    expect(probe).toHaveBeenCalledWith({ capability: "summary" });
    expect(probe).not.toHaveBeenCalledWith({ capability: "transcription" });
  });

  it("explains Grok OAuth and the Keychain-only API key alternative in English", () => {
    mount("en");

    expect(screen.getByText("Uses Grok CLI OAuth. Available capabilities depend on your Grok account.")).toBeInTheDocument();
    expect(screen.getByText("Use API key instead")).toBeInTheDocument();
    expect(screen.getByText("Saved in macOS Keychain. Yulu will not show it again.")).toBeInTheDocument();
    expect(screen.getByLabelText("xAI API Key")).toHaveAttribute("autocomplete", "new-password");
  });

  it("names the failed capability, pinned model, and recovery in the active language", () => {
    providerStatus.readiness.summary.status = "failed";

    mount("en");

    const row = screen.getByTestId("provider-readiness-summary");
    expect(within(row).getByRole("alert")).toHaveTextContent(
      "Summary provider · grok-4.6 failed. Check account access or model settings, then test again.",
    );
  });

  it("localizes connection and credential failures instead of exposing backend copy", () => {
    providerStatus.connection.authorization.status = "failed";
    providerStatus.connection.authorization.message = "xAI OAuth 授权失败，请重试";

    mount("en");

    expect(screen.getByRole("alert")).toHaveTextContent(
      "xAI connection failed. Check account or Keychain access, then retry.",
    );
    expect(screen.queryByText(/OAuth 授权失败/)).toBeNull();
  });

  it("repairs missing post-activation xAI disclosures before testing transcription and summary", async () => {
    providerConfig.transcription.engine = "xai";
    providerConfig.intelligence.summary = { provider: "xai", model: "grok-4.6" };
    mount();
    const user = userEvent.setup();

    expect(screen.getByText("录音音频会离开这台电脑并直接发送给 xAI，可能产生提供商费用。")).toBeInTheDocument();
    expect(screen.getByText("转写文本会发送给 xAI 用于生成摘要，可能产生提供商费用。")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "接受并测试转写" }));
    expect(acceptDataPathDisclosure).toHaveBeenCalledWith({ capability: "transcription" });
    expect(probe).toHaveBeenCalledWith({ capability: "transcription" });

    await user.click(screen.getByRole("button", { name: "接受并测试摘要" }));
    expect(acceptDataPathDisclosure).toHaveBeenCalledWith({ capability: "summary" });
    expect(probe).toHaveBeenCalledWith({ capability: "summary" });
  });

  it("shows a localized recovery when accepting a disclosure fails and does not probe", async () => {
    providerConfig.transcription.engine = "xai";
    providerMutationErrors.disclosure = new Error("transport failed");
    acceptDataPathDisclosure.mockRejectedValueOnce(new Error("transport failed"));
    mount();
    const user = userEvent.setup();

    expect(screen.getByRole("alert", { name: "数据路径确认未保存" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "接受并测试转写" }));
    expect(probe).not.toHaveBeenCalled();
  });

  it("keeps a capability-test failure distinct from a data-path disclosure failure", () => {
    providerMutationErrors.probe = new Error("transport failed");
    mount();

    expect(screen.getByRole("alert", { name: "能力测试未完成" })).toBeInTheDocument();
    expect(screen.queryByRole("alert", { name: "数据路径确认未保存" })).toBeNull();
  });
});
