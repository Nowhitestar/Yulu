// tests/web/MasterDetail.test.tsx
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MasterDetail } from "../../web/src/components/MasterDetail.js";

describe("MasterDetail", () => {
  it("renders both list and detail slots", () => {
    render(<MasterDetail listSlot={<div>my-list</div>} detailSlot={<div>my-detail</div>} />);
    expect(screen.getByText("my-list")).toBeInTheDocument();
    expect(screen.getByText("my-detail")).toBeInTheDocument();
  });

  it("renders 8 skeleton rows when listPending is true (hides listSlot)", () => {
    render(<MasterDetail listSlot={<div>my-list</div>} detailSlot={<div>d</div>} listPending />);
    expect(screen.queryByText("my-list")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("masterdetail-skeleton")).toHaveLength(8);
  });

  it("list column is wrapped in ResizableSplit with default 360px width", () => {
    const { container } = render(<MasterDetail listSlot={<span />} detailSlot={<span />} />);
    const list = container.querySelector(".masterdetail-list");
    expect(list).not.toBeNull();
    const pane = container.querySelector(".rs-pane") as HTMLElement | null;
    expect(pane).not.toBeNull();
    expect(pane?.style.width).toBe("360px");
    expect(container.querySelector(".rs-handle")).not.toBeNull();
  });
});
