import type { ReactNode } from "react";
import { useT } from "../../i18n/LanguageProvider.js";

/**
 * AdvancedDisclosure — a collapsible <details> that hides advanced/power-user
 * knobs behind a summary, collapsed by default (P3-2). Native <details> keeps it
 * keyboard-accessible and needs no controlled state; the summary carries a quiet
 * "change with care" note. Used for automation match-array editors.
 *
 * `title`/`note` are already-resolved display strings (callers pass t("…")); when
 * omitted they fall back to the localized generic "Advanced / change with care".
 */
export function AdvancedDisclosure({
  title,
  note,
  children,
}: {
  title?: string;
  note?: string;
  children: ReactNode;
}) {
  const t = useT();
  return (
    <details className="adv-disclosure">
      <summary className="adv-summary">
        <span>{title ?? t("disclosure.title")}</span>
        <span className="adv-summary-note">{note ?? t("disclosure.note")}</span>
      </summary>
      <div className="adv-body">{children}</div>
    </details>
  );
}
