import { useT } from "../i18n/LanguageProvider.js";
import "./TestPopover.css";

export interface TestPopoverProps {
  state: "pending" | "ok" | "failed";
  stdout?: string;
  stderr?: string;
  onClose: () => void;
}

function visibleOutput(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  const compact = trimmed.replace(/\\[rn]/g, "").trim();
  return compact === "[]" ? "" : (value ?? "");
}

export function TestPopover({ state, stdout, stderr, onClose }: TestPopoverProps) {
  const t = useT();
  const visibleStdout = visibleOutput(stdout);
  const visibleStderr = visibleOutput(stderr);
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
      {visibleStdout && <pre className="testpop-out">{visibleStdout}</pre>}
      {visibleStderr && <pre className="testpop-err">{visibleStderr}</pre>}
    </div>
  );
}
