import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { router, publicProcedure } from "../trpc.js";

type ScheduleEvent = Record<string, unknown>;
type PrimaryAction = "record" | "record_join";

const primaryActionSchema = z.enum(["record", "record_join"]);
const DEFAULT_PRIMARY_ACTION: PrimaryAction = "record";

function readJson(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function normalizeEvent(event: ScheduleEvent) {
  return {
    kind: String(event.kind ?? ""),
    at: String(event.at ?? ""),
    title: String(event.title ?? ""),
    meetingId: String(event.meeting_id ?? event.id ?? ""),
  };
}

function normalizeMeeting(meeting: ScheduleEvent) {
  return {
    id: String(meeting.id ?? ""),
    title: String(meeting.title ?? ""),
    start: String(meeting.start ?? ""),
    end: String(meeting.end ?? ""),
    durationMin: Number(meeting.duration_min ?? 60) || 60,
    source: String(meeting.source ?? meeting.provider ?? ""),
    link: String(meeting.link ?? meeting.url ?? ""),
    attendees: Array.isArray(meeting.attendees) ? meeting.attendees.map(String) : [],
  };
}

function readPrimaryAction(configDir: string): PrimaryAction {
  const raw = readJson(join(configDir, "meeting_prompt.json"));
  return raw.primary_action === "record_join" ? "record_join" : DEFAULT_PRIMARY_ACTION;
}

function writePrimaryAction(configDir: string, action: PrimaryAction): PrimaryAction {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "meeting_prompt.json"), JSON.stringify({
    primary_action: action,
    updated_at: new Date().toISOString(),
  }, null, 2), "utf8");
  return action;
}

function currentMeeting(meetings: ReturnType<typeof normalizeMeeting>[]) {
  const now = Date.now();
  return meetings
    .filter((meeting) => {
      const start = Date.parse(meeting.start);
      if (!Number.isFinite(start)) return false;
      const end = meeting.end ? Date.parse(meeting.end) : start + meeting.durationMin * 60_000;
      return Number.isFinite(end) && start <= now && now <= end;
    })
    .sort((a, b) => b.start.localeCompare(a.start))[0] ?? null;
}

function runMeetingDaemon(scriptDir: string, args: string[]): Promise<{ ok: boolean; code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const proc = spawn("python3", ["meeting_daemon.py", ...args], {
      cwd: scriptDir,
      env: { ...process.env, PYTHONPATH: scriptDir },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => proc.kill("SIGKILL"), 20_000);
    proc.stdout.on("data", (b: Buffer) => { stdout += b.toString("utf8"); });
    proc.stderr.on("data", (b: Buffer) => { stderr += b.toString("utf8"); });
    proc.on("error", (exc: Error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: 999, stdout, stderr: stderr || exc.message });
    });
    proc.on("close", (code: number | null) => {
      clearTimeout(timer);
      resolve({ ok: (code ?? 1) === 0, code: code ?? 1, stdout, stderr });
    });
  });
}

export const schedulerRouter = router({
  overview: publicProcedure.query(async ({ ctx }) => {
    const schedulePath = join(ctx.paths.configDir, "schedule.json");
    const pidPath = join(ctx.paths.configDir, ".scheduler.pid");
    const raw = readJson(schedulePath);
    const rawEvents = Array.isArray(raw.events) ? raw.events : [];
    const rawMeetings = Array.isArray(raw.meetings) ? raw.meetings : [];
    const events = rawEvents
      .filter((event): event is ScheduleEvent => !!event && typeof event === "object" && !Array.isArray(event))
      .map(normalizeEvent)
      .sort((a, b) => a.at.localeCompare(b.at));
    const meetings = rawMeetings
      .filter((meeting): meeting is ScheduleEvent => !!meeting && typeof meeting === "object" && !Array.isArray(meeting))
      .map(normalizeMeeting)
      .sort((a, b) => a.start.localeCompare(b.start));
    let schedulerPid: number | null = null;
    try {
      schedulerPid = existsSync(pidPath) ? Number(readFileSync(pidPath, "utf8").trim()) || null : null;
    } catch {
      schedulerPid = null;
    }
    const scheduler = await ctx.launchctl.status("com.yulu.scheduler");
    const calendar = await ctx.launchctl.status("com.yulu.calendar");
    return {
      schedulePath,
      exists: existsSync(schedulePath),
      updatedAt: existsSync(schedulePath) ? statSync(schedulePath).mtime.toISOString() : "",
      events,
      meetings,
      schedulerPid,
      schedulerStatus: scheduler ? { pid: scheduler.pid, exitStatus: scheduler.exitStatus } : null,
      calendarStatus: calendar ? { pid: calendar.pid, exitStatus: calendar.exitStatus } : null,
    };
  }),

  current: publicProcedure.query(({ ctx }) => {
    const schedulePath = join(ctx.paths.configDir, "schedule.json");
    const raw = readJson(schedulePath);
    const rawMeetings = Array.isArray(raw.meetings) ? raw.meetings : [];
    const meetings = rawMeetings
      .filter((meeting): meeting is ScheduleEvent => !!meeting && typeof meeting === "object" && !Array.isArray(meeting))
      .map(normalizeMeeting);
    return {
      meeting: currentMeeting(meetings),
      primaryAction: readPrimaryAction(ctx.paths.configDir),
    };
  }),

  setPrimaryAction: publicProcedure
    .input(z.object({ action: primaryActionSchema }))
    .mutation(({ ctx, input }) => ({
      primaryAction: writePrimaryAction(ctx.paths.configDir, input.action),
    })),

  startMeeting: publicProcedure
    .input(z.object({
      meetingId: z.string().min(1),
      action: primaryActionSchema,
    }))
    .mutation(async ({ ctx, input }) => {
      writePrimaryAction(ctx.paths.configDir, input.action);
      const args = ["start_meeting", input.meetingId];
      if (input.action === "record_join") args.push("--join");
      return runMeetingDaemon(ctx.paths.scriptDir, args);
    }),

  reload: publicProcedure.mutation(({ ctx }) => {
    const pidPath = join(ctx.paths.configDir, ".scheduler.pid");
    if (!existsSync(pidPath)) return { ok: false, error: "scheduler pid file not found" };
    const pid = Number(readFileSync(pidPath, "utf8").trim());
    if (!pid) return { ok: false, error: "scheduler pid file is invalid" };
    try {
      process.kill(pid, "SIGHUP");
      return { ok: true, pid };
    } catch (exc) {
      return { ok: false, pid, error: (exc as Error).message };
    }
  }),
});
