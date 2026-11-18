// The window itself: a left pane, a reading sheet, and almost no chrome.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";

vi.mock("../../web/src/trpc.js", () => {
  const recordings = [
    { stem: "Standup_20260102_090000", title: "Standup", recordedAt: null, durationSeconds: 600, status: "idle" },
    { stem: "Review_20260101_140000", title: "Review", recordedAt: null, durationSeconds: 1800, status: "idle" },
  ];
  const noop = () => ({ data: undefined, isPending: false });
  const mutation = () => ({ mutate: () => {}, mutateAsync: () => Promise.resolve(undefined), isPending: false });
  const any: unknown = new Proxy({}, { get: () => new Proxy({}, { get: () => ({ useQuery: noop, useMutation: mutation }) }) });
  return {
    trpc: new Proxy({}, {
      get(_target, prop) {
        if (prop === "useUtils") return () => any;
        if (prop === "recordings") {
          return new Proxy({}, { get: (_t, name) => name === "list"
            ? { useQuery: () => ({ data: recordings, isPending: false }) }
            : { useQuery: noop, useMutation: mutation } });
        }
        return new Proxy({}, { get: () => ({ useQuery: noop, useMutation: mutation }) });
      },
    }),
  };
});
vi.mock("../../web/src/ws.js", () => ({ useWsChannel: () => {} }));

import { RootLayout } from "../../web/src/routes/root.js";
import { LanguageProvider } from "../../web/src/i18n/LanguageProvider.js";
import { isSettingsArea, showsDetail, ALL_DESTINATIONS } from "../../web/src/navigation.js";

function mount(path = "/inbox/Standup_20260102_090000") {
  const router = createMemoryRouter([{
    path: "/",
    Component: RootLayout,
    children: [
      { path: "inbox", element: <p>nothing open</p> },
      { path: "inbox/:stem", element: <article data-testid="reader"><input aria-label="note" /></article> },
      { path: "settings/:category", element: <h1>settings page</h1> },
      { path: "knowledge/glossary", element: <h1>glossary page</h1> },
      { path: "health", element: <h1>status page</h1> },
    ],
  }], { initialEntries: [path] });
  const view = render(<LanguageProvider><RouterProvider router={router} /></LanguageProvider>);
  const shell = view.container.querySelector(".root-shell") as HTMLElement;
  return { ...view, router, shell };
}

