import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CommandEditor } from "../../web/src/components/CommandEditor.js";

describe("CommandEditor", () => {
  it("renders one input per arg", () => {
    render(<CommandEditor value={["claude", "--print"]} onChange={() => {}} />);
    const inputs = screen.getAllByRole("textbox");
    expect(inputs).toHaveLength(2);
    expect((inputs[0] as HTMLInputElement).value).toBe("claude");
    expect((inputs[1] as HTMLInputElement).value).toBe("--print");
  });

  it("typing into an input + blur emits onChange with new array", async () => {
    const onChange = vi.fn();
    render(<CommandEditor value={["claude", "--print"]} onChange={onChange} />);
    const user = userEvent.setup();
    const second = screen.getAllByRole("textbox")[1]!;
    await user.clear(second);
    await user.type(second, "--quiet");
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith(["claude", "--quiet"]);
  });

  it("'+ Add arg' appends an empty string", async () => {
    const onChange = vi.fn();
    render(<CommandEditor value={["claude"]} onChange={onChange} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /add arg/i }));
    expect(onChange).toHaveBeenCalledWith(["claude", ""]);
  });

  it("× button removes the arg", async () => {
    const onChange = vi.fn();
    render(<CommandEditor value={["claude", "--print", "--model"]} onChange={onChange} />);
    const user = userEvent.setup();
    const removeButtons = screen.getAllByRole("button", { name: /remove/i });
    await user.click(removeButtons[1]!);
    expect(onChange).toHaveBeenCalledWith(["claude", "--model"]);
  });
});
