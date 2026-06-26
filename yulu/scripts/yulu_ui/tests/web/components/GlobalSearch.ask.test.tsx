import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";

const navigateMock = vi.fn();

vi.mock("react-router", async (orig) => {
  const actual = await orig<typeof import("react-router")>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("../../../web/src/trpc.js", () => ({
  trpc: {
    search: {
      run: {
        useQuery: () => ({
          data: {
            hits: [
              {
                kind: "meeting_summary",
                stem: "ProductWeekly_20260624_090000",
                meetingTitle: "Product Weekly",
                recordedAt: "2026-06-24T09:00:00",
                sourcePath: "/Users/test/Movies/Yulu/ProductWeekly_20260624_090000.summary.md",
                score: 1,
                snippet: "[hit]OKR[/hit] next steps",
              },
            ],
          },
          isFetching: false,
        }),
      },
    },
    config: { schema: { useQuery: () => ({ data: [], isPending: false }) } },
  },
}));

import { GlobalSearch } from "../../../web/src/components/GlobalSearch.js";

beforeEach(() => {
  navigateMock.mockClear();
});

describe("GlobalSearch — Ask migration", () => {
  it("keeps the global entry search-only after Ask moved to Agent Console", () => {
    const { getByPlaceholderText, queryByText } = render(<GlobalSearch />);

    fireEvent.change(getByPlaceholderText("搜索"), { target: { value: "OKR" } });

    expect(queryByText("提问")).toBeNull();
    expect(queryByText("问 Yulu")).toBeNull();
    expect(queryByText("Agent 工作台")).toBeNull();
  });

  it("Enter opens the focused search result", () => {
    const { getByPlaceholderText } = render(<GlobalSearch />);
    const input = getByPlaceholderText("搜索");

    fireEvent.change(input, { target: { value: "OKR" } });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(navigateMock).toHaveBeenCalledWith("/inbox/ProductWeekly_20260624_090000?tab=summary&snippet=OKR");
  });
});
