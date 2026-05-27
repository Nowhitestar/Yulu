import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useConfirm } from "../../web/src/hooks/useConfirm.js";

afterEach(() => { vi.restoreAllMocks(); });

describe("useConfirm", () => {
  it("returns true when window.confirm returns true", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { result } = renderHook(() => useConfirm());
    expect(result.current("really?")).toBe(true);
    expect(window.confirm).toHaveBeenCalledWith("really?");
  });

  it("returns false when window.confirm returns false", () => {
    vi.spyOn(window, "confirm").mockReturnValue(false);
    const { result } = renderHook(() => useConfirm());
    expect(result.current("really?")).toBe(false);
  });

  it("returns a stable reference across renders", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { result, rerender } = renderHook(() => useConfirm());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
  });
});
