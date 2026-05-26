// tests/web/ws.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act, cleanup } from "@testing-library/react";
import { Server as MockServer, WebSocket as MockWebSocket } from "mock-socket";
import type { ReactNode } from "react";
import { WsProvider, useWsChannel, nextBackoff } from "../../web/src/ws.js";

describe("nextBackoff", () => {
  it("doubles each attempt, caps at 30000ms", () => {
    expect(nextBackoff(0)).toBe(1_000);
    expect(nextBackoff(1)).toBe(2_000);
    expect(nextBackoff(2)).toBe(4_000);
    expect(nextBackoff(3)).toBe(8_000);
    expect(nextBackoff(4)).toBe(16_000);
    expect(nextBackoff(5)).toBe(30_000);
    expect(nextBackoff(10)).toBe(30_000);
  });
});

describe("useWsChannel", () => {
  const URL = "ws://127.0.0.1:17999/ws";
  let server: MockServer;
  const originalWebSocket = globalThis.WebSocket;

  beforeEach(() => {
    globalThis.WebSocket = MockWebSocket as unknown as typeof WebSocket;
    server = new MockServer(URL);
  });
  afterEach(() => {
    cleanup();
    server.stop();
    globalThis.WebSocket = originalWebSocket;
  });

  function wrapper({ children }: { children: ReactNode }) {
    return <WsProvider url={URL}>{children}</WsProvider>;
  }

  it("subscribes on mount, receives published messages, unsubscribes on unmount", async () => {
    const received: unknown[] = [];
    const frames: unknown[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    });

    const { unmount } = renderHook(
      () => useWsChannel("recording", (msg) => received.push(msg)),
      { wrapper },
    );

    // wait for connection
    await vi.waitFor(() => expect(frames).toContainEqual({ type: "subscribe", channel: "recording" }));

    act(() => {
      server.emit("message", JSON.stringify({ channel: "recording", payload: { state: "recording" } }));
    });

    await vi.waitFor(() => expect(received).toEqual([{ state: "recording" }]));

    unmount();
    await vi.waitFor(() => expect(frames).toContainEqual({ type: "unsubscribe", channel: "recording" }));
  });

  it("two subscribers to the same channel dedupe the subscribe frame", async () => {
    const frames: unknown[] = [];
    server.on("connection", (socket) => {
      socket.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
    });
    function TwoSubs() {
      useWsChannel("recording", () => {});
      useWsChannel("recording", () => {});
      return null;
    }
    renderHook(() => TwoSubs(), { wrapper });
    await vi.waitFor(() => expect(frames.filter((f) => (f as { type: string }).type === "subscribe")).toHaveLength(1));
  });
});
