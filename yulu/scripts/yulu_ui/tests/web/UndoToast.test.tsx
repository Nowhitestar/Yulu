import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import { UndoToastProvider, useUndoToast, type UndoRequest } from "../../web/src/components/UndoToast.js";

// A tiny consumer that fires showUndo on demand so we can exercise the provider.
function Trigger({ req }: { req: UndoRequest }) {
  const { showUndo } = useUndoToast();
  return <button onClick={() => showUndo(req)}>fire</button>;
}

describe("UndoToast", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is hidden until showUndo is called", () => {
    render(<UndoToastProvider><Trigger req={{ label: "x", onUndo: () => {} }} /></UndoToastProvider>);
    expect(screen.queryByTestId("undo-toast")).toBeNull();
  });

  it("shows '已保存 · 撤销' after showUndo and auto-dismisses", () => {
    render(<UndoToastProvider><Trigger req={{ label: "x", onUndo: () => {} }} /></UndoToastProvider>);
    act(() => { fireEvent.click(screen.getByText("fire")); });
    const toast = screen.getByTestId("undo-toast");
    expect(toast).toHaveTextContent("已保存");
    expect(toast).toHaveTextContent("撤销");
    // Auto-dismiss after the timeout.
    act(() => { vi.advanceTimersByTime(7000); });
    expect(screen.queryByTestId("undo-toast")).toBeNull();
  });

  it("clicking 撤销 invokes onUndo and closes the toast", () => {
    const onUndo = vi.fn();
    render(<UndoToastProvider><Trigger req={{ label: "x", onUndo }} /></UndoToastProvider>);
    act(() => { fireEvent.click(screen.getByText("fire")); });
    act(() => { fireEvent.click(screen.getByText("撤销")); });
    expect(onUndo).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("undo-toast")).toBeNull();
  });

  it("a newer save replaces the previous toast (single slot)", () => {
    function Two() {
      const { showUndo } = useUndoToast();
      return (
        <>
          <button onClick={() => showUndo({ label: "a", onUndo: () => {} })}>a</button>
          <button onClick={() => showUndo({ label: "b", onUndo: () => {} })}>b</button>
        </>
      );
    }
    render(<UndoToastProvider><Two /></UndoToastProvider>);
    act(() => { fireEvent.click(screen.getByText("a")); });
    act(() => { fireEvent.click(screen.getByText("b")); });
    // Still exactly one toast slot.
    expect(screen.getAllByTestId("undo-toast").length).toBe(1);
  });
});
