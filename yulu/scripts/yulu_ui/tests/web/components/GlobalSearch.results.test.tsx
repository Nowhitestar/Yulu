import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor, within } from "@testing-library/react";

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
                kind: "meeting_transcript",
                stem: "ProductWeekly_20260624_090000",
                meetingTitle: "Product Weekly",
                recordedAt: "2026-06-24T09:00:00",
                sourcePath: "/Users/test/Movies/Yulu/ProductWeekly_20260624_090000.transcript.txt",
                score: 1.2,
                snippet: "...discussed [hit]OKR[/hit] changes...",
              },
            ],
          },
          isFetching: false,
        }),
      },
    },
    ask: { ask: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) } },
    config: { schema: { useQuery: () => ({ data: [], isPending: false }) } },
  },
}));

import { GlobalSearch } from "../../../web/src/components/GlobalSearch.js";

beforeEach(() => navigateMock.mockClear());

describe("GlobalSearch — recording results", () => {
  it("renders backend hit markers as highlights", async () => {
    const { getByPlaceholderText, container } = render(<GlobalSearch />);
    fireEvent.change(getByPlaceholderText("搜索"), { target: { value: "OKR" } });

    const row = await waitFor(() => {
      const result = container.querySelector(".gs-result") as HTMLElement | null;
      expect(result).not.toBeNull();
      return result!;
    });

    expect(within(row).getByText("Product Weekly")).toBeInTheDocument();
    const mark = row.querySelector("mark");
    expect(mark?.textContent).toBe("OKR");
    expect(row.textContent).toContain("06-24 09:00");
  });

  it("clicking a transcript hit opens the reader transcript tab with the hit term", async () => {
    const { getByPlaceholderText, container } = render(<GlobalSearch />);
    fireEvent.change(getByPlaceholderText("搜索"), { target: { value: "OKR" } });

    const row = await waitFor(() => {
      const result = container.querySelector(".gs-result") as HTMLButtonElement | null;
      expect(result).not.toBeNull();
      return result!;
    });
    fireEvent.click(row);

    expect(navigateMock).toHaveBeenCalledWith(
      "/inbox/ProductWeekly_20260624_090000?tab=transcript&snippet=OKR",
    );
  });
});
