import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmptyState } from "../../web/src/components/EmptyState.js";

describe("EmptyState", () => {
  it("renders label", () => {
    render(<EmptyState label="No items" />);
    expect(screen.getByText("No items")).toBeInTheDocument();
  });

  it("renders optional icon", () => {
    render(<EmptyState icon="📭" label="Empty" />);
    expect(screen.getByText("📭")).toBeInTheDocument();
  });

  it("renders optional CTA button + fires onClick", async () => {
    const onClick = vi.fn();
    render(<EmptyState label="Empty" cta={{ label: "Try again", onClick }} />);
    const btn = screen.getByRole("button", { name: "Try again" });
    const user = userEvent.setup();
    await user.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
