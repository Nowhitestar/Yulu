import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";

let stateData: { state?: string } | undefined = { state: "idle" };
let dataUpdatedAt = 1;
let queryOptions: { refetchInterval?: number; refetchIntervalInBackground?: boolean } | undefined;
const wsHandlers = new Map<string, (p: unknown) => void>();

vi.mock("../../../web/src/trpc.js", () => ({
  trpc: { recording: { state: { useQuery: (_input: unknown, options: typeof queryOptions) => {
    queryOptions = options;
    return { data: stateData, dataUpdatedAt };
  } } } },
}));
vi.mock("../../../web/src/ws.js", () => ({
  useWsChannel: (channel: string, fn: (p: unknown) => void) => { wsHandlers.set(channel, fn); },
}));

import { useIsRecording } from "../../../web/src/hooks/useIsRecording.js";

beforeEach(() => {
  wsHandlers.clear();
  stateData = { state: "idle" };
  dataUpdatedAt = 1;
  queryOptions = undefined;
});

describe("useIsRecording", () => {
  it("false when idle", () => {
    const { result } = renderHook(() => useIsRecording());
    expect(result.current).toBe(false);
  });

  it("keeps polling confirmed state while the page is in the background", () => {
    renderHook(() => useIsRecording());
    expect(queryOptions).toMatchObject({
      refetchInterval: 500,
      refetchIntervalInBackground: true,
    });
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

  it("fails closed while the bootstrap state is unknown", () => {
    stateData = { state: "unknown" };
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

  it("reconciles a stale WS event after an unchanged confirmed poll", () => {
    const confirmedIdle = { state: "idle" };
    stateData = confirmedIdle;
    const { result, rerender } = renderHook(() => useIsRecording());

    act(() => wsHandlers.get("recording")?.({ state: "recording" }));
    expect(result.current).toBe(true);

    stateData = confirmedIdle;
    dataUpdatedAt += 1;
    rerender();
    expect(result.current).toBe(false);
  });

  it("keeps the last live state when status polling is unavailable", () => {
    const { result, rerender } = renderHook(() => useIsRecording());
    act(() => wsHandlers.get("recording")?.({ state: "recording" }));
    expect(result.current).toBe(true);

    stateData = { state: "unknown" };
    dataUpdatedAt += 1;
    rerender();
    expect(result.current).toBe(true);
  });
});
