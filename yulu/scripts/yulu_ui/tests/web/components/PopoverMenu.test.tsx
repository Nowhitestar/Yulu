import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PopoverMenu } from "../../../web/src/components/PopoverMenu.js";

function mount(onRename = vi.fn(), onChoose = vi.fn()) {
  render(
    <div>
      <button type="button">elsewhere</button>
      <PopoverMenu label="More actions" icon={<span>…</span>}>
        <select aria-label="Template" onChange={onChoose}><option>Minutes</option><option>Actions</option></select>
        <button type="button" data-close onClick={onRename}>Rename</button>
      </PopoverMenu>
    </div>,
  );
  return { onRename, onChoose, trigger: screen.getByRole("button", { name: "More actions" }) };
}

describe("PopoverMenu", () => {
  it("keeps its actions out of the page until asked", () => {
    const { trigger } = mount();
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByRole("menu", { name: "More actions" })).toBeInTheDocument();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(trigger);
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes after an action that asks it to, and stays open for one that does not", () => {
    const { onRename, onChoose, trigger } = mount();
    fireEvent.click(trigger);
    fireEvent.change(screen.getByRole("combobox", { name: "Template" }), { target: { value: "Actions" } });
    fireEvent.click(screen.getByRole("combobox", { name: "Template" }));
    expect(onChoose).toHaveBeenCalledOnce();
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(onRename).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape and gives focus back to its trigger", () => {
    const { trigger } = mount();
    fireEvent.click(trigger);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("closes on a press outside, not on one inside", () => {
    const { trigger } = mount();
    fireEvent.click(trigger);
    fireEvent.mouseDown(screen.getByRole("menu"));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByRole("button", { name: "elsewhere" }));
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
