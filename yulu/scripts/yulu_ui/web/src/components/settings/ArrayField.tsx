import { CommandEditor } from "../CommandEditor.js";
import { useT } from "../../i18n/LanguageProvider.js";

/**
 * ArrayField — a labelled string-array editor reusing CommandEditor's chip rows
 * (P3-2). Used for the meeting_detection match arrays (window_keywords, app
 * hints, …). `label`/`help` are already-resolved display strings (callers pass
 * t("…")). When `blocked` (a restart-class field edited mid-recording) it renders
 * the current items read-only with a "locked while recording" note, mirroring how
 * AdvancedSection guards the cloud-command editor.
 */
export function ArrayField({
  label,
  help,
  value,
  onChange,
  blocked,
}: {
  label: string;
  help?: string;
  value: string[];
  onChange: (next: string[]) => void;
  blocked?: boolean;
}) {
  const t = useT();
  return (
    <div className="array-field">
      <div className="array-field-label">{label}</div>
      {help && <div className="array-field-help">{help}</div>}
      {blocked ? (
        <span className="value-disabled">
          <span className="value-disabled-text">{value.join(", ") || t("value.empty")}</span>
          <span className="array-field-note">{t("settings.locked.recording")}</span>
        </span>
      ) : (
        <CommandEditor value={value} onChange={onChange} />
      )}
    </div>
  );
}
