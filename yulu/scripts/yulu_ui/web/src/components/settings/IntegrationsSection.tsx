import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { TestPopover } from "../TestPopover.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import { useT } from "../../i18n/LanguageProvider.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";
import { CalendarDays, CheckCircle2, CircleDashed, Plug2, Send } from "lucide-react";

export interface IntegrationsSectionProps {
  tracker: SettingsRestartTracker;
}

type CalendarType = "macos" | "system" | "google";
interface CalendarEntry {
  type: CalendarType;
  enabled?: boolean;
  credentials_path?: string;
  gog_account?: string;
  watch_calendars?: string[];
  [k: string]: unknown;
}

type ConnState = "ok" | "failed" | "pending" | null;
type OutputChannel = "notion" | "zulip";

interface CalendarOption {
  id: string;
  summary: string;
  primary: boolean;
}

interface GoogleAccount {
  email: string;
  services: string[];
}

interface ConnectorEntry {
  connector_id: string;
  display_name: string;
  provenance: string;
  status: string;
  resolved_path: string;
  detail: string;
  actions: string[];
  config_prefix: string;
}

type ConnectorConfig = Record<string, { read_calendar?: boolean; send_summary?: boolean } | undefined>;
type OutputConfig = {
  notion?: {
    destination_id?: string;
    destination_type?: string;
    destination_label?: string;
    database_id?: string;
    api_key_env?: string;
  };
  zulip?: { stream_id?: string; stream?: string; topic?: string };
};
type SelectableOutputChannel = OutputChannel;
interface OutputDestination {
  id: string;
  type: string;
  label: string;
  detail?: string;
}
interface OutputIdentity {
  label: string;
  detail?: string;
}

const CONNECTOR_ORDER = ["gog", "feishu", "notion", "zulip"];
const OUTPUT_CONNECTORS: Array<{ id: OutputChannel; label: string; icon: typeof Send }> = [
  { id: "notion", label: "Notion", icon: Send },
  { id: "zulip", label: "Zulip", icon: Send },
];

function selectedWatchCalendars(cal: CalendarEntry): string[] {
  if (cal.type === "macos" || cal.type === "system") return cal.watch_calendars ?? [];
  const current = cal.watch_calendars;
  return current && current.length > 0 ? current : ["primary"];
}

function connectorStatusKey(status: string): string {
  if (status === "usable") return "settings.integrations.connector.status.usable";
  if (status === "present-but-unverified") return "settings.integrations.connector.status.unverified";
  return "settings.integrations.connector.status.absent";
}

function connectorSourceKey(provenance: string): string {
  if (provenance === "agent-config") return "settings.integrations.connector.source.agent-config";
  if (provenance === "host-path") return "settings.integrations.connector.source.host-path";
  if (provenance === "yulu-managed") return "settings.integrations.connector.source.yulu-managed";
  return "settings.integrations.connector.source.absent";
}

function connectorTone(status: string): "ok" | "warn" | "muted" {
  if (status === "usable") return "ok";
  if (status === "present-but-unverified") return "warn";
  return "muted";
}

function connectorOrder(connector: ConnectorEntry): number {
  const index = CONNECTOR_ORDER.indexOf(connector.connector_id);
  return index === -1 ? CONNECTOR_ORDER.length : index;
}

function connectorLocation(connector: ConnectorEntry): string {
  return connector.resolved_path || connector.detail || "";
}

function connectorIsInstalled(connector?: ConnectorEntry): boolean {
  return !!connector && connector.status !== "absent";
}

function connectorCanUse(connector?: ConnectorEntry): boolean {
  return !!connector && connector.status === "usable";
}

function selectedDestinationId(
  channel: SelectableOutputChannel,
  output: OutputConfig,
  destinations: OutputDestination[],
): string {
  if (channel === "notion") return output.notion?.destination_id || output.notion?.database_id || "";
  const streamId = output.zulip?.stream_id;
  if (streamId) return streamId;
  const stream = output.zulip?.stream;
  return destinations.find((destination) => destination.label === stream)?.id ?? "";
}

