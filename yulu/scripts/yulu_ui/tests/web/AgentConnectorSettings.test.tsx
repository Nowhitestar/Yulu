import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, waitFor } from "@testing-library/react";
import { AgentConnectorSettings } from "../../web/src/components/settings/AgentConnectorSettings.js";

const configure = vi.fn();
const refresh = vi.fn();
const query = vi.fn(() => ({ data: { agent: "codex", all: [
  { id: "notion", label: "Notion", status: "configured" },
  { id: "zulip", label: "Zulip", status: "unconfigured" },
  { id: "calendar", label: "日历", status: "unsupported" },
] }, refetch: refresh }));
vi.mock("../../web/src/trpc.js", () => ({ trpc: { agentConsole: {
  connectors: { useQuery: () => query() },
  configurePlugin: { useMutation: () => ({ mutate: configure, isPending: false, data: { label: "Notion", agent: "codex", manageCommand: "codex mcp", message: "Manage with the selected Agent" } }) },
} } }));

describe("Agent source settings", () => {
  it("loads source configuration only when expanded and keeps ownership with the Agent", async () => {
    query.mockClear(); configure.mockClear(); refresh.mockClear();
    const { container, getByRole, getByText } = render(<AgentConnectorSettings />);
    expect(query).not.toHaveBeenCalled();
    const disclosure = container.querySelector("details")!;
    disclosure.open = true;
    fireEvent(disclosure, new Event("toggle"));
    await waitFor(() => expect(getByRole("button", { name: "管理 Notion" })).toBeVisible());
    expect(getByText(/授权由 codex 管理/)).toBeVisible();
    expect(getByRole("button", { name: "管理 日历" })).toBeDisabled();
    expect(configure).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(getByRole("button", { name: "管理 Notion" }));
    expect(configure).toHaveBeenCalledWith({ plugin: "notion" });
    const copy = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: copy } });
    fireEvent.click(getByRole("button", { name: "复制管理命令" }));
    await waitFor(() => expect(copy).toHaveBeenCalledWith("codex mcp"));
    expect(getByRole("button", { name: "已复制" })).toBeVisible();
  });
});
