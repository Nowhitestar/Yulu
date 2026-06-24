// tests/web/ThemePresetPicker.test.tsx
import { describe, it, expect, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "../../web/src/theme.js";
import { ThemePresetPicker } from "../../web/src/components/ThemePresetPicker.js";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-family");
  document.documentElement.removeAttribute("data-theme-preset");
});

function mount() {
  return render(<ThemeProvider><ThemePresetPicker /></ThemeProvider>);
}

describe("ThemePresetPicker", () => {
  it("renders built-in theme presets", () => {
    mount();
    expect(screen.getByRole("group", { name: "主题家族" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "主题明暗模式" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /默认/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Ayu/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Paper/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /自定义/ })).toBeInTheDocument();
  });

  it("persists the selected family and mode", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Ayu/ }));
    await user.click(screen.getByRole("button", { name: /深色/ }));
    expect(localStorage.getItem("yulu_theme_family")).toBe("ayu");
    expect(localStorage.getItem("yulu_theme_mode")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme-family")).toBe("ayu");
    expect(document.documentElement.getAttribute("data-theme-preset")).toBe("ayu-dark");
  });

  it("allows editing custom accent color", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /自定义/ }));
    await user.click(within(screen.getByRole("group", { name: "主题明暗模式" })).getByRole("button", { name: /深色/ }));
    await user.click(within(screen.getByRole("group", { name: "自定义主题明暗模式" })).getByRole("button", { name: /深色/ }));
    const accent = screen.getByLabelText("强调");
    fireEvent.change(accent, { target: { value: "#123456" } });
    expect(localStorage.getItem("yulu_custom_theme_v2")).toContain("#123456");
    expect(document.documentElement.style.getPropertyValue("--accent")).toBe("#123456");
  });
});