beforeEach(() => { localStorage.clear(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("navigation", () => {
  it("knows which places belong to Settings", () => {
    expect(["/settings", "/settings/voice", "/knowledge/prompts/new", "/health"].map(isSettingsArea)).toEqual([true, true, true, true]);
    expect(["/inbox", "/inbox/a", "/onboarding", "/settingsx", "/"].map(isSettingsArea)).toEqual([false, false, false, false, false]);
  });

  it("treats only the two lists as list-only on a narrow window", () => {
    expect(showsDetail("/inbox")).toBe(false);
    expect(showsDetail("/settings")).toBe(false);
    expect(["/inbox/a", "/settings/general", "/health", "/onboarding"].map(showsDetail)).toEqual([true, true, true, true]);
  });

  it("has nine places in all, none of them an assistant", () => {
    expect(ALL_DESTINATIONS.map((destination) => destination.to)).toEqual([
      "/inbox", "/settings/general", "/settings/recording", "/settings/meetings", "/settings/voice",
      "/settings/connections", "/knowledge/prompts", "/knowledge/glossary", "/health",
    ]);
  });
});

describe("RootLayout", () => {
  it("shows the recordings beside what you are reading, with three things in the toolbar", () => {
    const { container, shell } = mount();
    expect(shell).toHaveAttribute("data-pane", "open");
    expect(shell).toHaveAttribute("data-detail", "true");
    const pane = container.querySelector(".root-pane") as HTMLElement;
    expect(within(pane).getByRole("button", { name: "搜索" })).toBeInTheDocument();
    expect(within(pane).getAllByTestId("recording-row").map((row) => row.textContent)).toEqual(["Standup10 分钟", "Review30 分钟"]);
    expect(pane.querySelector("nav")).toBeNull();
    expect(screen.getByTestId("reader")).toBeInTheDocument();

    const toolbar = container.querySelector(".topbar") as HTMLElement;
    expect(within(toolbar).getByRole("button", { name: "收起侧边栏" })).toHaveAttribute("aria-controls", "app-pane");
    expect(within(toolbar).getByRole("link", { name: "设置" })).toHaveAttribute("href", "/settings");
    expect(toolbar.querySelector(".topbar-record")).not.toBeNull();
    // No logo, breadcrumb, back/forward or theme switch.
    expect(toolbar.querySelectorAll("img, .topbar-breadcrumb, [aria-label='前进'], [aria-label*='主题']")).toHaveLength(0);
  });

  it("tucks the recordings away, and remembers that", () => {
    const first = mount();
    fireEvent.click(screen.getByRole("button", { name: "收起侧边栏" }));
    expect(first.shell).toHaveAttribute("data-pane", "closed");
    const show = screen.getByRole("button", { name: "显示侧边栏" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    expect(localStorage.getItem("yulu_ui.pane")).toBe("closed");
    first.unmount();

    const second = mount();
    expect(second.shell).toHaveAttribute("data-pane", "closed");
    fireEvent.click(screen.getByRole("button", { name: "显示侧边栏" }));
    expect(second.shell).toHaveAttribute("data-pane", "open");
    expect(localStorage.getItem("yulu_ui.pane")).toBe("open");
  });

  it("toggles the pane with the macOS sidebar shortcut", () => {
    const { shell } = mount();
    fireEvent.keyDown(window, { key: "s", code: "KeyS", metaKey: true, ctrlKey: true });
    expect(shell).toHaveAttribute("data-pane", "closed");
    fireEvent.keyDown(window, { key: "s", code: "KeyS", metaKey: true, ctrlKey: true });
    expect(shell).toHaveAttribute("data-pane", "open");
    // Plain ⌘S is not ours to take.
    fireEvent.keyDown(window, { key: "s", code: "KeyS", metaKey: true });
    expect(shell).toHaveAttribute("data-pane", "open");
  });

  it("still works when the browser refuses storage", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    const { shell } = mount();
    expect(shell).toHaveAttribute("data-pane", "open");
    fireEvent.click(screen.getByRole("button", { name: "收起侧边栏" }));
    expect(shell).toHaveAttribute("data-pane", "closed");
  });

  it("turns the pane into the settings list inside Settings, and always shows it there", () => {
    localStorage.setItem("yulu_ui.pane", "closed");
    const { container, shell, router } = mount("/settings/general");
    expect(shell).toHaveAttribute("data-pane", "open");
    const pane = container.querySelector(".root-pane") as HTMLElement;
    expect(within(pane).getByRole("navigation", { name: "设置分类" })).toBeInTheDocument();
    expect(within(pane).queryByTestId("recording-row")).toBeNull();
    // The gear and the pane toggle have nothing to do here.
    expect(screen.queryByRole("button", { name: /侧边栏/ })).toBeNull();
    expect(within(container.querySelector(".topbar") as HTMLElement).queryByRole("link", { name: "设置" })).toBeNull();
    fireEvent.keyDown(window, { key: "s", code: "KeyS", metaKey: true, ctrlKey: true });
    expect(shell).toHaveAttribute("data-pane", "open");

    // Leaving Settings restores the choice you made for recordings.
    act(() => { void router.navigate("/inbox/Standup_20260102_090000"); });
    expect(shell).toHaveAttribute("data-pane", "closed");
  });

  it("returns from Settings to the recording you were reading", () => {
    const { router } = mount("/inbox/Review_20260101_140000");
    act(() => { void router.navigate("/settings/general"); });
    expect(screen.getByRole("link", { name: "返回录音" })).toHaveAttribute("href", "/inbox/Review_20260101_140000");
    act(() => { void router.navigate("/health"); });
    expect(screen.getByRole("link", { name: "返回录音" })).toHaveAttribute("href", "/inbox/Review_20260101_140000");
  });

  it("opens the command palette from the search field and with ⌘K, and closes it on navigation", () => {
    const { router } = mount();
    const field = screen.getByRole("button", { name: "搜索" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(field);
    expect(screen.getByRole("dialog", { name: "搜索" })).toBeInTheDocument();
    expect(field).toHaveAttribute("aria-expanded", "true");
    fireEvent.keyDown(screen.getByRole("combobox", { name: "搜索" }), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.keyDown(window, { key: "k", code: "KeyK", metaKey: true });
    expect(screen.getByRole("dialog", { name: "搜索" })).toBeInTheDocument();
    // ⌘K is not also the list's "k": the recording you were reading stays open.
    expect(router.state.location.pathname).toBe("/inbox/Standup_20260102_090000");
    fireEvent.click(screen.getByRole("option", { name: "术语表" }));
    expect(router.state.location.pathname).toBe("/knowledge/glossary");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByRole("heading", { name: "glossary page" })).toBeInTheDocument();
  });

  it("marks the list-only state for narrow windows", () => {
    expect(mount("/inbox").shell).toHaveAttribute("data-detail", "false");
  });
});
