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
    document.documentElement.removeAttribute("data-theme-family");
    document.documentElement.removeAttribute("data-theme-preset");
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

  it("setPreset('ayu') persists as a family and mode controls light/dark", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.setPreset("ayu"));
    act(() => result.current.set("dark"));
    expect(localStorage.getItem("yulu_theme_family")).toBe("ayu");
    expect(result.current.preset).toBe("ayu");
    expect(result.current.resolved).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme-family")).toBe("ayu");
    expect(document.documentElement.getAttribute("data-theme-preset")).toBe("ayu-dark");
  });

  it("custom theme persists and writes CSS variables", () => {
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.setPreset("custom"));
    act(() => result.current.set("dark"));
    act(() => result.current.setCustomTheme({
      ...result.current.customTheme,
      dark: {
        ...result.current.customTheme.dark,
        accent: "#123456",
      },
    }));
    expect(localStorage.getItem("yulu_custom_theme_v2")).toContain("#123456");
    expect(result.current.resolved).toBe("dark");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
  });

  it("set('auto') persists auto mode for config-backed theme state", () => {
    localStorage.setItem("yulu_theme", "dark");
    const { result } = renderHook(() => useTheme(), { wrapper });
    act(() => result.current.set("auto"));
    expect(localStorage.getItem("yulu_theme_mode")).toBe("auto");
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
