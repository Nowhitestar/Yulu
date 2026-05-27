import { useState } from "react";
import { trpc } from "../../trpc.js";
import { SettingsPage } from "../../components/SettingsPage.js";
import { InlineEditRow } from "../../components/InlineEditRow.js";
import { TestPopover } from "../../components/TestPopover.js";
import "./integrations.css";

export const handle = { breadcrumb: "Integrations", filters: null };

export function SettingsIntegrations() {
  const { data: cfg } = trpc.config.get.useQuery();
  const updateMut = trpc.config.update.useMutation();
  const testMut = trpc.integrations.test.useMutation();
  const [popFor, setPopFor] = useState<string | null>(null);
  const [popState, setPopState] = useState<"pending" | "ok" | "failed">("pending");
  const [popStdout, setPopStdout] = useState("");
  const [popStderr, setPopStderr] = useState("");

  if (!cfg) return <SettingsPage>Loading config…</SettingsPage>;

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
    <SettingsPage>
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
            onCommit={(v) => updateMut.mutateAsync({ key: `calendars.${idx}.enabled`, value: v })}
          />
          <InlineEditRow
            label="Credentials path"
            type="path"
            mode="file"
            filter="json"
            value={cal.credentials_path ?? ""}
            onCommit={(v) => updateMut.mutateAsync({ key: `calendars.${idx}.credentials_path`, value: v })}
          />
          <InlineEditRow
            label="Account"
            type="text"
            value={cal.account ?? ""}
            onCommit={(v) => updateMut.mutateAsync({ key: `calendars.${idx}.account`, value: v })}
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
    </SettingsPage>
  );
}
