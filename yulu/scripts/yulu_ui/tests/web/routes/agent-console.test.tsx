import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const navigateMock = vi.fn();
const reprocessMutate = vi.fn();
const sendSummaryMutate = vi.fn();
const configurePluginMutate = vi.fn();
const setDestinationMutate = vi.fn();
const refreshDestinationMutate = vi.fn();
const updateCalendarMutate = vi.fn();
const detectRefetch = vi.fn();
const askMutateAsync = vi.fn();
const createSessionMutateAsync = vi.fn();
const appendSessionMutateAsync = vi.fn();
const renameSessionMutateAsync = vi.fn();
const deleteSessionMutateAsync = vi.fn();
const pinSessionMutateAsync = vi.fn();
const archiveSessionMutateAsync = vi.fn();
let mockSessions: Array<Record<string, unknown>> = [];
let mockSelectedSession: Record<string, unknown> | null = null;
let mockZulipConfigured = false;
let mockCalendars: Array<Record<string, unknown>> = [];
let mockTasks: Array<Record<string, unknown>> = [];
let mockDurableTasks: Array<Record<string, unknown>> = [];

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
        overview: {
          useQuery: () => ({
            data: {
              recording: { state: "idle", hotkey: "?" },
              agents: [
                { id: "codex", name: "Codex CLI", command: "codex", found: true, path: "/opt/homebrew/bin/codex", supported: true, connected: true, unavailableReason: "", runtimePreview: "codex exec" },
                { id: "claude", name: "Claude Code", command: "claude", found: true, path: "/usr/local/bin/claude", supported: true, connected: false, unavailableReason: "", runtimePreview: "" },
                { id: "hermes", name: "Hermes", command: "hermes", found: true, path: "/Users/test/.local/bin/hermes", supported: true, connected: false, unavailableReason: "", runtimePreview: "" },
                { id: "openclaw", name: "OpenClaw", command: "openclaw", found: true, path: "/opt/homebrew/bin/openclaw", supported: true, connected: false, unavailableReason: "", runtimePreview: "" },
              ],
              plugins: {
                agent: "codex",
                current: [
                  { id: "summary", label: "总结", added: true, core: true, status: "configured", statusLabel: "已配置", resolvedPath: "", detail: "摘要由当前 Agent 执行", configureLabel: "已配置", agent: "codex" },
                  { id: "notion", label: "Notion", added: true, core: false, status: "configured", statusLabel: "已配置", resolvedPath: "/agent/notion", detail: "/agent/notion", configureLabel: "已配置", agent: "codex", destination: { channel: "notion", label: "Notion", value: "Yulu Meeting", configured: true, missingReason: "", notion: { target: "Yulu Meeting" } } },
                  { id: "zulip", label: "Zulip", added: true, core: false, status: mockZulipConfigured ? "configured" : "unconfigured", statusLabel: mockZulipConfigured ? "已配置" : "未配置", resolvedPath: mockZulipConfigured ? "/agent/zulip" : "", detail: mockZulipConfigured ? "/agent/zulip" : "Codex CLI 尚未配置 Zulip 插件", configureLabel: mockZulipConfigured ? "已配置" : "去配置", agent: "codex", destination: { channel: "zulip", label: "Zulip", value: mockZulipConfigured ? "meetings / weekly" : "选择 Channel 和 Topic", configured: mockZulipConfigured, missingReason: mockZulipConfigured ? "" : "请选择 Zulip Channel 和 Topic", zulip: { stream: mockZulipConfigured ? "meetings" : "", topic: mockZulipConfigured ? "weekly" : "" } } },
                  { id: "calendar", label: "日历", added: true, core: false, status: "configured", statusLabel: "已配置", resolvedPath: "/agent/calendar", detail: "/agent/calendar", configureLabel: "已配置", agent: "codex" },
                ],
                available: [],
                all: [],
              },
              tasks: mockTasks,
            },
            isPending: false,
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
        connectAgent: { useMutation: () => mutation() },
        addPlugin: { useMutation: () => mutation() },
        removePlugin: { useMutation: () => mutation() },
        configurePlugin: { useMutation: () => mutation(configurePluginMutate) },
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
        updateCalendarConfig: { useMutation: () => ({ mutate: updateCalendarMutate, isPending: false, data: null }) },
      },
      config: {
        get: {
          useQuery: () => ({
            data: {
              agent_pipeline: { auto_send_notion: true },
              calendars: mockCalendars,
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
        sendSummary: { useMutation: () => mutation(sendSummaryMutate) },
      },
      ask: {
        ask: { useMutation: () => ({ mutateAsync: askMutateAsync, isPending: false }) },
      },
      agentSessions: {
        list: {
          useQuery: () => ({ data: { sessions: mockSessions }, isPending: false }),
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
      },
    },
  };
});

import { AgentConsole } from "../../../web/src/routes/agent-console.js";

function wrap(initialEntries = ["/agent-console"]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries}>
        <AgentConsole />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.removeItem("yulu_ui.agent.history_height");
  navigateMock.mockClear();
  reprocessMutate.mockClear();
  sendSummaryMutate.mockClear();
  configurePluginMutate.mockClear();
  setDestinationMutate.mockClear();
  refreshDestinationMutate.mockClear();
  updateCalendarMutate.mockClear();
  detectRefetch.mockReset();
  askMutateAsync.mockReset();
  createSessionMutateAsync.mockReset();
  appendSessionMutateAsync.mockReset();
  renameSessionMutateAsync.mockReset();
  deleteSessionMutateAsync.mockReset();
  pinSessionMutateAsync.mockReset();
  archiveSessionMutateAsync.mockReset();
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
  it("renders the primary work areas and opens capabilities on demand", () => {
    const { container, getByText, queryByText } = wrap();
    expect(getByText("最近三天")).toBeInTheDocument();
    expect(container.querySelector(".agent-session-history")).toBeInTheDocument();
    expect(container.querySelector(".agent-session-recent")).toBeInTheDocument();
    expect(container.querySelector(".agent-session-resizer")).toHaveAttribute("role", "separator");
    expect(container.querySelector(".agent-console-rail-left")).toBeNull();
    expect(getByText("问会议")).toBeInTheDocument();
    expect(queryByText("底层 Agent")).not.toBeInTheDocument();
    fireEvent.click(getByText("能力"));
    expect(getByText("底层 Agent")).toBeInTheDocument();
  });

  it("renders durable Agent task state in Run Tasks mode", () => {
    const { getByText } = wrap();
    fireEvent.click(getByText("跑任务"));

    expect(getByText("Agent 任务")).toBeInTheDocument();
    expect(getByText("Queued recording")).toBeInTheDocument();
    expect(getByText("等待 1")).toBeInTheDocument();
    expect(getByText("运行 1")).toBeInTheDocument();
    expect(getByText("失败 1")).toBeInTheDocument();
  });

  it("supports keyboard resizing for the history and recent-meetings split", () => {
    const { container } = wrap();
    const separator = container.querySelector(".agent-session-resizer") as HTMLElement;
    const history = container.querySelector(".agent-session-history") as HTMLElement;
    expect(separator).toHaveAttribute("tabindex", "0");
    expect(separator).toHaveAttribute("aria-valuenow", "300");
    expect(history).toHaveStyle({ height: "300px" });

    fireEvent.keyDown(separator, { key: "ArrowDown" });
    expect(separator).toHaveAttribute("aria-valuenow", "320");
    expect(history).toHaveStyle({ height: "320px" });
  });

  it("keeps voice input available without duplicating it in the mode bar", () => {
    const { container, getByText, queryByText } = wrap();
    const modebar = container.querySelector(".agent-console-modebar") as HTMLElement;
    expect(within(modebar).queryByText("语音输入")).not.toBeInTheDocument();
    fireEvent.click(getByText("能力"));
    expect(getByText("打开").closest("a")).toHaveAttribute("href", "/voice-input");
    expect(queryByText("查看入口")).not.toBeInTheDocument();
    expect(getByText("配置快捷键").closest("a")).toHaveAttribute("href", "/settings/voice");
  });

  it("shows Share as the next action when transcript and summary already exist", () => {
    const { getByRole, getByText, container } = wrap();
    expect(getByText("Product Sync")).toBeInTheDocument();
    expect(container.querySelector(".agent-stage-line")).toBeNull();

    fireEvent.click(getByRole("button", { name: "分享" }));
    expect(getByRole("menu", { name: "选择分享渠道" })).toBeInTheDocument();
    fireEvent.click(getByRole("menuitem", { name: /分享到 Notion/ }));
    expect(sendSummaryMutate).toHaveBeenCalledWith({
      stem: "ProductSync_20260625_093000",
      channel: "notion",
      label: "Notion",
      destination: "Yulu Meeting",
    }, expect.any(Object));
    expect(reprocessMutate).not.toHaveBeenCalled();
  });

  it("ignores a paused automatic task and still shows the artifact-derived next action", async () => {
    mockDurableTasks = [{
      id: "task-auto-paused",
      recordingStem: "ProductSync_20260625_093000",
      title: "Product Sync",
      trigger: "automatic",
      state: "awaiting_policy",
      phase: "queued",
      sendToNotion: false,
      agentProvider: "hermes",
      attempt: 0,
      error: "Automatic Agent recording processing is paused by policy",
      createdAt: "2026-06-25T09:31:00.000Z",
      updatedAt: "2026-06-25T09:31:00.000Z",
    }];
    const { getByRole, queryByText } = wrap();

    expect(queryByText("Agent 自动处理已暂停")).toBeNull();
    const actionsButton = getByRole("button", { name: "分享" });
    expect(actionsButton).toBeEnabled();
    expect(reprocessMutate).not.toHaveBeenCalled();
  });

  it("does not surface retired legacy queue state on a meeting with usable artifacts", () => {
    mockTasks = [taskFixture({ error: "Legacy queue task retired without automatic execution" })];
    mockDurableTasks = [{
      id: "legacy-retired",
      recordingStem: "ProductSync_20260625_093000",
      title: "Product Sync",
      trigger: "automatic",
      state: "cancelled",
      phase: "failed",
      sendToNotion: false,
      agentProvider: "hermes",
      attempt: 0,
      error: "Legacy queue task retired without automatic execution",
      createdAt: "2026-06-25T09:31:00.000Z",
      updatedAt: "2026-06-25T09:31:00.000Z",
    }];
    const { getByRole, queryByText } = wrap();

    expect(queryByText(/Legacy queue task retired/)).toBeNull();
    expect(queryByText("Hermes 任务已取消")).toBeNull();
    expect(getByRole("button", { name: "分享" })).toBeInTheDocument();
  });

  it("keeps an uncertain Notion delivery fenced in the main Agent Console", () => {
    mockDurableTasks = [{
      id: "task-delivery-uncertain",
      recordingStem: "ProductSync_20260625_093000",
      title: "Product Sync",
      trigger: "manual",
      state: "delivery_unverified",
      phase: "failed",
      sendToNotion: true,
      agentProvider: "hermes",
      attempt: 1,
      error: "Host restarted during delivery",
      createdAt: "2026-06-25T09:31:00.000Z",
      updatedAt: "2026-06-25T09:32:00.000Z",
    }];
    const { getByText, queryByRole } = wrap();

    expect(getByText("请核实 Notion 发送结果")).toBeInTheDocument();
    expect(queryByRole("button", { name: "让 Hermes 处理" })).toBeNull();
    expect(queryByRole("button", { name: "处理并发送 Notion" })).toBeNull();
  });

  it("uses the most recently updated durable task when a historical task id is reused", () => {
    mockDurableTasks = [
      {
        id: "task-reused",
        recordingStem: "ProductSync_20260625_093000",
        title: "Product Sync",
        trigger: "manual",
        state: "queued",
        phase: "queued",
        sendToNotion: true,
        agentProvider: "hermes",
        attempt: 1,
        error: null,
        createdAt: "2026-06-20T09:00:00.000Z",
        updatedAt: "2026-06-25T10:00:00.000Z",
      },
      {
        id: "task-newer-created-history",
        recordingStem: "ProductSync_20260625_093000",
        title: "Product Sync",
        trigger: "manual",
        state: "completed",
        phase: "completed",
        sendToNotion: false,
        agentProvider: "hermes",
        attempt: 1,
        error: null,
        createdAt: "2026-06-24T09:00:00.000Z",
        updatedAt: "2026-06-24T09:01:00.000Z",
      },
    ];
    const { getByText, queryByRole } = wrap();

    expect(getByText("已排队等待 Hermes")).toBeInTheDocument();
    expect(queryByRole("button", { name: "让 Hermes 处理" })).toBeNull();
    expect(queryByRole("button", { name: "处理并发送 Notion" })).toBeNull();
  });

  it("shows Transcribe first when the recording has no transcript", () => {
    mockTasks = [taskFixture({
      stages: { transcribe: "idle", summarize: "idle", send: "idle" },
      hasTranscript: false,
      hasSummary: false,
    })];
    const { getByRole } = wrap();
    fireEvent.click(getByRole("button", { name: "转录" }));
    expect(reprocessMutate).not.toHaveBeenCalled();
    expect(navigateMock).toHaveBeenCalledWith("/inbox/ProductSync_20260625_093000");
  });

  it("shows Summary after transcription and before sharing", () => {
    mockTasks = [taskFixture({
      stages: { transcribe: "done", summarize: "idle", send: "idle" },
      hasTranscript: true,
      hasSummary: false,
    })];
    const { queryByRole, getByRole } = wrap();
    expect(queryByRole("button", { name: "处理并发送 Notion" })).toBeNull();
    expect(getByRole("button", { name: "总结" })).toBeInTheDocument();
    expect(reprocessMutate).not.toHaveBeenCalled();
  });

  it("offers every configured Agent share channel", () => {
    mockZulipConfigured = true;
    const { getByRole } = wrap();
    fireEvent.click(getByRole("button", { name: "分享" }));
    expect(getByRole("menuitem", { name: /分享到 Notion/ })).toBeInTheDocument();
    expect(getByRole("menuitem", { name: /分享到 Zulip/ })).toBeInTheDocument();
    expect(getByRole("menuitem", { name: /更多分享渠道/ })).toBeInTheDocument();
  });

  it("keeps Hermes and OpenClaw visible and connectable", () => {
    const { getByText } = wrap();
    fireEvent.click(getByText("能力"));
    expect(getByText("Hermes")).toBeInTheDocument();
    expect(getByText("OpenClaw")).toBeInTheDocument();
    expect(getByText("Hermes").closest("button")).not.toBeDisabled();
  });

  it("runs Agent detection with visible feedback", async () => {
    const { getByText, findByText } = wrap();
    fireEvent.click(getByText("能力"));
    fireEvent.click(getByText("探测"));
    expect(detectRefetch).toHaveBeenCalled();
    expect(await findByText("已找到 4/4 个 Agent CLI")).toBeInTheDocument();
  });

  it("saves Notion send destination from Current Capabilities", () => {
    const { getByPlaceholderText, getByText } = wrap();
    fireEvent.click(getByText("能力"));
    const row = getByText("Yulu Meeting").closest(".agent-cap-row") as HTMLElement;
    fireEvent.click(within(row).getByText("更改"));
    const input = getByPlaceholderText("Yulu Meeting") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Product Notes" } });
    fireEvent.click(getByText("保存"));

    expect(setDestinationMutate).toHaveBeenCalledWith(
      { channel: "notion", target: "Product Notes" },
      expect.any(Object),
    );
  });

  it("saves Zulip send destination from Agent connector candidates", () => {
    mockZulipConfigured = true;
    const { getByLabelText, getByText } = wrap();
    fireEvent.click(getByText("能力"));
    const row = getByText("meetings / weekly").closest(".agent-cap-row") as HTMLElement;
    fireEvent.click(within(row).getByText("更改"));
    fireEvent.change(getByLabelText("Zulip 候选目标"), { target: { value: "zulip:product:launch" } });
    fireEvent.click(getByText("保存"));

    expect(setDestinationMutate).toHaveBeenCalledWith(
      { channel: "zulip", stream: "product", topic: "launch" },
      expect.any(Object),
    );
  });

  it("updates scheduler calendar subscriptions from the Console calendar modal", () => {
    const { getByText } = wrap();
    fireEvent.click(getByText("能力"));
    const row = getByText("账户与订阅日历").closest(".agent-cap-row") as HTMLElement;
    fireEvent.click(within(row).getByText("更改"));
    const primaryRow = getByText("Primary").closest("label") as HTMLLabelElement;
    const checkbox = primaryRow.querySelector("input") as HTMLInputElement;
    fireEvent.click(checkbox);

    expect(updateCalendarMutate).toHaveBeenCalledWith({
      key: "calendars.0.watch_calendars",
      value: [],
    });
  });

  it("opens summary capability in the same change modal pattern", () => {
    const { getByText, getByLabelText } = wrap();
    fireEvent.click(getByText("能力"));
    const row = getByText("会议纪要").closest(".agent-cap-row") as HTMLElement;
    fireEvent.click(within(row).getByText("更改"));
    expect(getByLabelText("总结配置")).toBeInTheDocument();
    expect(getByText("默认总结模板")).toBeInTheDocument();
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
    expect(createSessionMutateAsync).toHaveBeenCalledWith({ agent: "codex", title: "总结一下" });
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

    fireEvent.click(getByText("新对话"));
    expect(container.querySelector(".agent-chat-thread.empty")).toBeInTheDocument();
    expect(container.querySelector(".agent-chat-composer textarea[placeholder='问会议记录、决策、行动项...']")).toBeInTheDocument();
    fireEvent.change(getByPlaceholderText("问会议记录、决策、行动项..."), { target: { value: "新的问题" } });
    fireEvent.click(getByLabelText("发送"));

    await waitFor(() => expect(createSessionMutateAsync).toHaveBeenCalledWith({ agent: "codex", title: "新的问题" }));
    expect(askMutateAsync).toHaveBeenCalledWith({ question: "新的问题", limit: 10, sessionId: "session-new" });
  });
});
