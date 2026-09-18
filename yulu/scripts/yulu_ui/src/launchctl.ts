import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ipcSend } from "./ipc.js";

const REMINDER_SERVICES = new Set(["com.yulu.scheduler", "com.yulu.calendar", "com.yulu.detector"]);
const APP_SERVICES: Record<string, string> = {
  "com.yulu.ui": "com.yulu.app.host",
  "com.yulu.audiodaemon": "com.yulu.app.capture",
};
interface ReminderStatus extends DaemonStatus { ok: boolean; enabled: boolean; error?: string; }

const exec = promisify(execFile) as (cmd: string, args: string[], opts?: object) => Promise<{ stdout: string; stderr: string }>;

export interface DaemonStatus {
  pid: number;
  exitStatus: number;
  label: string;
}

export type LaunchctlInspection =
  | { state: "running"; status: DaemonStatus }
  | { state: "not_running"; status: DaemonStatus }
  | { state: "not_loaded" }
  | { state: "disabled" }
  | { state: "permission_denied" }
  | { state: "command_failed" };

function launchctlFailure(error: unknown): "permission_denied" | "command_failed" {
  const failure = error as Error & { stderr?: string };
  const detail = `${failure?.message ?? ""} ${failure?.stderr ?? ""}`;
  return /operation not permitted|permission denied|not privileged/i.test(detail)
    ? "permission_denied"
    : "command_failed";
}

function parseStatus(stdout: string, label: string): DaemonStatus | null {
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("PID")) continue;
    const [pidStr, exitStr, listedLabel] = line.split(/\s+/);
    if (listedLabel !== label) continue;
    return {
      pid: pidStr === "-" ? 0 : Number(pidStr) || 0,
      exitStatus: Number(exitStr) || 0,
      label: listedLabel,
    };
  }
  return null;
}

export class LaunchctlClient {
  constructor(
    private readonly launchAgentsDir: string,
    private readonly statusAgentPidFile = join(homedir(), "Library", "Caches", "Yulu", "status_agent.pid"),
    private readonly installedApp = process.env.YULU_SERVICE_OWNER === "com.yulu.app.host",
  ) {}

  private async reminder(label: string, action: string): Promise<ReminderStatus> {
    const status = await ipcSend<ReminderStatus>(
      join(dirname(this.statusAgentPidFile), "reminder_services.sock"), { label, action },
      { timeoutMs: 5_000 },
    );
    if (!status.ok) throw new Error(status.error ?? "Meeting reminder service is unavailable");
    return status;
  }

  private async controlInstalled(label: string, action: "start" | "stop" | "restart"): Promise<boolean> {
    if (!this.installedApp) return false;
    if (REMINDER_SERVICES.has(label)) { await this.reminder(label, action); return true; }
    const owner = APP_SERVICES[label];
    if (owner && action !== "stop") {
      await exec("launchctl", ["kickstart", ...(action === "restart" ? ["-k"] : []), `gui/${process.getuid?.() ?? 0}/${owner}`]);
      return true;
    }
    if (owner || label === "com.yulu.statusagent") {
      throw new Error("This component is managed by Yulu. Quit and reopen the app to restart it.");
    }
    return false;
  }

  private plist(label: string): string {
    return join(this.launchAgentsDir, label + ".plist");
  }

  async restart(label: string): Promise<void> {
    if (await this.controlInstalled(label, "restart")) return;
    await exec("launchctl", ["unload", this.plist(label)]).catch(() => undefined);
    await exec("launchctl", ["load", this.plist(label)]);
  }

  async stop(label: string): Promise<void> {
    if (await this.controlInstalled(label, "stop")) return;
    await exec("launchctl", ["unload", this.plist(label)]);
  }

  async start(label: string): Promise<void> {
    if (await this.controlInstalled(label, "start")) return;
    await exec("launchctl", ["load", this.plist(label)]);
  }

  /**
   * Parse `launchctl list` output. The label-specific form returns a
   * property-list-ish block on modern macOS, while the table form is stable:
   * PID\tEXIT\tLABEL, with PID "-" for loaded on-demand jobs.
   * Returns null when service is not loaded.
   */
  async status(label: string): Promise<DaemonStatus | null> {
    const inspection = await this.inspect(label);
    return inspection.state === "running" || inspection.state === "not_running"
      ? inspection.status
      : null;
  }

  async inspect(label: string): Promise<LaunchctlInspection> {
    if (this.installedApp && REMINDER_SERVICES.has(label)) {
      try {
        const result = await this.reminder(label, "status");
        if (!result.enabled) return { state: "disabled" };
        const status = { label, pid: result.pid, exitStatus: result.exitStatus };
        return { state: status.pid > 0 ? "running" : "not_running", status };
      } catch { return { state: "not_loaded" }; }
    }
    if (this.installedApp && label === "com.yulu.statusagent") {
      try {
        const reply = await ipcSend<{ ok: boolean }>(join(dirname(this.statusAgentPidFile), "status_agent.sock"), { action: "status" });
        const pid = this.statusAgentPid();
        return reply.ok && pid ? { state: "running", status: { label, pid, exitStatus: 0 } } : { state: "not_loaded" };
      } catch { return { state: "not_loaded" }; }
    }
    const inspectedLabel = this.installedApp ? APP_SERVICES[label] ?? label : label;
    let stdout: string;
    try {
      ({ stdout } = await exec("launchctl", ["list"]));
    } catch (error) {
      return { state: launchctlFailure(error) };
    }
    const parsed = parseStatus(stdout, inspectedLabel);
    const status = parsed ? { ...parsed, label } : null;
    if (status) {
      return status.pid > 0
        ? { state: "running", status }
        : { state: "not_running", status };
    }

    let disabledOutput: string;
    try {
      ({ stdout: disabledOutput } = await exec("launchctl", [
        "print-disabled",
        `gui/${process.getuid?.() ?? 0}`,
      ]));
    } catch (error) {
      return { state: launchctlFailure(error) };
    }
    const escapedLabel = inspectedLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const disabled = new RegExp(`(?:"${escapedLabel}"|${escapedLabel})\\s*=>\\s*true(?:\\s|$)`).test(disabledOutput);
    return { state: disabled ? "disabled" : "not_loaded" };
  }

  async sighup(label: string): Promise<void> {
    if (this.installedApp && REMINDER_SERVICES.has(label)) {
      await this.reminder(label, "sighup");
      return;
    }
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
