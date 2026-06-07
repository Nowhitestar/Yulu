import { useState } from "react";
import { useSearchParams } from "react-router";
import { trpc } from "../../trpc.js";
import { LogTail } from "../LogTail.js";
import { useT } from "../../i18n/LanguageProvider.js";
import "./LogsSection.css";

const YULU_DAEMONS = [
  "com.yulu.audiodaemon",
  "com.yulu.sttdaemon",
  "com.yulu.agentqueue",
  "com.yulu.statusagent",
  "com.yulu.scheduler",
  "com.yulu.detector",
  "com.yulu.calendar",
  "com.yulu.ui",
] as const;

type DaemonName = typeof YULU_DAEMONS[number];

export function LogsSection() {
  const [params, setParams] = useSearchParams();
  const t = useT();
  // Local override mirrors search.tsx pattern — controlled select reflects
  // changes immediately even if the router debounces or rejects
  // setSearchParams (e.g. jsdom in tests). URL is still updated for sharing.
  const [nameOverride, setNameOverride] = useState<DaemonName | null>(null);
  const fullName = (nameOverride ?? (params.get("name") ?? "com.yulu.audiodaemon")) as DaemonName;
  const shortName = fullName.replace(/^com\.yulu\./, "");
  const [paused, setPaused] = useState(false);
  const [resetKey, setResetKey] = useState(0);

  const { data } = trpc.logs.tail.useQuery({ name: fullName as DaemonName, limit: 500 });
  const initial = (data?.lines as string[] | undefined) ?? [];

  const setName = (v: string) => {
    setNameOverride(v as DaemonName);
    const next = new URLSearchParams(params);
    next.set("name", v);
    setParams(next, { replace: true });
  };

  return (
    <div className="logs-section">
      <div className="logs-toolbar">
        <select
          aria-label={t("health.logs.daemon.aria")}
          className="logs-select"
          data-testid="logs-daemon"
          value={fullName}
          onChange={(e) => setName(e.target.value)}
        >
          {YULU_DAEMONS.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
        <button type="button" className="logs-btn" onClick={() => setPaused((p) => !p)}>
          {paused ? t("health.logs.resume") : t("health.logs.pause")}
        </button>
        <button type="button" className="logs-btn" onClick={() => setResetKey((k) => k + 1)}>
          {t("health.logs.clear")}
        </button>
      </div>
      <LogTail
        key={`${shortName}-${resetKey}`}
        daemonShortName={shortName}
        daemonLabel={fullName}
        initialLines={initial}
        paused={paused}
        onClear={() => setResetKey((k) => k + 1)}
      />
    </div>
  );
}
