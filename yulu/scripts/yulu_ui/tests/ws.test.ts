import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { WebSocket } from "ws";
import { mountWsMultiplexer } from "../src/ws.js";
import { PubSub, type AppChannels } from "../src/pubsub.js";

describe("WS multiplexer", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  it("subscribes to a channel and receives published messages", async () => {
    server = createServer();
    const pubsub = new PubSub<AppChannels>();
    mountWsMultiplexer(server, pubsub);
    await new Promise<void>((res) => server!.listen(0, "127.0.0.1", res));
    const port = (server!.address() as { port: number }).port;

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const received: unknown[] = [];
    ws.on("message", (b) => received.push(JSON.parse(b.toString())));
    await new Promise((r) => ws.once("open", r));

    ws.send(JSON.stringify({ type: "subscribe", channel: "recording" }));
    await new Promise((r) => setTimeout(r, 30));
    pubsub.publish("recording", { state: "recording" });
    pubsub.publish("daemons",   { name: "x", status: "running", pid: 1 });
    await new Promise((r) => setTimeout(r, 30));

    expect(received.filter((m) => (m as { channel: string }).channel === "recording")).toHaveLength(1);
    expect(received.filter((m) => (m as { channel: string }).channel === "daemons")).toHaveLength(0);
    ws.close();
  });
});
