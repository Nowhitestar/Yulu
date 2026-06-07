import { useState } from "react";
import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { CommandEditor } from "../CommandEditor.js";
import { TestPopover } from "../TestPopover.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface IntegrationsSectionProps {
  tracker: SettingsRestartTracker;
}

// Google is the only real calendar provider. (Feishu was a dead stub and was
// removed in P4a-4.)
type CalendarType = "google";
interface CalendarEntry {
  type: CalendarType;
  enabled?: boolean;
  credentials_path?: string;
  gog_account?: string;
  watch_calendars?: string[];
  [k: string]: unknown;
}

type ConnState = "ok" | "failed" | "pending" | null;

export function IntegrationsSection({ tracker }: IntegrationsSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const { commit, isBlocked } = useConfigField(tracker);
  const testMut = trpc.integrations.test.useMutation();
  const [popFor, setPopFor] = useState<number | null>(null);
  const [popState, setPopState] = useState<"pending" | "ok" | "failed">("pending");
  const [popStdout, setPopStdout] = useState("");
  const [popStderr, setPopStderr] = useState("");
  // Per-entry connection status, shown as Connected / Not authenticated.
  const [connFor, setConnFor] = useState<number | null>(null);
  const [connState, setConnState] = useState<ConnState>(null);

  if (!cfg) return null;

  const calendars = (cfg.calendars ?? []) as CalendarEntry[];
  // calendars is restart-class (calendar + scheduler): changing a *watched*
  // (enabled) calendar interrupts the daemon, so those edits are guarded while
  // recording. Adding/removing/editing a DISABLED entry doesn't touch the
  // running daemon, so it's neither guarded nor restart-tracked (P4a-4).
  const calBlocked = isBlocked("calendars");
  const hasType = (t: CalendarType) => calendars.some((c) => c.type === t);

  // Append a fresh provider, DISABLED by default — the user fills in the account,
  // then toggles it on. Appending a disabled entry needs no daemon restart, so we
  // suppress the restart hint (P4a-4). The whole array is replaced via
  // config.update("calendars",…) (calendars has no per-index registry entry).
  const addCalendar = (type: CalendarType) => {
    if (calBlocked || hasType(type)) return;
    commit("calendars", { suppressRestart: true })([
      ...calendars,
      { type, enabled: false, watch_calendars: ["primary"] },
    ]);
  };

  // Removing an entry only needs a restart if it was actually being watched
  // (enabled); removing a disabled entry is a no-op for the daemon (P4a-4).
  const removeCalendar = (idx: number) => {
    if (calBlocked) return;
    const wasEnabled = calendars[idx]?.enabled === true;
    commit("calendars", { suppressRestart: !wasEnabled })(calendars.filter((_, i) => i !== idx));
  };

  // Toggling enabled: turning ON starts watching → restart; turning OFF stops
  // watching → no restart needed (P4a-4).
  const setEnabled = (idx: number) => (next: boolean) => {
    commit(`calendars.${idx}.enabled`, { suppressRestart: !next })(next);
  };

  // Editing a field of an entry only needs a restart if that entry is currently
  // enabled (the daemon is watching it); edits to a disabled entry are inert.
  const commitField = (idx: number, key: string, enabled: boolean) =>
    commit(`calendars.${idx}.${key}`, { suppressRestart: !enabled });

  const runTest = async (idx: number) => {
    setPopFor(idx);
    setConnFor(idx);
    setPopState("pending");
    setConnState("pending");
    setPopStdout("");
    setPopStderr("");
    try {
      const res = await testMut.mutateAsync({ provider: "google" });
      setPopState(res.ok ? "ok" : "failed");
      setConnState(res.ok ? "ok" : "failed");
      setPopStdout(res.stdout);
      setPopStderr(res.stderr);
    } catch (e) {
      setPopState("failed");
      setConnState("failed");
      setPopStderr((e as Error).message);
    }
  };

  return (
    <section id="integrations" className="settings-section">
      <h2 className="settings-section-h">Integrations</h2>
      <p className="settings-section-sub">Google Calendar (via gog)</p>
      {calendars.length === 0 && (
        <div className="integrations-empty">No calendar connected.</div>
      )}
      {calendars.map((cal, idx) => {
        const enabled = cal.enabled === true;
        return (
          <div key={`${cal.type}-${idx}`} className="integration-card">
            <div className="integration-header">
              <span>Google Calendar (via gog)</span>
              <button
                type="button"
                className="cmd-remove"
                aria-label="Remove Google calendar"
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
              onCommit={setEnabled(idx)}
              disabled={isBlocked(`calendars.${idx}.enabled`)}
            />
            <InlineEditRow
              label="Account"
              help="The Google account email you authenticated with `gog auth add`."
              type="text"
              value={cal.gog_account ?? ""}
              onCommit={commitField(idx, "gog_account", enabled) as (v: string) => void}
              disabled={isBlocked(`calendars.${idx}.gog_account`)}
            />
            {/* watch_calendars as a chip list (CommandEditor-style). Defaults to
                ["primary"] when unset, so the user sees the effective value. */}
            <div className="row">
              <div className="row-label">
                <div>Calendars to watch</div>
                <div className="row-help">Calendar ids to watch (default: primary).</div>
              </div>
              <div className="row-value">
                {isBlocked(`calendars.${idx}.watch_calendars`) ? (
                  <span className="value-disabled">
                    <span className="value-disabled-text">{(cal.watch_calendars ?? ["primary"]).join(", ")}</span>
                    <span className="value-disabled-note">录音中不可改</span>
                  </span>
                ) : (
                  <CommandEditor
                    value={cal.watch_calendars ?? ["primary"]}
                    onChange={(next) => commitField(idx, "watch_calendars", enabled)(next)}
                  />
                )}
              </div>
              <div className="row-status" />
            </div>
            <div className="row">
              <div className="row-label">
                <div>Connection</div>
                <div className="row-help">Checks `gog` can read this account&apos;s calendars.</div>
              </div>
              <div className="row-value">
                <button type="button" className="cmd-add" onClick={() => runTest(idx)}>Check connection</button>
                {connFor === idx && connState === "ok" && <span className="conn-status conn-status--ok">Connected</span>}
                {connFor === idx && connState === "failed" && <span className="conn-status conn-status--bad">Not authenticated</span>}
                {connFor === idx && connState === "pending" && <span className="conn-status">Checking…</span>}
              </div>
              <div className="row-status" />
            </div>
            {popFor === idx && (
              <TestPopover
                state={popState}
                stdout={popStdout}
                stderr={popStderr}
                onClose={() => setPopFor(null)}
              />
            )}
          </div>
        );
      })}

      {/* P4a-4: add the Google calendar provider. Appends a DISABLED entry; the
          user fills in the account and enables it. Appending disabled needs no
          restart (suppressed in addCalendar). Guarded while recording. */}
      <div className="row">
        <div className="row-label">
          <div>Add calendar</div>
          <div className="row-help">Connect Google Calendar, then fill in your account and enable it.</div>
        </div>
        <div className="row-value">
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
