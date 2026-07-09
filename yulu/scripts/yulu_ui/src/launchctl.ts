import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const exec = promisify(execFile) as (cmd: string, args: string[], opts?: object) => Promise<{ stdout: string; stderr: string }>;

export interface DaemonStatus {
  pid: number;
  exitStatus: number;
  label: string;
}

export class LaunchctlClient {
  constructor(
    private readonly launchAgentsDir: string,
    private readonly statusAgentPidFile = join(homedir(), ".config", "yulu", "status_agent.pid"),
  ) {}

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
   * Parse `launchctl list` output. The label-specific form returns a
   * property-list-ish block on modern macOS, while the table form is stable:
   * PID\tEXIT\tLABEL, with PID "-" for loaded on-demand jobs.
   * Returns null when service is not loaded.
   */
  async status(label: string): Promise<DaemonStatus | null> {
    try {
      const { stdout } = await exec("launchctl", ["list"]);
      for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line || line.startsWith("PID")) continue;
        const [pidStr, exitStr, lbl] = line.split(/\s+/);
        if (lbl !== label) continue;
        return {
          pid: pidStr === "-" ? 0 : Number(pidStr) || 0,
          exitStatus: Number(exitStr) || 0,
          label: lbl,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  async sighup(label: string): Promise<void> {
    if (label === "com.yulu.statusagent") {
      const pid = this.statusAgentPid();
      if (pid) {
        process.kill(pid, "SIGHUP");
        return;
      }
    }
    const s = await this.status(label);
    if (!s || s.pid === 0) throw new Error(`Cannot sighup — ${label} not running`);
    process.kill(s.pid, "SIGHUP");
  }

  private statusAgentPid(): number | null {
    try {
      const pid = Number(readFileSync(this.statusAgentPidFile, "utf8").trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }
}
