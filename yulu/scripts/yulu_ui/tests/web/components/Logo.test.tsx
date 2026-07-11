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

  it("renders the liquid-glass silhouette and quotation beads", () => {
    const { container } = render(<Logo />);
    expect(container.querySelector('[data-testid="logo-silhouette"]')).not.toBeNull();
    expect(container.querySelectorAll('[data-testid="logo-quotes"] path')).toHaveLength(2);
    expect(container.querySelector("text")).toBeNull();
  });

  it("accepts a custom size prop", () => {
    const { container } = render(<Logo size={48} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("width")).toBe("48");
    expect(svg?.getAttribute("height")).toBe("48");
  });

  it("uses unique gradient ids when multiple logos render", () => {
    const { container } = render(<><Logo /><Logo /></>);
    const ids = [...container.querySelectorAll("linearGradient, radialGradient")].map((node) => node.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
