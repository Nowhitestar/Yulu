import { describe, expect, it, vi } from "vitest";
import { MacOsNativeAgentAuthorizationLauncher } from "../src/nativeAgentAuthorization.js";

describe("native Agent authorization launcher", () => {
  it.each([
    ["codex", "/fake/bin/codex", "'/fake/bin/codex' 'login'"],
    ["claude-code", "/fake/bin/claude", "'/fake/bin/claude' 'auth' 'login'"],
    ["hermes", "/fake/bin/hermes", "'/fake/bin/hermes' 'model'"],
    ["openclaw", "/fake/bin/openclaw", "'/fake/bin/openclaw' 'configure'"],
  ] as const)("opens the fixed %s runtime-owned login command in Terminal", async (
    adapter,
    executable,
    expectedCommand,
  ) => {
    const run = vi.fn(async (_command: string, _args: string[]) => ({ code: 0, stderr: "" }));
    const launcher = new MacOsNativeAgentAuthorizationLauncher({ run });

    await expect(launcher.launch({ adapter, executable })).resolves.toEqual({ launched: true });

    expect(run).toHaveBeenCalledOnce();
    const [command, args] = run.mock.calls[0]!;
    expect(command).toBe("/usr/bin/osascript");
    expect(args).toHaveLength(2);
    expect(args[0]).toBe("-e");
    expect(args[1]).toContain(`do script ${JSON.stringify(expectedCommand)}`);
    expect(args[1]).not.toMatch(/access[-_ ]?token|refresh[-_ ]?token|api[-_ ]?key/i);
  });

  it("rejects an invalid executable before opening Terminal", async () => {
    const run = vi.fn();
    const launcher = new MacOsNativeAgentAuthorizationLauncher({ run });

    await expect(launcher.launch({ adapter: "codex", executable: "codex\nlogout" }))
      .rejects.toThrow("absolute runtime path");
    expect(run).not.toHaveBeenCalled();
  });

  it("shell-quotes an absolute runtime path before Terminal executes it", async () => {
    const run = vi.fn(async (_command: string, _args: string[]) => ({ code: 0, stderr: "" }));
    const launcher = new MacOsNativeAgentAuthorizationLauncher({ run });

    await launcher.launch({ adapter: "codex", executable: "/Applications/Agent's Tools/codex" });

    const quotedCommand = "'/Applications/Agent'\\''s Tools/codex' 'login'";
    expect(run.mock.calls[0]?.[1][1]).toContain(`do script ${JSON.stringify(quotedCommand)}`);
  });
});
