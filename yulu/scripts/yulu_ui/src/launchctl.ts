import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";

const exec = promisify(execFile) as (cmd: string, args: string[], opts?: object) => Promise<{ stdout: string; stderr: string }>;

export interface DaemonStatus {
  pid: number;
  exitStatus: number;
  label: string;
}

export class LaunchctlClient {
  constructor(private readonly launchAgentsDir: string) {}

  private plist(label: string): string {
    return join(this.launchAgentsDir, label + ".plist");
  }

  async restart(label: string): Promise<void> {
    await exec("launchctl", ["unload", this.plist(label)]).catch(() => undefined);
    await exec("launchctl", ["load", this.plist(label)]);
  }

  async stop(label: string): Promise<void> {
    await exec("launchctl", ["unload", this.plist(label)]);
  }

  async start(label: string): Promise<void> {
    await exec("launchctl", ["load", this.plist(label)]);
  }

  /**
   * Parse `launchctl list <label>` output (single line: PID\tEXIT\tLABEL).
   * Returns null when service is not loaded.
   */
  async status(label: string): Promise<DaemonStatus | null> {
    try {
      const { stdout } = await exec("launchctl", ["list", label]);
      const line = stdout.trim().split("\n")[0] ?? "";
      const [pidStr, exitStr, lbl] = line.split("\t");
      if (!pidStr || !exitStr || !lbl) return null;
      return { pid: Number(pidStr) || 0, exitStatus: Number(exitStr) || 0, label: lbl };
    } catch {
      return null;
    }
  }

  async sighup(label: string): Promise<void> {
    const s = await this.status(label);
    if (!s || s.pid === 0) throw new Error(`Cannot sighup — ${label} not running`);
    process.kill(s.pid, "SIGHUP");
  }
}
