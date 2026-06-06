import type { ReactNode } from "react";

/**
 * AdvancedDisclosure — a collapsible <details> that hides advanced/power-user
 * knobs behind a summary, collapsed by default (P3-2). Native <details> keeps it
 * keyboard-accessible and needs no controlled state; the summary carries a quiet
 * "change with care" note. Used for the `advanced` category content and the
 * automation match-array editors.
 */
export function AdvancedDisclosure({
  title = "Advanced",
  note = "change with care",
  children,
}: {
  title?: string;
  note?: string;
  children: ReactNode;
}) {
  return (
    <details className="adv-disclosure">
      <summary className="adv-summary">
        <span>{title}</span>
        <span className="adv-summary-note">{note}</span>
      </summary>
      <div className="adv-body">{children}</div>
    </details>
  );
}
