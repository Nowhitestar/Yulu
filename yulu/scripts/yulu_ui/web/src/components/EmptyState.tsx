import "./EmptyState.css";

export interface EmptyStateProps {
  icon?: string;
  label: string;
  cta?: { label: string; onClick: () => void };
}

export function EmptyState({ icon, label, cta }: EmptyStateProps) {
  return (
    <div className="emptystate">
      {icon && <div className="emptystate-icon" aria-hidden="true">{icon}</div>}
      <div className="emptystate-label">{label}</div>
      {cta && (
        <button type="button" className="emptystate-cta" onClick={cta.onClick}>
          {cta.label}
        </button>
      )}
    </div>
  );
}
