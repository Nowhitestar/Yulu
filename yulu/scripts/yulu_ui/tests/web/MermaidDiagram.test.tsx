import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

const renderDiagram = vi.fn(async (_id: string, source: string) => {
  if (source.includes("broken")) throw new Error("Parse error");
  return { svg: `<svg data-testid="diagram"><text>${source.length}</text></svg>` };
});
const initialize = vi.fn();
vi.mock("mermaid", () => ({ default: { initialize, render: renderDiagram } }));

import { MarkdownView } from "../../web/src/components/MarkdownView.js";

describe("Mermaid in Markdown", () => {
  it("draws a mermaid block in strict mode and leaves other code alone", async () => {
    const { container } = render(<MarkdownView text={"## Arch\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\n```js\nconst x = 1;\n```"} />);
    await waitFor(() => expect(screen.getByTestId("diagram")).toBeInTheDocument());
    expect(initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", startOnLoad: false }));
    expect(renderDiagram.mock.calls[0]![1]).toBe("flowchart LR\n  A --> B\n");
    expect(container.querySelector("pre code")?.textContent).toContain("const x = 1;");
  });

  it("shows the source when a diagram does not parse", async () => {
    render(<MarkdownView text={"```mermaid\nbroken diagram\n```"} />);
    await waitFor(() => expect(screen.getByText("broken diagram")).toBeInTheDocument());
    expect(screen.queryByTestId("diagram")).toBeNull();
  });
});
