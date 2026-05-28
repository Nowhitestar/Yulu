import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HotkeyCapture, formatHotkey } from "../../web/src/components/HotkeyCapture.js";

describe("formatHotkey", () => {
  it("renders modifiers + key as glyphs", () => {
    expect(formatHotkey({ key: "V", modifiers: ["cmd", "shift"] })).toBe("⌘⇧V");
    expect(formatHotkey({ key: "F19", modifiers: ["alt"] })).toBe("⌥F19");
    expect(formatHotkey({ key: "K", modifiers: ["cmd", "ctrl"] })).toBe("⌘⌃K");
  });
});

describe("HotkeyCapture", () => {
  it("renders current hotkey glyph", () => {
    render(<HotkeyCapture value={{ key: "V", modifiers: ["cmd", "shift"] }} onCommit={() => {}} />);
    expect(screen.getByText("⌘⇧V")).toBeInTheDocument();
  });

  it("clicking enters capture mode showing 'Press a key combination'", async () => {
    render(<HotkeyCapture value={{ key: "V", modifiers: ["cmd", "shift"] }} onCommit={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("⌘⇧V"));
    expect(screen.getByText(/press your hotkey/i)).toBeInTheDocument();
  });

  it("keydown with modifiers captures the combo + shows Save button", () => {
    render(<HotkeyCapture value={{ key: "V", modifiers: ["cmd", "shift"] }} onCommit={() => {}} />);
    fireEvent.click(screen.getByText("⌘⇧V"));
    const captureArea = screen.getByRole("textbox");   // capture area uses contenteditable / role=textbox
    fireEvent.keyDown(captureArea, { key: "K", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false });
    expect(screen.getByText("⌘K")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /save/i })).toBeInTheDocument();
  });

  it("Save commits the captured combo", async () => {
    const onCommit = vi.fn();
    render(<HotkeyCapture value={{ key: "V", modifiers: ["cmd", "shift"] }} onCommit={onCommit} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("⌘⇧V"));
    const captureArea = screen.getByRole("textbox");
    fireEvent.keyDown(captureArea, { key: "K", metaKey: true });
    await user.click(screen.getByRole("button", { name: /save/i }));
    expect(onCommit).toHaveBeenCalledWith({ key: "K", modifiers: ["cmd"] });
  });

  it("Escape cancels capture", async () => {
    render(<HotkeyCapture value={{ key: "V", modifiers: ["cmd", "shift"] }} onCommit={() => {}} />);
    const user = userEvent.setup();
    await user.click(screen.getByText("⌘⇧V"));
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    expect(screen.queryByText(/press your hotkey/i)).toBeNull();
    expect(screen.getByText("⌘⇧V")).toBeInTheDocument();   // back to displaying original
  });
});
