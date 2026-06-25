import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { envWithFallbackPath, resolveExecutable } from "./executables.js";

export interface LlmCommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function resolveBundledScriptArgs(command: string[], scriptDir: string): string[] {
  return command.map((part) => {
    if (part.includes("/")) return part;
    const candidate = join(scriptDir, part);
    return existsSync(candidate) ? candidate : part;
  });
}

export function runLlmCommand(
  command: string[],
  scriptDir: string,
  stdin: string,
  timeoutMs: number,
  cwd = scriptDir,
): Promise<LlmCommandResult> {
  return new Promise((resolve) => {
    const [rawCmd, ...args] = resolveBundledScriptArgs(command, scriptDir);
    const spawnEnv = envWithFallbackPath(process.env);
    const cmd = rawCmd ? resolveExecutable(rawCmd, spawnEnv) : "";
    if (!cmd) {
      resolve({ stdout: "", stderr: "llm.command is empty", code: 1 });
      return;
    }

    let stdout = "", stderr = "";
    let settled = false;
    const finish = (result: LlmCommandResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const proc = spawn(cmd, args, { cwd, env: spawnEnv });
    const timer = setTimeout(() => { proc.kill("SIGKILL"); }, timeoutMs);
    proc.stdin.write(stdin);
    proc.stdin.end();
    proc.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    proc.on("error", (err: Error) => {
      clearTimeout(timer);
      finish({ stdout, stderr: stderr || err.message, code: 1 });
    });
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      finish({ stdout, stderr, code: code ?? 1 });
    });
  });
}
