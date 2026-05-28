import { render } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { Logo } from "../../../web/src/components/Logo";

describe("Logo", () => {
  it("renders an SVG with role=img and aria-label Yulu", () => {
    const { container } = render(<Logo />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute("role")).toBe("img");
    expect(svg?.getAttribute("aria-label")).toBe("Yulu");
  });

  it("contains the 语 glyph", () => {
    const { container } = render(<Logo />);
    expect(container.textContent).toContain("语");
  });

  it("includes a cinnabar dot (circle with fill #A23B2B)", () => {
    const { container } = render(<Logo />);
    const circle = container.querySelector("circle");
    expect(circle).not.toBeNull();
    expect(circle?.getAttribute("fill")).toBe("#A23B2B");
  });

  it("accepts a custom size prop", () => {
    const { container } = render(<Logo size={48} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("48");
    expect(svg?.getAttribute("height")).toBe("48");
  });
});
