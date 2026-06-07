import { useState } from "react";
import { Link } from "react-router";
import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { CommandEditor } from "../CommandEditor.js";
import { TestPopover } from "../TestPopover.js";
import { CategoryChip } from "../CategoryChip.js";
import type { Category } from "../CategoryChip.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";
import "./LlmSection.css";

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

interface PromptRow {
  id: string;
  name: string;
  category: Category;
  is_auto_run: number;
}

/**
 * AutoRunTemplates — the summaries that fire automatically when a recording is
 * transcribed (P4a-2). Lists the prompts flagged is_auto_run, each with a toggle
 * that flips is_auto_run via the EXISTING prompts tRPC (so this reuses the Prompts
 * page's list/update — no new prompt CRUD). Multi-fire is intentional (a cleanup
 * pass can run before a summary), so this is NOT a single-active picker. Full
 * authoring lives on the Prompts page via the "Manage all templates" link.
 */
function AutoRunTemplates() {
  const utils = trpc.useUtils();
  const { data, isPending } = trpc.prompts.list.useQuery({});
  const updateMut = trpc.prompts.update.useMutation({
    onSuccess: () => { utils.prompts.list.invalidate(); },
  });

  const rows = ((data as PromptRow[] | undefined) ?? []).filter((p) => p.is_auto_run === 1);

  return (
    <div className="autorun-templates">
      <div className="autorun-templates-head">
        <div>
          <div className="autorun-templates-title">Auto-run templates</div>
          <div className="row-help">These run automatically when a recording is transcribed.</div>
        </div>
        <Link to="/knowledge/prompts" className="autorun-manage-link">Manage all templates →</Link>
      </div>

      {isPending ? (
        <div className="autorun-empty">Loading…</div>
      ) : rows.length === 0 ? (
        <div className="autorun-empty">No auto-run templates. Add one from the Prompts page.</div>
      ) : (
        <ul className="autorun-list">
          {rows.map((p) => (
            <li key={p.id} className="autorun-row" data-testid="autorun-row">
              <span className="autorun-row-name">{p.name}</span>
              <CategoryChip category={p.category} />
              <button
                type="button"
                role="switch"
                aria-checked={p.is_auto_run === 1}
                aria-label={`Auto-run ${p.name}`}
                className={"toggle on"}
                disabled={updateMut.isPending}
                onClick={() => updateMut.mutate({ id: p.id, isAutoRun: false })}
              >
                <span className="toggle-knob" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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

      {/* P4a-2: which summary templates fire automatically on transcribe. */}
      <AutoRunTemplates />
    </section>
  );
}
