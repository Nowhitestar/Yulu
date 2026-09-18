import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const navigateMock = vi.fn();
const reprocessMutate = vi.fn();
const connectAgentMutate = vi.fn();
const configurePluginMutate = vi.fn();
const setDestinationMutate = vi.fn();
const refreshDestinationMutate = vi.fn();
const detectRefetch = vi.fn();
const askMutateAsync = vi.fn();
const createSessionMutateAsync = vi.fn();
const appendSessionMutateAsync = vi.fn();
const renameSessionMutateAsync = vi.fn();
const deleteSessionMutateAsync = vi.fn();
const pinSessionMutateAsync = vi.fn();
const archiveSessionMutateAsync = vi.fn();
const resumeSessionMutateAsync = vi.fn();
let sessionListInputs: unknown[] = [];
let mockSessions: Array<Record<string, unknown>> = [];
let mockSelectedSession: Record<string, unknown> | null = null;
let mockZulipConfigured = false;
let mockCalendars: Array<Record<string, unknown>> = [];
let mockTasks: Array<Record<string, unknown>> = [];
let mockDurableTasks: Array<Record<string, unknown>> = [];
let mockConversationSelection: Record<string, unknown> = { provider: "agent", model: "runtime-managed" };

function taskFixture(overrides: Record<string, unknown> = {}) {
  const stages = overrides.stages as Record<string, unknown> | undefined;
  return {
    id: "ProductSync_20260625_093000",
    stem: "ProductSync_20260625_093000",
    title: "Product Sync",
    recordedAt: "2026-06-25T09:30:00",
    dayLabel: "today",
    stages: { record: "done", transcribe: "done", summarize: "done", send: "idle", ...stages },
    dest: null,
    error: "",
    hasTranscript: true,
    hasSummary: true,
    ...overrides,
  };
}

function pluginFixture() {
  const all = [
    { id: "summary", label: "总结", added: true, core: true, status: "configured", statusLabel: "已配置", resolvedPath: "", detail: "摘要由当前 Agent 执行", configureLabel: "已配置", agent: "codex" },
    { id: "notion", label: "Notion", added: true, core: false, status: "configured", statusLabel: "已配置", resolvedPath: "/agent/notion", detail: "/agent/notion", configureLabel: "已配置", agent: "codex", destination: { channel: "notion", label: "Notion", value: "Yulu Meeting", configured: true, missingReason: "", notion: { target: "Yulu Meeting" } } },
    { id: "zulip", label: "Zulip", added: true, core: false, status: mockZulipConfigured ? "configured" : "unconfigured", statusLabel: mockZulipConfigured ? "已配置" : "未配置", resolvedPath: mockZulipConfigured ? "/agent/zulip" : "", detail: mockZulipConfigured ? "/agent/zulip" : "Codex CLI 尚未配置 Zulip 插件", configureLabel: mockZulipConfigured ? "已配置" : "去配置", agent: "codex", destination: { channel: "zulip", label: "Zulip", value: mockZulipConfigured ? "meetings / weekly" : "选择 Channel 和 Topic", configured: mockZulipConfigured, missingReason: mockZulipConfigured ? "" : "请选择 Zulip Channel 和 Topic", zulip: { stream: mockZulipConfigured ? "meetings" : "", topic: mockZulipConfigured ? "weekly" : "" } } },
    { id: "calendar", label: "日历", added: true, core: false, status: "configured", statusLabel: "已配置", resolvedPath: "/agent/calendar", detail: "/agent/calendar", configureLabel: "已配置", agent: "codex" },
  ];
  return { agent: "codex", current: all, available: [], all };
}

