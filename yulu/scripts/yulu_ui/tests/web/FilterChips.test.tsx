import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FilterChips, type ChipDef } from "../../web/src/components/FilterChips.js";

const VM_CHIPS: ChipDef[] = [
  { id: "all", label: "All" },
  { id: "summarized", label: "Summarized" },
  { id: "last7d", label: "Last 7d" },
];

describe("FilterChips", () => {
  it("renders all chips with labels", () => {
    render(<FilterChips chips={VM_CHIPS} activeIds={[]} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "All" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Summarized" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Last 7d" })).toBeInTheDocument();
  });

  it("marks active chips with aria-pressed=true", () => {
    render(<FilterChips chips={VM_CHIPS} activeIds={["summarized"]} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "Summarized" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Last 7d" })).toHaveAttribute("aria-pressed", "false");
  });

  it("clicking a chip toggles it on, calling onChange with new active set", async () => {
    const onChange = vi.fn();
    render(<FilterChips chips={VM_CHIPS} activeIds={[]} onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Summarized" }));
    expect(onChange).toHaveBeenCalledWith(["summarized"]);
  });

  it("clicking an active chip toggles it off", async () => {
    const onChange = vi.fn();
    render(<FilterChips chips={VM_CHIPS} activeIds={["summarized", "last7d"]} onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Summarized" }));
    expect(onChange).toHaveBeenCalledWith(["last7d"]);
  });

  it("clicking 'All' (the chip with id='all') clears all other selections", async () => {
    const onChange = vi.fn();
    render(<FilterChips chips={VM_CHIPS} activeIds={["summarized", "last7d"]} onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "All" }));
    expect(onChange).toHaveBeenCalledWith([]);
  });

  it("'All' chip is active when activeIds is empty", () => {
    render(<FilterChips chips={VM_CHIPS} activeIds={[]} onChange={() => {}} />);
    expect(screen.getByRole("button", { name: "All" })).toHaveAttribute("aria-pressed", "true");
  });
});
