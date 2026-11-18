import "./Placeholder.css";

export interface PlaceholderProps {
  phase: "C" | "D" | "E" | "F" | "G";
  backendNote?: string;
}

export function Placeholder({ phase, backendNote }: PlaceholderProps) {
  return (
    <div className="placeholder">
      <div className="placeholder-label">COMING IN PHASE {phase}</div>
      {backendNote && <div className="placeholder-backend">backend wired: {backendNote}</div>}
    </div>
  );
}
