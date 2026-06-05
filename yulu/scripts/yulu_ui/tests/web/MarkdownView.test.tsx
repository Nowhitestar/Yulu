import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownView } from "../../web/src/components/MarkdownView.js";

describe("MarkdownView", () => {
  it("renders headings as real heading elements", () => {
    render(<MarkdownView text={"# Title\n\nbody text"} />);
    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getByText("body text")).toBeInTheDocument();
  });

  it("renders bullet lists", () => {
    const { container } = render(<MarkdownView text={"- one\n- two\n- three"} />);
    expect(container.querySelectorAll("li")).toHaveLength(3);
  });

  it("renders GFM tables (remark-gfm enabled)", () => {
    const { container } = render(
      <MarkdownView text={"| A | B |\n| - | - |\n| 1 | 2 |"} />
    );
    expect(container.querySelector("table")).not.toBeNull();
    expect(container.querySelectorAll("th")).toHaveLength(2);
  });

  it("does NOT inject raw HTML — script tags are inert text, never executed", () => {
    const { container } = render(
      <MarkdownView text={'before <script>window.__xss = 1</script> after'} />
    );
    // react-markdown without rehype-raw renders raw HTML as literal text.
    expect(container.querySelector("script")).toBeNull();
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
    expect(container.textContent).toContain("window.__xss = 1");
  });

  it("forces links to open in a new tab with noopener", () => {
    render(<MarkdownView text={"[link](https://example.com)"} />);
    const a = screen.getByRole("link", { name: "link" });
    expect(a).toHaveAttribute("target", "_blank");
    expect(a).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("renders bold and inline code", () => {
    const { container } = render(<MarkdownView text={"**strong** and `code`"} />);
    expect(container.querySelector("strong")?.textContent).toBe("strong");
    expect(container.querySelector("code")?.textContent).toBe("code");
  });
});