function commitOutputDestination(
  channel: SelectableOutputChannel,
  destination: OutputDestination,
  commit: ReturnType<typeof useConfigField>["commit"],
): void {
  if (channel === "notion") {
    void commit("output.notion.destination_id", { suppressRestart: true })(destination.id);
    void commit("output.notion.destination_type", { suppressRestart: true })(destination.type);
    void commit("output.notion.destination_label", { suppressRestart: true })(destination.label);
    return;
  }
  void commit("output.zulip.stream_id", { suppressRestart: true })(destination.id);
  void commit("output.zulip.stream", { suppressRestart: true })(destination.label);
}

function fallbackConnector(id: string, label: string, action: string): ConnectorEntry {
  return {
    connector_id: id,
    display_name: label,
    provenance: "absent",
    status: "absent",
    resolved_path: "",
    detail: "",
    actions: [action],
    config_prefix: `connectors.${id}`,
  };
}

function ConnectorStatusIcon({ status }: { status: string }) {
  if (status === "usable") return <CheckCircle2 size={13} strokeWidth={2} />;
  return <CircleDashed size={13} strokeWidth={2} />;
}

function ProviderState({ connector }: { connector: ConnectorEntry }) {
  const t = useT();
  const tone = connectorTone(connector.status);
  return (
    <span className={`provider-state provider-state--${tone}`}>
      <ConnectorStatusIcon status={connector.status} />
      {t(connectorStatusKey(connector.status))}
    </span>
  );
}

function ProviderAccount({ identity }: { identity: OutputIdentity }) {
  const t = useT();
  return (
    <div className="provider-account">
      <span className="provider-account-k">{t("settings.integrations.output.account.label")}</span>
      <span className="provider-account-main">
        <strong>{identity.label}</strong>
        {identity.detail && <span>{identity.detail}</span>}
      </span>
    </div>
  );
}

