import { useState } from "react";
import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { CommandEditor } from "../CommandEditor.js";
import { TestPopover } from "../TestPopover.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface LlmSectionProps {
  tracker: SettingsRestartTracker;
}

export function LlmSection({ tracker }: LlmSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const { commit } = useConfigField(tracker);
  const testMut = trpc.llm.test.useMutation();

  const [popState, setPopState] = useState<"pending" | "ok" | "failed" | null>(null);
  const [popStdout, setPopStdout] = useState("");
  const [popStderr, setPopStderr] = useState("");

  if (!cfg) return null;

  const llm = cfg.llm ?? {};

  const runTest = async () => {
    setPopState("pending");
    setPopStdout("");
    setPopStderr("");
    try {
      const res = await testMut.mutateAsync();
      setPopState(res.ok ? "ok" : "failed");
      setPopStdout(res.stdout);
      setPopStderr(res.stderr);
    } catch (e) {
      setPopState("failed");
      setPopStderr((e as Error).message);
    }
  };

  return (
    <section id="llm" className="settings-section">
      <h2 className="settings-section-h">LLM</h2>
      <p className="settings-section-sub">Summary generation method</p>
      <InlineEditRow
        label="Enabled"
        type="toggle"
        value={llm.enabled ?? false}
        onCommit={commit("llm.enabled")}
        status={tracker.statusFor("llm.enabled")}
      />
      <div className="row">
        <div className="row-label">
          Command
          <div className="row-help">Spawned with stdin = your turn text</div>
        </div>
        <div className="row-value">
          <CommandEditor
            value={llm.command ?? []}
            onChange={(next) => commit("llm.command")(next)}
          />
        </div>
        <div className="row-status" />
      </div>
      <div className="row">
        <div className="row-label">Test</div>
        <div className="row-value">
          <button type="button" className="cmd-add" onClick={runTest}>Test command</button>
        </div>
        <div className="row-status" />
      </div>
      {popState && <TestPopover state={popState} stdout={popStdout} stderr={popStderr} onClose={() => setPopState(null)} />}
    </section>
  );
}
