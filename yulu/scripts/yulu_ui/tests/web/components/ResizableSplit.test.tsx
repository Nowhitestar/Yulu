import { describe, it, expect, beforeEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { ResizableSplit } from "../../../web/src/components/ResizableSplit";

describe("ResizableSplit", () => {
  beforeEach(() => { localStorage.clear(); });

  it("renders children at the default width", () => {
    const { container } = render(
      <ResizableSplit storageKey="rs-test" side="right" min={100} max={400} defaultWidth={220}>
        <div>child content</div>
      </ResizableSplit>
    );
    const pane = container.querySelector(".rs-pane") as HTMLElement;
    expect(pane.style.width).toBe("220px");
  });

  it("renders a drag handle on the requested side", () => {
    const { container } = render(
      <ResizableSplit storageKey="rs-test" side="right" min={100} max={400} defaultWidth={220}>
        <div>child</div>
      </ResizableSplit>
    );
    const handle = container.querySelector('.rs-handle[data-side="right"]');
    expect(handle).not.toBeNull();
  });

  it("updates width when handle is dragged", () => {
    const { container } = render(
      <ResizableSplit storageKey="rs-test" side="right" min={100} max={400} defaultWidth={220}>
        <div>child</div>
      </ResizableSplit>
    );
    const handle = container.querySelector(".rs-handle") as HTMLElement;
    const pane = container.querySelector(".rs-pane") as HTMLElement;

    fireEvent.mouseDown(handle, { clientX: 220 });
    fireEvent.mouseMove(window, { clientX: 300 });
    fireEvent.mouseUp(window);

    expect(parseInt(pane.style.width, 10)).toBe(300);
    expect(localStorage.getItem("rs-test")).toBe("300");
  });

  it("clamps width to min/max", () => {
    const { container } = render(
      <ResizableSplit storageKey="rs-test" side="right" min={150} max={300} defaultWidth={220}>
        <div>child</div>
      </ResizableSplit>
    );
    const handle = container.querySelector(".rs-handle") as HTMLElement;
    const pane = container.querySelector(".rs-pane") as HTMLElement;

    fireEvent.mouseDown(handle, { clientX: 220 });
    fireEvent.mouseMove(window, { clientX: 50 });
    fireEvent.mouseUp(window);
    expect(parseInt(pane.style.width, 10)).toBe(150);

    fireEvent.mouseDown(handle, { clientX: 150 });
    fireEvent.mouseMove(window, { clientX: 999 });
    fireEvent.mouseUp(window);
    expect(parseInt(pane.style.width, 10)).toBe(300);
  });

  it("resets to defaultWidth on double-click", () => {
    localStorage.setItem("rs-test", "400");
    const { container } = render(
      <ResizableSplit storageKey="rs-test" side="right" min={100} max={500} defaultWidth={220}>
        <div>child</div>
      </ResizableSplit>
    );
    const handle = container.querySelector(".rs-handle") as HTMLElement;
    fireEvent.doubleClick(handle);
    const pane = container.querySelector(".rs-pane") as HTMLElement;
    expect(parseInt(pane.style.width, 10)).toBe(220);
    expect(localStorage.getItem("rs-test")).toBe("220");
  });
});
