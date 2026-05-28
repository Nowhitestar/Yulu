import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CategoryChip } from "../../web/src/components/CategoryChip.js";

describe("CategoryChip", () => {
  it.each([
    ["summary", "summary"],
    ["cleanup", "cleanup"],
    ["voicemail", "voicemail"],
  ] as const)("renders label '%s'", (category, expectedText) => {
    render(<CategoryChip category={category} />);
    expect(screen.getByText(expectedText)).toBeInTheDocument();
  });

  it("applies category-specific data-category attribute", () => {
    const { container } = render(<CategoryChip category="summary" />);
    expect(container.querySelector(".category-chip")).toHaveAttribute("data-category", "summary");
  });
});
