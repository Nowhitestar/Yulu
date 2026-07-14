import { describe, it, expect } from "vitest";
import { PubSub } from "../src/pubsub.js";

describe("PubSub", () => {
  it("publishes to subscribers of the same channel only", () => {
    const ps = new PubSub<{ recording: { state: string }; daemons: { name: string } }>();
    const recv: string[] = [];
    const unsub = ps.subscribe("recording", (msg) => recv.push(msg.state));
    ps.publish("recording", { state: "recording" });
    ps.publish("daemons", { name: "audiodaemon" });
    expect(recv).toEqual(["recording"]);
    unsub();
    ps.publish("recording", { state: "idle" });
    expect(recv).toEqual(["recording"]);
  });

  it("unsubscribe is idempotent + safe to call twice", () => {
    const ps = new PubSub<{ x: number }>();
    const unsub = ps.subscribe("x", () => {});
    unsub(); unsub();
    expect(ps.subscriberCount("x")).toBe(0);
  });

  it("retains the latest value so a late WebSocket subscriber can hydrate", () => {
    const ps = new PubSub<{ live: { text: string } }>();
    ps.publish("live", { text: "已有实时内容" });
    expect(ps.latest("live")).toEqual({ text: "已有实时内容" });
  });
});
