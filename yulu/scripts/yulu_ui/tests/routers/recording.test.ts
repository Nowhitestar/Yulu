import { describe, it, expect, afterEach } from "vitest";
import { recordingRouter } from "../../src/routers/recording.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { startFakeSocket, type FakeSocket } from "../helpers/fakeUnixSocket.js";

describe("recordingRouter", () => {
  let fake: FakeSocket | undefined;
  afterEach(async () => { if (fake) { await fake.stop(); fake = undefined; } });

  it("state() round-trips status from status_agent.sock", async () => {
    fake = await startFakeSocket((req) => {
      expect(req).toEqual({ action: "status" });
      return { ok: true, state: "idle", hotkey: "⌘⇧V" };
    });
    const ctx = { paths: { statusAgentSock: fake.path } } as unknown as AppContext;
    const caller = createCaller(recordingRouter, ctx);
    const r = await caller.state();
    expect(r.state).toBe("idle");
    expect(r.hotkey).toBe("⌘⇧V");
  });

  it("state() degrades to idle when status_agent.sock is unavailable", async () => {
    const ctx = { paths: { statusAgentSock: "/tmp/yulu-missing-status-agent.sock" } } as unknown as AppContext;
    const caller = createCaller(recordingRouter, ctx);
    const r = await caller.state();
    expect(r).toEqual({ state: "idle", hotkey: "?", launcherPid: undefined });
  });

  it("toggle() returns state_before/state_after", async () => {
    const published: unknown[] = [];
    fake = await startFakeSocket((req) => {
      expect(req).toEqual({ action: "toggle" });
      return { ok: true, state_before: "idle", state_after: "recording" };
    });
    const ctx = {
      paths: { statusAgentSock: fake.path },
      pubsub: { publish: (_channel: string, payload: unknown) => published.push(payload) },
    } as unknown as AppContext;
    const caller = createCaller(recordingRouter, ctx);
    const r = await caller.toggle();
    expect(r.stateBefore).toBe("idle");
    expect(r.stateAfter).toBe("recording");
    expect(published).toEqual([{ state: "recording" }]);
  });
});
