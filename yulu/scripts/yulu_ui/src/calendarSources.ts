import { createHash } from "node:crypto";
import type { UpdateResult, YuluConfig } from "./config.js";

export type CalendarSourceId = "macos" | "gog";
export type CalendarSourceAdapterId = "eventkit" | "gog-cli";
export type CalendarSourceFailureReason =
  | "runtime_missing"
  | "authorization_denied"
  | "authorization_restricted"
  | "authorization_not_determined"
  | "service_activation_failed"
  | "enumeration_failed";

export interface CalendarSourceConfigStore {
  read(): YuluConfig;
  update(key: string, value: unknown): UpdateResult;
}

export interface CalendarSourceProbeInput {
  start: string;
  end: string;
  account: string | null;
}

export type CalendarSourceAdapterResult =
  | {
      ok: true;
      adapter: CalendarSourceAdapterId;
      start: string;
      end: string;
      eventCount: number;
    }
  | {
      ok: false;
      reason: CalendarSourceFailureReason;
      detail: string;
      remediation: string;
    };

export interface CalendarSourceAdapter {
  probe(input: CalendarSourceProbeInput): Promise<CalendarSourceAdapterResult>;
}

export type CalendarServiceVerification =
  | { ok: true }
  | { ok: false; errors: string[] };

export interface CalendarSourceEvidenceSnapshot {
  capability: "calendar-source";
  source: CalendarSourceId;
  adapter: CalendarSourceAdapterId;
  selectionFingerprint: string;
  accessGranted: true;
  enumerationSucceeded: true;
  eventCount: number;
  window: { start: string; end: string };
  testedAt: string;
}

export interface CalendarSourceReadiness {
  status: "untested" | "ready" | "failed";
  source: CalendarSourceId | null;
  reason: CalendarSourceFailureReason | null;
  detail: string;
  remediation: string;
  testedAt: string | null;
  evidence: CalendarSourceEvidenceSnapshot | null;
}

export interface SelectedCalendarSource {
  source: CalendarSourceId;
  account: string | null;
}

const SOURCE_METADATA = [
  {
    id: "macos" as const,
    label: "macOS Calendar",
    recommended: true,
    advanced: false,
    externalRuntime: false,
  },
  {
    id: "gog" as const,
    label: "Google Calendar via gog",
    recommended: false,
    advanced: true,
    externalRuntime: true,
  },
] as const;

function selectedSource(config: YuluConfig): SelectedCalendarSource | null {
  const selected: SelectedCalendarSource[] = [];
  for (const calendar of config.calendars) {
    if (calendar.enabled === false) continue;
    if (calendar.type === "macos" || calendar.type === "system") {
      selected.push({ source: "macos", account: null });
      continue;
    }
    if (calendar.type === "google") {
      const account = calendar.gog_account?.trim() ?? "";
      if (account) selected.push({ source: "gog", account });
    }
  }
  return selected.length === 1 ? selected[0]! : null;
}

function fingerprint(selection: SelectedCalendarSource): string {
  return createHash("sha256")
    .update(selection.source)
    .update("\0")
    .update(selection.account ?? "")
    .digest("hex");
}

function untested(source: CalendarSourceId | null): CalendarSourceReadiness {
  return {
    status: "untested",
    source,
    reason: null,
    detail: source ? "The selected Calendar Source has not been tested in this Host process" : "Select a Calendar Source",
    remediation: source ? "Run the Calendar Source test" : "Choose macOS Calendar or the advanced gog source",
    testedAt: null,
    evidence: null,
  };
}