vi.mock("react-router", async (orig) => {
  const actual = await orig<typeof import("react-router")>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("../../../web/src/ws.js", () => ({
  useWsChannel: () => {},
}));

vi.mock("../../../web/src/trpc.js", () => {
  const mutation = (fn = vi.fn()) => ({ mutate: fn, mutateAsync: vi.fn(), isPending: false });
  const utils = new Proxy({}, {
    get() {
      return new Proxy({}, {
        get() {
          return { invalidate: vi.fn(() => Promise.resolve()) };
        },
      });
    },
  });
  return {
    trpc: {
      useUtils: () => utils,
      agentConsole: {
        meetings: { useQuery: () => ({ data: mockTasks, isPending: false }) },
        overview: {
          useQuery: () => ({
            data: {
              recording: { state: "idle", hotkey: "?" },
              recordingAgent: { available: true, provider: "local", reason: null, paused: false, policyReason: null },
              agents: [
                { id: "codex", name: "Codex CLI", command: "codex", found: true, path: "/opt/homebrew/bin/codex", supported: true, connected: true, unavailableReason: "", runtimePreview: "codex exec" },
                { id: "claude", name: "Claude Code", command: "claude", found: true, path: "/usr/local/bin/claude", supported: true, connected: false, unavailableReason: "", runtimePreview: "" },
                { id: "hermes", name: "Hermes", command: "hermes", found: true, path: "/Users/test/.local/bin/hermes", supported: true, connected: false, unavailableReason: "", runtimePreview: "" },
                { id: "openclaw", name: "OpenClaw", command: "openclaw", found: false, path: "", supported: true, connected: false, unavailableReason: "", runtimePreview: "" },
              ],
              plugins: pluginFixture(),
              tasks: mockTasks,
            },
            isPending: false,
            isFetching: false,
            refetch: vi.fn(() => Promise.resolve({ data: null })),
          }),
        },
        detectAgents: {
          useQuery: () => ({
            data: null,
            isFetching: false,
            refetch: detectRefetch,
          }),
        },
        connectAgent: { useMutation: () => ({ mutate: connectAgentMutate, isPending: false }) },
        addPlugin: { useMutation: () => mutation() },
        removePlugin: { useMutation: () => mutation() },
        configurePlugin: {
          useMutation: (options: { onSuccess?: (result: Record<string, unknown>) => void }) => ({
            mutate: (input: { plugin: string }) => {
              configurePluginMutate(input);
              options.onSuccess?.({
                ok: true,
                agent: "codex",
                plugin: input.plugin,
                label: input.plugin === "notion" ? "Notion" : input.plugin === "zulip" ? "Zulip" : "日历",
                agentCli: "codex",
                manageCommand: "codex mcp",
                message: "请在 Codex CLI 的 MCP 管理器中完成配置。",
              });
            },
            isPending: false,
          }),
        },
        setDestination: { useMutation: () => mutation(setDestinationMutate) },
        destinationOptions: {
          useQuery: (input: { channel: "notion" | "zulip" }) => ({
            data: input.channel === "zulip" ? {
              agent: "codex",
              channel: "zulip",
              options: [
                { id: "zulip:meetings:weekly", label: "meetings / weekly", value: "meetings / weekly", stream: "meetings", topic: "weekly", source: "saved" },
                { id: "zulip:product:launch", label: "product / launch", value: "product / launch", stream: "product", topic: "launch", source: "agent" },
              ],
            } : {
              agent: "codex",
              channel: "notion",
              options: [
                { id: "notion:Yulu Meeting", label: "Yulu Meeting", value: "Yulu Meeting", target: "Yulu Meeting", source: "saved" },
                { id: "notion:Product DB", label: "Product DB", value: "Product DB", target: "Product DB", source: "agent" },
              ],
            },
            isSuccess: true,
            isPending: false,
          }),
        },
        refreshDestinationOptions: { useMutation: () => ({ mutate: refreshDestinationMutate, isPending: false, data: null }) },
      },
      config: {
        get: {
          useQuery: () => ({
            data: {
              agent_pipeline: { auto_send_notion: true },
              calendars: mockCalendars,
              intelligence: { conversation: mockConversationSelection },
            },
          }),
        },
      },
      prompts: {
        list: { useQuery: () => ({ data: [{ id: "p1", slug: "summary", name: "会议纪要" }] }) },
      },
      agentTasks: {
        list: { useQuery: () => ({ data: mockDurableTasks, isPending: false }) },
      },
      scheduler: {
        overview: { useQuery: () => ({ data: { events: [], meetings: [] }, isPending: false }) },
      },
      integrations: {
        accountList: { useQuery: () => ({ data: { ok: true, accounts: [{ email: "yulu@example.com", services: ["calendar"] }] }, isPending: false }) },
        calendarList: { useQuery: () => ({ data: { ok: true, calendars: [{ id: "primary", summary: "Primary", primary: true }] }, isPending: false }) },
        test: { useMutation: () => ({ mutateAsync: vi.fn(() => Promise.resolve({ ok: true, stdout: "", stderr: "" })), isPending: false, data: null }) },
      },
      recording: {
        toggle: { useMutation: () => mutation() },
      },
      recordings: {
        reprocess: { useMutation: () => mutation(reprocessMutate) },
      },
      ask: {
        ask: { useMutation: () => ({ mutateAsync: askMutateAsync, isPending: false }) },
      },
      agentSessions: {
        list: {
          useQuery: (input?: unknown) => {
            sessionListInputs.push(input);
            return { data: { sessions: mockSessions }, isPending: false };
          },
        },
        get: {
          useQuery: (input: { id: string }) => ({
            data: mockSelectedSession && mockSelectedSession.id === input.id ? mockSelectedSession : null,
            isPending: false,
          }),
        },
        create: {
          useMutation: () => ({ mutateAsync: createSessionMutateAsync, isPending: false }),
        },
        append: {
          useMutation: () => ({ mutateAsync: appendSessionMutateAsync, isPending: false }),
        },
        rename: {
          useMutation: () => ({ mutateAsync: renameSessionMutateAsync, isPending: false }),
        },
        delete: {
          useMutation: () => ({ mutateAsync: deleteSessionMutateAsync, isPending: false }),
        },
        pin: {
          useMutation: () => ({ mutateAsync: pinSessionMutateAsync, isPending: false }),
        },
        archive: {
          useMutation: () => ({ mutateAsync: archiveSessionMutateAsync, isPending: false }),
        },
        resume: {
          useMutation: () => ({ mutateAsync: resumeSessionMutateAsync, isPending: false }),
        },
      },
    },
  };
});

import { AgentConsole } from "../../../web/src/routes/agent-console.js";
import { LanguageProvider } from "../../../web/src/i18n/LanguageProvider.js";

function wrap(initialEntries = ["/agent-console"], lang?: "zh" | "en") {
  if (lang) localStorage.setItem("yulu_ui.lang", lang);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const console = <AgentConsole />;
  const rendered = render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        {lang ? <LanguageProvider>{console}</LanguageProvider> : console}
      </MemoryRouter>
    </QueryClientProvider>,
  );
  if (mockSessions.length) fireEvent.click(rendered.getByRole("button", { name: lang === "en" ? "Conversation history" : "对话历史" }));
  return rendered;
}

beforeEach(() => {
  localStorage.removeItem("yulu_ui.lang");
  localStorage.removeItem("yulu_ui.agent.history_height");
  navigateMock.mockClear();
  reprocessMutate.mockClear();
  connectAgentMutate.mockReset();
  configurePluginMutate.mockClear();
  setDestinationMutate.mockClear();
  refreshDestinationMutate.mockClear();
  detectRefetch.mockReset();
  askMutateAsync.mockReset();
  createSessionMutateAsync.mockReset();
  appendSessionMutateAsync.mockReset();
  renameSessionMutateAsync.mockReset();
  deleteSessionMutateAsync.mockReset();
  pinSessionMutateAsync.mockReset();
  archiveSessionMutateAsync.mockReset();
  resumeSessionMutateAsync.mockReset();
  sessionListInputs = [];
  mockSessions = [];
  mockSelectedSession = null;
  mockZulipConfigured = false;
  mockCalendars = [{ type: "google", enabled: true, gog_account: "yulu@example.com", watch_calendars: ["primary"] }];
  mockTasks = [taskFixture()];
  mockDurableTasks = [
    { id: "task-queued", recordingStem: "Queued", title: "Queued recording", state: "queued", phase: "queued", agentProvider: "hermes", attempt: 0, error: null, createdAt: "", updatedAt: "" },
    { id: "task-running", recordingStem: "Running", title: "Running recording", state: "running", phase: "summarizing", agentProvider: "hermes", attempt: 1, error: null, createdAt: "", updatedAt: "" },
    { id: "task-failed", recordingStem: "Failed", title: "Failed recording", state: "failed", phase: "failed", agentProvider: "hermes", attempt: 1, error: "boom", createdAt: "", updatedAt: "" },
  ];
  mockConversationSelection = { provider: "agent", model: "runtime-managed" };
  connectAgentMutate.mockImplementation((input: { agent: string }, options: { onSuccess?: (result: unknown) => void; onSettled?: () => void }) => {
    options.onSuccess?.({ ok: true, activeAgent: input.agent, agents: [] });
    options.onSettled?.();
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: vi.fn(() => Promise.resolve()) },
  });
  askMutateAsync.mockResolvedValue({
    answer: "OK",
    sources: [],
    usedFallback: false,
    llmStatus: "ok",
  });
  createSessionMutateAsync.mockResolvedValue({
    id: "session-new",
    agent: "codex",
    title: "新对话",
    updatedAt: "2026-06-25T10:00:00.000Z",
    messages: [],
  });
  appendSessionMutateAsync.mockResolvedValue({
    id: "session-new",
    agent: "codex",
    title: "总结一下",
    updatedAt: "2026-06-25T10:01:00.000Z",
    messages: [],
  });
  renameSessionMutateAsync.mockResolvedValue({});
  deleteSessionMutateAsync.mockResolvedValue({ deleted: true });
  pinSessionMutateAsync.mockResolvedValue({});
  archiveSessionMutateAsync.mockResolvedValue({});
  resumeSessionMutateAsync.mockResolvedValue({});
  detectRefetch.mockResolvedValue({
    data: {
      agents: [
        { id: "codex", found: true },
        { id: "claude", found: true },
        { id: "hermes", found: true },
        { id: "openclaw", found: true },
      ],
    },
  });
});