function OutputDestinationPanel({
  channel,
  output,
  commit,
}: {
  channel: SelectableOutputChannel;
  output: OutputConfig;
  commit: ReturnType<typeof useConfigField>["commit"];
}) {
  const t = useT();
  const destinationsQuery = trpc.integrations.outputDestinations.useQuery({ channel });
  const result = destinationsQuery.data;

  if (destinationsQuery.isPending && !result) {
    return <div className="provider-status-note">{t("settings.integrations.output.destinations.loading")}</div>;
  }

  if (!result?.ok) {
    return (
      <div className="provider-status-note provider-status-note--bad">
        {t("settings.integrations.output.destinations.failed", { error: result?.error || t("value.unset") })}
      </div>
    );
  }

  const destinations = result.destinations as OutputDestination[];
  const selected = selectedDestinationId(channel, output, destinations);
  const labelKey = channel === "notion"
    ? "settings.integrations.output.destination.notion"
    : "settings.integrations.output.destination.zulip";

  return (
    <div className="provider-fields provider-fields--destinations">
      {result.identity && <ProviderAccount identity={result.identity as OutputIdentity} />}
      <div className="row provider-destination-row">
        <div className="row-label">
          <div>{t(labelKey)}</div>
          <div className="row-help">{t("settings.integrations.output.destination.help")}</div>
        </div>
        <div className="row-value">
          {destinations.length === 0 ? (
            <span className="value-disabled-note">{t("settings.integrations.output.destinations.empty")}</span>
          ) : (
            <select
              aria-label={t(labelKey)}
              className="value-input provider-destination-select"
              value={selected}
              onChange={(event) => {
                const destination = destinations.find((item) => item.id === event.currentTarget.value);
                if (destination) commitOutputDestination(channel, destination, commit);
              }}
            >
              <option value="">{t("settings.integrations.output.destination.choose")}</option>
              {destinations.map((destination) => (
                <option key={`${destination.type}:${destination.id}`} value={destination.id}>
                  {destination.label}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="row-status" />
      </div>
      {channel === "zulip" && (
        <InlineEditRow
          label={t("settings.output.zulip.topic")}
          type="text"
          value={output.zulip?.topic ?? ""}
          onCommit={commit("output.zulip.topic", { suppressRestart: true }) as (v: string) => void}
        />
      )}
    </div>
  );
}

function ProviderMeta({ connector }: { connector: ConnectorEntry }) {
  const t = useT();
  const location = connectorLocation(connector);
  return (
    <div className="provider-meta">
      <span className="provider-source">{t(connectorSourceKey(connector.provenance))}</span>
      {location && (
        <span className="provider-location" title={location}>
          {location}
        </span>
      )}
    </div>
  );
}

function CalendarAccountRow({
  idx,
  cal,
  enabled,
  blocked,
  accounts,
  commitAccount,
}: {
  idx: number;
  cal: CalendarEntry;
  enabled: boolean;
  blocked: boolean;
  accounts: GoogleAccount[];
  commitAccount: (idx: number, enabled: boolean, next: string) => void;
}) {
  const t = useT();
  const current = (cal.gog_account ?? "").trim();

  if (accounts.length === 0) {
    return (
      <InlineEditRow
        label={t("settings.integrations.account.label")}
        help={t("settings.integrations.account.help")}
        type="text"
        value={cal.gog_account ?? ""}
        onCommit={(next) => commitAccount(idx, enabled, next)}
        disabled={blocked}
      />
    );
  }

  const options = current && !accounts.some((account) => account.email === current)
    ? [{ email: current, services: [] }, ...accounts]
    : accounts;

  return (
    <div className="row">
      <div className="row-label">
        <div>{t("settings.integrations.account.label")}</div>
        <div className="row-help">{t("settings.integrations.account.help")}</div>
      </div>
      <div className="row-value">
        {blocked ? (
          <span className="value-disabled">
            <span className="value-disabled-text">{current || t("value.unset")}</span>
            <span className="value-disabled-note">{t("settings.locked.recording")}</span>
          </span>
        ) : accounts.length === 1 ? (
          <span className="account-current">
            <span className="value-display">{current || accounts[0]!.email}</span>
            <span className="conn-status conn-status--ok">{t("settings.integrations.account.auto")}</span>
          </span>
        ) : (
          <select
            aria-label={t("settings.integrations.account.label")}
            className="value-input account-select"
            value={current}
            onChange={(event) => commitAccount(idx, enabled, event.currentTarget.value)}
          >
            <option value="">{t("settings.integrations.account.choose")}</option>
            {options.map((account) => (
              <option key={account.email} value={account.email}>{account.email}</option>
            ))}
          </select>
        )}
      </div>
      <div className="row-status" />
    </div>
  );
}

function CalendarWatchSelector({
  idx,
  cal,
  enabled,
  blocked,
  commitWatchCalendars,
}: {
  idx: number;
  cal: CalendarEntry;
  enabled: boolean;
  blocked: boolean;
  commitWatchCalendars: (idx: number, enabled: boolean, next: string[]) => void;
}) {
  const t = useT();
  const account = (cal.gog_account ?? "").trim();
  const selected = new Set(selectedWatchCalendars(cal));
  const calendarsQuery = trpc.integrations.calendarList.useQuery(
    { account },
    { enabled: account.length > 0 },
  );

  if (blocked) {
    return (
      <span className="value-disabled">
        <span className="value-disabled-text">{selectedWatchCalendars(cal).join(", ")}</span>
        <span className="value-disabled-note">{t("settings.locked.recording")}</span>
      </span>
    );
  }

  if (!account) {
    return <span className="value-disabled-note">{t("settings.integrations.watch.accountRequired")}</span>;
  }

  if (calendarsQuery.isPending && !calendarsQuery.data) {
    return <span className="conn-status">{t("settings.integrations.watch.loading")}</span>;
  }

  const result = calendarsQuery.data;
  if (!result?.ok) {
    return <span className="conn-status conn-status--bad">{result?.stderr || t("settings.integrations.watch.listFailed")}</span>;
  }

  const calendars = result.calendars as CalendarOption[];
  if (calendars.length === 0) {
    return <span className="conn-status">{t("settings.integrations.watch.none")}</span>;
  }

  const toggleCalendar = (id: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(id);
    else next.delete(id);
    const ordered = calendars.map((c) => c.id).filter((calendarId) => next.has(calendarId));
    for (const calendarId of next) {
      if (!ordered.includes(calendarId)) ordered.push(calendarId);
    }
    commitWatchCalendars(idx, enabled, ordered);
  };

  return (
    <div className="calendar-checklist">
      {calendars.map((calendar) => (
        <label key={calendar.id} className="calendar-check">
          <input
            type="checkbox"
            checked={selected.has(calendar.id)}
            onChange={(event) => toggleCalendar(calendar.id, event.currentTarget.checked)}
          />
          <span className="calendar-check-main">
            <span className="calendar-check-title">{calendar.summary}</span>
            <span className="calendar-check-id">{calendar.id}</span>
          </span>
        </label>
      ))}
    </div>
  );
}

function ProviderToggleRow({
  label,
  help,
  value,
  disabled,
  onCommit,
}: {
  label: string;
  help?: string;
  value: boolean;
  disabled?: boolean;
  onCommit: (next: boolean) => void;
}) {
  return (
    <div className="row">
      <div className="row-label">
        <div>{label}</div>
        {help && <div className="row-help">{help}</div>}
      </div>
      <div className="row-value">
        <button
          type="button"
          role="switch"
          aria-label={label}
          aria-checked={value}
          className={"toggle" + (value ? " on" : "")}
          disabled={disabled}
          onClick={() => onCommit(!value)}
        >
          <span className="toggle-knob" />
        </button>
      </div>
      <div className="row-status" />
    </div>
  );
}

function CalendarConnectorCard({
  connector,
  value,
  onCommit,
  blocked,
}: {
  connector: ConnectorEntry;
  value: boolean;
  onCommit: (next: boolean) => void;
  blocked: boolean;
}) {
  const t = useT();
  const installed = connectorIsInstalled(connector);
  const usable = connectorCanUse(connector);
  return (
    <article className="integration-card calendar-provider-card connector-calendar-card" data-status={connector.status}>
      <div className="provider-card-head">
        <div className="provider-title-block">
          <span className="provider-mark" aria-hidden="true">
            <Plug2 size={15} strokeWidth={2} />
          </span>
          <div className="provider-title-main">
            <div className="provider-name">{connector.display_name}</div>
            <ProviderMeta connector={connector} />
          </div>
        </div>
        <ProviderState connector={connector} />
      </div>
      <ProviderToggleRow
        label={t(`settings.integrations.connector.action.readCalendar.${connector.connector_id}`)}
        help={connector.detail}
        value={value}
        disabled={!usable || blocked}
        onCommit={onCommit}
      />
      {!installed && <div className="provider-install-hint">{t("settings.integrations.output.installHint")}</div>}
      {installed && !usable && <div className="provider-install-hint">{t("settings.integrations.output.unavailableHint")}</div>}
    </article>
  );
}

function OutputProviderCard({
  connector,
  channel,
  label,
  output,
  connectorConfig,
  commit,
}: {
  connector: ConnectorEntry;
  channel: OutputChannel;
  label: string;
  output: OutputConfig;
  connectorConfig: ConnectorConfig;
  commit: ReturnType<typeof useConfigField>["commit"];
}) {
  const t = useT();
  const notionMcpStartAuth = trpc.integrations.notionMcpStartAuth.useMutation();
  const [connectError, setConnectError] = useState("");
  const installed = connectorIsInstalled(connector);
  const usable = connectorCanUse(connector);
  const enabled = connectorConfig[channel]?.send_summary ?? false;
  const toggleKey = `connectors.${channel}.send_summary`;

  const connectNotion = async () => {
    setConnectError("");
    try {
      const result = await notionMcpStartAuth.mutateAsync();
      window.open(result.authUrl, "_blank", "noopener,noreferrer");
    } catch (exc) {
      setConnectError((exc as Error).message || String(exc));
    }
  };

  return (
    <article className="output-provider-card" data-status={connector.status}>
      <div className="provider-card-head">
        <div className="provider-title-block">
          <span className="provider-mark provider-mark--output" aria-hidden="true">
            <Send size={15} strokeWidth={2} />
          </span>
          <div className="provider-title-main">
            <div className="provider-name">{label}</div>
            <ProviderMeta connector={connector} />
          </div>
        </div>
        <ProviderState connector={connector} />
      </div>

      <ProviderToggleRow
        label={t(`settings.integrations.output.enable.${channel}`)}
        help={connector.detail}
        value={enabled}
        disabled={!usable}
        onCommit={(next) => commit(toggleKey, { suppressRestart: true })(next)}
      />

      {!installed ? (
        <div className="provider-install-hint">{t("settings.integrations.output.installHint")}</div>
      ) : !usable ? (
        <div className="provider-install-hint">
          <span>{t("settings.integrations.output.unavailableHint")}</span>
          {channel === "notion" && (
            <>
              <button
                type="button"
                className="cmd-add provider-connect"
                onClick={connectNotion}
                disabled={notionMcpStartAuth.isPending}
              >
                {t("settings.integrations.output.connect.notion")}
              </button>
              {connectError && (
                <span className="provider-status-note provider-status-note--bad">
                  {t("settings.integrations.output.connect.failed", { error: connectError })}
                </span>
              )}
            </>
          )}
        </div>
      ) : (
        <>
          <OutputDestinationPanel channel={channel} output={output} commit={commit} />
        </>
      )}
    </article>
  );
}

export function IntegrationsSection({ tracker }: IntegrationsSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const accountListQuery = trpc.integrations.accountList.useQuery();
  const connectorStatusQuery = trpc.integrations.connectorStatus.useQuery();
  const { commit, isBlocked } = useConfigField(tracker);
  const testMut = trpc.integrations.test.useMutation();
  const t = useT();
  const [popFor, setPopFor] = useState<number | null>(null);
  const [popState, setPopState] = useState<"pending" | "ok" | "failed">("pending");
  const [popStdout, setPopStdout] = useState("");
  const [popStderr, setPopStderr] = useState("");
  const [connFor, setConnFor] = useState<number | null>(null);
  const [connState, setConnState] = useState<ConnState>(null);
  const autoFilledAccountRef = useRef<Set<string>>(new Set());

  const calendars = (cfg?.calendars ?? []) as CalendarEntry[];
  const connectorConfig = (cfg?.connectors ?? {}) as ConnectorConfig;
  const output = (cfg?.output ?? {}) as OutputConfig;
  const connectorEntries = useMemo(() => {
    return Object.values((connectorStatusQuery.data?.connectors ?? {}) as Record<string, ConnectorEntry>)
      .sort((a, b) => connectorOrder(a) - connectorOrder(b) || a.display_name.localeCompare(b.display_name));
  }, [connectorStatusQuery.data]);
  const connectorById = useMemo(() => {
    const out = new Map<string, ConnectorEntry>();
    for (const connector of connectorEntries) out.set(connector.connector_id, connector);
    return out;
  }, [connectorEntries]);
  const calendarConnectors = connectorEntries.filter((connector) =>
    connector.connector_id !== "gog" && connector.actions.includes("calendar.read")
  );
  const discoveredAccounts = useMemo(() => {
    const result = accountListQuery.data;
    if (!result?.ok) return [];
    return result.accounts as GoogleAccount[];
  }, [accountListQuery.data]);
  const singleDiscoveredAccount = discoveredAccounts.length === 1 ? discoveredAccounts[0]!.email : "";

  useEffect(() => {
    if (!singleDiscoveredAccount) return;
    calendars.forEach((cal, idx) => {
      if (cal.type !== "google") return;
      if ((cal.gog_account ?? "").trim()) return;
      const key = `${idx}:${singleDiscoveredAccount}`;
      if (autoFilledAccountRef.current.has(key)) return;
      autoFilledAccountRef.current.add(key);
      const enabled = cal.enabled === true;
      commit(`calendars.${idx}.gog_account`, { suppressRestart: !enabled })(singleDiscoveredAccount);
    });
  }, [calendars, commit, singleDiscoveredAccount]);

  if (!cfg) return null;

  const calBlocked = isBlocked("calendars");
  const hasType = (type: CalendarType) => calendars.some((cal) => cal.type === type);
  const hasSystemCalendar = calendars.some((cal) => cal.type === "macos" || cal.type === "system");
  const gogConnector = connectorById.get("gog") ?? fallbackConnector("gog", t("settings.integrations.google.title"), "calendar.read");
  const systemCalendarConnector: ConnectorEntry = {
    connector_id: "macos-calendar",
    display_name: t("settings.integrations.macos.title"),
    provenance: "yulu-managed",
    status: "usable",
    resolved_path: "macOS Calendar",
    detail: t("settings.integrations.macos.detail"),
    actions: ["calendar.read"],
    config_prefix: "calendars",
  };

  const addCalendar = (type: CalendarType) => {
    if (calBlocked || hasType(type) || (type === "macos" && hasSystemCalendar)) return;
    const entry = type === "macos"
      ? { type, enabled: true, watch_calendars: [] }
      : { type, enabled: false, watch_calendars: ["primary"] };
    commit("calendars", { suppressRestart: type !== "macos" })([
      ...calendars,
      entry,
    ]);
  };

  const removeCalendar = (idx: number) => {
    if (calBlocked) return;
    const wasEnabled = calendars[idx]?.enabled === true;
    commit("calendars", { suppressRestart: !wasEnabled })(calendars.filter((_, i) => i !== idx));
  };

  const setEnabled = (idx: number) => (next: boolean) => {
    commit(`calendars.${idx}.enabled`, { suppressRestart: !next })(next);
  };

  const commitField = (idx: number, key: string, enabled: boolean) =>
    commit(`calendars.${idx}.${key}`, { suppressRestart: !enabled });

  const commitWatchCalendars = (idx: number, enabled: boolean, next: string[]) => {
    commitField(idx, "watch_calendars", enabled)(next);
  };

  const commitAccount = (idx: number, enabled: boolean, next: string) => {
    commitField(idx, "gog_account", enabled)(next);
  };

  const runTest = async (idx: number) => {
    const provider = calendars[idx]?.type === "macos" || calendars[idx]?.type === "system" ? "macos" : "google";
    setPopFor(idx);
    setConnFor(idx);
    setPopState("pending");
    setConnState("pending");
    setPopStdout("");
    setPopStderr("");
    try {
      const res = await testMut.mutateAsync({ provider });
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
    <section id="integrations" className="settings-section ai-integrations">
      <h2 className="settings-section-h">{t("settings.integrations.heading")}</h2>
      <p className="settings-section-sub">{t("settings.integrations.sub")}</p>

      <div className="ai-integration-section" data-section="calendar">
        <div className="ai-integration-section-head">
          <div>
            <h3>{t("settings.integrations.calendar.heading")}</h3>
            <p>{t("settings.integrations.calendar.sub")}</p>
          </div>
          <div className="integration-head-actions">
            <button type="button" className="cmd-add" disabled={calBlocked || hasSystemCalendar} onClick={() => addCalendar("macos")}>
              {t("settings.integrations.add.macos")}
            </button>
            <button type="button" className="cmd-add" disabled={calBlocked || hasType("google")} onClick={() => addCalendar("google")}>
              + Google
            </button>
          </div>
        </div>

        {calendars.length === 0 && (
          <div className="integrations-empty">{t("settings.integrations.empty")}</div>
        )}

        {calendars.map((cal, idx) => {
          const enabled = cal.enabled === true;
          const isSystemCalendar = cal.type === "macos" || cal.type === "system";
          const providerConnector = isSystemCalendar ? systemCalendarConnector : gogConnector;
          const providerTitle = isSystemCalendar ? t("settings.integrations.macos.title") : t("settings.integrations.google.title");
          const effectiveCal = singleDiscoveredAccount && !(cal.gog_account ?? "").trim()
            ? { ...cal, gog_account: singleDiscoveredAccount }
            : cal;
          return (
            <article key={`${cal.type}-${idx}`} className="integration-card calendar-provider-card" data-status={providerConnector.status}>
              <div className="provider-card-head integration-header">
                <div className="provider-title-block">
                  <span className="provider-mark" aria-hidden="true">
                    <CalendarDays size={15} strokeWidth={2} />
                  </span>
                  <div className="provider-title-main">
                    <div className="provider-name">{providerTitle}</div>
                    <ProviderMeta connector={providerConnector} />
                  </div>
                </div>
                <div className="provider-card-actions">
                  <span className={`provider-state provider-state--${connectorTone(providerConnector.status)}`}>
                    <ConnectorStatusIcon status={providerConnector.status} />
                    {providerConnector.status === "usable"
                      ? t("settings.integrations.connection.connected")
                      : t(connectorStatusKey(providerConnector.status))}
                  </span>
                  <button
                    type="button"
                    className="cmd-remove"
                    aria-label={t("settings.integrations.removeAria")}
                    disabled={calBlocked}
                    onClick={() => removeCalendar(idx)}
                  >
                    {t("settings.integrations.remove")}
                  </button>
                </div>
              </div>

              <InlineEditRow
                label={t("settings.integrations.enabled.label")}
                type="toggle"
                value={cal.enabled ?? false}
                onCommit={setEnabled(idx)}
                disabled={isBlocked(`calendars.${idx}.enabled`)}
              />
              {isSystemCalendar ? (
                <div className="row">
                  <div className="row-label">
                    <div>{t("settings.integrations.macos.source.label")}</div>
                    <div className="row-help">{t("settings.integrations.macos.source.help")}</div>
                  </div>
                  <div className="row-value">{t("settings.integrations.macos.source.value")}</div>
                  <div className="row-status" />
                </div>
              ) : (
                <>
                  <CalendarAccountRow
                    idx={idx}
                    cal={effectiveCal}
                    enabled={enabled}
                    blocked={isBlocked(`calendars.${idx}.gog_account`)}
                    accounts={discoveredAccounts}
                    commitAccount={commitAccount}
                  />
                  <div className="row">
                    <div className="row-label">
                      <div>{t("settings.integrations.watch.label")}</div>
                      <div className="row-help">{t("settings.integrations.watch.help")}</div>
                    </div>
                    <div className="row-value">
                      <CalendarWatchSelector
                        idx={idx}
                        cal={effectiveCal}
                        enabled={enabled}
                        blocked={isBlocked(`calendars.${idx}.watch_calendars`)}
                        commitWatchCalendars={commitWatchCalendars}
                      />
                    </div>
                    <div className="row-status" />
                  </div>
                </>
              )}
              <div className="row">
                <div className="row-label">
                  <div>{t("settings.integrations.connection.label")}</div>
                  <div className="row-help">{t("settings.integrations.connection.help")}</div>
                </div>
                <div className="row-value">
                  <button type="button" className="cmd-add" onClick={() => runTest(idx)}>{t("settings.integrations.connection.check")}</button>
                  {connFor === idx && connState === "ok" && <span className="conn-status conn-status--ok">{t("settings.integrations.connection.connected")}</span>}
                  {connFor === idx && connState === "failed" && <span className="conn-status conn-status--bad">{t("settings.integrations.connection.notAuth")}</span>}
                  {connFor === idx && connState === "pending" && <span className="conn-status">{t("settings.integrations.connection.checking")}</span>}
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
            </article>
          );
        })}
        {calendarConnectors.map((connector) => (
          <CalendarConnectorCard
            key={connector.connector_id}
            connector={connector}
            value={connectorConfig[connector.connector_id]?.read_calendar ?? false}
            blocked={isBlocked(`connectors.${connector.connector_id}.read_calendar`)}
            onCommit={(next) => commit(`connectors.${connector.connector_id}.read_calendar`, { suppressRestart: !next })(next)}
          />
        ))}
      </div>

      <div className="ai-integration-section" data-section="output">
        <div className="ai-integration-section-head">
          <div>
            <h3>{t("settings.integrations.output.heading")}</h3>
            <p>{t("settings.integrations.output.sub")}</p>
          </div>
        </div>
        <div className="output-provider-grid">
          {OUTPUT_CONNECTORS.map((provider) => {
            const connector = connectorById.get(provider.id) ?? fallbackConnector(provider.id, provider.label, "summary.send");
            return (
              <OutputProviderCard
                key={provider.id}
                connector={connector}
                channel={provider.id}
                label={provider.label}
                output={output}
                connectorConfig={connectorConfig}
                commit={commit}
              />
            );
          })}
        </div>
      </div>
    </section>
  );
}
