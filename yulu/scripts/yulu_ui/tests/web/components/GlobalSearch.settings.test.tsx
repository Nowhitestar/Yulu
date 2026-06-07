import type React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, fireEvent, waitFor, within } from "@testing-library/react";

// Drive config.schema (the registry metadata) + an empty backend search so the
// only hits are the client-side settings hits GlobalSearch synthesises.
const SCHEMA = [
  { path: "audio.mic_device",       category: "audio",         label: "麦克风设备", type: "select", reload: { kind: "restart", daemons: ["audiodaemon"] } },
  { path: "transcription.language", category: "transcription", label: "语言",      type: "text",   reload: { kind: "restart", daemons: ["sttdaemon"] } },
  { path: "llm.enabled",            category: "llm",           label: "启用 LLM",  type: "toggle", reload: { kind: "none" } },
];

const navigateMock = vi.fn();

vi.mock("react-router", async (orig) => {
  const actual = await orig<typeof import("react-router")>();
  return { ...actual, useNavigate: () => navigateMock };
});

vi.mock("../../../web/src/trpc.js", () => ({
  trpc: {
    search: { run: { useQuery: () => ({ data: { hits: [] }, isFetching: false }) } },
    config: { schema: { useQuery: () => ({ data: SCHEMA, isPending: false }) } },
  },
}));

import { GlobalSearch } from "../../../web/src/components/GlobalSearch.js";

beforeEach(() => navigateMock.mockClear());

describe("GlobalSearch — settings scope", () => {
  it("a query matching a setting label yields a setting hit", async () => {
    const { getByPlaceholderText, container } = render(<GlobalSearch />);
    fireEvent.change(getByPlaceholderText("搜索"), { target: { value: "麦克风" } });
    const badge = await waitFor(() => {
      const el = container.querySelector(".gs-kind-setting");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(badge.textContent).toBe("设置");
  });

  it("a query matching a category label yields that category's hit", async () => {
    const { getByPlaceholderText, container } = render(<GlobalSearch />);
    // "转写" is the Chinese label for the transcription category.
    fireEvent.change(getByPlaceholderText("搜索"), { target: { value: "转写" } });
    await waitFor(() => expect(container.querySelector(".gs-kind-setting")).not.toBeNull());
  });

  it("clicking a setting hit navigates to /settings/:category", async () => {
    const { getByPlaceholderText, container } = render(<GlobalSearch />);
    fireEvent.change(getByPlaceholderText("搜索"), { target: { value: "麦克风" } });
    const target = await waitFor(() => {
      const row = container.querySelector(".gs-result") as HTMLElement | null;
      expect(row).not.toBeNull();
      return within(row!).getByText("音频与存储");
    });
    fireEvent.click(target);
    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/settings/audio"));
  });

  it("a non-matching query produces no setting hits", async () => {
    const { getByPlaceholderText, container } = render(<GlobalSearch />);
    fireEvent.change(getByPlaceholderText("搜索"), { target: { value: "zzzznotathing" } });
    // Give the debounce time to settle; still no setting badge.
    await new Promise((r) => setTimeout(r, 250));
    expect(container.querySelector(".gs-kind-setting")).toBeNull();
  });
});
