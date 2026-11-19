// The Settings update row talks only to the Yulu App's updater bridge. In a
// browser there is no bridge, so the row is absent; inside the App it can read
// state, start a check and turn scheduled checks on or off — never install.
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("../../web/src/trpc.js", () => ({ trpc: {} }));

import { UpdateSection } from "../../web/src/components/settings/UpdateSection.js";

type Message = { action: string; enabled?: boolean };

function installBridge(reply: (message: Message) => unknown) {
  const postMessage = vi.fn(async (message: Message) => reply(message));
  (window as unknown as { webkit?: unknown }).webkit = { messageHandlers: { yuluUpdates: { postMessage } } };
  return postMessage;
}

afterEach(() => {
  delete (window as unknown as { webkit?: unknown }).webkit;
});

const ready = {
  available: true,
  version: "0.28.0",
  automaticChecks: true,
  canCheck: true,
  lastCheck: "2026-11-19T01:12:00Z",
};

describe("UpdateSection", () => {
  it("renders nothing outside the Yulu App", () => {
    const { container } = render(<UpdateSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the App's state, checks on request and schedules checks", async () => {
    let automatic = true;
    const postMessage = installBridge((message) => {
      if (message.action === "setAutomaticChecks") automatic = Boolean(message.enabled);
      return { ...ready, automaticChecks: automatic };
    });
    render(<UpdateSection />);

    expect(await screen.findByText("更新")).toBeInTheDocument();
    expect(screen.getByText("自动检查更新")).toBeInTheDocument();
    expect(screen.getByText(/^上次检查：/)).toBeInTheDocument();
    expect(postMessage).toHaveBeenCalledWith({ action: "state" });

    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "立即检查" })); });
    expect(postMessage).toHaveBeenCalledWith({ action: "check" });

    await act(async () => { fireEvent.click(screen.getByRole("switch")); });
    expect(postMessage).toHaveBeenCalledWith({ action: "setAutomaticChecks", enabled: false });
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false");

    const actions = postMessage.mock.calls.map(([message]) => message.action);
    expect(actions.every((action) => ["state", "check", "setAutomaticChecks"].includes(action))).toBe(true);
  });

  it("says when this copy cannot update itself", async () => {
    installBridge(() => ({ available: false, version: "0.28.0" }));
    render(<UpdateSection />);
    expect(await screen.findByText(/不能在应用内更新/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "立即检查" })).toBeNull();
  });

  it("reports an unreachable updater instead of failing silently", async () => {
    installBridge(() => { throw new Error("unavailable"); });
    render(<UpdateSection />);
    expect(await screen.findByRole("alert")).toHaveTextContent("暂时连不上更新程序");
  });
});
