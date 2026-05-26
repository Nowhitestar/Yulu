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

  it("list column has fixed 220px width via data attribute", () => {
    const { container } = render(<MasterDetail listSlot={<span />} detailSlot={<span />} />);
    const list = container.querySelector(".masterdetail-list");
    expect(list).not.toBeNull();
    expect(list?.getAttribute("data-width")).toBe("220");
  });
});
