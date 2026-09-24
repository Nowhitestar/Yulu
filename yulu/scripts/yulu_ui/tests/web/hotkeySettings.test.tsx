import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { LanguageProvider } from "../../web/src/i18n/LanguageProvider.js";
import { DEFAULT_HOTKEYS } from "../../src/hotkeys.js";
const mock = vi.hoisted(() => ({ pause: vi.fn(async () => ({ ok: true })), commit: vi.fn(async () => ({})) }));
vi.mock("../../web/src/trpc.js", () => ({ trpc: { recording: {
  shortcutEditing: { useMutation: () => ({ mutateAsync: mock.pause, isPending: false }) },
} } }));
import { HotkeySettings } from "../../web/src/components/settings/HotkeySettings.js";

function wrap() {
  localStorage.setItem("yulu_ui.lang", "zh");
  return render(<LanguageProvider><HotkeySettings hotkeys={{ ...DEFAULT_HOTKEYS,
    translate: { ...DEFAULT_HOTKEYS.translate, target_language: "Japanese" } }} disabled={false} onCommit={mock.commit} /></LanguageProvider>);
}
async function edit() {
  await userEvent.setup().click(screen.getByLabelText("听写快捷键 更改"));
  await screen.findByRole("group", { name: "编辑快捷键" });
}
afterEach(() => { mock.pause.mockClear(); mock.commit.mockClear(); localStorage.clear(); });

describe("shortcut settings", () => {
  it.each([["MetaLeft", "LeftCommand"], ["MetaRight", "RightCommand"], ["ShiftLeft", "LeftShift"], ["ShiftRight", "RightShift"], ["AltLeft", "LeftOption"], ["AltRight", "RightOption"], ["ControlLeft", "LeftControl"], ["ControlRight", "RightControl"]])("records standalone %s on release", async (code, expected) => {
    wrap(); await edit();
    const key = code.replace(/Left|Right/, "");
    fireEvent.keyDown(window, { key, code });
    expect(mock.commit).not.toHaveBeenCalled();
    fireEvent.keyUp(window, { key, code });
    await waitFor(() => expect(mock.commit).toHaveBeenCalledWith("status_agent.hotkeys.dictate", { key: expected, modifiers: [] }));
    expect(mock.pause).toHaveBeenCalledWith({ active: true });
    await waitFor(() => expect(mock.pause).toHaveBeenCalledWith({ active: false }));
  });
  it("keeps the side of a modifier in a normal key combination", async () => {
    wrap(); await edit();
    fireEvent.keyDown(window, { key: "Meta", code: "MetaRight", metaKey: true });
    fireEvent.keyDown(window, { key: "j", code: "KeyJ", metaKey: true });
    await waitFor(() => expect(mock.commit).toHaveBeenCalledWith("status_agent.hotkeys.dictate", { key: "J", modifiers: ["right_cmd"] }));
  });
  it("can select Fn combinations without relying on browser keyboard events", async () => {
    wrap(); await edit();
    fireEvent.change(screen.getByLabelText("组合键 cmd"), { target: { value: "right_cmd" } });
    await userEvent.setup().click(screen.getByRole("button", { name: "保存快捷键" }));
    expect(mock.commit).toHaveBeenCalledWith("status_agent.hotkeys.dictate", { key: "Fn", modifiers: ["right_cmd"] });
  });
  it("restores all defaults atomically while preserving the translation language", async () => {
    wrap();
    await userEvent.setup().click(screen.getByRole("button", { name: "恢复默认快捷键" }));
    expect(mock.commit).toHaveBeenCalledOnce();
    expect(mock.commit).toHaveBeenCalledWith("status_agent.hotkeys", { ...DEFAULT_HOTKEYS,
      translate: { ...DEFAULT_HOTKEYS.translate, target_language: "Japanese" } });
  });
  it("cancels without changing the saved shortcut", async () => {
    wrap(); await edit();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("group", { name: "编辑快捷键" })).toBeNull();
    expect(mock.commit).not.toHaveBeenCalled();
    expect(screen.getByLabelText("听写快捷键 更改")).toHaveFocus();
  });
});
