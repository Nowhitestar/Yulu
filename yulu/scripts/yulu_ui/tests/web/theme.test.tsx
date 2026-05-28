// tests/web/theme.test.tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render, renderHook, act } from "@testing-library/react";
import type { ReactNode } from "react";
import { ThemeProvider, useTheme } from "../../web/src/theme.js";

function wrapper({ children }: { children: ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

describe("ThemeProvider + useTheme", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
  });

  it("defaults to auto + resolves to dark when matchMedia matches dark", () => {
    (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (q: string) => ({
      matches: q.includes("dark"),
      media: q, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    } as MediaQueryList);

    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.choice).toBe("auto");
    expect(result.current.resolved).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("set('light') persists to localStorage and flips data-theme", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.set("light"));
    expect(localStorage.getItem("yulu_theme")).toBe("light");
    expect(result.current.choice).toBe("light");
    expect(result.current.resolved).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("set('auto') clears localStorage", () => {
    localStorage.setItem("yulu_theme", "dark");
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.set("auto"));
    expect(localStorage.getItem("yulu_theme")).toBeNull();
    expect(result.current.choice).toBe("auto");
  });

  it("reads existing localStorage value on mount", () => {
    localStorage.setItem("yulu_theme", "light");
    const { result } = renderHook(() => useTheme(), { wrapper });
    expect(result.current.choice).toBe("light");
    expect(result.current.resolved).toBe("light");
  });

  it("renders children without crashing", () => {
    const { getByText } = render(<ThemeProvider><span>hi</span></ThemeProvider>);
    expect(getByText("hi")).toBeInTheDocument();
  });
});
