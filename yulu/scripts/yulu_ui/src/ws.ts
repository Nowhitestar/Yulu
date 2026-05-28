import type { Server as HttpServer } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import type { PubSub, AppChannels } from "./pubsub.js";

/**
 * Single /ws endpoint. Clients send:
 *   {"type":"subscribe","channel":"recording"}
 *   {"type":"unsubscribe","channel":"recording"}
 * Server pushes:
 *   {"channel":"recording","payload":{...}}
 */
export function mountWsMultiplexer(http: HttpServer, pubsub: PubSub<AppChannels>): void {
  const wss = new WebSocketServer({ server: http, path: "/ws", maxPayload: 64 * 1024 });

  wss.on("connection", (ws: WebSocket) => {
    const unsubs = new Map<string, () => void>();
    ws.on("message", (raw) => {
      let msg: { type: string; channel: keyof AppChannels & string };
      try { msg = JSON.parse(raw.toString()); }
      catch { ws.send(JSON.stringify({ error: "bad json" })); return; }
      if (msg.type === "subscribe" && msg.channel) {
        if (unsubs.has(msg.channel)) return;
        const off = pubsub.subscribe(msg.channel, (payload) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ channel: msg.channel, payload }));
        });
        unsubs.set(msg.channel, off);
      } else if (msg.type === "unsubscribe" && msg.channel) {
        unsubs.get(msg.channel)?.();
        unsubs.delete(msg.channel);
      }
    });
    ws.on("close", () => {
      for (const off of unsubs.values()) off();
      unsubs.clear();
    });
  });
}
