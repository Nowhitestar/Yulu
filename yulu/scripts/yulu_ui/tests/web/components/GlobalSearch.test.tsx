import type React from "react";
import { describe, it, expect } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { trpc, makeTrpcClient } from "../../../web/src/trpc.js";
import { GlobalSearch } from "../../../web/src/components/GlobalSearch.js";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const tc = makeTrpcClient();
  return render(
    <trpc.Provider client={tc} queryClient={qc}>
      <QueryClientProvider client={qc}>
        <MemoryRouter>{ui}</MemoryRouter>
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

describe("GlobalSearch", () => {
  it("renders a search input with placeholder Search and a kbd hint", () => {
    const { getByPlaceholderText, container } = wrap(<GlobalSearch />);
    expect(getByPlaceholderText("搜索")).toBeInTheDocument();
    expect(container.querySelector(".gs-kbd")?.textContent).toMatch(/⌘K|Ctrl-K/);
  });

  it("does not render a popover when input is empty", () => {
    const { container } = wrap(<GlobalSearch />);
    expect(container.querySelector(".gs-popover")).toBeNull();
  });

  it("opens a popover when the user types", () => {
    const { getByPlaceholderText, container } = wrap(<GlobalSearch />);
    const input = getByPlaceholderText("搜索");
    fireEvent.change(input, { target: { value: "test" } });
    expect(container.querySelector(".gs-popover")).not.toBeNull();
  });

  it("closes the popover on Escape", () => {
    const { getByPlaceholderText, container } = wrap(<GlobalSearch />);
    const input = getByPlaceholderText("搜索");
    fireEvent.change(input, { target: { value: "test" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(container.querySelector(".gs-popover")).toBeNull();
  });

  it("⌘K (or Ctrl+K) focuses the input from anywhere on the page", () => {
    const { getByPlaceholderText } = wrap(<GlobalSearch />);
    const input = getByPlaceholderText("搜索");
    fireEvent.keyDown(window, { key: "k", metaKey: true });
    expect(document.activeElement).toBe(input);
  });

  it("renders no filter chips (keyword-only)", () => {
    const { container } = wrap(<GlobalSearch />);
    fireEvent.change(container.querySelector("input")!, { target: { value: "hi" } });
    expect(container.querySelectorAll(".filterchip").length).toBe(0);
    expect(container.querySelectorAll(".gs-filter").length).toBe(0);
  });

  it("renders the keyboard hint footer", () => {
    const { container } = wrap(<GlobalSearch />);
    fireEvent.change(container.querySelector("input")!, { target: { value: "hi" } });
    const footer = container.querySelector(".gs-footer");
    expect(footer?.textContent).toMatch(/切换/);
    expect(footer?.textContent).toMatch(/打开/);
    expect(footer?.textContent).toMatch(/关闭/);
  });
});
