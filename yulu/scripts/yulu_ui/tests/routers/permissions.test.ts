import { afterEach, describe, expect, it } from "vitest";
import { permissionsRouter } from "../../src/routers/permissions.js";
import { createCaller, type AppContext } from "../../src/trpc.js";
import { startFakeSocket, type FakeSocket } from "../helpers/fakeUnixSocket.js";

const sockets: FakeSocket[] = [];
afterEach(async () => { await Promise.all(sockets.splice(0).map((socket) => socket.stop())); });
const native = { ok: true, macos_major: 27, accessibility_trusted: true, event_posting_allowed: true, hotkeys_ready: true, notifications: "not_determined" };
const captureStatus = { micReady: true, sysReady: false, sysPermission: "granted", sysDisabled: true, recording: false, file: "/private/recording.wav" };
async function fixture(reply: unknown = native, authorized = true, captureReply: unknown = captureStatus) {
  const calls: unknown[] = [];
  const capture = await startFakeSocket(() => captureReply);
  const app = await startFakeSocket((request) => { calls.push(request); return reply; });
  sockets.push(capture, app);
  const caller = createCaller(permissionsRouter, { uiMutationAuthorized: authorized,
    paths: { audioDaemonSock: capture.path, statusAgentSock: app.path },
    config: { read: () => ({ status_agent: { enabled: true } }) },
  } as unknown as AppContext);
  return { caller, calls, capture, app };
}

describe("permission setup", () => {
  it("reads native states without leaking recordings or requesting grants", async () => {
    const { caller, calls } = await fixture();
    expect(await caller.status()).toEqual({ checkedAt: expect.any(String), macosMajor: 27,
      voiceInputEnabled: true, microphone: "ready", systemAudio: "ready", systemAudioCapturing: false, input: "ready", notifications: "not_determined" });
    expect(calls).toEqual([{ action: "permission_status" }]);
  });
  it.each([
    [{ recording: true, sysDisabled: true, sysReady: false }, false],
    [{ recording: false, sysDisabled: false, sysReady: true }, false],
    [{ recording: true, sysDisabled: false, sysReady: true }, true],
  ])("keeps system audio access separate from recording activity %j", async (activity, capturing) => {
    const { caller } = await fixture(native, true, { ...captureStatus, ...activity });
    expect(await caller.status()).toMatchObject({ systemAudio: "ready", systemAudioCapturing: capturing });
  });
  it("does not turn an unavailable device into a permission denial or a stale grant", async () => {
    const { caller } = await fixture(native, true, { ...captureStatus, sysPermission: "check_failed" });
    expect((await caller.status()).systemAudio).toBe("check_failed");
  });
  it.each([[false, "unknown"], [true, "ready"]])("handles older Capture readiness %s conservatively", async (ready, expected) => {
    const { caller } = await fixture(native, true, { micReady: true, sysReady: ready });
    expect(await caller.status()).toMatchObject({ systemAudio: expected, systemAudioCapturing: null });
  });
  it("does not infer a grant from a malformed capture response", async () => {
    const { caller } = await fixture(native, true, { ...captureStatus, sysPermission: true });
    expect(await caller.status()).toMatchObject({ systemAudio: "unknown", systemAudioCapturing: null });
  });
  it("distinguishes an unreachable service from a permission being off", async () => {
    const { caller, capture, app } = await fixture();
    await capture.stop(); await app.stop();
    sockets.splice(sockets.indexOf(capture), 1); sockets.splice(sockets.indexOf(app), 1);
    expect(await caller.status()).toMatchObject({ microphone: "check_failed", systemAudio: "check_failed", input: "check_failed", notifications: "check_failed" });
  });
  it("preserves the main app's denied notification state", async () => {
    const { caller } = await fixture({ ...native, notifications: "denied" });
    expect((await caller.status()).notifications).toBe("denied");
  });
  it.each(["accessibility_trusted", "event_posting_allowed", "hotkeys_ready"])("requires %s for input readiness", async (field) => {
    const { caller } = await fixture({ ...native, [field]: false });
    expect((await caller.status()).input).toBe("needs_attention");
  });
  it("treats missing native fields as unknown, not granted or denied", async () => {
    const { caller } = await fixture({ ok: true, accessibility_trusted: true });
    expect(await caller.status()).toMatchObject({ macosMajor: null, input: "unknown", notifications: "unknown", microphone: "ready" });
  });
  it("requires UI authorization and a fixed permission identifier before opening settings", async () => {
    const { caller, calls } = await fixture();
    await expect(caller.openSettings({ permission: "input" })).resolves.toEqual({ opened: true });
    expect(calls).toEqual([{ action: "open_permission_settings", permission: "input" }]);
    await expect(caller.openSettings({ permission: "https://example.com" })).rejects.toThrow();
    const denied = await fixture(native, false);
    await expect(denied.caller.openSettings({ permission: "input" })).rejects.toThrow("UI mutation bearer required");
    expect(denied.calls).toEqual([]);
  });
});
