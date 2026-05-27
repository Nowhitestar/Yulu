import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TestPopover } from "../../web/src/components/TestPopover.js";

describe("TestPopover", () => {
  it("renders pending status while pending=true", () => {
    render(<TestPopover state="pending" onClose={vi.fn()} />);
    expect(screen.getByText(/running/i)).toBeInTheDocument();
  });

  it("renders ok status with stdout when state='ok'", () => {
    render(<TestPopover state="ok" stdout="Hello world!" stderr="" onClose={vi.fn()} />);
    expect(screen.getByText("✓ ok")).toBeInTheDocument();
    expect(screen.getByText("Hello world!")).toBeInTheDocument();
  });

  it("renders failed status with stderr when state='failed'", () => {
    render(<TestPopover state="failed" stdout="" stderr="boom" onClose={vi.fn()} />);
    expect(screen.getByText("✗ failed")).toBeInTheDocument();
    expect(screen.getByText("boom")).toBeInTheDocument();
  });

  it("fires onClose when × clicked", async () => {
    const onClose = vi.fn();
    render(<TestPopover state="ok" stdout="x" stderr="" onClose={onClose} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});
