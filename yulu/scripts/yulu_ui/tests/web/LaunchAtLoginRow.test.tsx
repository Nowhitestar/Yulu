// The "Open at login" row talks only to the Yulu App's login-item bridge. In a
// browser there is no bridge, so the row is absent; inside the App it reads the
// macOS login item, adds or removes Yulu, and opens Login Items settings.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../web/src/trpc.js", () => ({ trpc: {} }));

import { LaunchAtLoginRow } from "../../web/src/components/settings/LaunchAtLoginRow.js";

type Message = { action: string; enabled?: boolean };

function installBridge(reply: (message: Message) => unknown) {
  const postMessage = vi.fn(async (message: Message) => reply(message));
  (window as unknown as { webkit?: unknown }).webkit = { messageHandlers: { yuluLoginItem: { postMessage } } };
  return postMessage;
}

afterEach(() => {
  delete (window as unknown as { webkit?: unknown }).webkit;
});

describe("LaunchAtLoginRow", () => {
  it("renders nothing outside the Yulu App", () => {
    const { container } = render(<LaunchAtLoginRow />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for a copy of Yulu outside Applications", async () => {
    const postMessage = installBridge(() => ({ available: false }));
    const { container } = render(<LaunchAtLoginRow />);
    await act(async () => {});
    expect(postMessage).toHaveBeenCalledWith({ action: "state" });
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the login item and turns it on and off", async () => {
    let enabled = false;
    const postMessage = installBridge((message) => {
      if (message.action === "set") enabled = Boolean(message.enabled);
      return { available: true, enabled, status: enabled ? "enabled" : "notRegistered" };
    });
    render(<LaunchAtLoginRow />);

    expect(await screen.findByText("登录时打开语录")).toBeInTheDocument();
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");

    await act(async () => { fireEvent.click(screen.getByRole("switch")); });
    expect(postMessage).toHaveBeenCalledWith({ action: "set", enabled: true });
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true");

    await act(async () => { fireEvent.click(screen.getByRole("switch")); });
    expect(postMessage).toHaveBeenCalledWith({ action: "set", enabled: false });
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");

    const actions = postMessage.mock.calls.map(([message]) => message.action);
    expect(actions.every((action) => ["state", "set"].includes(action))).toBe(true);
  });

  it("asks for approval in System Settings when macOS requires it", async () => {
    const postMessage = installBridge(() => ({ available: true, enabled: true, status: "requiresApproval" }));
    render(<LaunchAtLoginRow />);
    expect(await screen.findByText("需要在「系统设置 › 通用 › 登录项」里允许语录。")).toBeInTheDocument();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "打开登录项设置" })); });
    expect(postMessage).toHaveBeenCalledWith({ action: "openSettings" });
  });

  it("says when macOS refused the change", async () => {
    installBridge(() => ({ available: true, enabled: false, status: "notRegistered", error: "Operation not permitted" }));
    render(<LaunchAtLoginRow />);
    expect(await screen.findByRole("alert")).toHaveTextContent("没能更改登录项");
  });
});
