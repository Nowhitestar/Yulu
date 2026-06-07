import { useT } from "../i18n/LanguageProvider.js";
import "./TestPopover.css";

export interface TestPopoverProps {
  state: "pending" | "ok" | "failed";
  stdout?: string;
  stderr?: string;
  onClose: () => void;
}

export function TestPopover({ state, stdout, stderr, onClose }: TestPopoverProps) {
  const t = useT();
  return (
    <div className="testpop" role="dialog">
      <div className="testpop-header">
        <span className={"testpop-status " + state}>
          {state === "pending" && t("test.running")}
          {state === "ok" && t("test.ok")}
          {state === "failed" && t("test.failed")}
        </span>
        <button type="button" className="testpop-close" onClick={onClose} aria-label={t("test.closeAria")}>×</button>
      </div>
      {stdout && <pre className="testpop-out">{stdout}</pre>}
      {stderr && <pre className="testpop-err">{stderr}</pre>}
    </div>
  );
}
