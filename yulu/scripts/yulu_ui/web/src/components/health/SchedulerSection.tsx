import { useQueryClient } from "@tanstack/react-query";
import { trpc } from "../../trpc.js";
import { useT } from "../../i18n/LanguageProvider.js";
import "./ControlSections.css";

interface ScheduleEvent {
  kind: string;
  at: string;
  title: string;
  meetingId: string;
}

interface ScheduleMeeting {
  id: string;
  title: string;
  start: string;
  source: string;
  attendees: string[];
}

function daemonStatus(status?: { pid: number; exitStatus: number } | null): string {
  if (!status) return "stopped";
  if (status.pid > 0) return "running";
  return status.exitStatus === 0 ? "idle" : "crashed";
}

export function SchedulerSection() {
  const t = useT();
  const qc = useQueryClient();
  const { data, refetch, isPending } = trpc.scheduler.overview.useQuery(undefined, { refetchInterval: 10_000 });
  const reloadMut = trpc.scheduler.reload.useMutation({
    onSuccess: () => qc.invalidateQueries({ queryKey: [["scheduler", "overview"]] }),
  });
  const events = (data?.events ?? []) as ScheduleEvent[];
  const meetings = (data?.meetings ?? []) as ScheduleMeeting[];
  const schedulerState = daemonStatus(data?.schedulerStatus);
  const calendarState = daemonStatus(data?.calendarStatus);
  const reloadPid = reloadMut.data && "pid" in reloadMut.data ? reloadMut.data.pid : "";
  const reloadError = reloadMut.data && "error" in reloadMut.data ? reloadMut.data.error : "";

  return (
    <section className="control-section" data-testid="scheduler-section">
      <div className="control-toolbar">
        <div className="control-toolbar-title">
          <h2>{t("health.scheduler.heading")}</h2>
          <p>{data?.schedulePath ?? t("health.scheduler.loading")}</p>
        </div>
        <div className="control-actions">
          <button type="button" className="control-btn" onClick={() => refetch()}>{t("common.refresh")}</button>
          <button type="button" className="control-btn" disabled={reloadMut.isPending} onClick={() => reloadMut.mutate()}>
            {t("health.scheduler.reload")}
          </button>
        </div>
      </div>

      {isPending ? (
        <div className="control-empty">{t("common.loading")}</div>
      ) : (
        <>
          <div className="control-stats">
            <span className="control-pill" data-status={schedulerState}>{t("health.scheduler.daemon")}: {schedulerState}</span>
            <span className="control-pill" data-status={calendarState}>{t("health.scheduler.calendar")}: {calendarState}</span>
            <span className="control-pill">{t("health.scheduler.events", { n: events.length })}</span>
            <span className="control-pill">{t("health.scheduler.meetings", { n: meetings.length })}</span>
          </div>

          {reloadMut.data && (
            <div className="control-empty">
              {reloadMut.data.ok ? t("health.scheduler.reloadOk", { pid: reloadPid }) : t("health.scheduler.reloadFailed", { error: reloadError })}
            </div>
          )}

          <div className="control-grid">
            <article className="control-card">
              <div className="control-card-title">{t("health.scheduler.nextEvents")}</div>
              {events.length === 0 ? (
                <div className="control-card-sub">{t("health.scheduler.noEvents")}</div>
              ) : events.slice(0, 12).map((event) => (
                <div key={`${event.kind}-${event.at}-${event.meetingId}`} className="control-meta">
                  <div><strong>{event.kind}</strong> · {event.at}</div>
                  <div>{event.title || event.meetingId}</div>
                </div>
              ))}
            </article>

            <article className="control-card">
              <div className="control-card-title">{t("health.scheduler.meetingList")}</div>
              {meetings.length === 0 ? (
                <div className="control-card-sub">{t("health.scheduler.noMeetings")}</div>
              ) : meetings.slice(0, 12).map((meeting) => (
                <div key={`${meeting.id}-${meeting.start}`} className="control-meta">
                  <div><strong>{meeting.title || meeting.id}</strong> · {meeting.start}</div>
                  <div>{meeting.source || "calendar"} · {meeting.attendees.length} attendees</div>
                </div>
              ))}
            </article>
          </div>
        </>
      )}
    </section>
  );
}
