import { ArrowUpRight, AudioLines, CalendarDays, CheckCircle2, CircleHelp, FileText, HeartPulse, Mic, RefreshCw } from "lucide-react";
import { Link } from "react-router";
import { trpc } from "../../trpc.js";
import { useLang, useT } from "../../i18n/LanguageProvider.js";
import { buildFeatureHealth } from "./featureHealth.js";
import { taskActivity } from "./taskStatus.js";
import { usePermissions } from "../../hooks/usePermissions.js";
import "./HealthSummary.css";

const ICONS = { recording: Mic, transcription: AudioLines, summary: FileText, reminders: CalendarDays, voice: AudioLines };
const polling = { refetchInterval: 15_000, retry: false } as const;

export function HealthSummary() {
  const t = useT();
  const { lang } = useLang();
  const locale = lang === "zh" ? "zh-CN" : "en-US";
  const config = trpc.config.get.useQuery(undefined, polling);
  const capture = trpc.recording.captureStatus.useQuery(undefined, polling);
  const recording = trpc.recording.state.useQuery(undefined, polling);
  const audio = trpc.agentTasks.transcriptionHealth.useQuery(undefined, polling);
  const connections = trpc.agentConnections.view.useQuery(undefined, polling);
  const calendar = trpc.integrations.calendarSources.useQuery(undefined, polling);
  const schedule = trpc.scheduler.overview.useQuery(undefined, polling);
  const tasks = trpc.agentTasks.list.useQuery({ limit: 100 }, polling);
  const permissions = usePermissions();
  // A failed refresh must not keep showing stale green query data.
  const features = buildFeatureHealth({
    config: config.isError ? undefined : config.data,
    capture: capture.isError ? undefined : capture.data,
    recording: recording.isError ? undefined : recording.data,
    audio: audio.isError ? undefined : audio.data,
    connections: connections.isError ? undefined : connections.data,
    calendar: calendar.isError ? undefined : calendar.data,
    schedule: schedule.isError ? undefined : schedule.data,
    permissions: permissions.data,
  });
  const attention = features.filter((item) => item.state === "attention").length;
  const incomplete = features.filter((item) => ["unchecked", "unconfigured"].includes(item.state)).length;
  const activity = tasks.isError ? null : taskActivity(tasks.data ?? []);
  const queries = [config, capture, recording, audio, connections, calendar, schedule, tasks, permissions];
  const refreshing = queries.some((query) => query.isFetching);
  const checkedAt = !capture.isError ? capture.data?.checkedAt : undefined;
  const rank = { attention: 0, unconfigured: 1, unchecked: 2, ready: 3, off: 4 };
  const sorted = [...features].sort((a, b) => rank[a.state] - rank[b.state]);
  return <section className="runtime-overview" data-testid="health-summary">
    <header className="runtime-heading">
      <div><h1>{t("runtime.title")}</h1><p>{t("runtime.intro")}</p></div>
      <button type="button" className="control-btn runtime-refresh" disabled={refreshing} onClick={() => void Promise.allSettled(queries.map((query) => query.refetch()))}><RefreshCw size={14} />{t(refreshing ? "runtime.refreshing" : "common.refresh")}</button>
    </header>
    <div className={`runtime-verdict ${attention ? "attention" : incomplete ? "unchecked" : "ready"}`} role="status">
      {attention ? <HeartPulse size={22} /> : incomplete ? <CircleHelp size={22} /> : <CheckCircle2 size={22} />}
      <div><strong>{t(attention ? "runtime.attention" : incomplete ? "runtime.incomplete" : "runtime.ready", { n: attention || incomplete })}</strong>
        <span>{checkedAt ? t("runtime.checkedAt", { time: new Date(checkedAt).toLocaleTimeString(locale, { hour12: false }) }) : t("runtime.waiting")}</span></div>
    </div>
    <div className="runtime-features">
      {sorted.map((feature) => {
        const Icon = ICONS[feature.id as keyof typeof ICONS];
        return <article key={feature.id} className="runtime-feature" data-feature={feature.id} data-state={feature.state}>
          <Icon size={19} className="runtime-feature-icon" />
          <div className="runtime-feature-copy"><h2>{t(`runtime.feature.${feature.id}`)}</h2><p>{t(`runtime.detail.${feature.detail}`, { time: feature.time ? new Date(feature.time).toLocaleString(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }) : "" })}</p></div>
          <span className={`runtime-state ${feature.state}`}><i aria-hidden="true" />{t(`runtime.state.${feature.state}`)}</span>
          <Link to={feature.href} className="runtime-feature-action" aria-label={`${t(`runtime.feature.${feature.id}`)}：${t(`runtime.action.${feature.action ?? "details"}`)}`}>{t(`runtime.action.${feature.action ?? "details"}`)}<ArrowUpRight size={13} /></Link>
        </article>;
      })}
    </div>
    <Link className="runtime-task-link" to="/health#queue"><FileText size={17} /><span>{activity ? activity.attention ? t("assistant.activity.attention", { n: activity.attention }) : activity.active ? t("assistant.activity.active", { n: activity.active }) : t("runtime.tasks.empty") : t("runtime.tasks.unavailable")}</span><span>{t("runtime.tasks.open")} →</span></Link>
  </section>;
}
