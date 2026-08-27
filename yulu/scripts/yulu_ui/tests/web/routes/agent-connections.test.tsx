import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { LanguageProvider } from "../../../web/src/i18n/LanguageProvider.js";

const mocks = vi.hoisted(() => ({
  probe: vi.fn(async () => ({ status: "ready" })),
  refresh: vi.fn(async () => ({})),
  select: vi.fn(async () => ({})),
  acceptDisclosure: vi.fn(async () => ({})),
  selectCredentialSource: vi.fn(async () => ({})),
  restoreDirectXai: vi.fn(async () => ({})),
  authorize: vi.fn(async () => ({})),
  cancelAuthorization: vi.fn(async () => ({})),
  logoutOAuth: vi.fn(async () => ({})),
  setApiKey: vi.fn(async () => ({})),
  clearApiKey: vi.fn(async () => ({})),
  deletionImpact: vi.fn(async () => ({
    connectionId: "direct-xai",
    selectedCapabilities: ["summary", "conversation"],
    pinnedTasks: [{ id: "task-1", recordingStem: "Planning_20260827_120000", title: "Planning", state: "queued", model: "grok-summary" }],
    pinnedConversations: [{ id: "session-1", title: "Launch plan", status: "active", model: "grok-conversation" }],
    removesRuntimeAuthorization: false,
    removesYuluManagedCredentials: true,
  })),
  remove: vi.fn(async () => ({})),
  view: {
    connections: [{
      id: "direct-xai",
      kind: "direct-provider",
      adapter: "direct-xai",
      label: "xAI",
      lifecycle: "connected",
      authorization: {
        connected: true,
        credentialSource: "oauth",
        oauthConnected: true,
        apiKeyConfigured: false,
        status: "idle",
        verificationUrl: "",
        userCode: "",
        message: "",
      },
      settings: { credentialSource: "oauth", summaryModel: "grok-summary", conversationModel: "grok-conversation" },
      capabilities: [
        {
          capability: "transcription",
          declared: true,
          selected: false,
          currentReadiness: { status: "untested", model: "speech-to-text", testedAt: null },
          readinessHistory: [],
          disclosure: { required: false, disclosureVersion: "xai-audio-v1", data: "recording_audio", destination: "xAI" },
          remediation: null,
        },
        {
          capability: "summary",
          declared: true,
          selected: true,
          currentReadiness: {
            status: "failed",
            model: "grok-summary",
            testedAt: "2026-08-27T12:00:00.000Z",
            detail: "summary · grok-summary failed; check account access and the exact model, then test again",
            reason: "invalid_model",
          },
          readinessHistory: [{ status: "ready", model: "grok-summary", testedAt: "2026-08-26T12:00:00.000Z" }],
          disclosure: { required: true, disclosureVersion: "xai-summary-v1", data: "transcript_text", destination: "xAI" },
          remediation: { href: "/agent-connections?connection=direct-xai&capability=summary" },
        },
        {
          capability: "conversation",
          declared: true,
          selected: true,
          currentReadiness: { status: "ready", model: "grok-conversation", testedAt: "2026-08-27T12:00:00.000Z" },
          readinessHistory: [],
          disclosure: { required: false, disclosureVersion: "xai-conversation-v1", data: "meeting_excerpt_text", destination: "xAI" },
          remediation: null,
        },
      ],
    }],
    candidates: [{
      id: "candidate:codex",
      kind: "supported-agent",
      adapter: "codex",
      label: "Codex",
      lifecycle: "candidate",
      source: "discovered",
      detectedPath: "/fake/bin/codex",
      capabilities: ["summary", "conversation"],
      selected: false,
      readiness: "untested",
      remediation: { href: "/agent-connections?candidate=candidate%3Acodex" },
    }],
    legacyConnections: [{
      id: "legacy-custom:migrated",
      kind: "legacy-custom",
      adapter: "legacy-command",
      label: "private-wrapper",
      lifecycle: "legacy",
      selected: false,
      capabilities: [],
      readiness: "unsupported",
      settings: { executable: "private-wrapper" },
      remediation: { href: "/agent-connections?legacy=legacy-custom%3Amigrated" },
    }],
    selections: {
      transcription: { connectionId: null, model: "local" },
      summary: { connectionId: "direct-xai", model: "grok-summary" },
      conversation: { connectionId: "direct-xai", model: "grok-conversation" },
    },
  },
}));

