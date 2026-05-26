import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, cleanup } from "@testing-library/react";
import { fireEvent } from "@testing-library/react";
import { useHotkeys } from "../../web/src/hooks/useHotkeys.js";

describe("useHotkeys", () => {
  afterEach(() => { cleanup(); });

  it("calls the handler when a registered key is pressed", () => {
    const onJ = vi.fn();
    renderHook(() => useHotkeys({ j: onJ }));
    fireEvent.keyDown(window, { key: "j" });
    expect(onJ).toHaveBeenCalledTimes(1);
  });

  it("does not call handler when focus is in an <input>", () => {
    const onJ = vi.fn();
    renderHook(() => useHotkeys({ j: onJ }));
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.keyDown(input, { key: "j" });
    expect(onJ).not.toHaveBeenCalled();
    document.body.removeChild(input);
  });

  it("does not call handler when focus is in a [contenteditable]", () => {
    const onJ = vi.fn();
    renderHook(() => useHotkeys({ j: onJ }));
    const div = document.createElement("div");
    div.setAttribute("contenteditable", "true");
    document.body.appendChild(div);
    div.focus();
    fireEvent.keyDown(div, { key: "j" });
    expect(onJ).not.toHaveBeenCalled();
    document.body.removeChild(div);
  });

  it("supports multiple keys", () => {
    const onJ = vi.fn();
    const onK = vi.fn();
    renderHook(() => useHotkeys({ j: onJ, k: onK }));
    fireEvent.keyDown(window, { key: "j" });
    fireEvent.keyDown(window, { key: "k" });
    expect(onJ).toHaveBeenCalledTimes(1);
    expect(onK).toHaveBeenCalledTimes(1);
  });

  it("removes listener on unmount", () => {
    const onJ = vi.fn();
    const { unmount } = renderHook(() => useHotkeys({ j: onJ }));
    unmount();
    fireEvent.keyDown(window, { key: "j" });
    expect(onJ).not.toHaveBeenCalled();
  });
});
