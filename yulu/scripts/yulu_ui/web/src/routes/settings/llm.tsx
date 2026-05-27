import { useState } from "react";
import type { inferProcedureInput } from "@trpc/server";
import type { AppRouter } from "../../../../src/routers/_app.js";
import { trpc } from "../../trpc.js";
import { useSettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";
import { SettingsPage } from "../../components/SettingsPage.js";
import { InlineEditRow } from "../../components/InlineEditRow.js";
import { RestartBanner } from "../../components/RestartBanner.js";
import { CommandEditor } from "../../components/CommandEditor.js";
import { TestPopover } from "../../components/TestPopover.js";

type DaemonLabel = inferProcedureInput<AppRouter["daemons"]["restart"]>["name"];

export const handle = { breadcrumb: "Settings / LLM", filters: null };

const DAEMON_LABEL: Record<string, DaemonLabel> = {
  agentqueue: "com.yulu.agentqueue",
};

export function SettingsLlm() {
  const { data: cfg } = trpc.config.get.useQuery();
  const tracker = useSettingsRestartTracker();
  const updateMut = trpc.config.update.useMutation({
    onSuccess: (res: { daemonsNeedingRestart: string[] }, vars: { key: string }) => {
      tracker.record(vars.key, res.daemonsNeedingRestart);
    },
  });
  const restartMut = trpc.daemons.restart.useMutation({
    onSuccess: (_res: unknown, vars: { name: string }) => {
      const short = vars.name.replace(/^com\.yulu\./, "");
      tracker.clearDaemon(short);
    },
  });
  const testMut = trpc.llm.test.useMutation();

  const [popState, setPopState] = useState<"pending" | "ok" | "failed" | null>(null);
  const [popStdout, setPopStdout] = useState("");
  const [popStderr, setPopStderr] = useState("");

  if (!cfg) return <SettingsPage>Loading config…</SettingsPage>;

  const llm = (cfg.llm ?? {}) as { enabled?: boolean; command?: string[] };

  const banner = tracker.daemons.size > 0 ? (
    <RestartBanner
      daemons={Array.from(tracker.daemons, ([name, keys]) => ({ name, keys: Array.from(keys) }))}
      onRestart={(name) => { restartMut.mutateAsync({ name: (DAEMON_LABEL[name] ?? name) as DaemonLabel }); }}
      onRestartAll={() => {
        for (const name of tracker.daemons.keys()) restartMut.mutateAsync({ name: (DAEMON_LABEL[name] ?? name) as DaemonLabel });
      }}
    />
  ) : null;

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
    <SettingsPage banner={banner}>
      <InlineEditRow
        label="Enabled"
        type="toggle"
        value={llm.enabled ?? false}
        onCommit={(v) => updateMut.mutateAsync({ key: "llm.enabled", value: v })}
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
            onChange={(next) => updateMut.mutateAsync({ key: "llm.command", value: next })}
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
    </SettingsPage>
  );
}
