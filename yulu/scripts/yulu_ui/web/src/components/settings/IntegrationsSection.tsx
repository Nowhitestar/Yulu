import { useEffect, useMemo, useRef, useState } from "react";
import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { TestPopover } from "../TestPopover.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import { useT } from "../../i18n/LanguageProvider.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface IntegrationsSectionProps {
  tracker: SettingsRestartTracker;
}

// Google is the only real calendar provider. (Feishu was a dead stub and was
// removed in P4a-4.)
type CalendarType = "google";
interface CalendarEntry {
  type: CalendarType;
  enabled?: boolean;
  credentials_path?: string;
  gog_account?: string;
  watch_calendars?: string[];
  [k: string]: unknown;
}

type ConnState = "ok" | "failed" | "pending" | null;

interface CalendarOption {
  id: string;
  summary: string;
  primary: boolean;
}

interface GoogleAccount {
  email: string;
  services: string[];
}

function selectedWatchCalendars(cal: CalendarEntry): string[] {
  const current = cal.watch_calendars;
  return current && current.length > 0 ? current : ["primary"];
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
            <span className="value-disabled-text">{current || t("settings.value.unset")}</span>
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

export function IntegrationsSection({ tracker }: IntegrationsSectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const accountListQuery = trpc.integrations.accountList.useQuery();
  const { commit, isBlocked } = useConfigField(tracker);
  const testMut = trpc.integrations.test.useMutation();
  const t = useT();
  const [popFor, setPopFor] = useState<number | null>(null);
  const [popState, setPopState] = useState<"pending" | "ok" | "failed">("pending");
  const [popStdout, setPopStdout] = useState("");
  const [popStderr, setPopStderr] = useState("");
  // Per-entry connection status, shown as Connected / Not authenticated.
  const [connFor, setConnFor] = useState<number | null>(null);
  const [connState, setConnState] = useState<ConnState>(null);
  const autoFilledAccountRef = useRef<Set<string>>(new Set());

  const calendars = (cfg?.calendars ?? []) as CalendarEntry[];
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

  // calendars is restart-class (calendar + scheduler): changing a *watched*
  // (enabled) calendar interrupts the daemon, so those edits are guarded while
  // recording. Adding/removing/editing a DISABLED entry doesn't touch the
  // running daemon, so it's neither guarded nor restart-tracked (P4a-4).
  const calBlocked = isBlocked("calendars");
  const hasType = (t: CalendarType) => calendars.some((c) => c.type === t);

  // Append a fresh provider, DISABLED by default — the user fills in the account,
  // then toggles it on. Appending a disabled entry needs no daemon restart, so we
  // suppress the restart hint (P4a-4). The whole array is replaced via
  // config.update("calendars",…) (calendars has no per-index registry entry).
  const addCalendar = (type: CalendarType) => {
    if (calBlocked || hasType(type)) return;
    commit("calendars", { suppressRestart: true })([
      ...calendars,
      { type, enabled: false, watch_calendars: ["primary"] },
    ]);
  };

  // Removing an entry only needs a restart if it was actually being watched
  // (enabled); removing a disabled entry is a no-op for the daemon (P4a-4).
  const removeCalendar = (idx: number) => {
    if (calBlocked) return;
    const wasEnabled = calendars[idx]?.enabled === true;
    commit("calendars", { suppressRestart: !wasEnabled })(calendars.filter((_, i) => i !== idx));
  };

  // Toggling enabled: turning ON starts watching → restart; turning OFF stops
  // watching → no restart needed (P4a-4).
  const setEnabled = (idx: number) => (next: boolean) => {
    commit(`calendars.${idx}.enabled`, { suppressRestart: !next })(next);
  };

  // Editing a field of an entry only needs a restart if that entry is currently
  // enabled (the daemon is watching it); edits to a disabled entry are inert.
  const commitField = (idx: number, key: string, enabled: boolean) =>
    commit(`calendars.${idx}.${key}`, { suppressRestart: !enabled });

  const commitWatchCalendars = (idx: number, enabled: boolean, next: string[]) => {
    commitField(idx, "watch_calendars", enabled)(next);
  };

  const commitAccount = (idx: number, enabled: boolean, next: string) => {
    commitField(idx, "gog_account", enabled)(next);
  };

  const runTest = async (idx: number) => {
    setPopFor(idx);
    setConnFor(idx);
    setPopState("pending");
    setConnState("pending");
    setPopStdout("");
    setPopStderr("");
    try {
      const res = await testMut.mutateAsync({ provider: "google" });
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
    <section id="integrations" className="settings-section">
      <h2 className="settings-section-h">{t("settings.integrations.heading")}</h2>
      <p className="settings-section-sub">{t("settings.integrations.sub")}</p>
      {calendars.length === 0 && (
        <div className="integrations-empty">{t("settings.integrations.empty")}</div>
      )}
      {calendars.map((cal, idx) => {
        const enabled = cal.enabled === true;
        const effectiveCal = singleDiscoveredAccount && !(cal.gog_account ?? "").trim()
          ? { ...cal, gog_account: singleDiscoveredAccount }
          : cal;
        return (
          <div key={`${cal.type}-${idx}`} className="integration-card">
            <div className="integration-header">
              <span>{t("settings.integrations.google.title")}</span>
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
            <InlineEditRow
              label={t("settings.integrations.enabled.label")}
              type="toggle"
              value={cal.enabled ?? false}
              onCommit={setEnabled(idx)}
              disabled={isBlocked(`calendars.${idx}.enabled`)}
            />
            <CalendarAccountRow
              idx={idx}
              cal={effectiveCal}
              enabled={enabled}
              blocked={isBlocked(`calendars.${idx}.gog_account`)}
              accounts={discoveredAccounts}
              commitAccount={commitAccount}
            />
            {/* watch_calendars comes from gog's calendar list; users select ids by checkbox.
                Defaults to ["primary"] when unset, so the effective value is visible. */}
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
          </div>
        );
      })}

      {/* P4a-4: add the Google calendar provider. Appends a DISABLED entry; the
          user fills in the account and enables it. Appending disabled needs no
          restart (suppressed in addCalendar). Guarded while recording. */}
      <div className="row">
        <div className="row-label">
          <div>{t("settings.integrations.add.label")}</div>
          <div className="row-help">{t("settings.integrations.add.help")}</div>
        </div>
        <div className="row-value">
          <button
            type="button"
            className="cmd-add"
            disabled={calBlocked || hasType("google")}
            onClick={() => addCalendar("google")}
          >
            {t("settings.integrations.add.google")}
          </button>
          {calBlocked && <span className="value-disabled-note">{t("settings.locked.recording")}</span>}
        </div>
        <div className="row-status" />
      </div>
    </section>
  );
}
