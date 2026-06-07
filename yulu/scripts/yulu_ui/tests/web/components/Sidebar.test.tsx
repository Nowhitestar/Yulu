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

  it("shows Inbox section with a single Recordings entry, no Voicemails/Meetings/Search", () => {
    const { getByText, queryByText } = wrap(<Sidebar />);
    expect(getByText("录音")).toBeInTheDocument();
    expect(queryByText("Voicemails")).toBeNull();
    expect(queryByText("Meetings")).toBeNull();
    expect(queryByText("Search")).toBeNull();
    expect(getByText("录音").closest("a")?.getAttribute("href")).toBe("/inbox");
  });

  it("shows Knowledge section with Prompts + Glossary", () => {
    const { getByText } = wrap(<Sidebar />);
    expect(getByText("提示词")).toBeInTheDocument();
    expect(getByText("术语表")).toBeInTheDocument();
  });

  it("renders an icon (svg) on each top-nav item", () => {
    const { getByText } = wrap(<Sidebar />);
    for (const label of ["录音", "提示词", "术语表"]) {
      const link = getByText(label).closest("a");
      expect(link?.querySelector("svg")).not.toBeNull();
    }
  });

  it("does NOT render Settings or Health as nav sections (they are bottom-only)", () => {
    const { container } = wrap(<Sidebar />);
    const headings = Array.from(container.querySelectorAll(".sidebar-heading")).map((el) => el.textContent);
    expect(headings).toEqual(["收件箱", "知识库"]);
  });

  it("renders Settings link in the bottom region", () => {
    const { container, getByText } = wrap(<Sidebar />);
    const bottom = container.querySelector('[data-testid="sidebar-bottom"]');
    expect(bottom).not.toBeNull();
    expect(bottom?.textContent).toContain("设置");
    expect(getByText("设置").closest("a")?.getAttribute("href")).toBe("/settings");
  });

  it("renders Health link in the bottom region with a health-state dot", () => {
    const { container, getByText } = wrap(<Sidebar />);
    const bottom = container.querySelector('[data-testid="sidebar-bottom"]');
    expect(bottom?.textContent).toContain("健康状态");
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
