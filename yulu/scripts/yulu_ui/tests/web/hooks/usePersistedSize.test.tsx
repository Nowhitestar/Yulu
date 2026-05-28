import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { usePersistedSize } from "../../../web/src/hooks/usePersistedSize";

describe("usePersistedSize", () => {
  beforeEach(() => { localStorage.clear(); });

  it("returns default size when nothing stored", () => {
    const { result } = renderHook(() => usePersistedSize("test-key", 250));
    expect(result.current[0]).toBe(250);
  });

  it("reads previously stored value", () => {
    localStorage.setItem("test-key", "320");
    const { result } = renderHook(() => usePersistedSize("test-key", 250));
    expect(result.current[0]).toBe(320);
  });

  it("persists new value to localStorage", () => {
    const { result } = renderHook(() => usePersistedSize("test-key", 250));
    act(() => result.current[1](400));
    expect(result.current[0]).toBe(400);
    expect(localStorage.getItem("test-key")).toBe("400");
  });

  it("falls back to in-memory state if localStorage throws", () => {
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error("quota"); };
    try {
      const { result } = renderHook(() => usePersistedSize("test-key", 250));
      act(() => result.current[1](500));
      expect(result.current[0]).toBe(500);
    } finally {
      Storage.prototype.setItem = orig;
    }
  });

  it("ignores non-numeric stored values", () => {
    localStorage.setItem("test-key", "garbage");
    const { result } = renderHook(() => usePersistedSize("test-key", 250));
    expect(result.current[0]).toBe(250);
  });
});
