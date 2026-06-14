import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import { useT } from "../../i18n/LanguageProvider.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";
import "./OutputSection.css";

export interface OutputSectionProps {
  tracker: SettingsRestartTracker;
}

const CHANNELS = [
  { value: "file", label: "file" },
  { value: "zulip", label: "zulip" },
  { value: "notion", label: "notion" },
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
  const t = useT();
  // Only query presence once a non-empty name exists.
  const presence = trpc.config.envPresent.useQuery(
    { name },
    { enabled: name.trim().length > 0 },
  );

  const hint =
    name.trim().length === 0
      ? null
      : presence.data?.present
        ? <span className="env-present env-present--ok" data-testid="env-presence">{t("settings.output.env.present")}</span>
        : <span className="env-present env-present--missing" data-testid="env-presence">{t("settings.output.env.missing")}</span>;

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
  const t = useT();
  return (
    <input
      className="value-input"
      type="text"
      autoComplete="off"
      spellCheck={false}
      aria-label={t("settings.output.env.aria")}
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
 * selector picks file / zulip / notion; the matching channel's fields
 * appear below. All fields are reload:none (agent_queue_worker re-reads each
 * tick). Secrets are NEVER held here — Notion's API key is referenced by env-var
 * NAME only (see EnvNameRow).
 */
export function OutputSection({ tracker }: OutputSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const { commit } = useConfigField(tracker);
  const t = useT();

  if (!cfg) return null;

  const output = (cfg.output ?? {}) as {
    channel?: "file" | "zulip" | "notion" | "telegram";
    zulip?: { stream?: string; topic?: string };
    notion?: { database_id?: string; api_key_env?: string };
  };
  const channel = output.channel === "telegram" ? "file" : (output.channel ?? "file");
  const zulip = output.zulip ?? {};
  const notion = output.notion ?? {};

  return (
    <section id="output" className="settings-section">
      <h2 className="settings-section-h">{t("settings.output.heading")}</h2>
      <p className="settings-section-sub">{t("settings.output.sub")}</p>

      {/* P4a-5: a prominent, always-visible channel picker (not click-to-edit) so
          the section reads as a real, configurable choice. The chosen channel's
          fields appear below it. */}
      <div className="row output-channel-row">
        <div className="row-label">
          <div>{t("settings.output.channel.label")}</div>
          <div className="row-help">{t("settings.output.channel.help")}</div>
        </div>
        <div className="row-value">
          <select
            aria-label={t("settings.output.channel.aria")}
            className="value-input output-channel-select"
            value={channel}
            onChange={(e) => commit("output.channel")(e.target.value)}
          >
            {CHANNELS.map((c) => (
              <option key={c.value} value={c.value}>{c.label}</option>
            ))}
          </select>
        </div>
        <div className="row-status">{tracker.statusFor("output.channel") === "saved" ? "✓" : null}</div>
      </div>

      {channel === "file" && (
        <div className="output-file-note">
          {t("settings.output.file.note")}
        </div>
      )}

      {channel === "zulip" && (
        <>
          <InlineEditRow
            label={t("settings.output.zulip.stream")}
            type="text"
            value={zulip.stream ?? ""}
            onCommit={commit("output.zulip.stream") as (v: string) => void}
            status={tracker.statusFor("output.zulip.stream")}
          />
          <InlineEditRow
            label={t("settings.output.zulip.topic")}
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
            label={t("settings.output.notion.database")}
            help={t("settings.output.notion.database.help")}
            type="text"
            value={notion.database_id ?? ""}
            onCommit={commit("output.notion.database_id") as (v: string) => void}
            status={tracker.statusFor("output.notion.database_id")}
          />
          <EnvNameRow
            label={t("settings.output.notion.apiKey")}
            help={t("settings.output.notion.apiKey.help")}
            name={notion.api_key_env ?? ""}
            onCommit={commit("output.notion.api_key_env") as (v: string) => void}
          />
        </>
      )}

    </section>
  );
}
