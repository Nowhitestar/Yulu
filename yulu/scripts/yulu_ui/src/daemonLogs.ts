import { existsSync } from "node:fs";
import { join } from "node:path";

export const YULU_DAEMON_LOG_SOURCES = [
  { label: "com.yulu.audiodaemon", shortName: "audiodaemon", filename: "audio_daemon.log" },
  { label: "com.yulu.statusagent", shortName: "statusagent", filename: "status_agent.log" },
  { label: "com.yulu.scheduler", shortName: "scheduler", filename: "scheduler.log" },
  { label: "com.yulu.detector", shortName: "detector", filename: "detector.log" },
  { label: "com.yulu.calendar", shortName: "calendar", filename: "calendar_services.log" },
  { label: "com.yulu.ui", shortName: "ui", filename: "ui.log" },
] as const;

export const YULU_DAEMONS = YULU_DAEMON_LOG_SOURCES.map((source) => source.label) as [
  "com.yulu.audiodaemon",
  "com.yulu.statusagent",
  "com.yulu.scheduler",
  "com.yulu.detector",
  "com.yulu.calendar",
  "com.yulu.ui",
];

export type YuluDaemon = typeof YULU_DAEMONS[number];

export const YULU_DAEMON_LOG_FILES = Object.fromEntries(
  YULU_DAEMON_LOG_SOURCES.map((source) => [source.label, source.filename]),
) as Record<YuluDaemon, string>;

export function daemonLogPath(name: YuluDaemon, logsDir: string, legacyDir: string): string {
  const filename = YULU_DAEMON_LOG_FILES[name];
  const standard = join(logsDir, filename);
  return existsSync(standard) ? standard : join(legacyDir, filename);
}
