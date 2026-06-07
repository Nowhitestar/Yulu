import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TagEditor } from "../../web/src/components/TagEditor.js";

describe("TagEditor", () => {
  it("renders existing tags as chips", () => {
    render(<TagEditor tags={["work", "urgent"]} onChange={() => {}} />);
    expect(screen.getByText("work")).toBeInTheDocument();
    expect(screen.getByText("urgent")).toBeInTheDocument();
  });

  it("adds a tag on Enter", () => {
    const onChange = vi.fn();
    render(<TagEditor tags={["work"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "添加标签" }));
    const input = screen.getByPlaceholderText("标签…");
    fireEvent.change(input, { target: { value: "client" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["work", "client"]);
  });

  it("splits a comma-separated entry into multiple tags", () => {
    const onChange = vi.fn();
    render(<TagEditor tags={[]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "添加标签" }));
    const input = screen.getByPlaceholderText("标签…");
    fireEvent.change(input, { target: { value: "a, b ,c" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith(["a", "b", "c"]);
  });

  it("does not add a case-insensitive duplicate", () => {
    const onChange = vi.fn();
    render(<TagEditor tags={["Work"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "添加标签" }));
    const input = screen.getByPlaceholderText("标签…");
    fireEvent.change(input, { target: { value: "work" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("removes a tag via its ✕ button", () => {
    const onChange = vi.fn();
    render(<TagEditor tags={["work", "urgent"]} onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: "移除标签 work" }));
    expect(onChange).toHaveBeenCalledWith(["urgent"]);
  });

  it("hides editing affordances when disabled", () => {
    render(<TagEditor tags={["work"]} onChange={() => {}} disabled />);
    expect(screen.queryByRole("button", { name: /添加标签/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /remove tag/i })).toBeNull();
  });
});
