import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  config: { ui: { theme: { family: "ayu", mode: "dark" } } },
  update: vi.fn(), invalidate: vi.fn(), fail: false,
}));
vi.mock("../../web/src/trpc.js", () => ({
  trpc: {
    config: {
      get: { useQuery: () => ({ data: state.config }) },
      update: { useMutation: () => ({ mutate: (input: unknown, options: { onError: (error: Error) => void; onSettled: () => void }) => {
        state.update(input);
        if (state.fail) options.onError(new Error("Could not save preferences"));
        options.onSettled();
      } }) },
    },
    useUtils: () => ({ config: { get: { invalidate: state.invalidate } } }),
  },
}));
import { ThemeProvider, ThemeConfigSync, useTheme } from "../../web/src/theme.js";
function SwitchTheme() {
  const theme = useTheme();
  return <button onClick={() => theme.setFamily("paper")}>Paper</button>;
}
beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); state.fail = false; });
function mount(onError = vi.fn()) {
  render(<ThemeProvider><ThemeConfigSync onError={onError} /><SwitchTheme /></ThemeProvider>);
}
describe("Theme preference persistence", () => {
  it("applies saved appearance without overwriting it with the browser default", () => {
    mount();
    expect(document.documentElement.dataset.themeFamily).toBe("ayu");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(state.update).not.toHaveBeenCalled();
  });
  it("persists an explicit appearance change", async () => {
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Paper" }));
    await waitFor(() => expect(state.update).toHaveBeenCalledWith({ key: "ui.theme", value: expect.objectContaining({ family: "paper", mode: "dark" }) }));
    expect(state.update).toHaveBeenCalledOnce();
  });
  it("surfaces failed saves and restores the saved appearance", async () => {
    state.fail = true;
    const onError = vi.fn();
    mount(onError);
    fireEvent.click(screen.getByRole("button", { name: "Paper" }));
    await waitFor(() => expect(onError).toHaveBeenCalledWith("Could not save preferences"));
    expect(document.documentElement.dataset.themeFamily).toBe("ayu");
    expect(localStorage.getItem("yulu_theme_family")).toBe("ayu");
  });
});