describe("AgentConsole", () => {
  it("starts with one composer and no dashboard panels", () => {
    const { getByRole, queryByText, container } = wrap();
    expect(getByRole("textbox")).toBeInTheDocument();
    expect(getByRole("button", { name: "对话历史" })).toHaveAttribute("aria-expanded", "false");
    expect(queryByText("跑任务")).toBeNull();
    expect(queryByText("Agents")).toBeNull();
    expect(container.querySelector(".agent-session-recent")).toBeNull();
    expect(getByRole("link", { name: /项需要处理/ })).toHaveAttribute("href", "/health#queue");
    expect(configurePluginMutate).not.toHaveBeenCalled();
    expect(detectRefetch).not.toHaveBeenCalled();
  });

  it("opens history with focus and returns focus on Escape", () => {
    const { getByRole, getByPlaceholderText, queryByLabelText } = wrap();
    const toggle = getByRole("button", { name: "对话历史" });
    fireEvent.click(toggle);
    expect(getByPlaceholderText("搜索对话")).toHaveFocus();
    fireEvent.keyDown(getByPlaceholderText("搜索对话"), { key: "Escape" });
    expect(queryByLabelText("对话历史", { selector: "aside" })).toBeNull();
    expect(toggle).toHaveFocus();
  });

  it("adds a recent meeting reference to the editable question without sending it", () => {
    const { getByRole, getByText, getByPlaceholderText } = wrap();
    fireEvent.click(getByRole("button", { name: "引用会议" }));
    fireEvent.click(getByText("Product Sync"));
    expect(getByPlaceholderText("问会议记录、决策、行动项...")).toHaveValue("关于会议「Product Sync」（2026-06-25 09:30）：");
    expect(askMutateAsync).not.toHaveBeenCalled();
    expect(reprocessMutate).not.toHaveBeenCalled();
    expect(getByRole("button", { name: "引用会议" })).toHaveFocus();
  });

  it("keeps unknown execution visible without a replay button", () => {
    mockDurableTasks = [{ id: "uncertain", recordingStem: "meeting", state: "execution_unverified" }];
    const { getByRole, queryByRole } = wrap();
    expect(getByRole("link", { name: "1 项需要处理" })).toHaveAttribute("href", "/health#queue");
    expect(queryByRole("button", { name: "重试" })).toBeNull();
  });

  it("does not submit while an IME composition is being confirmed", () => {
    const { getByRole } = wrap();
    fireEvent.change(getByRole("textbox"), { target: { value: "会议" } });
    fireEvent.keyDown(getByRole("textbox"), { key: "Enter", isComposing: true });
    expect(createSessionMutateAsync).not.toHaveBeenCalled();
  });

  it("renders Ask Meeting answers as Markdown", async () => {
    askMutateAsync.mockResolvedValueOnce({
      answer: "**重点**\n\n- 行动项",
      sources: [],
      usedFallback: false,
      llmStatus: "ok",
    });
    const { getByPlaceholderText, getByLabelText, findByText, container } = wrap();
    fireEvent.change(getByPlaceholderText("问会议记录、决策、行动项..."), { target: { value: "总结一下" } });
    fireEvent.click(getByLabelText("发送"));

    await findByText("重点");
    expect(container.querySelector(".agent-message-text strong")).toHaveTextContent("重点");
    expect(container.querySelector(".agent-message-text li")).toHaveTextContent("行动项");
    expect(createSessionMutateAsync).toHaveBeenCalledWith({ title: "总结一下" });
    expect(appendSessionMutateAsync).toHaveBeenCalledTimes(2);
  });

  it("does not show local citations unless the answer references numbered sources", async () => {
    askMutateAsync.mockResolvedValueOnce({
      answer: "我是 Yulu 的会议助手。",
      sources: [
        {
          ref: 1,
          kind: "summary",
          stem: "ProductSync_20260625_093000",
          title: "Product Sync",
          recordedAt: "2026-06-25T09:30:00",
          sourcePath: "/tmp/ProductSync.summary.md",
          snippet: "会议摘要片段",
          url: "/inbox/ProductSync_20260625_093000",
        },
      ],
      usedFallback: false,
      llmStatus: "ok",
    });
    const { getByPlaceholderText, getByLabelText, findByText, queryByText } = wrap();
    fireEvent.change(getByPlaceholderText("问会议记录、决策、行动项..."), { target: { value: "你是谁" } });
    fireEvent.click(getByLabelText("发送"));

    await findByText("我是 Yulu 的会议助手。");
    expect(queryByText("引用来源")).toBeNull();
  });

  it("shows a pinned xAI identity and only its persisted local source cards", async () => {
    mockSessions = [{
      id: "session-xai",
      agent: "xai",
      provider: "xai",
      model: "grok-4.6-exact",
      status: "active",
      title: "Pinned xAI",
      updatedAt: "2026-08-24T10:00:00.000Z",
      messageCount: 2,
    }];
    mockSelectedSession = {
      ...mockSessions[0],
      messages: [
        { role: "user", text: "What changed?" },
        {
          role: "assistant",
          text: "A malicious model URL is https://evil.example/private",
          sources: [{
            ref: 1,
            kind: "meeting_summary",
            stem: "Product_20260824_100000",
            title: "Product Review",
            recordedAt: "2026-08-24T10:00:00",
            sourcePath: "/private/Product.summary.md",
            snippet: "Launch decision",
            url: "/inbox/Product_20260824_100000",
          }],
        },
      ],
    };

    const { getByText, findByText, container } = wrap();
    fireEvent.click(getByText("Pinned xAI"));

    expect(await findByText("xAI · grok-4.6-exact")).toBeInTheDocument();
    const sourceCard = container.querySelector(".agent-citation") as HTMLElement;
    expect(sourceCard).toHaveTextContent("Product Review");
    expect(sourceCard).toHaveTextContent("2026-08-24");
    expect(sourceCard).toHaveTextContent("Launch decision");
    expect(sourceCard).not.toHaveTextContent("evil.example");
    expect(sessionListInputs.every((input) => input === undefined)).toBe(true);
  });

  it("describes xAI conversations as local-only before the first question", async () => {
    mockConversationSelection = { provider: "xai", model: "grok-4.6-exact" };

    const { findByText, queryByText } = wrap();

    expect(await findByText("本地会议片段")).toHaveAttribute("title", "只会使用有界的本地会议片段，不会调用 Web、X、文件或 Connectors。");
    expect(await findByText("xAI · grok-4.6-exact")).toBeInTheDocument();
    expect(queryByText("本地记录、Notion、Zulip 会自动进入上下文。")).not.toBeInTheDocument();
  });

  it("keeps a failed new-session attempt explicit and repairs the selected connection", async () => {
    mockConversationSelection = {
      provider: "agent",
      connectionId: "codex",
      model: "gpt-5.6-sol",
    };
    createSessionMutateAsync.mockRejectedValueOnce(new Error("Codex readiness proof expired"));

    const { findByPlaceholderText, getByLabelText, findByText, getByText, getByRole } = wrap(undefined, "en");
    const input = await findByPlaceholderText("问会议记录、决策、行动项...");
    fireEvent.change(input, { target: { value: "What changed?" } });
    fireEvent.click(getByLabelText("发送"));

    expect(await findByText("Couldn't start conversation")).toHaveAttribute("role", "alert");
    expect(getByText("codex · gpt-5.6-sol could not start. Yulu did not switch providers."))
      .toBeInTheDocument();
    expect(getByText("Codex readiness proof expired")).toBeInTheDocument();
    expect(getByRole("link", { name: "Open AI Providers" })).toHaveAttribute(
      "href",
      "/settings/llm?connection=codex&capability=conversation",
    );
    expect(input).toHaveValue("What changed?");

    fireEvent.click(getByRole("button", { name: "Retry new conversation" }));
    await waitFor(() => expect(createSessionMutateAsync).toHaveBeenCalledTimes(2));
  });

  it("preserves paused history and retries the same pinned snapshot only on click", async () => {
    mockSessions = [{
      id: "session-paused",
      agent: "xai",
      provider: "xai",
      model: "grok-4.6-exact",
      status: "paused",
      pausedReason: "xAI conversation request failed (HTTP 403)",
      title: "Paused xAI",
      updatedAt: "2026-08-24T10:00:00.000Z",
      messageCount: 2,
    }];
    mockSelectedSession = {
      ...mockSessions[0],
      retrySnapshot: { question: "Retry this question", sources: [] },
      messages: [
        { role: "user", text: "Retry this question" },
        { role: "assistant", text: "Preserved answer", sources: [] },
      ],
    };
    askMutateAsync.mockResolvedValueOnce({
      answer: "Retry result",
      provider: "xai",
      model: "grok-4.6-exact",
      sessionStatus: "active",
      sources: [],
      usedFallback: false,
      llmStatus: "ok",
    });

    const { getByText, getByRole, findByText, container } = wrap();
    fireEvent.click(getByText("Paused xAI"));

    expect(await findByText("服务已暂停")).toHaveAttribute("role", "alert");
    expect(getByText("xAI · grok-4.6-exact 请求失败，Yulu 没有切换服务。")).toBeInTheDocument();
    expect(getByText("Preserved answer")).toBeInTheDocument();
    expect(container.querySelector(".agent-composer textarea")).toBeDisabled();
    expect(getByRole("link", { name: "打开智能服务设置" })).toHaveAttribute(
      "href",
      "/settings/llm?connection=direct-xai&capability=conversation",
    );
    expect(askMutateAsync).not.toHaveBeenCalled();

    fireEvent.click(getByRole("button", { name: "使用同一服务重试" }));

    expect(resumeSessionMutateAsync).not.toHaveBeenCalled();
    expect(askMutateAsync).toHaveBeenCalledTimes(1);
    expect(askMutateAsync).toHaveBeenCalledWith({
      question: "Retry this question",
      limit: 8,
      retry: true,
      sessionId: "session-paused",
    });
    expect(await findByText("Retry result")).toBeInTheDocument();
    expect(appendSessionMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("does not offer retry and preserves exact Claude remediation when the native session is unknown", async () => {
    mockSessions = [{
      id: "session-claude-unknown",
      agent: "claude-code",
      provider: "claude-code",
      connectionId: "claude-code",
      model: "claude-sonnet-5",
      status: "active",
      title: "Claude unknown outcome",
      updatedAt: "2026-08-27T10:00:00.000Z",
      messageCount: 0,
    }];
    mockSelectedSession = { ...mockSessions[0], messages: [] };
    askMutateAsync.mockResolvedValueOnce({
      answer: "",
      provider: "claude-code",
      model: "claude-sonnet-5",
      sessionStatus: "paused",
      sources: [],
      usedFallback: false,
      llmStatus: "error",
      llmError: "Claude Code Conversation outcome is unknown",
      recovery: {
        retry: "unavailable_unknown_outcome",
        settingsPath: "/settings/llm?connection=claude-code&capability=conversation",
        newConversation: true,
      },
    });

    const { getByText, findByPlaceholderText, getByLabelText, findByText, queryByRole, getByRole } = wrap();
    fireEvent.click(getByText("Claude unknown outcome"));
    fireEvent.change(await findByPlaceholderText("问会议记录、决策、行动项..."), { target: { value: "May this be retried?" } });
    fireEvent.click(getByLabelText("发送"));

    expect(await findByText("服务已暂停")).toBeInTheDocument();
    expect(queryByRole("button", { name: "使用同一服务重试" })).toBeNull();
    expect(getByRole("link", { name: "打开智能服务设置" })).toHaveAttribute(
      "href",
      "/settings/llm?connection=claude-code&capability=conversation",
    );
    expect(askMutateAsync).toHaveBeenCalledTimes(1);
  });

  it("renders pinned provider pause and recovery guidance in English", async () => {
    mockSessions = [{
      id: "session-paused-en",
      agent: "xai",
      provider: "xai",
      model: "grok-4.6-exact",
      status: "paused",
      pausedReason: "request failed",
      title: "Paused xAI English",
      updatedAt: "2026-08-24T10:00:00.000Z",
      messageCount: 2,
    }];
    mockSelectedSession = {
      ...mockSessions[0],
      retrySnapshot: { question: "Retry this question", sources: [] },
      messages: [
        { role: "user", text: "Retry this question" },
        { role: "assistant", text: "Preserved answer", sources: [] },
      ],
    };

    const { getByText, getAllByText, findByText, getByRole, queryByText } = wrap(["/agent-console"], "en");
    fireEvent.click(getByText("Paused xAI English"));

    expect(await findByText("Provider paused")).toHaveAttribute("role", "alert");
    expect(getByText("xAI · grok-4.6-exact failed. Yulu did not switch providers.")).toBeInTheDocument();
    expect(getByRole("button", { name: "Retry same provider" })).toBeInTheDocument();
    expect(getByRole("link", { name: "Open AI Providers" })).toHaveAttribute(
      "href",
      "/settings/llm?connection=direct-xai&capability=conversation",
    );
    expect(getAllByText("Provider changes apply to a new conversation.")).toHaveLength(1);
    expect(getByRole("link", { name: "xAI · grok-4.6-exact" })).toHaveAttribute("title", expect.stringContaining("xAI is pinned to this conversation · 2 messages"));
    expect(queryByText(/条消息/)).toBeNull();
  });

  it("names an existing Agent session from its pinned snapshot", async () => {
    mockSessions = [{
      id: "session-claude",
      agent: "claude",
      provider: "claude",
      model: "runtime-managed",
      status: "active",
      title: "Pinned Claude",
      updatedAt: "2026-08-24T10:00:00.000Z",
      messageCount: 0,
    }];
    mockSelectedSession = { ...mockSessions[0], messages: [] };

    const { getByText, findByText, queryByText } = wrap(["/agent-console"], "en");
    fireEvent.click(getByText("Pinned Claude"));

    expect(await findByText("claude · runtime-managed")).toHaveAttribute("title", expect.stringContaining("claude is pinned to this conversation"));
    expect(queryByText(/^Codex CLI is pinned to this conversation/)).toBeNull();
  });

  it("localizes the xAI privacy boundary and empty local result without a source card", async () => {
    mockConversationSelection = { provider: "xai", model: "grok-4.6-exact" };
    askMutateAsync.mockResolvedValueOnce({
      answer: "未找到匹配的本地会议片段，本次未向 xAI 发送内容。",
      provider: "xai",
      model: "grok-4.6-exact",
      sessionStatus: "active",
      sources: [],
      remoteSources: [],
      usedFallback: false,
      llmStatus: "empty",
    });

    const { getByText, getByPlaceholderText, getByLabelText, findByText, container } = wrap(["/agent-console"], "en");
    expect(getByText("Local meeting excerpts")).toHaveAttribute("title", "Only bounded local meeting excerpts are used. Web, X, files, and connectors stay off.");
    expect(getByText("xAI · grok-4.6-exact")).toHaveAttribute("title", expect.stringContaining("xAI is selected for this new conversation"));
    expect(container).not.toHaveTextContent("xAI is pinned to this conversation · Session not created yet");
    fireEvent.change(getByPlaceholderText("问会议记录、决策、行动项..."), { target: { value: "missing" } });
    fireEvent.click(getByLabelText("发送"));

    expect(await findByText("No matching local meeting excerpts were found. Nothing was sent to xAI.")).toBeInTheDocument();
    expect(container.querySelector(".agent-citation")).toBeNull();
  });

  it("resumes persisted Agent session history only after selecting it", async () => {
    mockSessions = [{
      id: "session-1",
      agent: "codex",
      title: "Bruce 忙什么",
      updatedAt: "2026-06-25T10:00:00.000Z",
      messageCount: 2,
    }];
    mockSelectedSession = {
      id: "session-1",
      agent: "codex",
      title: "Bruce 忙什么",
      updatedAt: "2026-06-25T10:00:00.000Z",
      messages: [
        { role: "user", text: "Bruce 最近忙什么？" },
        { role: "assistant", text: "**重点**：订阅和 KYC。", sources: [] },
      ],
    };

    const { findByText, queryByText, container } = wrap();

    const sessionPanel = container.querySelector(".agent-session-panel") as HTMLElement;
    await waitFor(() => {
      expect(within(sessionPanel).getByText("Bruce 忙什么")).toBeInTheDocument();
    });
    expect(queryByText("重点")).toBeNull();
    fireEvent.click(within(sessionPanel).getByText("Bruce 忙什么"));
    expect(await findByText("重点")).toBeInTheDocument();
    expect(container.querySelector(".agent-message-text strong")).toHaveTextContent("重点");
  });

  it("opens a floating voice chat directly on the URL session", async () => {
    mockSessions = [{
      id: "session-1",
      agent: "codex",
      title: "Bruce 忙什么",
      updatedAt: "2026-06-25T10:00:00.000Z",
      messageCount: 2,
    }];
    mockSelectedSession = {
      id: "session-1",
      agent: "codex",
      title: "Bruce 忙什么",
      updatedAt: "2026-06-25T10:00:00.000Z",
      messages: [
        { role: "user", text: "Bruce 最近忙什么？" },
        { role: "assistant", text: "**重点**：订阅和 KYC。", sources: [] },
      ],
    };

    const { findByText, queryByText, container } = wrap(["/voice-chat?session=session-1"]);

    expect(container.querySelector(".agent-console-modebar")).toBeNull();
    expect(await findByText("重点")).toBeInTheDocument();
    expect(queryByText("尚未创建 session")).toBeNull();
    expect(container.querySelector(".agent-session-item.active")).toHaveTextContent("Bruce 忙什么");
  });

  it("filters persisted Agent session history", async () => {
    mockSessions = [
      { id: "session-1", agent: "codex", title: "Bruce 忙什么", updatedAt: "2026-06-25T10:00:00.000Z", messageCount: 2 },
      { id: "session-2", agent: "codex", title: "Launch Review", updatedAt: "2026-06-24T10:00:00.000Z", messageCount: 4 },
    ];
    const { getByPlaceholderText, container } = wrap();
    const sessionPanel = container.querySelector(".agent-session-panel") as HTMLElement;
    expect(within(sessionPanel).getByText("Bruce 忙什么")).toBeInTheDocument();
    fireEvent.change(getByPlaceholderText("搜索对话"), { target: { value: "Launch" } });
    expect(within(sessionPanel).getByText("Launch Review")).toBeInTheDocument();
    expect(within(sessionPanel).queryByText("Bruce 忙什么")).toBeNull();
  });

  it("manages Agent sessions from the history menu", async () => {
    mockSessions = [
      { id: "session-1", agent: "codex", title: "Bruce 忙什么", updatedAt: "2026-06-25T10:00:00.000Z", messageCount: 2 },
    ];
    const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("Renamed");
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { getByText } = wrap();

    fireEvent.click(getByText("重命名"));
    expect(renameSessionMutateAsync).toHaveBeenCalledWith({ id: "session-1", title: "Renamed" });

    fireEvent.click(getByText("置顶"));
    expect(pinSessionMutateAsync).toHaveBeenCalledWith({ id: "session-1", pinned: true });

    fireEvent.click(getByText("归档"));
    expect(archiveSessionMutateAsync).toHaveBeenCalledWith({ id: "session-1", archived: true });

    fireEvent.click(getByText("删除"));
    expect(deleteSessionMutateAsync).toHaveBeenCalledWith({ id: "session-1" });

    promptSpy.mockRestore();
    confirmSpy.mockRestore();
  });

  it("starts a fresh Ask session when New Chat is clicked", async () => {
    mockSessions = [{
      id: "session-old",
      agent: "codex",
      title: "旧会话",
      updatedAt: "2026-06-25T10:00:00.000Z",
      messageCount: 2,
    }];
    mockSelectedSession = {
      id: "session-old",
      agent: "codex",
      title: "旧会话",
      updatedAt: "2026-06-25T10:00:00.000Z",
      messages: [
        { role: "user", text: "旧问题" },
        { role: "assistant", text: "旧回答", sources: [] },
      ],
    };

    const { getByText, getByPlaceholderText, getByLabelText, container } = wrap();
    expect(container.querySelector(".agent-chat-thread.empty")).toBeInTheDocument();
    fireEvent.click(getByText("旧会话"));
    await waitFor(() => expect(getByText("旧回答")).toBeInTheDocument());

    fireEvent.click(getByLabelText("新对话"));
    expect(container.querySelector(".agent-chat-thread.empty")).toBeInTheDocument();
    expect(container.querySelector(".agent-chat-composer textarea[placeholder='问会议记录、决策、行动项...']")).toBeInTheDocument();
    fireEvent.change(getByPlaceholderText("问会议记录、决策、行动项..."), { target: { value: "新的问题" } });
    fireEvent.click(getByLabelText("发送"));

    await waitFor(() => expect(createSessionMutateAsync).toHaveBeenCalledWith({ title: "新的问题" }));
    expect(askMutateAsync).toHaveBeenCalledWith({ question: "新的问题", limit: 8, sessionId: "session-new" });
  });
});
