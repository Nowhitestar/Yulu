// tests/web/ThemeToggle.test.tsx
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "../../web/src/theme.js";
import { ThemeToggle } from "../../web/src/components/ThemeToggle.js";

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute("data-theme");
});

function mount() {
  return render(<ThemeProvider><ThemeToggle /></ThemeProvider>);
}

describe("ThemeToggle", () => {
  it("renders three segments: Auto, Light, Dark", () => {
    mount();
    expect(screen.getByRole("button", { name: /自动/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /浅色/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /深色/ })).toBeInTheDocument();
  });

  it("marks the active choice with aria-pressed", async () => {
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /浅色/ }));
    expect(screen.getByRole("button", { name: /浅色/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /深色/ })).toHaveAttribute("aria-pressed", "false");
    expect(localStorage.getItem("yulu_theme")).toBe("light");
  });

  it("Auto clears localStorage", async () => {
    localStorage.setItem("yulu_theme", "dark");
    mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /自动/ }));
    expect(localStorage.getItem("yulu_theme")).toBeNull();
  });
});
