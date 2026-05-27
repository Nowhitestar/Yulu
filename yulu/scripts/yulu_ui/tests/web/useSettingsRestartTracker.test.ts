import { describe, it, expect } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSettingsRestartTracker } from "../../web/src/hooks/useSettingsRestartTracker.js";

describe("useSettingsRestartTracker", () => {
  it("records keys per daemon", () => {
    const { result } = renderHook(() => useSettingsRestartTracker());
    act(() => result.current.record("audio.silence_threshold", ["audiodaemon"]));
    act(() => result.current.record("audio.mic_device", ["audiodaemon"]));
    const dmap = result.current.daemons;
    expect(dmap.get("audiodaemon")?.size).toBe(2);
    expect(Array.from(dmap.get("audiodaemon") ?? [])).toEqual(
      expect.arrayContaining(["audio.silence_threshold", "audio.mic_device"])
    );
  });

  it("does not record when daemonsNeedingRestart is empty", () => {
    const { result } = renderHook(() => useSettingsRestartTracker());
    act(() => result.current.record("audio.output_dir", []));
    expect(result.current.daemons.size).toBe(0);
  });

  it("statusFor returns 'restart' for tracked keys, else null", () => {
    const { result } = renderHook(() => useSettingsRestartTracker());
    act(() => result.current.record("audio.silence_threshold", ["audiodaemon"]));
    expect(result.current.statusFor("audio.silence_threshold")).toBe("restart");
    expect(result.current.statusFor("audio.mic_device")).toBeNull();
  });

  it("clearDaemon removes the daemon entry", () => {
    const { result } = renderHook(() => useSettingsRestartTracker());
    act(() => result.current.record("audio.silence_threshold", ["audiodaemon"]));
    act(() => result.current.clearDaemon("audiodaemon"));
    expect(result.current.daemons.size).toBe(0);
  });

  it("clearKey removes a single key (may leave daemon if other keys remain)", () => {
    const { result } = renderHook(() => useSettingsRestartTracker());
    act(() => result.current.record("audio.silence_threshold", ["audiodaemon"]));
    act(() => result.current.record("audio.mic_device", ["audiodaemon"]));
    act(() => result.current.clearKey("audio.silence_threshold"));
    expect(result.current.daemons.get("audiodaemon")?.size).toBe(1);
    expect(result.current.daemons.get("audiodaemon")?.has("audio.mic_device")).toBe(true);
  });

  it("clearAll wipes all entries", () => {
    const { result } = renderHook(() => useSettingsRestartTracker());
    act(() => result.current.record("audio.silence_threshold", ["audiodaemon"]));
    act(() => result.current.record("transcription.glossary", ["sttdaemon"]));
    act(() => result.current.clearAll());
    expect(result.current.daemons.size).toBe(0);
  });
});
