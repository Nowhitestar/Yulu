import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AudioPlayer } from "../../web/src/components/AudioPlayer.js";

// Capture handlers registered via .on() so tests can fire 'ready' / 'audioprocess' / 'finish'.
// vi.mock is hoisted to the top of the file; bind mock variables via vi.hoisted so they're
// initialized before the mock factory runs.
const { handlers, playMock, pauseMock, setTimeMock, destroyMock, createMock } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const playMock = vi.fn();
  const pauseMock = vi.fn();
  const setTimeMock = vi.fn();
  const destroyMock = vi.fn();
  const createMock = vi.fn(() => ({
    on: (event: string, cb: (...args: unknown[]) => void) => { handlers.set(event, cb); },
    play: playMock,
    pause: pauseMock,
    setTime: setTimeMock,
    destroy: destroyMock,
    getDuration: () => 12.5,
    isPlaying: () => false,
  }));
  return { handlers, playMock, pauseMock, setTimeMock, destroyMock, createMock };
});

vi.mock("wavesurfer.js", () => ({ default: { create: createMock } }));

beforeEach(() => {
  handlers.clear();
  playMock.mockReset();
  pauseMock.mockReset();
  setTimeMock.mockReset();
  destroyMock.mockReset();
  createMock.mockClear();
});

describe("AudioPlayer", () => {
  it("creates a wavesurfer instance with the right src on mount", () => {
    render(<AudioPlayer src="/files/voicemails/foo.wav" />);
    expect(createMock).toHaveBeenCalledTimes(1);
    const opts = (createMock.mock.calls[0] as unknown as [{ url: string }])[0];
    expect(opts.url).toBe("/files/voicemails/foo.wav");
  });

  it("destroys the wavesurfer instance on unmount", () => {
    const { unmount } = render(<AudioPlayer src="/files/voicemails/foo.wav" />);
    unmount();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it("applies initialSeek when the 'ready' event fires", () => {
    render(<AudioPlayer src="/x.wav" initialSeek={5.2} />);
    act(() => { handlers.get("ready")?.(); });
    expect(setTimeMock).toHaveBeenCalledWith(5.2);
  });

  it("clicking the play button calls wavesurfer.play()", async () => {
    render(<AudioPlayer src="/x.wav" />);
    act(() => { handlers.get("ready")?.(); });
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /play/i }));
    expect(playMock).toHaveBeenCalled();
  });

  it("emits onSeek when wavesurfer fires 'audioprocess'", () => {
    const onSeek = vi.fn();
    render(<AudioPlayer src="/x.wav" onSeek={onSeek} />);
    act(() => { handlers.get("audioprocess")?.(3.7); });
    expect(onSeek).toHaveBeenCalledWith(3.7);
  });
});
