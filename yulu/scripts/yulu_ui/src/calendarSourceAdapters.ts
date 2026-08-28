import { spawn } from "node:child_process";
import { join } from "node:path";
import { envWithFallbackPath, resolveExecutable } from "./executables.js";
import type {
  CalendarSourceAdapterResult,
  CalendarSourceFailureReason,
  CalendarSourceId,
} from "./calendarSources.js";

export interface CalendarCommandResult {
  code: number;
  stdout: string;
  stderr: string;
  errorCode: string | null;
}

export interface CalendarCommandRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<CalendarCommandResult>;
}

class SpawnCalendarCommandRunner implements CalendarCommandRunner {
  run(command: string, args: string[], timeoutMs: number): Promise<CalendarCommandResult> {
    return new Promise((resolve) => {
      const env = envWithFallbackPath(process.env);
      const executable = command === "gog" ? resolveExecutable(command, env) : command;
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: CalendarCommandResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      const child = spawn(executable, args, { env });
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        finish({ code: 1, stdout, stderr, errorCode: error.code ?? "SPAWN_ERROR" });
      });
      child.on("close", (code: number | null) => {
        clearTimeout(timer);
        finish({ code: code ?? 1, stdout, stderr, errorCode: null });
      });
    });
  }
}

const FAILURE_COPY: Record<CalendarSourceId, Record<CalendarSourceFailureReason, {
  detail: string;
  remediation: string;
}>> = {
  macos: {
    runtime_missing: {
      detail: "The native EventKit Calendar helper is missing",
      remediation: "Reinstall Yulu from the signed application",
    },
    authorization_denied: {
      detail: "Calendar access was denied",
      remediation: "Open System Settings > Privacy & Security > Calendars and allow Yulu",
    },
    authorization_restricted: {
      detail: "Calendar access is restricted",
      remediation: "Ask the device administrator to allow Calendar access in System Settings",
    },
    authorization_not_determined: {
      detail: "Calendar access is still not determined",
      remediation: "Return to Yulu and Allow Calendar access when macOS asks",
    },
    service_activation_failed: {
      detail: "The production Calendar polling services did not activate",
      remediation: "Repair or reinstall Yulu's Calendar services, then select the Calendar Source again",
    },
    enumeration_failed: {
      detail: "EventKit could not enumerate the bounded Calendar window",
      remediation: "Try again; if it still fails, review Yulu Calendar access in System Settings",
    },
  },
  gog: {
    runtime_missing: {
      detail: "The optional gog runtime is not installed",
      remediation: "Install gog, complete its native OAuth flow, then return to Yulu",
    },
    authorization_denied: {
      detail: "gog does not have usable Google Calendar authorization",
      remediation: "Run gog auth for the selected account, then return to Yulu",
    },
    authorization_restricted: {
      detail: "Google Calendar access is restricted for this account",
      remediation: "Ask the Google Workspace administrator to allow Calendar access",
    },
    authorization_not_determined: {
      detail: "gog Calendar authorization is incomplete",
      remediation: "Finish the gog native OAuth flow, then return to Yulu",
    },
    service_activation_failed: {
      detail: "The production Calendar polling services did not activate",
      remediation: "Repair or reinstall Yulu's Calendar services, then select the Calendar Source again",
    },
    enumeration_failed: {
      detail: "gog could not enumerate the bounded Calendar window",
      remediation: "Try again; if it still fails, run gog Calendar diagnostics for the selected account",
    },
  },
};

function failed(source: CalendarSourceId, reason: CalendarSourceFailureReason): CalendarSourceAdapterResult {
  return { ok: false, reason, ...FAILURE_COPY[source][reason] };
}

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function parseJson(stdout: string): unknown {
  try {
    return JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
}

function nativeHelperPath(scriptDir: string): string {
  return join(scriptDir, "Yulu.app", "Contents", "MacOS", "calendar_probe");
}

function helperFailureReason(value: unknown): CalendarSourceFailureReason {
  const reason = object(value)?.reason;
  return reason === "authorization_denied" || reason === "authorization_restricted" ||
      reason === "authorization_not_determined"
    ? reason
    : "enumeration_failed";
}

function gogFailureReason(result: CalendarCommandResult): CalendarSourceFailureReason {
  if (result.errorCode === "ENOENT") return "runtime_missing";
  const message = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return /not authenticated|unauthori[sz]ed|oauth|auth required|login required|credential|token expired/.test(message)
    ? "authorization_denied"
    : "enumeration_failed";
}

function eventItems(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  const record = object(value);
  if (!record) return null;
  if (Array.isArray(record.events)) return record.events;
  if (Array.isArray(record.items)) return record.items;
  if (record.result) return eventItems(record.result);
  return null;
}

function validGogEventDate(value: unknown): boolean {
  const record = object(value);
  if (!record) return false;
  const raw = typeof record.dateTime === "string"
    ? record.dateTime
    : typeof record.date === "string"
      ? record.date
      : "";
  return raw.length > 0 && Number.isFinite(Date.parse(raw));
}

function validGogEvent(value: unknown): boolean {
  const record = object(value);
  return !!record && validGogEventDate(record.start) && validGogEventDate(record.end);
}

export function createCalendarSourceAdapters(options: {
  scriptDir: string;
  runner?: CalendarCommandRunner;
}) {
  const runner = options.runner ?? new SpawnCalendarCommandRunner();
  return {
    macos: {
      async probe(input): Promise<CalendarSourceAdapterResult> {
        const result = await runner.run(
          nativeHelperPath(options.scriptDir),
          ["--start", input.start, "--end", input.end],
          35_000,
        );
        if (result.errorCode === "ENOENT") return failed("macos", "runtime_missing");
        const parsed = parseJson(result.stdout);
        const record = object(parsed);
        if (result.code !== 0 || record?.ok !== true) {
          return failed("macos", helperFailureReason(parsed));
        }
        if (
          record.access !== "granted" || record.enumerationSucceeded !== true ||
          record.start !== input.start || record.end !== input.end ||
          typeof record.eventCount !== "number" || !Number.isSafeInteger(record.eventCount) || record.eventCount < 0
        ) return failed("macos", "enumeration_failed");
        return {
          ok: true,
          adapter: "eventkit",
          start: input.start,
          end: input.end,
          eventCount: record.eventCount,
        };
      },
    },
    gog: {
      async probe(input): Promise<CalendarSourceAdapterResult> {
        if (!input.account) return failed("gog", "authorization_not_determined");
        const result = await runner.run("gog", [
          "--json",
          "--results-only",
          "--no-input",
          "--account",
          input.account,
          "calendar",
          "events",
          "primary",
          "--all-pages",
          "--from",
          input.start,
          "--to",
          input.end,
        ], 15_000);
        if (result.code !== 0 || result.errorCode) return failed("gog", gogFailureReason(result));
        const events = eventItems(parseJson(result.stdout));
        if (!events || !events.every(validGogEvent)) return failed("gog", "enumeration_failed");
        return {
          ok: true,
          adapter: "gog-cli",
          start: input.start,
          end: input.end,
          eventCount: events.length,
        };
      },
    },
  } satisfies Record<CalendarSourceId, { probe(input: {
    start: string;
    end: string;
    account: string | null;
  }): Promise<CalendarSourceAdapterResult> }>;
}
