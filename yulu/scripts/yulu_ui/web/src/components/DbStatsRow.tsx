import "./DbStatsRow.css";

export interface DbStatsRowProps {
  name: string;
  path: string;
  size: number;
  rows: number | null;
  actionLabel?: string;
  onAction?: () => void;
  actionDisabled?: boolean;
}

export function formatBytes(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export function DbStatsRow({ name, path, size, rows, actionLabel, onAction, actionDisabled }: DbStatsRowProps) {
  return (
    <div className="dbstats-row">
      <div className="dbstats-name">{name}</div>
      <div className="dbstats-path">{path}</div>
      <div className="dbstats-meta">
        <span>{formatBytes(size)}</span>
        <span>{rows === null ? "— rows" : `${rows} rows`}</span>
      </div>
      {actionLabel && onAction && (
        <button type="button" className="dbstats-action" onClick={onAction} disabled={actionDisabled}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}
