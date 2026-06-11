import { describe, it, expect, vi, beforeEach } from "vitest";
import { LaunchctlClient } from "../src/launchctl.js";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile: execFileMock }));

beforeEach(() => execFileMock.mockReset());

// execFile may be called as (cmd, args, cb) or (cmd, args, opts, cb).
// Vitest cleanup hooks also invoke the mock with 0 args — ignore those.
function cbOf(args: unknown[]): ((err: unknown, res?: { stdout: string; stderr: string }) => void) | null {
  const last = args[args.length - 1];
  return typeof last === "function" ? (last as never) : null;
}
function ok(stdout = "") {
  execFileMock.mockImplementation((...args: unknown[]) => {
    cbOf(args)?.(null, { stdout, stderr: "" });
  });
}
function fail(code: number, stderr: string) {
  execFileMock.mockImplementation((...args: unknown[]) => {
    const err = new Error("exit " + code) as Error & { code: number; stderr: string };
    err.code = code; err.stderr = stderr;
    cbOf(args)?.(err, { stdout: "", stderr });
  });
}

describe("LaunchctlClient", () => {
  it("restart() runs unload then load", async () => {
    ok();
    const c = new LaunchctlClient("/Users/x/Library/LaunchAgents");
    await c.restart("com.yulu.audiodaemon");
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(execFileMock.mock.calls[0]![1]).toEqual(["unload", "/Users/x/Library/LaunchAgents/com.yulu.audiodaemon.plist"]);
    expect(execFileMock.mock.calls[1]![1]).toEqual(["load", "/Users/x/Library/LaunchAgents/com.yulu.audiodaemon.plist"]);
  });

  it("status() parses the launchctl list table", async () => {
    ok("PID\tStatus\tLabel\n12345\t0\tcom.yulu.audiodaemon\n-\t0\tcom.yulu.agentqueue\n");
    const c = new LaunchctlClient("/Users/x/Library/LaunchAgents");
    const s = await c.status("com.yulu.audiodaemon");
    expect(s).toEqual({ pid: 12345, exitStatus: 0, label: "com.yulu.audiodaemon" });
    expect(execFileMock.mock.calls[0]![1]).toEqual(["list"]);
  });

  it("status() treats '-' PID as loaded without a running process", async () => {
    ok("PID\tStatus\tLabel\n-\t0\tcom.yulu.agentqueue\n");
    const c = new LaunchctlClient("/Users/x/Library/LaunchAgents");
    const s = await c.status("com.yulu.agentqueue");
    expect(s).toEqual({ pid: 0, exitStatus: 0, label: "com.yulu.agentqueue" });
  });

  it("status() returns null when not loaded", async () => {
    fail(3, "Could not find service");
    const c = new LaunchctlClient("/Users/x/Library/LaunchAgents");
    expect(await c.status("com.yulu.missing")).toBeNull();
  });
});
