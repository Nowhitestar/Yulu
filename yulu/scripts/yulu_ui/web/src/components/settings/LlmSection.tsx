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

// The known LLM backends. `null` is agent-queue mode (no llm.command — the host
// coding agent watches agent-queue.json directly); the others are concrete
// commands. "custom" has no fixed value — it reveals the raw CommandEditor.
type PresetId = "agent-queue" | "claude" | "codex" | "custom";

const PRESET_COMMAND: Record<Exclude<PresetId, "custom" | "agent-queue">, string[]> = {
  claude: ["claude", "--print"],
  codex: ["python3", "codex_llm.py"],
};

const PRESET_OPTIONS: Array<{ value: PresetId; label: string }> = [
  { value: "agent-queue", label: "Agent-queue (your coding agent)" },
  { value: "claude", label: "Claude CLI" },
  { value: "codex", label: "Codex" },
  { value: "custom", label: "Custom command…" },
];

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Identify which preset the current `llm.command` value represents:
 *  - null / missing → agent-queue mode
 *  - exactly ["claude","--print"] → Claude
 *  - exactly ["python3","codex_llm.py"] → Codex
 *  - any other array → a custom command
 */
function presetOf(command: string[] | null | undefined): PresetId {
  if (command == null) return "agent-queue";
  if (arraysEqual(command, PRESET_COMMAND.claude)) return "claude";
  if (arraysEqual(command, PRESET_COMMAND.codex)) return "codex";
  return "custom";
}

export function LlmSection({ tracker }: LlmSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const { commit } = useConfigField(tracker);
  const testMut = trpc.llm.test.useMutation();

  const [popState, setPopState] = useState<"pending" | "ok" | "failed" | null>(null);
  const [popStdout, setPopStdout] = useState("");
  const [popStderr, setPopStderr] = useState("");
  // Sticky "Custom" selection: lets the user reveal the editor even when the
  // current value happens to equal a preset (e.g. null → seed an empty array).
  const [forceCustom, setForceCustom] = useState(false);

  if (!cfg) return null;

  const llm = cfg.llm ?? {};
  const command = (llm.command ?? null) as string[] | null;
  const derived = presetOf(command);
  const selected: PresetId = forceCustom ? "custom" : derived;

  const onPresetChange = (next: PresetId) => {
    if (next === "custom") {
      // Reveal the editor; don't commit yet. Seed agent-queue (null) with [] so
      // the editor has an array to grow.
      setForceCustom(true);
      if (command == null) commit("llm.command")([]);
      return;
    }
    setForceCustom(false);
    if (next === "agent-queue") commit("llm.command")(null);
    else commit("llm.command")(PRESET_COMMAND[next]);
  };

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
      {/* P2-2: pick a backend preset instead of hand-editing the raw command.
          Agent-queue = null (the agent watches the queue itself); Claude / Codex
          write a known command; Custom reveals the editor for anything else. */}
      <div className="row">
        <div className="row-label">
          <div>Backend</div>
          <div className="row-help">Agent-queue hands summaries to your own coding agent. Claude / Codex run a known command. Custom = your own command.</div>
        </div>
        <div className="row-value">
          <select
            aria-label="LLM backend"
            className="value-input"
            value={selected}
            onChange={(e) => onPresetChange(e.target.value as PresetId)}
          >
            {PRESET_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="row-status">{tracker.statusFor("llm.command") === "saved" ? "✓" : null}</div>
      </div>
      {selected === "custom" && (
        <div className="row">
          <div className="row-label">
            <div>Command</div>
            <div className="row-help">Spawned with stdin = your turn text</div>
          </div>
          <div className="row-value">
            <CommandEditor
              value={command ?? []}
              onChange={(next) => commit("llm.command")(next)}
            />
          </div>
          <div className="row-status" />
        </div>
      )}
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
