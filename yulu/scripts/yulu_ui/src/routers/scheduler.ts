import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { router, publicProcedure } from "../trpc.js";

type ScheduleEvent = Record<string, unknown>;

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
    source: String(meeting.source ?? meeting.provider ?? ""),
    attendees: Array.isArray(meeting.attendees) ? meeting.attendees.map(String) : [],
  };
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
