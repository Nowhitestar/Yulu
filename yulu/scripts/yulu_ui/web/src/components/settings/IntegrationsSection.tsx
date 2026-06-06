import { useState } from "react";
import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { TestPopover } from "../TestPopover.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface IntegrationsSectionProps {
  tracker: SettingsRestartTracker;
}

type CalendarType = "feishu" | "google";
interface CalendarEntry {
  type: CalendarType;
  enabled?: boolean;
  credentials_path?: string;
  gog_account?: string;
  [k: string]: unknown;
}

export function IntegrationsSection({ tracker }: IntegrationsSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const { commit, isBlocked } = useConfigField(tracker);
  const testMut = trpc.integrations.test.useMutation();
  const [popFor, setPopFor] = useState<string | null>(null);
  const [popState, setPopState] = useState<"pending" | "ok" | "failed">("pending");
  const [popStdout, setPopStdout] = useState("");
  const [popStderr, setPopStderr] = useState("");

  if (!cfg) return null;

  const calendars = (cfg.calendars ?? []) as CalendarEntry[];
  // calendars is restart-class (calendar + scheduler); adding/removing while
  // recording would interrupt capture, so the whole-array edit is guarded.
  const calBlocked = isBlocked("calendars");
  const hasType = (t: CalendarType) => calendars.some((c) => c.type === t);

  // Append a fresh provider (disabled by default — the user fills in creds, then
  // toggles it on). The whole array is replaced via config.update("calendars",…)
  // since calendars has no per-index registry entry (setByDottedKey writes the
  // array wholesale).
  const addCalendar = (type: CalendarType) => {
    if (calBlocked || hasType(type)) return;
    commit("calendars")([...calendars, { type, enabled: false }]);
  };

  const removeCalendar = (idx: number) => {
    if (calBlocked) return;
    commit("calendars")(calendars.filter((_, i) => i !== idx));
  };

  const runTest = async (provider: "feishu" | "google") => {
    setPopFor(provider);
    setPopState("pending");
    setPopStdout("");
    setPopStderr("");
    try {
      const res = await testMut.mutateAsync({ provider });
      setPopState(res.ok ? "ok" : "failed");
      setPopStdout(res.stdout);
      setPopStderr(res.stderr);
    } catch (e) {
      setPopState("failed");
      setPopStderr((e as Error).message);
    }
  };

  return (
    <section id="integrations" className="settings-section">
      <h2 className="settings-section-h">Integrations</h2>
      <p className="settings-section-sub">Google Calendar and external services</p>
      {calendars.length === 0 && (
        <div className="integrations-empty">No calendar providers configured.</div>
      )}
      {calendars.map((cal, idx) => (
        <div key={`${cal.type}-${idx}`} className="integration-card">
          <div className="integration-header">
            <span>{cal.type}</span>
            <button
              type="button"
              className="cmd-remove"
              aria-label={`Remove ${cal.type} calendar`}
              disabled={calBlocked}
              onClick={() => removeCalendar(idx)}
            >
              Remove
            </button>
          </div>
          <InlineEditRow
            label="Enabled"
            type="toggle"
            value={cal.enabled ?? false}
            onCommit={commit(`calendars.${idx}.enabled`)}
            disabled={isBlocked(`calendars.${idx}.enabled`)}
          />
          <InlineEditRow
            label="Credentials path"
            type="path"
            mode="file"
            filter="json"
            value={cal.credentials_path ?? ""}
            onCommit={commit(`calendars.${idx}.credentials_path`) as (v: string) => void}
            disabled={isBlocked(`calendars.${idx}.credentials_path`)}
          />
          <InlineEditRow
            label="Account"
            type="text"
            value={cal.gog_account ?? ""}
            onCommit={commit(`calendars.${idx}.gog_account`) as (v: string) => void}
            disabled={isBlocked(`calendars.${idx}.gog_account`)}
          />
          <div className="row">
            <div className="row-label">Test connection</div>
            <div className="row-value">
              <button type="button" className="cmd-add" onClick={() => runTest(cal.type)}>Test</button>
            </div>
            <div className="row-status" />
          </div>
          {popFor === cal.type && (
            <TestPopover
              state={popState}
              stdout={popStdout}
              stderr={popStderr}
              onClose={() => setPopFor(null)}
            />
          )}
        </div>
      ))}

      {/* P2-5: add a calendar provider. Each appends a disabled entry to the
          calendars array; a provider already present is offered no add (avoids
          duplicate entries). The whole array commit restarts calendar+scheduler,
          so it's guarded while recording. */}
      <div className="row">
        <div className="row-label">
          <div>Add calendar</div>
          <div className="row-help">Add a provider, then fill in its credentials and enable it.</div>
        </div>
        <div className="row-value">
          <button
            type="button"
            className="cmd-add"
            disabled={calBlocked || hasType("feishu")}
            onClick={() => addCalendar("feishu")}
          >
            + Feishu
          </button>{" "}
          <button
            type="button"
            className="cmd-add"
            disabled={calBlocked || hasType("google")}
            onClick={() => addCalendar("google")}
          >
            + Google
          </button>
          {calBlocked && <span className="value-disabled-note">录音中不可改</span>}
        </div>
        <div className="row-status" />
      </div>
    </section>
  );
}
