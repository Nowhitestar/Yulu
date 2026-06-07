import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RestartBanner } from "../../web/src/components/RestartBanner.js";

describe("RestartBanner (P4a-6 — single Restart now + dismiss)", () => {
  const daemons = [
    { name: "audiodaemon", keys: ["audio.silence_threshold", "audio.mic_device"] },
    { name: "sttdaemon", keys: ["transcription.final_engine"] },
  ];

  it("shows a single clear restart message and the affected daemon names", () => {
    render(<RestartBanner daemons={daemons} onRestartAll={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText(/需要重启守护进程/)).toBeInTheDocument();
    expect(screen.getByText(/audiodaemon/)).toBeInTheDocument();
    expect(screen.getByText(/sttdaemon/)).toBeInTheDocument();
  });

  it("renders exactly one primary 'Restart now' and no per-daemon restart buttons", () => {
    render(<RestartBanner daemons={daemons} onRestartAll={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByRole("button", { name: "立即重启" })).toBeInTheDocument();
    // No per-daemon "Restart <name>" buttons anymore.
    expect(screen.queryByRole("button", { name: /restart audiodaemon/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /restart sttdaemon/i })).toBeNull();
  });

  it("'Restart now' fires onRestartAll", async () => {
    const onRestartAll = vi.fn();
    render(<RestartBanner daemons={daemons} onRestartAll={onRestartAll} onDismiss={vi.fn()} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "立即重启" }));
    expect(onRestartAll).toHaveBeenCalled();
  });

  it("is dismissible — Dismiss fires onDismiss", async () => {
    const onDismiss = vi.fn();
    render(<RestartBanner daemons={daemons} onRestartAll={vi.fn()} onDismiss={onDismiss} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "忽略" }));
    expect(onDismiss).toHaveBeenCalled();
  });
});
