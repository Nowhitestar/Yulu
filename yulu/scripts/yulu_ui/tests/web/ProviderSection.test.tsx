import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { LanguageProvider } from "../../web/src/i18n/LanguageProvider.js";

const { configUpdate, setApiKey, probe, providerStatus } = vi.hoisted(() => ({
  configUpdate: vi.fn(async () => ({ daemonsNeedingRestart: [], daemonsNeedingSighup: [] })),
  setApiKey: vi.fn(),
  probe: vi.fn(),
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
  },
}));

vi.mock("../../web/src/ws.js", () => ({
  useWsChannel: () => {},
}));

vi.mock("../../web/src/trpc.js", () => {
  const cfg = {
    transcription: { engine: "local", language: "zh" },
    intelligence: {
      summary: { provider: "agent", model: "runtime-managed" },
      conversation: { provider: "xai", model: "grok-4.6" },
    },
  };
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
        get: { useQuery: () => ({ data: cfg }) },
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
        probe: { useMutation: () => mutation(probe) },
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
  providerStatus.readiness.summary.status = "untested";
});

describe("ProviderSection", () => {
  it("renders one shared connection and three independent accessible readiness rows", () => {
    mount();

    expect(screen.getByRole("heading", { name: "智能服务" })).toBeInTheDocument();
    expect(screen.getByText("xAI 连接")).toBeInTheDocument();
    expect(screen.getByLabelText("转写服务")).toHaveValue("local");
    expect(screen.getByLabelText("摘要服务")).toHaveValue("agent");
    expect(screen.getByLabelText("对话服务")).toHaveValue("xai");
    expect(screen.getAllByTestId(/^provider-readiness-/)).toHaveLength(3);
    expect(screen.getByText(/2026-08-24.*grok-4.6/)).toBeInTheDocument();
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
});
