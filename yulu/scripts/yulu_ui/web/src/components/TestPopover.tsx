import "./TestPopover.css";

export interface TestPopoverProps {
  state: "pending" | "ok" | "failed";
  stdout?: string;
  stderr?: string;
  onClose: () => void;
}

export function TestPopover({ state, stdout, stderr, onClose }: TestPopoverProps) {
  return (
    <div className="testpop" role="dialog">
      <div className="testpop-header">
        <span className={"testpop-status " + state}>
          {state === "pending" && "● running…"}
          {state === "ok" && "✓ ok"}
          {state === "failed" && "✗ failed"}
        </span>
        <button type="button" className="testpop-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      {stdout && <pre className="testpop-out">{stdout}</pre>}
      {stderr && <pre className="testpop-err">{stderr}</pre>}
    </div>
  );
}
