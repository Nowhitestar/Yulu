import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DbStatsRow, formatBytes } from "../../web/src/components/DbStatsRow.js";

describe("formatBytes", () => {
  it("renders bytes with KB / MB units", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5_242_880)).toBe("5.0 MB");
  });
});

describe("DbStatsRow", () => {
  it("renders name + path + size + rows", () => {
    const { container } = render(<DbStatsRow name="prompts" path="/x/prompts.sqlite" size={5242880} rows={42} />);
    expect(container.querySelector(".dbstats-name")?.textContent).toMatch(/prompts/);
    expect(screen.getByText("/x/prompts.sqlite")).toBeInTheDocument();
    expect(screen.getByText(/5\.0 MB/)).toBeInTheDocument();
    expect(screen.getByText(/42 rows/)).toBeInTheDocument();
  });

  it("renders '— rows' when rows=null", () => {
    render(<DbStatsRow name="search" path="/x/search.sqlite" size={1024} rows={null} />);
    expect(screen.getByText(/— rows/)).toBeInTheDocument();
  });

  it("action button fires onAction when provided", async () => {
    const onAction = vi.fn();
    render(<DbStatsRow name="search" path="/x/search.sqlite" size={1024} rows={10} actionLabel="Reindex" onAction={onAction} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Reindex" }));
    expect(onAction).toHaveBeenCalled();
  });
});
