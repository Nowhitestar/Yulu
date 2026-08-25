import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc, makeTrpcClient } from "../../../web/src/trpc";
import { Sidebar } from "../../../web/src/components/Sidebar";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tc = makeTrpcClient();
  return render(
    <trpc.Provider client={tc} queryClient={qc}>
      <QueryClientProvider client={qc}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

describe("Sidebar", () => {
  it("renders the Yulu brand mark and text", () => {
    const { container, getByText } = wrap(<Sidebar />);
    expect(container.querySelector('svg[aria-label="Yulu"]')).not.toBeNull();
    expect(getByText("Yulu")).toBeInTheDocument();
  });

  it("keeps recordings under the workspace section, no Voicemails/Meetings/Search", () => {
    const { getByText, queryByText } = wrap(<Sidebar />);
    expect(getByText("Agent Console")).toBeInTheDocument();
    expect(getByText("Agent Console").closest("a")?.getAttribute("href")).toBe("/agent-console");
    expect(getByText("录音")).toBeInTheDocument();
    expect(queryByText("Voicemails")).toBeNull();
    expect(queryByText("Meetings")).toBeNull();
    expect(queryByText("Search")).toBeNull();
    expect(getByText("录音").closest("a")?.getAttribute("href")).toBe("/inbox");
  });

  it("shows templates and glossary in the workspace section", () => {
    const { getByText } = wrap(<Sidebar />);
    expect(getByText("模板")).toBeInTheDocument();
    expect(getByText("术语表")).toBeInTheDocument();
  });

  it("renders an icon (svg) on each nav item", () => {
    const { getByText } = wrap(<Sidebar />);
    for (const label of ["Agent Console", "录音", "模板", "术语表", "设置", "健康状态"]) {
      const link = getByText(label).closest("a");
      expect(link?.querySelector("svg")).not.toBeNull();
    }
  });

  it("renders Settings and Health in a System nav section", () => {
    const { container } = wrap(<Sidebar />);
    const headings = Array.from(container.querySelectorAll(".sidebar-heading")).map((el) => el.textContent);
    expect(headings).toEqual(["工作台", "系统"]);
    expect(container.textContent).not.toContain("收件箱");
    expect(container.textContent).not.toContain("知识库");
  });

  it("renders Settings link in the System section", () => {
    const { getByText } = wrap(<Sidebar />);
    expect(getByText("设置").closest("a")?.getAttribute("href")).toBe("/settings");
  });

  it("keeps a non-blocking Activation Journey re-entry in the normal product", () => {
    const { getByText } = wrap(<Sidebar />);
    expect(getByText("激活 Yulu").closest("a")?.getAttribute("href")).toBe("/activate");
  });

  it("renders Health link in the System section with a health-state dot", () => {
    const { container, getByText } = wrap(<Sidebar />);
    expect(getByText("健康状态").closest("a")?.getAttribute("href")).toBe("/health");
    expect(container.querySelector('[data-testid="health-dot"]')).not.toBeNull();
  });

  it("does NOT render any sidebar-count badges or '?' placeholders", () => {
    const { container } = wrap(<Sidebar />);
    expect(container.querySelector(".sidebar-count")).toBeNull();
    expect(container.textContent).not.toContain("?");
  });

  it("does NOT render the ThemeToggle (it moved to TopBar)", () => {
    const { queryByRole } = wrap(<Sidebar />);
    expect(queryByRole("group", { name: /theme/i })).toBeNull();
  });
});