function normalizedCalendars(
  config: YuluConfig,
  selection: SelectedCalendarSource,
): YuluConfig["calendars"] {
  let matched = false;
  const calendars = config.calendars.map((calendar) => {
    const isMacos = calendar.type === "macos" || calendar.type === "system";
    const isGog = calendar.type === "google";
    if (selection.source === "macos" && isMacos && !matched) {
      matched = true;
      return { ...calendar, type: "macos" as const, enabled: true, watch_calendars: calendar.watch_calendars ?? [] };
    }
    if (selection.source === "gog" && isGog && !matched) {
      matched = true;
      return {
        ...calendar,
        type: "google" as const,
        enabled: true,
        gog_account: selection.account!,
        watch_calendars: calendar.watch_calendars?.length ? calendar.watch_calendars : ["primary"],
      };
    }
    return { ...calendar, enabled: false };
  });
  if (!matched) {
    calendars.push(selection.source === "macos"
      ? { type: "macos", enabled: true, watch_calendars: [] }
      : {
          type: "google",
          enabled: true,
          gog_account: selection.account!,
          watch_calendars: ["primary"],
        });
  }
  return calendars;
}

export class CalendarSourceManager {
  private readiness: CalendarSourceReadiness;
  private readinessSelectionFingerprint: string | null;

  constructor(private readonly options: {
    config: CalendarSourceConfigStore;
    adapters: Record<CalendarSourceId, CalendarSourceAdapter>;
    verifyServices: () => Promise<CalendarServiceVerification>;
    now?: () => Date;
  }) {
    const selection = selectedSource(options.config.read());
    this.readiness = untested(selection?.source ?? null);
    this.readinessSelectionFingerprint = selection ? fingerprint(selection) : null;
  }

  view() {
    const selection = selectedSource(this.options.config.read());
    const currentFingerprint = selection ? fingerprint(selection) : null;
    const readiness = this.readiness.source === selection?.source &&
        this.readinessSelectionFingerprint === currentFingerprint
      ? this.readiness
      : untested(selection?.source ?? null);
    if (readiness !== this.readiness) {
      this.readiness = readiness;
      this.readinessSelectionFingerprint = currentFingerprint;
    }
    return {
      selectedSource: selection,
      sources: [...SOURCE_METADATA],
      readiness,
    };
  }

  select(input: { source: CalendarSourceId; account?: string | null }) {
    const account = input.source === "gog" ? input.account?.trim() ?? "" : "";
    if (input.source === "gog" && (!account || account.length > 320)) {
      throw new Error("A gog Calendar Source requires an explicit account");
    }
    const selection: SelectedCalendarSource = {
      source: input.source,
      account: input.source === "gog" ? account : null,
    };
    const update = this.options.config.update(
      "calendars",
      normalizedCalendars(this.options.config.read(), selection),
    );
    this.readiness = untested(selection.source);
    this.readinessSelectionFingerprint = fingerprint(selection);
    return { selection, update };
  }

  markServiceActivationFailed(errors: string[]) {
    const selection = selectedSource(this.options.config.read());
    if (!selection) return;
    const failureState = ([
      "not_loaded",
      "disabled",
      "permission_denied",
      "command_failed",
      "not_running",
    ] as const).find((state) => errors.some((error) => error.endsWith(`: ${state}`)));
    const copy = failureState === "not_loaded"
      ? {
          detail: "A required production Calendar service is not installed or loaded",
          remediation: "Repair or reinstall Yulu so its Calendar services are registered, then try again",
        }
      : failureState === "disabled"
        ? {
            detail: "A required production Calendar service is disabled",
            remediation: "Repair or reinstall Yulu to re-enable its Calendar services, then try again",
          }
        : failureState === "permission_denied"
          ? {
              detail: "macOS denied Yulu permission to inspect its Calendar services",
              remediation: "Quit and reopen the signed Yulu app from Applications; repair the installation if this continues",
            }
          : failureState === "command_failed"
            ? {
                detail: "Yulu could not verify production Calendar service status",
                remediation: "Restart Yulu; repair or reinstall it if service verification continues to fail",
              }
            : failureState === "not_running"
              ? {
                  detail: "A required production Calendar service is loaded but not running",
                  remediation: "Restart Yulu's Calendar services from System Health, then try again",
                }
              : {
                  detail: "The production Calendar polling services did not activate",
                  remediation: "Repair or reinstall Yulu's Calendar services, then select the Calendar Source again",
                };
    this.readinessSelectionFingerprint = fingerprint(selection);
    this.readiness = {
      status: "failed",
      source: selection.source,
      reason: "service_activation_failed",
      detail: copy.detail,
      remediation: copy.remediation,
      testedAt: (this.options.now?.() ?? new Date()).toISOString(),
      evidence: null,
    };
  }

