import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { LanguageProvider } from "../../../web/src/i18n/LanguageProvider.js";

const mocks = vi.hoisted(() => ({
  probe: vi.fn(async () => ({ status: "ready" })),
  refresh: vi.fn(async () => ({})),
  startNativeAuthorization: vi.fn(async () => ({ launched: true })),
  refreshNativeAuthorizationStatus: vi.fn(async () => ({
    connectionId: "candidate:codex",
    adapter: "codex",
    supported: true,
    authorized: true,
    runtimeVersion: "0.144.4",
    detail: "Codex native authorization is available",
  })),
  refetchView: vi.fn(async () => ({})),
  confirmCandidate: vi.fn(async () => ({})),
  select: vi.fn(async () => ({})),
  acceptDisclosure: vi.fn(async () => ({})),
  selectCredentialSource: vi.fn(async () => ({})),
  restoreDirectXai: vi.fn(async () => ({})),
  authorize: vi.fn(async () => ({})),
  cancelAuthorization: vi.fn(async () => ({})),
  logoutOAuth: vi.fn(async () => ({})),
  setApiKey: vi.fn(async () => ({})),
  clearApiKey: vi.fn(async () => ({})),
  deletionImpact: vi.fn(async ({ connectionId }: { connectionId: string }) => ({
    connectionId,
    selectedCapabilities: ["summary", "conversation"],
    pinnedTasks: [{ id: "task-1", recordingStem: "Planning_20260827_120000", title: "Planning", state: "queued", model: "grok-summary" }],
    pinnedConversations: [{ id: "session-1", title: "Launch plan", status: "active", model: "grok-conversation" }],
    removesRuntimeAuthorization: false,
    removesYuluManagedCredentials: connectionId === "direct-xai",
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
            credentialSource: "oauth",
            testedAt: "2026-08-27T12:00:00.000Z",
            detail: "summary · grok-summary failed; check account access and the exact model, then test again",
            reason: "invalid_model",
          },
          readinessHistory: [{ status: "ready", model: "grok-summary", testedAt: "2026-08-26T12:00:00.000Z" }],
          disclosure: { required: true, disclosureVersion: "xai-summary-v1", data: "transcript_text", destination: "xAI" },
          remediation: { href: "/settings/llm?connection=direct-xai&capability=summary" },
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
    }, {
      id: "codex",
      kind: "supported-agent",
      adapter: "codex",
      label: "Codex",
      lifecycle: "connected",
      authorization: {
        connected: true,
        credentialSource: "runtime-oauth",
        authorizationClass: "chatgpt",
        runtimeVersion: "0.144.4",
        minimumVersion: "0.144.0",
        supported: true,
        availableModels: ["gpt-5.6-sol"],
        features: ["account/read", "model/list", "thread/start", "thread/resume", "no-provider-model-fallback"],
        loginCommand: "/fake/bin/codex login",
        statusCommand: "/fake/bin/codex login status",
        remediation: null,
      },
      settings: {
        executablePath: "/fake/bin/codex",
        summaryModel: "gpt-5.6-sol",
        conversationModel: "gpt-5.6-sol",
      },
      capabilities: [{
        capability: "summary",
        declared: true,
        selected: false,
        currentReadiness: { status: "ready", model: "gpt-5.6-sol", testedAt: "2026-08-27T12:00:00.000Z" },
        readinessHistory: [],
        disclosure: {
          required: true,
          disclosureVersion: "codex-summary-v1",
          data: "transcript_text",
          destination: "Codex runtime and its configured model provider",
        },
        remediation: null,
      }, {
        capability: "conversation",
        declared: true,
        selected: false,
        currentReadiness: { status: "ready", model: "gpt-5.6-sol", testedAt: "2026-08-27T12:00:00.000Z" },
        readinessHistory: [],
        disclosure: {
          required: true,
          disclosureVersion: "codex-conversation-v1",
          data: "conversation_text_and_agent_tool_context",
          destination: "Codex runtime and its configured providers/connectors",
        },
        remediation: null,
      }],
    }, {
      id: "claude-code",
      kind: "supported-agent",
      adapter: "claude-code",
      label: "Claude Code",
      lifecycle: "connected",
      authorization: {
        connected: true,
        credentialSource: "runtime-oauth",
        authorizationClass: "claude-subscription",
        runtimeVersion: "2.1.169",
        minimumVersion: "2.1.169",
        supported: true,
        authorizationMethod: "claude.ai",
        apiProvider: "firstParty",
        availableModels: [],
        features: ["auth/status", "safe-mode", "print/stream-json", "verbose", "model", "session-id", "resume", "probe-single-result", "tools/none", "probe-isolation", "fallback-model/opt-in"],
        loginCommand: "/fake/bin/claude auth login",
        statusCommand: "/fake/bin/claude auth status",
        remediation: null,
      },
      settings: {
        executablePath: "/fake/bin/claude",
        summaryModel: "claude-sonnet-5",
        conversationModel: "claude-sonnet-5",
      },
      capabilities: [{
        capability: "summary",
        declared: false,
        selected: false,
        currentReadiness: {
          status: "failed",
          model: "claude-sonnet-5",
          testedAt: null,
          detail: "Claude Code cannot currently prove policy-managed hooks are disabled; Summary remains unavailable",
          reason: "readiness_failed",
        },
        readinessHistory: [],
        disclosure: {
          required: true,
          disclosureVersion: "claude-code-summary-v1",
          data: "transcript_text",
          destination: "Claude Code runtime and its configured model provider",
        },
        remediation: { href: "/settings/llm?connection=claude-code&capability=summary" },
      }, {
        capability: "conversation",
        declared: true,
        selected: false,
        currentReadiness: { status: "ready", model: "claude-sonnet-5", testedAt: "2026-08-27T12:00:00.000Z" },
        readinessHistory: [],
        disclosure: {
          required: true,
          disclosureVersion: "claude-code-conversation-v1",
          data: "conversation_text_and_agent_tool_context",
          destination: "Claude Code runtime and its configured model/tools",
        },
        remediation: null,
      }],
    }, {
      id: "hermes",
      kind: "supported-agent",
      adapter: "hermes",
      label: "Hermes",
      lifecycle: "connected",
      authorization: {
        connected: true,
        credentialSource: "runtime-oauth",
        runtimeVersion: "0.20.0",
        minimumVersion: "0.20.0",
        supported: true,
        provider: "xai",
        model: "grok-4.6",
        availableModels: [],
        features: ["status", "model", "query", "resume", "session-id", "probe-bounds", "no-fallback"],
        loginCommand: "/fake/bin/hermes model",
        statusCommand: "/fake/bin/hermes status",
        remediation: null,
      },
      settings: { executablePath: "/fake/bin/hermes", conversationModel: "grok-4.6" },
      capabilities: [{
        capability: "conversation",
        declared: true,
        selected: false,
        currentReadiness: { status: "ready", model: "grok-4.6", testedAt: "2026-08-28T12:00:00.000Z" },
        readinessHistory: [],
        disclosure: {
          required: true,
          disclosureVersion: "hermes-conversation-v1",
          data: "conversation_text_and_agent_tool_context",
          destination: "Hermes runtime and its configured model/tools/connectors",
        },
        remediation: null,
      }],
      summaryUnsupported: "Hermes is Conversation-only because its stable interface cannot prove a tool-free background Summary invocation",
    }, {
      id: "openclaw",
      kind: "supported-agent",
      adapter: "openclaw",
      label: "OpenClaw",
      lifecycle: "connected",
      authorization: {
        connected: true,
        credentialSource: "runtime-oauth",
        runtimeVersion: "2026.5.12",
        minimumVersion: "2026.5.12",
        supported: true,
        provider: "openai-codex",
        model: "openai-codex/gpt-5.5",
        availableModels: [],
        features: ["models/status-json", "model", "message", "session-id", "json", "probe-bounds", "no-fallback"],
        loginCommand: "/fake/bin/openclaw configure",
        statusCommand: "/fake/bin/openclaw models status --json --check",
        remediation: null,
      },
      settings: { executablePath: "/fake/bin/openclaw", conversationModel: "openai-codex/gpt-5.5" },
      capabilities: [{
        capability: "conversation",
        declared: true,
        selected: false,
        currentReadiness: { status: "ready", model: "openai-codex/gpt-5.5", testedAt: "2026-08-28T12:00:00.000Z" },
        readinessHistory: [],
        disclosure: {
          required: true,
          disclosureVersion: "openclaw-conversation-v1",
          data: "conversation_text_and_agent_tool_context",
          destination: "OpenClaw runtime and its configured model/tools/connectors",
        },
        remediation: null,
      }],
      summaryUnsupported: "OpenClaw is Conversation-only because its stable interface cannot prove a tool-free background Summary invocation",
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
      remediation: { href: "/settings/llm?candidate=candidate%3Acodex" },
    }, {
      id: "candidate:claude-code",
      kind: "supported-agent",
      adapter: "claude-code",
      label: "Claude Code",
      lifecycle: "candidate",
      source: "discovered",
      detectedPath: "/fake/bin/claude",
      capabilities: ["summary", "conversation"],
      selected: false,
      readiness: "untested",
      remediation: { href: "/settings/llm?candidate=candidate%3Aclaude-code" },
    }, {
      id: "candidate:hermes",
      kind: "supported-agent",
      adapter: "hermes",
      label: "Hermes",
      lifecycle: "candidate",
      source: "discovered",
      detectedPath: "/fake/bin/hermes",
      capabilities: ["conversation"],
      selected: false,
      readiness: "untested",
      remediation: { href: "/settings/llm?candidate=candidate%3Ahermes" },
    }, {
      id: "candidate:openclaw",
      kind: "supported-agent",
      adapter: "openclaw",
      label: "OpenClaw",
      lifecycle: "candidate",
      source: "discovered",
      detectedPath: "/fake/bin/openclaw",
      capabilities: ["conversation"],
      selected: false,
      readiness: "untested",
      remediation: { href: "/settings/llm?candidate=candidate%3Aopenclaw" },
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
      remediation: { href: "/settings/llm?legacy=legacy-custom%3Amigrated" },
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
        view: { useQuery: () => ({ data: mocks.view, isPending: false, isError: false, refetch: mocks.refetchView }) },
        probe: { useMutation: () => mutation(mocks.probe) },
        refreshCandidates: { useMutation: () => mutation(mocks.refresh) },
        startNativeAuthorization: { useMutation: () => mutation(mocks.startNativeAuthorization) },
        refreshNativeAuthorizationStatus: { useMutation: () => mutation(mocks.refreshNativeAuthorizationStatus) },
        confirmCandidate: { useMutation: () => mutation(mocks.confirmCandidate) },
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

import {
  AgentConnections,
  LegacyAgentConnectionsRedirect,
} from "../../../web/src/routes/agent-connections.js";

function LocationProbe() {
  const location = useLocation();
  return <output>{`${location.pathname}${location.search}`}</output>;
}

function mount(lang: "zh" | "en" = "zh", initialEntry = "/settings/llm") {
  localStorage.setItem("yulu_ui.lang", lang);
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <LanguageProvider>
        <AgentConnections />
      </LanguageProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  const claude = mocks.view.connections.find((connection) => connection.id === "claude-code");
  if (claude) claude.settings.summaryModel = "claude-sonnet-5";
});

describe("shared Agent Connection Center", () => {
  it("preserves exact remediation parameters when redirecting the legacy center path", async () => {
    render(
      <MemoryRouter initialEntries={["/agent-connections?connection=codex&capability=summary"]}>
        <Routes>
          <Route path="/agent-connections" element={<LegacyAgentConnectionsRedirect />} />
          <Route path="/settings/llm" element={<LocationProbe />} />
        </Routes>
      </MemoryRouter>,
    );

    expect(await screen.findByText("/settings/llm?connection=codex&capability=summary"))
      .toBeInTheDocument();
  });

  it("focuses the exact connection capability from a remediation deep link without probing", async () => {
    mount("en", "/settings/llm?connection=codex&capability=summary");

    const target = screen.getByTestId("connection-capability-codex-summary");
    await vi.waitFor(() => expect(target).toHaveFocus());
    expect(target).toHaveAttribute("aria-current", "location");
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it("focuses and names an exact connection-only remediation target without probing", async () => {
    mount("en", "/settings/llm?connection=codex");

    const target = screen.getByTestId("agent-connection-codex");
    await vi.waitFor(() => expect(target).toHaveFocus());
    expect(target).toHaveAttribute("aria-current", "location");
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it("keeps a deleted pinned connection deep link actionable with a focused tombstone", async () => {
    const saved = mocks.view.connections;
    mocks.view.connections = saved.filter((connection) => connection.id !== "codex");
    mount("en", "/settings/llm?connection=codex&capability=summary");

    const target = screen.getByTestId("missing-remediation-connection");
    await vi.waitFor(() => expect(target).toHaveFocus());
    expect(target).toHaveAttribute("id", "agent-connection-codex-summary");
    expect(target).toHaveAttribute("aria-current", "location");
    expect(target).toHaveTextContent("codex");
    expect(target).toHaveTextContent("Summary");
    expect(target).toHaveTextContent("Existing pinned work stays pinned");
    expect(mocks.probe).not.toHaveBeenCalled();

    const user = userEvent.setup();
    await user.click(within(target).getByRole("button", { name: "Scan installed runtimes" }));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    mocks.view.connections = saved;
  });

  it("opens without a probe and distinguishes candidates, legacy connections, current readiness, and history", () => {
    mount();

    expect(screen.getByRole("heading", { name: "Agent 连接中心" })).toBeInTheDocument();
    expect(screen.getAllByText("候选连接，不是已连接")).toHaveLength(4);
    expect(screen.getByText("旧版自定义连接不能证明能力就绪")).toBeInTheDocument();
    const summary = screen.getByTestId("connection-capability-summary");
    expect(within(summary).getByText("需要修复")).toHaveAttribute("role", "alert");
    expect(within(summary).getByText(
      "所选 Grok OAuth 无法使用模型 grok-summary。请输入账户有权限的准确模型 ID 后重试；在你明确修改前，Yulu 会保留当前来源和模型。",
    )).toBeInTheDocument();
    expect(within(summary).getByText(/历史：已就绪/)).toBeInTheDocument();
    const codex = screen.getByTestId("agent-connection-codex");
    expect(within(codex).getByText("/fake/bin/codex login")).toBeInTheDocument();
    expect(within(codex).getByText(/0.144.4/)).toBeInTheDocument();
    expect(mocks.probe).not.toHaveBeenCalled();
    expect(mocks.confirmCandidate).not.toHaveBeenCalled();
  });

  it("guides installation or location without treating any runtime as selected", () => {
    mount("en");

    const guidance = screen.getByTestId("agent-runtime-install-guidance");
    expect(within(guidance).getByRole("heading", { name: "Install or locate a runtime" }))
      .toBeInTheDocument();
    expect(within(guidance).getByText(/Codex.*codex executable.*Yulu Host PATH/i)).toBeInTheDocument();
    expect(within(guidance).getByText(/Claude Code.*claude executable.*Yulu Host PATH/i)).toBeInTheDocument();
    expect(within(guidance).getByText(/Hermes.*hermes executable.*Yulu Host PATH/i)).toBeInTheDocument();
    expect(within(guidance).getByText(/OpenClaw.*openclaw executable.*Yulu Host PATH/i)).toBeInTheDocument();
    expect(mocks.confirmCandidate).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();
  });

  it("launches candidate native login and lets the user refresh status after returning", async () => {
    mount("en");
    const user = userEvent.setup();
    const candidate = screen.getByTestId("agent-candidate-codex");

    await user.click(within(candidate).getByRole("button", { name: "Open Codex native login" }));
    expect(mocks.startNativeAuthorization).toHaveBeenCalledWith({
      connectionId: "candidate:codex",
    });
    expect(mocks.confirmCandidate).not.toHaveBeenCalled();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.probe).not.toHaveBeenCalled();

    await user.click(within(candidate).getByRole("button", { name: "Refresh status after returning" }));
    expect(mocks.refreshNativeAuthorizationStatus).toHaveBeenCalledWith({
      connectionId: "candidate:codex",
    });
    expect(mocks.refetchView).toHaveBeenCalledOnce();
    expect(within(candidate).getByRole("status")).toHaveTextContent(
      "Codex native authorization is available",
    );
  });

  it("shows versioned xAI consent and disclosures separately from authorization before enabling probes", () => {
    const direct = mocks.view.connections.find((connection) => connection.id === "direct-xai")!;
    const previous = direct.capabilities.map((capability) => ({
      disclosure: { ...capability.disclosure },
    }));
    for (const capability of direct.capabilities) capability.disclosure.required = true;

    mount("en");

    const transcription = screen.getByTestId("connection-capability-transcription");
    expect(within(transcription).getByText("Cloud Transcription Consent · xai-audio-v1"))
      .toBeInTheDocument();
    expect(within(transcription).getByRole("button", { name: "Test transcription" })).toBeDisabled();
    const summary = screen.getByTestId("connection-capability-summary");
    expect(within(summary).getByText("Summary Data Path Disclosure · xai-summary-v1"))
      .toBeInTheDocument();
    expect(within(summary).getByRole("button", { name: "Test summary" })).toBeDisabled();
    const conversation = screen.getByTestId("connection-capability-conversation");
    expect(within(conversation).getByText("Conversation Data Path Disclosure · xai-conversation-v1"))
      .toBeInTheDocument();
    expect(within(conversation).getByRole("button", { name: "Test conversation" })).toBeDisabled();
    expect(within(screen.getByRole("heading", { name: "xAI" }).closest("section")!)
      .getByRole("button", { name: "Reconnect Grok OAuth" })).toBeEnabled();
    expect(mocks.probe).not.toHaveBeenCalled();

    direct.capabilities.forEach((capability, index) => {
      capability.disclosure = previous[index]!.disclosure;
    });
  });

  it("stores an API key separately from explicitly selecting it as the xAI Credential Source", async () => {
    mount("en");
    const user = userEvent.setup();
    const xai = screen.getByRole("heading", { name: "xAI" }).closest("section")!;
    expect(within(xai).getByText(
      "Write-only and stored in macOS Keychain. Saving does not select it; Yulu never shows it again or silently falls back to it.",
    )).toBeInTheDocument();

    await user.type(within(xai).getByLabelText("xAI API Key alternative"), "submitted-once");
    await user.click(within(xai).getByRole("button", { name: "Save API Key" }));

    expect(mocks.setApiKey).toHaveBeenCalledWith({ apiKey: "submitted-once" });
    expect(mocks.selectCredentialSource).not.toHaveBeenCalled();

    await user.click(within(xai).getByRole("radio", { name: "Yulu-managed API Key" }));
    expect(mocks.selectCredentialSource).toHaveBeenCalledWith({
      connectionId: "direct-xai",
      credentialSource: "api-key",
    });
  });

  it("shows exact source-and-model-preserving remediation for xAI entitlement failure", () => {
    const direct = mocks.view.connections.find((connection) => connection.id === "direct-xai")!;
    const summary = direct.capabilities.find((capability) => capability.capability === "summary")!;
    const original = { ...summary.currentReadiness };
    Object.assign(summary.currentReadiness, {
      reason: "entitlement_failed",
      credentialSource: "oauth",
    });

    mount("en");

    expect(within(screen.getByTestId("connection-capability-summary")).getByText(
      "Selected Grok OAuth is not entitled to grok-summary. Verify xAI account access or explicitly choose another Credential Source, then test again; Yulu did not switch either value.",
    )).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Grok OAuth" })).toBeChecked();
    expect(screen.getByRole("textbox", { name: "Summary model" })).toHaveValue("grok-summary");

    summary.currentReadiness = original;
  });

  it("gives capability-specific Transcription repair and no nonexistent session for xAI unknown outcomes", () => {
    const direct = mocks.view.connections.find((connection) => connection.id === "direct-xai")!;
    const transcription = direct.capabilities.find((capability) => capability.capability === "transcription")!;
    const summary = direct.capabilities.find((capability) => capability.capability === "summary")!;
    const originalTranscription = { ...transcription.currentReadiness };
    const originalSummary = { ...summary.currentReadiness };
    Object.assign(transcription.currentReadiness, {
      status: "failed",
      reason: "readiness_failed",
      credentialSource: "oauth",
    });
    Object.assign(summary.currentReadiness, {
      status: "failed",
      reason: "unknown_outcome",
      credentialSource: "oauth",
    });

    mount("en");

    expect(within(screen.getByTestId("connection-capability-transcription")).getByText(
      "The realtime Transcription WebSocket probe failed with selected Grok OAuth. Verify that source and xAI realtime STT availability, then test again; Yulu did not switch the source or model.",
    )).toBeInTheDocument();
    const unknown = within(screen.getByTestId("connection-capability-summary")).getByText(
      "The grok-summary probe outcome with selected Grok OAuth is unknown. Yulu did not retry or switch. Check xAI service status and account activity, then explicitly test the same source and model again.",
    );
    expect(unknown).toBeInTheDocument();
    expect(unknown).not.toHaveTextContent(/native session/i);

    transcription.currentReadiness = originalTranscription;
    summary.currentReadiness = originalSummary;
  });

  it("shows a non-secret OAuth class mismatch and disables stale Codex readiness actions", () => {
    const codex = mocks.view.connections.find((connection) => connection.id === "codex");
    expect(codex).toBeDefined();
    const originalAuthorization = { ...codex!.authorization };
    const remediation =
      "Codex API-key authorization cannot be used as Runtime-owned OAuth; run /fake/bin/codex login without --with-api-key to complete ChatGPT OAuth, then refresh this connection";
    Object.assign(codex!.authorization, {
      connected: false,
      authorizationClass: "api-key",
      remediation,
    });

    mount("en");

    const card = screen.getByTestId("agent-connection-codex");
    expect(within(card).getByText("API key (not Runtime-owned OAuth)")).toBeInTheDocument();
    expect(within(card).getByText(remediation).parentElement).toHaveAttribute("role", "alert");
    expect(within(card).getByRole("button", { name: "Select Codex for future summaries" })).toBeDisabled();
    expect(within(card).getByRole("button", { name: "Test summary" })).toBeDisabled();

    Object.assign(codex!.authorization, originalAuthorization);
  });

  it("explicitly confirms a Codex candidate, accepts only Conversation disclosure, probes, and selects", async () => {
    mount("en");
    const user = userEvent.setup();
    const candidate = screen.getByTestId("agent-candidate-codex");

    await user.clear(within(candidate).getByRole("textbox", { name: "Codex initial Summary and Conversation model" }));
    await user.type(within(candidate).getByRole("textbox", { name: "Codex initial Summary and Conversation model" }), "gpt-5.6-sol");
    await user.click(within(candidate).getByRole("button", { name: "Connect Codex runtime" }));
    expect(mocks.confirmCandidate).toHaveBeenCalledWith({
      candidateId: "candidate:codex",
      model: "gpt-5.6-sol",
    });

    const codex = screen.getByTestId("agent-connection-codex");
    await user.click(within(codex).getByRole("button", { name: "Accept Conversation Data Path Disclosure" }));
    expect(mocks.acceptDisclosure).toHaveBeenCalledWith({ connectionId: "codex", capability: "conversation" });
    await user.click(within(codex).getByRole("button", { name: "Test conversation" }));
    expect(mocks.probe).toHaveBeenCalledWith({
      connectionId: "codex",
      capability: "conversation",
      model: "gpt-5.6-sol",
    });
    await user.click(within(codex).getByRole("button", { name: "Select Codex for future conversations" }));
    expect(mocks.select).toHaveBeenCalledWith({
      connectionId: "codex",
      capability: "conversation",
      model: "gpt-5.6-sol",
    });
  });

  it("renders and routes Codex Summary independently from Conversation", async () => {
    mount("en");
    const user = userEvent.setup();
    const summary = screen.getByTestId("connection-capability-codex-summary");
    const conversation = screen.getByTestId("connection-capability-codex-conversation");

    expect(within(summary).getByRole("heading", { name: "Summary" })).toBeInTheDocument();
    expect(within(conversation).getByRole("heading", { name: "Conversation" })).toBeInTheDocument();
    await user.click(within(summary).getByRole("button", { name: "Accept Summary Data Path Disclosure" }));
    expect(mocks.acceptDisclosure).toHaveBeenCalledWith({ connectionId: "codex", capability: "summary" });
    await user.click(within(summary).getByRole("button", { name: "Test summary" }));
    expect(mocks.probe).toHaveBeenCalledWith({
      connectionId: "codex",
      capability: "summary",
      model: "gpt-5.6-sol",
    });
    await user.click(within(summary).getByRole("button", { name: "Select Codex for future summaries" }));
    expect(mocks.select).toHaveBeenCalledWith({
      connectionId: "codex",
      capability: "summary",
      model: "gpt-5.6-sol",
    });
  });

  it("connects Claude Code and routes Summary independently from Conversation", async () => {
    mount("en");
    const user = userEvent.setup();
    const candidate = screen.getByTestId("agent-candidate-claude-code");

    await user.clear(within(candidate).getByRole("textbox", { name: "Claude Code initial Summary and Conversation model" }));
    await user.type(within(candidate).getByRole("textbox", { name: "Claude Code initial Summary and Conversation model" }), "claude-sonnet-5");
    await user.click(within(candidate).getByRole("button", { name: "Connect Claude Code runtime" }));
    expect(mocks.confirmCandidate).toHaveBeenCalledWith({
      candidateId: "candidate:claude-code",
      model: "claude-sonnet-5",
    });

    const claude = screen.getByTestId("agent-connection-claude-code");
    expect(within(claude).getByText("/fake/bin/claude auth login")).toBeInTheDocument();
    const summary = within(claude).getByTestId("connection-capability-claude-code-summary");
    const conversation = within(claude).getByTestId("connection-capability-claude-code-conversation");
    expect(within(summary).getByText(/policy-managed hooks.*Summary remains unavailable/)).toBeInTheDocument();
    await user.click(within(summary).getByRole("button", { name: "Accept Claude Code Summary Data Path Disclosure" }));
    expect(mocks.acceptDisclosure).toHaveBeenCalledWith({ connectionId: "claude-code", capability: "summary" });
    await user.click(within(summary).getByRole("button", { name: "Test summary" }));
    expect(mocks.probe).toHaveBeenCalledWith({
      connectionId: "claude-code",
      capability: "summary",
      model: "claude-sonnet-5",
    });
    expect(within(summary).getByRole("button", { name: "Select Claude Code for future summaries" })).toBeDisabled();
    await user.click(within(conversation).getByRole("button", { name: "Accept Claude Code Conversation Data Path Disclosure" }));
    expect(mocks.acceptDisclosure).toHaveBeenCalledWith({ connectionId: "claude-code", capability: "conversation" });
    await user.click(within(conversation).getByRole("button", { name: "Test conversation" }));
    expect(mocks.probe).toHaveBeenCalledWith({
      connectionId: "claude-code",
      capability: "conversation",
      model: "claude-sonnet-5",
    });
    await user.click(within(conversation).getByRole("button", { name: "Select Claude Code for future conversations" }));
    expect(mocks.select).toHaveBeenCalledWith({
      connectionId: "claude-code",
      capability: "conversation",
      model: "claude-sonnet-5",
    });
  });

  it.each([
    ["hermes", "Hermes", "grok-4.6"],
    ["openclaw", "OpenClaw", "openai-codex/gpt-5.5"],
  ] as const)("connects %s as Conversation-only with runtime-owned authorization", async (adapter, label, model) => {
    mount("en");
    const user = userEvent.setup();
    const candidate = screen.getByTestId(`agent-candidate-${adapter}`);

    await user.clear(within(candidate).getByRole("textbox", { name: `${label} Conversation model` }));
    await user.type(within(candidate).getByRole("textbox", { name: `${label} Conversation model` }), model);
    await user.click(within(candidate).getByRole("button", { name: `Connect ${label} runtime` }));
    expect(mocks.confirmCandidate).toHaveBeenCalledWith({ candidateId: `candidate:${adapter}`, model });

    const card = screen.getByTestId(`agent-connection-${adapter}`);
    expect(within(card).queryByRole("heading", { name: "Summary" })).not.toBeInTheDocument();
    expect(within(card).getByText(/Conversation-only.*tool-free background Summary/)).toBeInTheDocument();
    expect(within(card).getByText(/never reads or copies.*credentials/i)).toBeInTheDocument();
    const conversation = within(card).getByTestId(`connection-capability-${adapter}-conversation`);
    expect(within(conversation).getByRole("button", { name: "Test conversation" })).toBeDisabled();
    await user.click(within(conversation).getByRole("button", { name: `Accept ${label} Conversation Data Path Disclosure` }));
    expect(mocks.acceptDisclosure).toHaveBeenCalledWith({ connectionId: adapter, capability: "conversation" });
    expect(within(conversation).getByRole("button", { name: "Test conversation" })).toBeEnabled();
    await user.click(within(conversation).getByRole("button", { name: "Test conversation" }));
    expect(mocks.probe).toHaveBeenCalledWith({ connectionId: adapter, capability: "conversation", model });
    await user.click(within(conversation).getByRole("button", { name: `Select ${label} for future conversations` }));
    expect(mocks.select).toHaveBeenCalledWith({ connectionId: adapter, capability: "conversation", model });

    await user.click(within(card).getByRole("button", { name: "Delete connection" }));
    expect(mocks.deletionImpact).toHaveBeenCalledWith({ connectionId: adapter });
    const dialog = await screen.findByRole("dialog", { name: `Delete ${label} connection` });
    expect(within(dialog).getByText(/native OAuth login and runtime configuration remain unchanged/i)).toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Confirm deletion" }));
    expect(mocks.remove).toHaveBeenCalledWith({ connectionId: adapter, confirmed: true });
    expect(within(conversation).getByRole("button", { name: `Accept ${label} Conversation Data Path Disclosure` }))
      .toBeInTheDocument();
    expect(within(conversation).getByRole("button", { name: "Test conversation" })).toBeDisabled();
  });

  it.each([
    ["en", "The action did not complete: Codex exact model access denied"],
    ["zh", "操作未完成：Codex exact model access denied"],
  ] as const)("shows an exact localized mutation failure in %s", async (lang, expected) => {
    mocks.probe.mockRejectedValueOnce(new Error("Codex exact model access denied"));
    mount(lang);
    const user = userEvent.setup();
    const summary = screen.getByTestId("connection-capability-codex-summary");

    await user.click(within(summary).getByRole("button", {
      name: lang === "en" ? "Accept Summary Data Path Disclosure" : "接受摘要数据路径说明",
    }));
    await user.click(within(summary)
      .getByRole("button", { name: lang === "en" ? "Test summary" : "测试摘要" }));

    expect(await screen.findByText(expected)).toHaveAttribute("role", "alert");
  });

  it("deletes a connected Codex record through the same impact-confirmation path", async () => {
    mount("en");
    const user = userEvent.setup();
    const card = screen.getByTestId("agent-connection-codex");

    await user.click(within(card).getByRole("button", { name: "Delete connection" }));
    expect(mocks.deletionImpact).toHaveBeenCalledWith({ connectionId: "codex" });
    const dialog = await screen.findByRole("dialog", { name: "Delete Codex connection" });
    expect(within(dialog).getByText(/native OAuth login and runtime configuration remain unchanged/i))
      .toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Confirm deletion" }));
    expect(mocks.remove).toHaveBeenCalledWith({ connectionId: "codex", confirmed: true });
  });

  it("migrates a #136 Conversation-only Claude connection without declaring Summary ready", () => {
    const claude = mocks.view.connections.find((connection) => connection.id === "claude-code");
    expect(claude).toBeDefined();
    (claude!.settings as { summaryModel?: string }).summaryModel = undefined;

    mount("en");

    const card = screen.getByTestId("agent-connection-claude-code");
    const summary = within(card).getByTestId("connection-capability-claude-code-summary");
    const conversation = within(card).getByTestId("connection-capability-claude-code-conversation");
    expect(within(summary).getByRole("textbox", { name: "Claude Code Summary model" }))
      .toHaveValue("claude-sonnet-5");
    expect(within(summary).getByText(/policy-managed hooks.*Summary remains unavailable/)).toBeInTheDocument();
    expect(within(summary).getByRole("button", { name: "Select Claude Code for future summaries" })).toBeDisabled();
    expect(within(conversation).getByRole("button", { name: "Select Claude Code for future conversations" }))
      .toBeEnabled();
  });

  it("runs only the explicit capability action and previews deletion impact before confirmation", async () => {
    const direct = mocks.view.connections.find((connection) => connection.id === "direct-xai")!;
    const summary = direct.capabilities.find((capability) => capability.capability === "summary")!;
    const disclosureRequired = summary.disclosure.required;
    summary.disclosure.required = false;
    mount();
    const user = userEvent.setup();
    const xaiCard = screen.getByRole("heading", { name: "xAI" }).closest("section")!;

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

    await user.click(within(xaiCard).getByRole("button", { name: "删除连接" }));
    const dialog = await screen.findByRole("dialog", { name: "删除 xAI 连接" });
    expect(dialog).toHaveFocus();
    expect(within(dialog).getByText(/Planning/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Launch plan/)).toBeInTheDocument();
    expect(mocks.remove).not.toHaveBeenCalled();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "删除 xAI 连接" })).not.toBeInTheDocument();
    expect(within(xaiCard).getByRole("button", { name: "删除连接" })).toHaveFocus();
    await user.click(within(xaiCard).getByRole("button", { name: "删除连接" }));
    const reopenedDialog = await screen.findByRole("dialog", { name: "删除 xAI 连接" });
    await user.click(within(reopenedDialog).getByRole("button", { name: "确认删除" }));
    expect(mocks.remove).toHaveBeenCalledWith({ connectionId: "direct-xai", confirmed: true });
    summary.disclosure.required = disclosureRequired;
  });

  it("provides bilingual accessible status and exact repair guidance", () => {
    mount("en");

    expect(screen.getByRole("heading", { name: "Agent Connection Center" })).toBeInTheDocument();
    expect(screen.getAllByText("Connection candidate, not connected")).toHaveLength(4);
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
