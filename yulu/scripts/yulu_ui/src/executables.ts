import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

const FALLBACK_PATHS = [
  join(homedir(), ".local", "bin"),
  join(homedir(), ".npm-global", "bin"),
  join(homedir(), ".nvm", "current", "bin"),
  "/opt/homebrew/opt/node/bin",
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
  "/bin",
  "/usr/sbin",
  "/sbin",
];

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function envWithFallbackPath(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const entries = new Set((env.PATH ?? "").split(delimiter).filter(Boolean));
  for (const dir of FALLBACK_PATHS) entries.add(dir);
  return { ...env, PATH: [...entries].join(delimiter) };
}

export function resolveExecutable(cmd: string, env: NodeJS.ProcessEnv = process.env): string {
  if (isAbsolute(cmd)) return cmd;
  const pathEnv = envWithFallbackPath(env).PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, cmd);
    if (isExecutable(candidate)) return candidate;
  }
  return cmd;
}
