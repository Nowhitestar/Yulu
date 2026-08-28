import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

export type NativeAgentAdapter = "codex" | "claude-code" | "hermes" | "openclaw";

export interface NativeAgentAuthorizationTarget {
  adapter: NativeAgentAdapter;
  executable: string;
}

interface SystemCommandResult {
  code: number;
  stderr: string;
}

type SystemCommandRunner = (command: string, args: string[]) => Promise<SystemCommandResult>;

const LOGIN_ARGS: Record<NativeAgentAdapter, readonly string[]> = {
  codex: ["login"],
  "claude-code": ["auth", "login"],
  hermes: ["model"],
  openclaw: ["configure"],
};

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function runSystemCommand(command: string, args: string[]): Promise<SystemCommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const finish = (result: SystemCommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: 1, stderr: "native authorization launcher timed out" });
    }, 10_000);
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < 8_192) stderr += chunk.toString("utf8").slice(0, 8_192 - stderr.length);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      finish({ code: 1, stderr: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      finish({ code: code ?? 1, stderr });
    });
  });
}

export class MacOsNativeAgentAuthorizationLauncher {
  private readonly run: SystemCommandRunner;

  constructor(options: { run?: SystemCommandRunner } = {}) {
    this.run = options.run ?? runSystemCommand;
  }

  async launch(input: NativeAgentAuthorizationTarget): Promise<{ launched: true }> {
    if (!isAbsolute(input.executable) || /[\0\r\n]/.test(input.executable)) {
      throw new Error("Native authorization requires an absolute runtime path");
    }
    const command = [input.executable, ...LOGIN_ARGS[input.adapter]].map(shellQuote).join(" ");
    const script = [
      'tell application "Terminal"',
      "activate",
      `do script ${JSON.stringify(command)}`,
      "end tell",
    ].join("\n");
    const result = await this.run("/usr/bin/osascript", ["-e", script]);
    if (result.code !== 0) {
      throw new Error(`Unable to open ${input.adapter} native authorization in Terminal`);
    }
    return { launched: true };
  }
}
