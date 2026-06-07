import { useState } from "react";
import { trpc } from "../trpc.js";
import { useT } from "../i18n/LanguageProvider.js";
import "../onboarding.css";

// localStorage hint so a returning user never flashes the overlay before the
// config query resolves (D-06). The authoritative dismissal still lives in
// config.onboarding_dismissed (persisted via the config router), so it also
// survives across browsers/machines.
const LS_KEY = "yulu_ui.onboarding_dismissed";

function readLocalDismissed(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === "true";
  } catch {
    return false; // localStorage unavailable — fall back to the config flag only
  }
}

function writeLocalDismissed(): void {
  try {
    localStorage.setItem(LS_KEY, "true");
  } catch {
    /* ignore — config flag is the source of truth */
  }
}

interface Capability {
  provenance: string;
  status: string;
  resolved_path: string;
  detail: string;
}

// The few capabilities the first-run walkthrough reflects. `key` matches the
// host_capabilities report name; `i18n` is the message-key stem whose
// `.label/.ok/.missing` copy is resolved at render time (keys live in
// messages.ts). The two differ (recording_dir vs recordingDir, whisper_cli vs
// whisper) so the report-name and the copy-name are kept as separate fields.
const WALKTHROUGH: { key: string; i18n: string }[] = [
  { key: "recording_dir", i18n: "recordingDir" },
  { key: "claude", i18n: "claude" },
  { key: "whisper_cli", i18n: "whisper" },
  { key: "models", i18n: "models" },
];

type StatusKind = "usable" | "present" | "absent" | "unknown";

// Collapse the Phase 3 tri-state into the walkthrough's ready/not-ready framing.
// An entry the report didn't include (or a degraded report) reads "unknown" so
// we show a "couldn't check" placeholder rather than implying a failure.
function statusKind(cap: Capability | undefined, degraded: boolean): StatusKind {
  if (degraded || cap === undefined) return "unknown";
  if (cap.status === "usable") return "usable";
  if (cap.status === "absent") return "absent";
  return "present"; // present-but-unverified (or any other non-absent state)
}

/**
 * Onboarding — a skippable first-run walkthrough overlay (SET-03 / D-06 / D-07).
 *
 * It reflects LIVE permission/capability status by reading
 * `trpc.capabilities.host_capabilities` and is dismissable WITHOUT completing
 * any step. First-run is detected from BOTH `localStorage` (synchronous, so it
 * never flashes for a returning user) AND `config.onboarding_dismissed` (so the
 * dismissal survives across browsers/machines). Once dismissed via either, it
 * renders `null` — a forced/unskippable onboarding is an explicit Out-of-Scope
 * anti-feature.
 *
 * Report strings render as JSX text children only (React auto-escapes) — never
 * dangerouslySetInnerHTML (T-04-XSS). A degraded host_capabilities `{error,...}`
 * shape renders "couldn't check" placeholders instead of crashing.
 */
export function Onboarding() {
  const t = useT();
  // Read the localStorage hint synchronously on first render so a returning
  // user never sees a flash before the config query resolves (Test 4).
  const [dismissedLocal, setDismissedLocal] = useState<boolean>(() => readLocalDismissed());

  const cfgQuery = trpc.config.get.useQuery();
  const cfg = cfgQuery.data as { onboarding_dismissed?: boolean } | undefined;
  const configDismissed = cfg?.onboarding_dismissed === true;

  const dismissMutation = trpc.config.update.useMutation();

  const capsQuery = trpc.capabilities.host_capabilities.useQuery();
  const report = capsQuery.data as
    | { capabilities?: Record<string, Capability>; error?: string }
    | undefined;
  // Degraded when the query errored, returned the typed error shape, or hasn't
  // resolved yet — in all cases we show "couldn't check" placeholders.
  const degraded = capsQuery.isError || report === undefined || Boolean(report?.error);
  const caps = (report?.capabilities ?? {}) as Record<string, Capability>;

  // Never forced: localStorage OR config flag (OR a just-clicked Skip) hides it.
  if (dismissedLocal || configDismissed) return null;

  async function handleSkip() {
    // Hide immediately (local state) — skipping must NOT require completing a step.
    writeLocalDismissed();
    setDismissedLocal(true);
    try {
      await dismissMutation.mutateAsync({ key: "onboarding_dismissed", value: true });
    } catch {
      // The localStorage hint already prevents a reappear this session; the
      // config write will be retried next run if it failed here.
    }
  }

  return (
    <div className="onboarding-scrim">
      <div className="onboarding-card" role="dialog" aria-modal="true" aria-label={t("onboarding.aria")}>
        <div className="onboarding-head">
          <div>
            <h2 className="onboarding-title">{t("onboarding.title")}</h2>
            <p className="onboarding-sub">{t("onboarding.sub")}</p>
          </div>
          <button
            type="button"
            className="onboarding-skip"
            onClick={() => { void handleSkip(); }}
          >
            {t("onboarding.skip")}
          </button>
        </div>

        <ul className="onboarding-list">
          {WALKTHROUGH.map((item) => {
            const kind = statusKind(caps[item.key], degraded);
            const line =
              kind === "unknown"
                ? t("onboarding.unknown")
                : kind === "absent"
                  ? t(`onboarding.${item.i18n}.missing`)
                  : t(`onboarding.${item.i18n}.ok`);
            return (
              <li className="onboarding-item" key={item.key}>
                <span className="onboarding-dot" data-status={kind} aria-hidden="true" />
                <span className="onboarding-item-body">
                  <span className="onboarding-item-label">{t(`onboarding.${item.i18n}.label`)}</span>
                  <span className="onboarding-item-line">{line}</span>
                </span>
              </li>
            );
          })}
        </ul>

        <div className="onboarding-foot">
          <button
            type="button"
            className="onboarding-done"
            onClick={() => { void handleSkip(); }}
          >
            {t("onboarding.done")}
          </button>
        </div>
      </div>
    </div>
  );
}
