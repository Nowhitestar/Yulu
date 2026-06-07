import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

let stateData: { state?: string } | undefined = { state: "idle" };
const wsHandlers = new Map<string, (p: unknown) => void>();

vi.mock("../../../web/src/trpc.js", () => ({
  trpc: { recording: { state: { useQuery: () => ({ data: stateData }) } } },
}));
vi.mock("../../../web/src/ws.js", () => ({
  useWsChannel: (channel: string, fn: (p: unknown) => void) => { wsHandlers.set(channel, fn); },
}));

import { useIsRecording } from "../../../web/src/hooks/useIsRecording.js";

beforeEach(() => {
  wsHandlers.clear();
  stateData = { state: "idle" };
});

describe("useIsRecording", () => {
  it("false when idle", () => {
    const { result } = renderHook(() => useIsRecording());
    expect(result.current).toBe(false);
  });

  it("true when the bootstrap state is recording", () => {
    stateData = { state: "recording" };
    const { result } = renderHook(() => useIsRecording());
    expect(result.current).toBe(true);
  });

  it("true when the bootstrap state is processing", () => {
    stateData = { state: "processing" };
    const { result } = renderHook(() => useIsRecording());
    expect(result.current).toBe(true);
  });

  it("follows live recording WS events after hydration", () => {
    const { result } = renderHook(() => useIsRecording());
    expect(result.current).toBe(false);
    act(() => wsHandlers.get("recording")?.({ state: "recording" }));
    expect(result.current).toBe(true);
    act(() => wsHandlers.get("recording")?.({ state: "idle" }));
    expect(result.current).toBe(false);
  });
});
