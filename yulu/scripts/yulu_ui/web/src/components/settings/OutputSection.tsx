import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface OutputSectionProps {
  tracker: SettingsRestartTracker;
}

const CHANNELS = [
  { value: "file", label: "file" },
  { value: "zulip", label: "zulip" },
  { value: "notion", label: "notion" },
  { value: "telegram", label: "telegram" },
] as const;

/**
 * EnvNameRow — an env-var NAME field (P2-4). The user types the *name* of the
 * env var that holds a secret (e.g. NOTION_API_KEY); Yulu never stores or shows
 * the secret itself. A read-only "set / not set" hint confirms the var is
 * exported in the daemon's environment — `config.envPresent` returns ONLY a
 * boolean, so the value never crosses the wire. This is a plain text input, not
 * a password field: it is a variable name, not a credential.
 */
function EnvNameRow({
  label,
  help,
  name,
  onCommit,
}: {
  label: string;
  help: string;
  name: string;
  onCommit: (v: string) => void;
}) {
  // Only query presence once a non-empty name exists.
  const presence = trpc.config.envPresent.useQuery(
    { name },
    { enabled: name.trim().length > 0 },
  );

  const hint =
    name.trim().length === 0
      ? null
      : presence.data?.present
        ? <span className="env-present env-present--ok" data-testid="env-presence">set</span>
        : <span className="env-present env-present--missing" data-testid="env-presence">not set</span>;

  return (
    <div className="row">
      <div className="row-label">
        <div>{label}</div>
        <div className="row-help">{help}</div>
      </div>
      <div className="row-value">
        <EnvNameInput value={name} onCommit={onCommit} />
        {hint}
      </div>
      <div className="row-status" />
    </div>
  );
}

// A small inline text editor for the env-var name. Mirrors InlineEditRow's text
// editing (click to edit, Enter/blur to commit) but kept local so the presence
// hint can sit beside it. autocomplete=off so browsers never treat it as a
// credential field.
function EnvNameInput({ value, onCommit }: { value: string; onCommit: (v: string) => void }) {
  return (
    <input
      className="value-input"
      type="text"
      autoComplete="off"
      spellCheck={false}
      aria-label="Environment variable name"
      defaultValue={value}
      onBlur={(e) => { if (e.target.value !== value) onCommit(e.target.value.trim()); }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") { (e.target as HTMLInputElement).value = value; (e.target as HTMLInputElement).blur(); }
      }}
    />
  );
}

/**
 * OutputSection — where a finished summary is delivered (P2-4). The channel
 * selector picks file / zulip / notion / telegram; the matching channel's fields
 * appear below. All fields are reload:none (agent_queue_worker re-reads each
 * tick). Secrets are NEVER held here — Notion's API key is referenced by env-var
 * NAME only (see EnvNameRow).
 */
export function OutputSection({ tracker }: OutputSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const { commit } = useConfigField(tracker);

  if (!cfg) return null;

  const output = (cfg.output ?? {}) as {
    channel?: "file" | "zulip" | "notion" | "telegram";
    zulip?: { stream?: string; topic?: string };
    notion?: { database_id?: string; api_key_env?: string };
    telegram?: { chat_id?: string };
  };
  const channel = output.channel ?? "file";
  const zulip = output.zulip ?? {};
  const notion = output.notion ?? {};
  const telegram = output.telegram ?? {};

  return (
    <section id="output" className="settings-section">
      <h2 className="settings-section-h">Output</h2>
      <p className="settings-section-sub">Where a finished summary is delivered</p>

      <InlineEditRow
        label="Output channel"
        help="file writes the note to disk. zulip / notion / telegram post it to that service."
        type="select"
        value={channel}
        options={CHANNELS.map((c) => ({ value: c.value, label: c.label }))}
        onCommit={commit("output.channel") as (v: string) => void}
        status={tracker.statusFor("output.channel")}
      />

      {channel === "file" && (
        <p className="settings-section-sub">The summary is written next to the recording. No further setup needed.</p>
      )}

      {channel === "zulip" && (
        <>
          <InlineEditRow
            label="Zulip stream"
            type="text"
            value={zulip.stream ?? ""}
            onCommit={commit("output.zulip.stream") as (v: string) => void}
            status={tracker.statusFor("output.zulip.stream")}
          />
          <InlineEditRow
            label="Zulip topic"
            type="text"
            value={zulip.topic ?? ""}
            onCommit={commit("output.zulip.topic") as (v: string) => void}
            status={tracker.statusFor("output.zulip.topic")}
          />
        </>
      )}

      {channel === "notion" && (
        <>
          <InlineEditRow
            label="Notion database"
            help="The target Notion database ID."
            type="text"
            value={notion.database_id ?? ""}
            onCommit={commit("output.notion.database_id") as (v: string) => void}
            status={tracker.statusFor("output.notion.database_id")}
          />
          <EnvNameRow
            label="Notion API key env var"
            help="Name of the env var holding your Notion API key (e.g. NOTION_API_KEY). Yulu reads the name, never the secret — export the value in your shell."
            name={notion.api_key_env ?? ""}
            onCommit={commit("output.notion.api_key_env") as (v: string) => void}
          />
        </>
      )}

      {channel === "telegram" && (
        <InlineEditRow
          label="Telegram chat ID"
          type="text"
          value={telegram.chat_id ?? ""}
          onCommit={commit("output.telegram.chat_id") as (v: string) => void}
          status={tracker.statusFor("output.telegram.chat_id")}
        />
      )}
    </section>
  );
}
