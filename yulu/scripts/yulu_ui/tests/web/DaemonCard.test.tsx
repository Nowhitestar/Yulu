// tests/web/DaemonCard.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { DaemonCard, type DaemonHealth } from "../../web/src/components/DaemonCard.js";

const RUNNING: DaemonHealth = {
  name: "com.yulu.audiodaemon",
  status: "running",
  pid: 1234,
  exitStatus: 0,
  lastLog: "Listening on /Users/x/.config/yulu/audio_daemon.sock",
};

function mount(daemon: DaemonHealth, opts: Partial<{ onRestart: (n: string) => void; onStop: (n: string) => void; onStart: (n: string) => void }> = {}) {
  return render(
    <MemoryRouter>
      <DaemonCard
        daemon={daemon}
        onRestart={opts.onRestart ?? (() => {})}
        onStop={opts.onStop ?? (() => {})}
        onStart={opts.onStart}
      />
    </MemoryRouter>
  );
}

describe("DaemonCard", () => {
  it("renders short daemon name (strips com.yulu. prefix)", () => {
    mount(RUNNING);
    expect(screen.getByText("audiodaemon")).toBeInTheDocument();
  });

  it("renders status pill with correct data-status", () => {
    const { container } = mount(RUNNING);
    const pill = container.querySelector(".status-pill");
    expect(pill).not.toBeNull();
    expect(pill).toHaveAttribute("data-status", "running");
    expect(pill?.textContent).toMatch(/运行中/);
  });

  it("shows alert-circle icon for crashed status", () => {
    const { container } = mount({ ...RUNNING, status: "crashed", exitStatus: 137 });
    expect(container.querySelector(".status-pill-glyph .lucide-circle-alert, .status-pill-glyph .lucide-alert-circle")).not.toBeNull();
  });

  it("shows pause icon for stopped status", () => {
    const { container } = mount({ ...RUNNING, status: "stopped", pid: 0 });
    expect(container.querySelector(".status-pill-glyph .lucide-pause")).not.toBeNull();
  });

  it("renders PID + last log line", () => {
    mount(RUNNING);
    expect(screen.getByText(/PID 1234/)).toBeInTheDocument();
    expect(screen.getByText(/Listening on/)).toBeInTheDocument();
  });

  it("Restart button click fires onRestart with the full daemon name", async () => {
    const onRestart = vi.fn();
    mount(RUNNING, { onRestart });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "重启" }));
    expect(onRestart).toHaveBeenCalledWith("com.yulu.audiodaemon");
  });

  it("Stop button click fires onStop with the full daemon name", async () => {
    const onStop = vi.fn();
    mount(RUNNING, { onStop });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "停止" }));
    expect(onStop).toHaveBeenCalledWith("com.yulu.audiodaemon");
  });

  it("Start button appears for stopped daemons and fires onStart", async () => {
    const onStart = vi.fn();
    mount({ ...RUNNING, status: "stopped", pid: 0 }, { onStart });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /启动/ }));
    expect(onStart).toHaveBeenCalledWith("com.yulu.audiodaemon");
  });

  it("View logs → links to /health/logs?name=<full-name>", () => {
    mount(RUNNING);
    const link = screen.getByRole("link", { name: /查看日志/ });
    expect(link).toHaveAttribute("href", "/health/logs?name=com.yulu.audiodaemon");
  });
});
