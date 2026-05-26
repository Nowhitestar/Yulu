// web/src/ws.tsx
import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import type { AppChannels } from "../../src/pubsub.js";

const MAX_BACKOFF_MS = 30_000;
const BASE_BACKOFF_MS = 1_000;

export function nextBackoff(attempt: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
}

interface WsManager {
  subscribe<K extends keyof AppChannels & string>(channel: K, fn: (payload: AppChannels[K]) => void): () => void;
}

const WsContext = createContext<WsManager | null>(null);

interface WsProviderProps {
  url?: string;
  children: ReactNode;
}

/**
 * Owns the single WebSocket connection. Opens lazily on the first subscribe.
 * Reconnects with exponential backoff (1s → 30s). Listeners ref-count per
 * channel so the unsubscribe frame fires only when the last listener leaves.
 */
export function WsProvider({ url, children }: WsProviderProps) {
  const managerRef = useRef<WsManager | null>(null);

  if (!managerRef.current) managerRef.current = createManager(url ?? defaultUrl());

  useEffect(() => () => {
    // Provider unmount = full teardown (page unload)
    (managerRef.current as ReturnType<typeof createManager>).destroy();
    managerRef.current = null;
  }, []);

  return <WsContext.Provider value={managerRef.current}>{children}</WsContext.Provider>;
}

export function useWsChannel<K extends keyof AppChannels & string>(
  channel: K,
  onMessage: (payload: AppChannels[K]) => void,
): void {
  const mgr = useContext(WsContext);
  if (!mgr) throw new Error("useWsChannel must be used inside <WsProvider>");
  const cbRef = useRef(onMessage);
  cbRef.current = onMessage;

  useEffect(() => {
    return mgr.subscribe(channel, (p) => cbRef.current(p));
  }, [mgr, channel]);
}

function defaultUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

interface ManagerInternals extends WsManager {
  destroy(): void;
}

function createManager(url: string): ManagerInternals {
  const listeners = new Map<string, Set<(p: unknown) => void>>();
  let socket: WebSocket | null = null;
  let attempt = 0;
  let destroyed = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function ensureOpen() {
    if (destroyed) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    const ws = new WebSocket(url);
    socket = ws;
    ws.addEventListener("open", () => {
      attempt = 0;
      // resubscribe everything
      for (const channel of listeners.keys()) ws.send(JSON.stringify({ type: "subscribe", channel }));
    });
    ws.addEventListener("message", (e) => {
      let msg: { channel?: string; payload?: unknown };
      try { msg = JSON.parse(typeof e.data === "string" ? e.data : ""); } catch { return; }
      if (!msg.channel) return;
      const set = listeners.get(msg.channel);
      if (!set) return;
      for (const fn of set) fn(msg.payload);
    });
    const onClose = () => {
      if (destroyed) return;
      socket = null;
      reconnectTimer = setTimeout(ensureOpen, nextBackoff(attempt));
      attempt += 1;
    };
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", () => ws.close());
  }

  function sendIfOpen(frame: object) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
  }

  return {
    subscribe(channel, fn) {
      let set = listeners.get(channel);
      const isFirst = !set || set.size === 0;
      if (!set) { set = new Set(); listeners.set(channel, set); }
      set.add(fn as (p: unknown) => void);
      ensureOpen();
      if (isFirst) sendIfOpen({ type: "subscribe", channel });

      return () => {
        const s = listeners.get(channel);
        if (!s) return;
        s.delete(fn as (p: unknown) => void);
        if (s.size === 0) {
          listeners.delete(channel);
          sendIfOpen({ type: "unsubscribe", channel });
        }
      };
    },
    destroy() {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      // Graceful: send unsubscribe for every active channel before closing.
      // This also ensures child useEffect cleanups (which may run *after*
      // provider cleanup) still observe an unsubscribe frame on the wire.
      if (socket?.readyState === WebSocket.OPEN) {
        for (const channel of listeners.keys()) {
          socket.send(JSON.stringify({ type: "unsubscribe", channel }));
        }
      }
      socket?.close();
      socket = null;
      listeners.clear();
    },
  };
}
