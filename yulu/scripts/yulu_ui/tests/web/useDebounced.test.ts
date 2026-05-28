import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useDebounced } from "../../web/src/hooks/useDebounced.js";

describe("useDebounced", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns the initial value immediately", () => {
    const { result } = renderHook(() => useDebounced("hello", 200));
    expect(result.current).toBe("hello");
  });

  it("returns the new value only after the delay elapses", () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 200), { initialProps: { v: "a" } });
    rerender({ v: "b" });
    expect(result.current).toBe("a");
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toBe("a");
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toBe("b");
  });

  it("resets the timer when the value changes again within the delay", () => {
    const { result, rerender } = renderHook(({ v }) => useDebounced(v, 200), { initialProps: { v: "a" } });
    rerender({ v: "b" });
    act(() => { vi.advanceTimersByTime(150); });
    rerender({ v: "c" });
    act(() => { vi.advanceTimersByTime(150); });
    expect(result.current).toBe("a");
    act(() => { vi.advanceTimersByTime(100); });
    expect(result.current).toBe("c");
  });
});
