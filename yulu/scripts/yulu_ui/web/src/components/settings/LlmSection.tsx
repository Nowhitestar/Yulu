import { useState } from "react";
import { Link } from "react-router";
import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { CommandEditor } from "../CommandEditor.js";
import { TestPopover } from "../TestPopover.js";
import { CategoryChip } from "../CategoryChip.js";
import type { Category } from "../CategoryChip.js";
import { CapabilityBadge, CapabilityStatusValue, type Capability } from "./CapabilitiesSection.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import { useT } from "../../i18n/LanguageProvider.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";
import "./LlmSection.css";

export interface LlmSectionProps {
  tracker: SettingsRestartTracker;
}

// The known Agent backends. `null` is agent-queue mode for durable summaries and
// lets Ask Yulu auto-detect the local Agent CLI for live chat.
type PresetId = "agent-queue" | "claude" | "codex" | "custom";

const PRESET_COMMAND: Record<Exclude<PresetId, "custom" | "agent-queue">, string[]> = {
  claude: ["claude", "--print"],
  codex: ["codex", "exec", "--sandbox", "read-only", "--skip-git-repo-check"],
};

const PRESET_OPTIONS: Array<{ value: PresetId; labelKey: string }> = [
  { value: "agent-queue", labelKey: "settings.llm.preset.agentQueue" },
  { value: "claude", labelKey: "settings.llm.preset.claude" },
  { value: "codex", labelKey: "settings.llm.preset.codex" },
  { value: "custom", labelKey: "settings.llm.preset.custom" },
];

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Identify which preset the current `llm.command` value represents:
 *  - null / missing → agent-queue mode
 *  - exactly ["claude","--print"] → Claude
 *  - exactly ["codex","exec",...] → Codex
 *  - any other array → a custom command
 */
function presetOf(command: string[] | null | undefined): PresetId {
  if (command == null) return "agent-queue";
  if (arraysEqual(command, PRESET_COMMAND.claude)) return "claude";
  if (arraysEqual(command, PRESET_COMMAND.codex)) return "codex";
  return "custom";
}

function capForPreset(selected: PresetId, caps: Record<string, Capability>, t: (key: string) => string): Capability | undefined {
  if (selected === "agent-queue") {
    return {
      provenance: "yulu-managed",
      status: "usable",
      resolved_path: "~/.config/yulu/agent-queue.json",
      detail: t("settings.llm.capability.agentQueue"),
    };
  }
  if (selected === "claude") return caps.claude_cli ?? caps.claude ?? caps.llm_command;
  if (selected === "codex") return caps.codex_cli ?? caps.llm_command;
  return caps.llm_command;
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
  const t = useT();
  const { data, isPending, isError } = trpc.prompts.list.useQuery({});
  const updateMut = trpc.prompts.update.useMutation({
    onSuccess: () => { utils.prompts.list.invalidate(); },
  });

  const rows = ((data as PromptRow[] | undefined) ?? []).filter((p) => p.is_auto_run === 1);

  return (
    <div className="autorun-templates">
      <div className="autorun-templates-head">
        <div>
          <div className="autorun-templates-title">{t("settings.llm.autorun.title")}</div>
          <div className="row-help">{t("settings.llm.autorun.help")}</div>
        </div>
        <Link to="/knowledge/prompts" className="autorun-manage-link">{t("settings.llm.autorun.manage")}</Link>
      </div>

      {isPending ? (
        <div className="autorun-empty">{t("common.loading")}</div>
      ) : isError ? (
        <div className="autorun-empty">{t("settings.llm.autorun.error")}</div>
      ) : rows.length === 0 ? (
        <div className="autorun-empty">{t("settings.llm.autorun.empty")}</div>
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
                aria-label={t("settings.llm.autorun.toggleAria", { name: p.name })}
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
  const hostCapabilitiesQuery = trpc.capabilities.host_capabilities.useQuery();
  const { commit } = useConfigField(tracker);
  const testMut = trpc.llm.test.useMutation();
  const t = useT();

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
  const caps = (hostCapabilitiesQuery.data?.capabilities ?? {}) as Record<string, Capability>;
  const capabilitiesLoading = hostCapabilitiesQuery.isPending && !hostCapabilitiesQuery.data;
  const backendCap = capForPreset(selected, caps, t);

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
      <h2 className="settings-section-h">{t("settings.llm.heading")}</h2>
      <p className="settings-section-sub">{t("settings.llm.sub")}</p>
      <InlineEditRow
        label={t("settings.llm.enabled.label")}
        type="toggle"
        value={llm.enabled ?? false}
        onCommit={commit("llm.enabled")}
        status={tracker.statusFor("llm.enabled")}
      />
      {/* P2-2: pick an Agent preset instead of hand-editing the raw command.
          Agent-queue = null; live Ask auto-detects an Agent CLI. */}
      <div className="row row--capability">
        <div className="row-label">
          <div>{t("settings.llm.backend.label")}</div>
          <div className="row-help">{t("settings.llm.backend.help")}</div>
        </div>
        <div className="row-value">
          <select
            aria-label={t("settings.llm.backend.aria")}
            className="value-input"
            value={selected}
            onChange={(e) => onPresetChange(e.target.value as PresetId)}
          >
            {PRESET_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{t(o.labelKey)}</option>
            ))}
          </select>
        </div>
        <div className="row-status">{tracker.statusFor("llm.command") === "saved" ? "✓" : null}</div>
      </div>
      <div className="row">
        <div className="row-label">
          <div>{t("settings.llm.capability.label")}</div>
          <div className="row-help">{t("settings.llm.capability.help")}</div>
        </div>
        <div className="row-value">
          {capabilitiesLoading ? <div className="cap-detail">{t("settings.capabilities.loading")}</div> : <CapabilityStatusValue cap={backendCap} />}
        </div>
        <div className="row-status">
          {capabilitiesLoading ? null : <CapabilityBadge status={backendCap?.status ?? "absent"} detail={backendCap?.detail} />}
        </div>
      </div>
      {selected === "custom" && (
        <div className="row">
          <div className="row-label">
            <div>{t("settings.llm.command.label")}</div>
            <div className="row-help">{t("settings.llm.command.help")}</div>
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
        <div className="row-label">{t("settings.llm.test.label")}</div>
        <div className="row-value">
          <button type="button" className="cmd-add" onClick={runTest}>{t("settings.llm.test.button")}</button>
        </div>
        <div className="row-status" />
      </div>
      {popState && <TestPopover state={popState} stdout={popStdout} stderr={popStderr} onClose={() => setPopState(null)} />}

      {/* P4a-2: which summary templates fire automatically on transcribe. */}
      <AutoRunTemplates />
    </section>
  );
}
