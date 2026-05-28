import { describe, it, expect, afterEach } from "vitest";
import { ipcSend } from "../src/ipc.js";
import { startFakeSocket, type FakeSocket } from "./helpers/fakeUnixSocket.js";

describe("ipcSend (SHUT_WR framing)", () => {
  let fake: FakeSocket | undefined;
  afterEach(async () => { if (fake) { await fake.stop(); fake = undefined; } });

  it("writes JSON, half-closes, parses reply", async () => {
    fake = await startFakeSocket((req) => ({ ok: true, echo: req }));
    const reply = await ipcSend(fake.path, { action: "status" });
    expect(reply).toEqual({ ok: true, echo: { action: "status" } });
  });

  it("rejects on socket missing", async () => {
    await expect(ipcSend("/tmp/nonexistent.sock", { action: "x" }))
      .rejects.toThrow(/ENOENT|ECONNREFUSED/);
  });

  it("times out after ipcTimeoutMs", async () => {
    fake = await startFakeSocket(async () => {
      await new Promise((r) => setTimeout(r, 5_000));
      return { never: true };
    });
    await expect(ipcSend(fake.path, { action: "x" }, { timeoutMs: 200 }))
      .rejects.toThrow(/timed out/i);
  });
});