  private async productionServicesReady(): Promise<boolean> {
    try {
      const verification = await this.options.verifyServices();
      if (verification.ok) return true;
      this.markServiceActivationFailed(verification.errors);
    } catch {
      this.markServiceActivationFailed(["Calendar service status verification failed"]);
    }
    return false;
  }

  async probe(): Promise<CalendarSourceReadiness> {
    const selection = selectedSource(this.options.config.read());
    if (!selection) throw new Error("Select exactly one Calendar Source before testing readiness");
    const probeFingerprint = fingerprint(selection);
    if (!await this.productionServicesReady()) return this.readiness;
    const testedAt = (this.options.now?.() ?? new Date()).toISOString();
    const start = testedAt;
    const end = new Date(Date.parse(testedAt) + 24 * 60 * 60 * 1000).toISOString();
    const result = await this.options.adapters[selection.source].probe({
      start,
      end,
      account: selection.account,
    });
    const currentSelection = selectedSource(this.options.config.read());
    const currentFingerprint = currentSelection ? fingerprint(currentSelection) : null;
    if (currentFingerprint !== probeFingerprint) {
      this.readiness = untested(currentSelection?.source ?? null);
      this.readinessSelectionFingerprint = currentFingerprint;
      return this.readiness;
    }
    this.readinessSelectionFingerprint = probeFingerprint;
    if (!result.ok) {
      this.readiness = {
        status: "failed",
        source: selection.source,
        reason: result.reason,
        detail: result.detail,
        remediation: result.remediation,
        testedAt,
        evidence: null,
      };
      return this.readiness;
    }
    const expectedAdapter = selection.source === "macos" ? "eventkit" : "gog-cli";
    if (
      result.adapter !== expectedAdapter || result.start !== start || result.end !== end ||
      !Number.isSafeInteger(result.eventCount) || result.eventCount < 0
    ) {
      this.readiness = {
        status: "failed",
        source: selection.source,
        reason: "enumeration_failed",
        detail: "Calendar Source returned invalid enumeration evidence",
        remediation: "Try the Calendar Source test again",
        testedAt,
        evidence: null,
      };
      return this.readiness;
    }
    const evidence: CalendarSourceEvidenceSnapshot = {
      capability: "calendar-source",
      source: selection.source,
      adapter: result.adapter,
      selectionFingerprint: fingerprint(selection),
      accessGranted: true,
      enumerationSucceeded: true,
      eventCount: result.eventCount,
      window: { start, end },
      testedAt,
    };
    this.readiness = {
      status: "ready",
      source: selection.source,
      reason: null,
      detail: result.eventCount === 0
        ? "Calendar access and enumeration succeeded; no events were found in the test window"
        : `Calendar access and enumeration succeeded with ${result.eventCount} event(s)`,
      remediation: "",
      testedAt,
      evidence,
    };
    return this.readiness;
  }

  async adoptionEvidence() {
    if (!await this.productionServicesReady()) {
      throw new Error("Calendar Source adoption requires current production service activation");
    }
    const view = this.view();
    if (view.readiness.status !== "ready" || !view.readiness.evidence || !view.selectedSource) {
      throw new Error("Calendar Source adoption requires an exact ready probe");
    }
    return {
      kind: "calendar-source-probe",
      reference: `calendar-source:${view.readiness.evidence.selectionFingerprint}:${view.readiness.evidence.testedAt}`,
      snapshot: view.readiness.evidence,
    };
  }
}
