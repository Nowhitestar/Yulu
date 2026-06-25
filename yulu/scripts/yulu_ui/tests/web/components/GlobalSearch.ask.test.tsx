import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor, within } from "@testing-library/react";

const navigateMock = vi.fn();
const askMutateMock = vi.hoisted(() => vi.fn());

vi.mock("react-router", async (orig) => {
  const actual = await orig<typeof import("react-router")>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("../../../web/src/trpc.js", () => ({
  trpc: {
    search: { run: { useQuery: () => ({ data: { hits: [] }, isFetching: false }) } },
    ask: { ask: { useMutation: () => ({ mutateAsync: askMutateMock, isPending: false }) } },
    config: { schema: { useQuery: () => ({ data: [], isPending: false }) } },
  },
}));

import { GlobalSearch } from "../../../web/src/components/GlobalSearch.js";

const ASK_RESULT = {
  answer: "这次会议决定先收敛 OKR，再同步到 Notion。",
  sources: [
    {
      kind: "meeting_summary",
      stem: "ProductWeekly_20260624_090000",
      title: "Product Weekly",
      recordedAt: "2026-06-24T09:00:00",
      sourcePath: "/Users/test/Movies/Yulu/ProductWeekly_20260624_090000.summary.md",
      snippet: "OKR",
      url: "/inbox/ProductWeekly_20260624_090000?tab=summary&snippet=OKR",
    },
  ],
  usedFallback: false,
  llmStatus: "ok",
  llmError: null,
  search: {
    telemetry: {
      plannedQueries: ["OKR 怎么处理？", "OKR"],
      mergedHitCount: 3,
    },
  },
  agentRuntime: {
    provider: "codex",
    label: "Codex",
    source: "auto-detected",
    commandPreview: "codex exec --sandbox read-only --skip-git-repo-check",
    cwd: "/Users/test/Movies/Yulu",
    status: "ready",
  },
  connectorContext: {
    calendar: {
      configured: 1,
      enabled: 1,
      schedulerProvider: "gog legacy provider",
      schedulerStatus: "watching 1 Google calendar(s) for native scheduling",
      upcomingMeetings: [{ title: "Product Weekly", start: "2026-06-24T09:00:00" }],
    },
    outputs: [
      { channel: "notion", label: "Notion", enabled: true, destination: "Team Notes", connected: true },
      { channel: "zulip", label: "Zulip", enabled: false, destination: "未设置", connected: false },
    ],
  },
};

beforeEach(() => {
  navigateMock.mockClear();
  askMutateMock.mockReset();
  askMutateMock.mockResolvedValue(ASK_RESULT);
});

describe("GlobalSearch — Ask Yulu", () => {
  it("switches to Ask mode and submits the current question", async () => {
    const { getByPlaceholderText, getByText, getAllByText } = render(<GlobalSearch />);
    fireEvent.change(getByPlaceholderText("搜索"), { target: { value: "OKR 怎么处理？" } });
    fireEvent.click(getByText("提问"));
    fireEvent.click(getByText("问 Yulu"));

    await waitFor(() => expect(askMutateMock).toHaveBeenCalledWith({
      question: "OKR 怎么处理？",
      limit: 10,
    }));
    expect(await waitFor(() => getByText(/先收敛 OKR/))).toBeInTheDocument();
    expect(getAllByText("OKR 怎么处理？").length).toBeGreaterThan(0);
    expect(getByText("1 条来源")).toBeInTheDocument();
    expect(getByText("Agent 工作台")).toBeInTheDocument();
    expect(getByText("Codex · 可用")).toBeInTheDocument();
    expect(getByText("本地种子")).toBeInTheDocument();
    expect(getByText("1 条来源 · 3 条命中")).toBeInTheDocument();
    expect(getByText("2 个计划查询")).toBeInTheDocument();
    expect(getByText("Native Scheduler")).toBeInTheDocument();
    expect(getByText("gog legacy provider")).toBeInTheDocument();
    expect(getByText("Agent Connectors")).toBeInTheDocument();
    expect(getByText("Notion")).toBeInTheDocument();
    expect(getByText("Team Notes")).toBeInTheDocument();
    expect(getByText("Zulip")).toBeInTheDocument();
    expect(getByText("未启用")).toBeInTheDocument();
    expect(getByText("检索计划")).toBeInTheDocument();
  });

  it("renders answer sources and opens the reader deep link", async () => {
    const { getByPlaceholderText, getByText, container } = render(<GlobalSearch />);
    fireEvent.change(getByPlaceholderText("搜索"), { target: { value: "OKR" } });
    fireEvent.click(getByText("提问"));
    fireEvent.click(getByText("问 Yulu"));

    const source = await waitFor(() => {
      const row = container.querySelector(".gs-ask-source") as HTMLElement | null;
      expect(row).not.toBeNull();
      return row!;
    });

    expect(within(source).getByText("Product Weekly")).toBeInTheDocument();
    fireEvent.click(source);
    expect(navigateMock).toHaveBeenCalledWith("/inbox/ProductWeekly_20260624_090000?tab=summary&snippet=OKR");
  });

  it("shows fallback status when the Ask backend returns a fallback answer", async () => {
    askMutateMock.mockResolvedValueOnce({ ...ASK_RESULT, usedFallback: true, answer: "暂时不能生成自然语言回答。" });
    const { getByPlaceholderText, getByText } = render(<GlobalSearch />);
    fireEvent.change(getByPlaceholderText("搜索"), { target: { value: "OKR" } });
    fireEvent.click(getByText("提问"));
    fireEvent.click(getByText("问 Yulu"));

    expect(await waitFor(() => getByText("降级结果"))).toBeInTheDocument();
  });

  it("keeps prior turns when asking a follow-up", async () => {
    askMutateMock
      .mockResolvedValueOnce(ASK_RESULT)
      .mockResolvedValueOnce({ ...ASK_RESULT, answer: "第二轮回答：待办是同步 Notion。" });
    const { getByPlaceholderText, getByText } = render(<GlobalSearch />);
    const input = getByPlaceholderText("搜索");

    fireEvent.change(input, { target: { value: "OKR 怎么处理？" } });
    fireEvent.click(getByText("提问"));
    fireEvent.click(getByText("问 Yulu"));
    expect(await waitFor(() => getByText(/先收敛 OKR/))).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "有哪些待办？" } });
    fireEvent.click(getByText("问 Yulu"));

    expect(await waitFor(() => getByText(/第二轮回答/))).toBeInTheDocument();
    expect(getByText(/先收敛 OKR/)).toBeInTheDocument();
    expect(getByText("有哪些待办？")).toBeInTheDocument();
  });

  it("focuses the entry with Cmd+K using browser code fallback", () => {
    const { getByPlaceholderText } = render(<GlobalSearch />);
    const input = getByPlaceholderText("搜索");
    fireEvent.keyDown(window, { key: "K", code: "KeyK", metaKey: true });
    expect(input).toHaveFocus();
  });
});
