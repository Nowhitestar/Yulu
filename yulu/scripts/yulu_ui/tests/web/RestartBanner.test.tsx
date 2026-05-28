import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RestartBanner } from "../../web/src/components/RestartBanner.js";

describe("RestartBanner", () => {
  const daemons = [
    { name: "audiodaemon", keys: ["audio.silence_threshold", "audio.mic_device"] },
    { name: "sttdaemon", keys: ["transcription.final_engine"] },
  ];

  it("renders each daemon + its keys", () => {
    render(<RestartBanner daemons={daemons} onRestart={vi.fn()} onRestartAll={vi.fn()} />);
    expect(screen.getByText(/audiodaemon/)).toBeInTheDocument();
    expect(screen.getByText(/silence_threshold/)).toBeInTheDocument();
    expect(screen.getByText(/mic_device/)).toBeInTheDocument();
    expect(screen.getByText(/sttdaemon/)).toBeInTheDocument();
    expect(screen.getByText(/final_engine/)).toBeInTheDocument();
  });

  it("Restart now fires onRestartAll", async () => {
    const onRestartAll = vi.fn();
    render(<RestartBanner daemons={daemons} onRestart={vi.fn()} onRestartAll={onRestartAll} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /restart now/i }));
    expect(onRestartAll).toHaveBeenCalled();
  });

  it("per-daemon restart button fires onRestart(name)", async () => {
    const onRestart = vi.fn();
    render(<RestartBanner daemons={daemons} onRestart={onRestart} onRestartAll={vi.fn()} />);
    const user = userEvent.setup();
    const audioBtn = screen.getByRole("button", { name: /restart audiodaemon/i });
    await user.click(audioBtn);
    expect(onRestart).toHaveBeenCalledWith("audiodaemon");
  });
});
