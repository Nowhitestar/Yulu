export type FeatureState = "ready" | "off" | "unconfigured" | "unchecked" | "attention";
export interface FeatureHealth {
  id: string;
  state: FeatureState;
  detail: string;
  href: string;
  action?: string;
  time?: string;
}
interface ConnectionView {
  selections: { summary: { connectionId: string | null; model: string }; transcription: { connectionId: string | null; model: string } };
  connections: readonly {
    id: string;
    authorization: { connected: boolean };
    capabilities: readonly { capability: string; declared: boolean; currentReadiness: { status: string; model: string; testedAt?: string | null }; disclosure: { required: boolean } }[];
  }[];
}
export interface FeatureInputs {
  config?: {
    transcription: { engine: string };
    agent_pipeline: { enabled: boolean; auto_process_recordings: boolean };
    status_agent: { enabled: boolean };
    calendars: readonly { enabled?: boolean }[];
  };
  capture?: { reachable: boolean; recording: boolean | null; micReady: boolean | null; sysReady: boolean | null };
  recording?: { state: string };
  audio?: { available: boolean; provider: string };
  connections?: ConnectionView;
  calendar?: { selectedSource: unknown; readiness: { status: string; testedAt?: string | null } };
  schedule?: { exists?: boolean; updatedAt: string; schedulerStatus: { pid: number | null } | null; calendarStatus: { pid: number | null } | null; events: readonly { kind: string; at: string }[] };
  now?: number;
}

export function buildFeatureHealth(input: FeatureInputs): FeatureHealth[] {
  const { config, capture, recording, audio, connections, calendar, schedule } = input;
  const now = input.now ?? Date.now();
  const row = (id: string, href: string): FeatureHealth => ({ id, state: "unchecked", detail: "unavailable", href });
  const captureRow = row("recording", "/health#daemons");
  if (capture?.reachable === false) Object.assign(captureRow, { state: "attention", detail: "captureUnavailable" });
  if (capture?.reachable) {
    if (!capture.micReady || !capture.sysReady) Object.assign(captureRow, { state: "attention", detail: !capture.micReady ? "microphone" : "systemAudio", href: "/settings/recording#audio", action: "configure" });
    else if (recording && recording.state !== "unknown" && recording.state !== "daemonDown") Object.assign(captureRow, { state: "ready", detail: capture.recording ? "recording" : "captureReady" });
  }

  const providerRow = (id: "transcription" | "summary") => {
    const feature = row(id, `/settings/connections?capability=${id}`);
    if (!connections) return feature;
    const selection = connections.selections[id];
    feature.href = `/settings/connections?${selection.connectionId ? `connection=${encodeURIComponent(selection.connectionId)}&` : ""}capability=${id}`;
    const connection = connections.connections.find((item) => item.id === selection.connectionId);
    const capability = connection?.capabilities.find((item) => item.capability === id);
    if (!connection || !capability?.declared) return { ...feature, state: "unconfigured" as const, detail: "chooseService", action: "configure" };
    if (!connection.authorization.connected) return { ...feature, state: "attention" as const, detail: "signIn", action: "configure" };
    if (capability.disclosure.required) return { ...feature, state: "attention" as const, detail: "reviewData", action: "configure" };
    const check = capability.currentReadiness;
    // A proof for a different model must never make the selected model green.
    if (check.model !== selection.model || !["ready", "failed"].includes(check.status)) return { ...feature, detail: "notTested", action: "check" };
    return { ...feature, state: check.status === "ready" ? "ready" as const : "attention" as const, detail: check.status === "ready" ? "tested" : "testFailed", time: check.testedAt ?? undefined, action: "check" };
  };
  let transcription = providerRow("transcription");
  if (!config) transcription = row("transcription", "/settings/recording#transcription");
  else if (config.transcription.engine === "local") {
    transcription = row("transcription", "/settings/recording#transcription");
    if (audio?.provider === "local") Object.assign(transcription, { state: audio.available ? "ready" : "unconfigured", detail: audio.available ? "localReady" : "installModel", action: "configure" });
  }
  const summary = providerRow("summary");
  if (!config) Object.assign(summary, { state: "unchecked", detail: "unavailable" });
  else if (!config.agent_pipeline.enabled || !config.agent_pipeline.auto_process_recordings) Object.assign(summary, { state: "off", detail: "automaticOff", href: "/settings/recording#recording-processing", action: "configure", time: undefined });

  const reminders = row("reminders", "/settings/meetings#calendar-source");
  if (config && calendar) {
    if (config.calendars.length > 0 && !config.calendars.some((item) => item.enabled === true)) Object.assign(reminders, { state: "off", detail: "remindersOff" });
    else if (!calendar.selectedSource) Object.assign(reminders, { state: "unconfigured", detail: "connectCalendar", action: "connect" });
    else if (calendar.readiness.status === "failed") Object.assign(reminders, { state: "attention", detail: "calendarFailed", action: "connect" });
    else if (schedule && (!schedule.schedulerStatus?.pid || !schedule.calendarStatus?.pid)) Object.assign(reminders, { state: "attention", detail: "reminderStopped", href: "/health#scheduler" });
    else if (schedule) {
      const updated = Date.parse(schedule.updatedAt);
      if (!Number.isFinite(updated) || schedule.exists === false || now - updated > 10 * 60_000 || updated > now + 60_000) Object.assign(reminders, { state: "attention", detail: "calendarStale", action: "connect" });
      else if (calendar.readiness.status !== "ready") Object.assign(reminders, { detail: "calendarNotTested", action: "check" });
      else {
        const next = schedule.events.filter((event) => /^(prompt|remind|reminder|notify)$/.test(event.kind) && Date.parse(event.at) >= now).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0];
        Object.assign(reminders, { state: "ready", detail: next ? "nextReminder" : "calendarUpdated", time: next?.at ?? schedule.updatedAt });
      }
    }
  }

  const voice = row("voice", "/settings/voice");
  if (config?.status_agent.enabled === false) Object.assign(voice, { state: "off", detail: "voiceOff", action: "configure" });
  else if (config && capture?.reachable && capture.micReady === false) Object.assign(voice, { state: "attention", detail: "microphone", action: "configure" });
  else if (config && recording && ["daemonDown", "unknown"].includes(recording.state)) Object.assign(voice, { state: "attention", detail: "voiceUnavailable" });
  else if (config && recording && capture?.micReady) {
    if (transcription.state !== "ready") Object.assign(voice, { state: transcription.state, detail: "voiceEngine", href: transcription.href, action: transcription.action });
    else Object.assign(voice, { state: "ready", detail: "voiceReady" });
  }
  return [captureRow, transcription, summary, reminders, voice];
}