vi.mock("../../../web/src/trpc.js", () => {
  const mutation = (fn: ReturnType<typeof vi.fn>) => ({
    mutate: (input?: unknown) => { void (fn as (value?: unknown) => unknown)(input); },
    mutateAsync: (input?: unknown) => (fn as (value?: unknown) => Promise<unknown>)(input),
    isPending: false,
    error: null,
    variables: undefined,
  });
  return {
    trpc: {
      agentConnections: {
        view: { useQuery: () => ({ data: mocks.view, isPending: false, isError: false, refetch: vi.fn() }) },
        probe: { useMutation: () => mutation(mocks.probe) },
        refreshCandidates: { useMutation: () => mutation(mocks.refresh) },
        select: { useMutation: () => mutation(mocks.select) },
        acceptDisclosure: { useMutation: () => mutation(mocks.acceptDisclosure) },
        selectCredentialSource: { useMutation: () => mutation(mocks.selectCredentialSource) },
        restoreDirectXai: { useMutation: () => mutation(mocks.restoreDirectXai) },
        authorize: { useMutation: () => mutation(mocks.authorize) },
        cancelAuthorization: { useMutation: () => mutation(mocks.cancelAuthorization) },
        logoutOAuth: { useMutation: () => mutation(mocks.logoutOAuth) },
        setApiKey: { useMutation: () => mutation(mocks.setApiKey) },
        clearApiKey: { useMutation: () => mutation(mocks.clearApiKey) },
        deletionImpact: { useMutation: () => mutation(mocks.deletionImpact) },
        remove: { useMutation: () => mutation(mocks.remove) },
      },
      useUtils: () => ({ agentConnections: { view: { invalidate: vi.fn() } } }),
    },
  };
});

import { AgentConnections } from "../../../web/src/routes/agent-connections.js";

function mount(lang: "zh" | "en" = "zh") {
  localStorage.setItem("yulu_ui.lang", lang);
  return render(
    <MemoryRouter>
      <LanguageProvider>
        <AgentConnections />
      </LanguageProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

describe("shared Agent Connection Center", () => {
  it("opens without a probe and distinguishes candidates, legacy connections, current readiness, and history", () => {
    mount();

    expect(screen.getByRole("heading", { name: "Agent 连接中心" })).toBeInTheDocument();
    expect(screen.getByText("候选连接，不是已连接")).toBeInTheDocument();
    expect(screen.getByText("旧版自定义连接不能证明能力就绪")).toBeInTheDocument();
    const summary = screen.getByTestId("connection-capability-summary");
    expect(within(summary).getByText("需要修复")).toHaveAttribute("role", "alert");
    expect(within(summary).getByText("模型 grok-summary 不可用。请输入账户可访问的准确模型 ID，然后重新测试。")).toBeInTheDocument();
    expect(within(summary).getByText(/历史：已就绪/)).toBeInTheDocument();
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it("runs only the explicit capability action and previews deletion impact before confirmation", async () => {
    mount();
    const user = userEvent.setup();

    await user.click(within(screen.getByTestId("connection-capability-summary"))
      .getByRole("button", { name: "测试摘要" }));
    expect(mocks.probe).toHaveBeenCalledWith({ connectionId: "direct-xai", capability: "summary" });

    await user.clear(within(screen.getByTestId("connection-capability-summary"))
      .getByRole("textbox", { name: "摘要模型" }));
    await user.type(within(screen.getByTestId("connection-capability-summary"))
      .getByRole("textbox", { name: "摘要模型" }), "grok-summary-new");
    await user.click(within(screen.getByTestId("connection-capability-summary"))
      .getByRole("button", { name: "保存摘要选择" }));
    expect(mocks.select).toHaveBeenCalledWith({
      connectionId: "direct-xai",
      capability: "summary",
      model: "grok-summary-new",
    });

    await user.click(screen.getByRole("button", { name: "删除连接" }));
    const dialog = await screen.findByRole("dialog", { name: "删除 xAI 连接" });
    expect(dialog).toHaveFocus();
    expect(within(dialog).getByText(/Planning/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Launch plan/)).toBeInTheDocument();
    expect(mocks.remove).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "删除 xAI 连接" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "删除连接" })).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "删除连接" }));
    const reopenedDialog = await screen.findByRole("dialog", { name: "删除 xAI 连接" });
    await user.click(within(reopenedDialog).getByRole("button", { name: "确认删除" }));
    expect(mocks.remove).toHaveBeenCalledWith({ connectionId: "direct-xai", confirmed: true });
  });

  it("provides bilingual accessible status and exact repair guidance", () => {
    mount("en");

    expect(screen.getByRole("heading", { name: "Agent Connection Center" })).toBeInTheDocument();
    expect(screen.getByText("Connection candidate, not connected")).toBeInTheDocument();
    expect(screen.getByText(/Open this same center from Activation, Settings, or Agent Console/)).toBeInTheDocument();
    expect(screen.getByRole("status", { name: "xAI connection status" })).toHaveTextContent("Connected");
  });

  it("offers an explicit restore action after direct xAI is deleted", async () => {
    const saved = mocks.view.connections;
    mocks.view.connections = [];
    mount("en");
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "Restore direct xAI connection" }));
    expect(mocks.restoreDirectXai).toHaveBeenCalledOnce();
    mocks.view.connections = saved;
  });
});
