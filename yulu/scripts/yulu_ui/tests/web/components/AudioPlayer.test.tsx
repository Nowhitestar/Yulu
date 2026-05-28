import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { AudioPlayer } from "../../../web/src/components/AudioPlayer";

const mockWavesurfer = {
  destroy: vi.fn(),
  play: vi.fn(),
  pause: vi.fn(),
  setTime: vi.fn(),
  getDuration: vi.fn(() => 120),
  on: vi.fn((_event: string, _cb: (arg?: number) => void) => {}),
};
vi.mock("wavesurfer.js", () => ({
  default: { create: vi.fn(() => mockWavesurfer) },
}));

describe("AudioPlayer", () => {
  beforeEach(() => {
    mockWavesurfer.destroy.mockClear();
    mockWavesurfer.play.mockClear();
    mockWavesurfer.pause.mockClear();
    mockWavesurfer.on.mockClear();
  });

  it("disables Play button when not ready", () => {
    render(<AudioPlayer src="a.wav" />);
    const btn = screen.getByRole("button", { name: /play|pause/i });
    expect(btn).toBeDisabled();
  });

  it("enables Play after wavesurfer fires 'ready'", () => {
    render(<AudioPlayer src="a.wav" />);
    const readyCall = mockWavesurfer.on.mock.calls.find((c) => c[0] === "ready");
    expect(readyCall).toBeDefined();
    act(() => {
      readyCall![1]!();
    });
    const btn = screen.getByRole("button", { name: /play|pause/i });
    expect(btn).not.toBeDisabled();
  });

  it("resets isPlaying state when src changes", () => {
    const { rerender } = render(<AudioPlayer src="a.wav" />);
    const readyA = mockWavesurfer.on.mock.calls.find((c) => c[0] === "ready");
    act(() => {
      readyA![1]!();
    });
    const playA = mockWavesurfer.on.mock.calls.find((c) => c[0] === "play");
    act(() => {
      playA![1]!();
    });
    rerender(<AudioPlayer src="b.wav" />);
    const btn = screen.getByRole("button", { name: /play|pause/i });
    expect(btn.getAttribute("aria-label")).toBe("Play");
  });

  it("destroys the wavesurfer instance on src change", () => {
    const { rerender } = render(<AudioPlayer src="a.wav" />);
    expect(mockWavesurfer.destroy).not.toHaveBeenCalled();
    rerender(<AudioPlayer src="b.wav" />);
    expect(mockWavesurfer.destroy).toHaveBeenCalled();
  });

  it("disables Play again after src changes (until new ready)", () => {
    const { rerender } = render(<AudioPlayer src="a.wav" />);
    const readyA = mockWavesurfer.on.mock.calls.find((c) => c[0] === "ready");
    act(() => {
      readyA![1]!();
    });
    rerender(<AudioPlayer src="b.wav" />);
    const btn = screen.getByRole("button", { name: /play|pause/i });
    expect(btn).toBeDisabled();
  });
});
