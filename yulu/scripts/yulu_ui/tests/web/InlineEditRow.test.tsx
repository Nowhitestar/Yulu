import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { InlineEditRow } from "../../web/src/components/InlineEditRow.js";

vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    system: {
      pickFile: { useMutation: () => ({ mutateAsync: async () => ({ path: "/picked/dir" }), isPending: false }) },
      openInFinder: { useMutation: () => ({ mutate: vi.fn() }) },
    },
    // PathValue calls useUtils().system.cloud.detect.fetch() on a folder pick (DATA-03);
    // default not-cloud so the picker commits immediately (this suite covers the base flow,
    // not the cloud-warn branch — see InlineEditRow.cloudwarn.test.tsx).
    useUtils: () => ({
      system: { cloud: { detect: { fetch: async () => ({ is_cloud: false, engine: "", reason: "", dataless: false }) } } },
    }),
  },
}));

describe("InlineEditRow", () => {
  it("text variant: shows value, click → input, Enter commits", async () => {
    const onCommit = vi.fn();
    render(<InlineEditRow label="L" type="text" value="abc" onCommit={onCommit} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("abc"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "xyz{Enter}");
    expect(onCommit).toHaveBeenCalledWith("xyz");
  });

  it("text variant: blur commits", async () => {
    const onCommit = vi.fn();
    render(<InlineEditRow label="L" type="text" value="abc" onCommit={onCommit} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("abc"));
    const input = screen.getByRole("textbox");
    await user.clear(input);
    await user.type(input, "xyz");
    await user.tab();   // blur
    expect(onCommit).toHaveBeenCalledWith("xyz");
  });

  it("number variant: commits parsed number", async () => {
    const onCommit = vi.fn();
    render(<InlineEditRow label="L" type="number" value={0.5} onCommit={onCommit} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("0.5"));
    const input = screen.getByRole("spinbutton");
    await user.clear(input);
    await user.type(input, "0.7{Enter}");
    expect(onCommit).toHaveBeenCalledWith(0.7);
  });

  it("select variant: commits on change", async () => {
    const onCommit = vi.fn();
    render(<InlineEditRow label="L" type="select" value="a" options={[{value:"a",label:"A"},{value:"b",label:"B"}]} onCommit={onCommit} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("A"));
    const select = screen.getByRole("combobox");
    await user.selectOptions(select, "b");
    expect(onCommit).toHaveBeenCalledWith("b");
  });

  it("toggle variant: commits immediately on click", async () => {
    const onCommit = vi.fn();
    render(<InlineEditRow label="L" type="toggle" value={false} onCommit={onCommit} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("switch"));
    expect(onCommit).toHaveBeenCalledWith(true);
  });

  it("path variant: 'Choose…' button fires pickFile + onCommit", async () => {
    const onCommit = vi.fn();
    render(<InlineEditRow label="L" type="path" value="/old/dir" mode="folder" onCommit={onCommit} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /选择/ }));
    // mutateAsync resolves to { path: "/picked/dir" }
    await vi.waitFor(() => expect(onCommit).toHaveBeenCalledWith("/picked/dir"));
  });

  it("readonly variant: displays value, no edit input", async () => {
    render(<InlineEditRow label="L" type="readonly" value="immutable" />);
    expect(screen.getByText("immutable")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("status icon renders ✓ when status='saved', ⟳ when 'restart'", () => {
    const { rerender } = render(<InlineEditRow label="L" type="text" value="x" onCommit={() => {}} status="saved" />);
    expect(screen.getByTestId("row-status")).toHaveTextContent("✓");
    rerender(<InlineEditRow label="L" type="text" value="x" onCommit={() => {}} status="restart" />);
    expect(screen.getByTestId("row-status")).toHaveTextContent("⟳");
  });
});
