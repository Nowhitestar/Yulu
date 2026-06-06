import { useState } from "react";
import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { TestPopover } from "../TestPopover.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface IntegrationsSectionProps {
  tracker: SettingsRestartTracker;
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

  const calendars = cfg.calendars ?? [];

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
        <div key={cal.type} className="integration-card">
          <div className="integration-header">{cal.type}</div>
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
    </section>
  );
}
