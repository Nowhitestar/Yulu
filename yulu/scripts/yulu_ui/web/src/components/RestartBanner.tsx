import "./RestartBanner.css";

export interface RestartBannerProps {
  /** Daemons (with the keys that changed) pending a restart. */
  daemons: Array<{ name: string; keys: string[] }>;
  /** Restart every daemon in the pending set. */
  onRestartAll: () => void;
  /** Dismiss the banner without restarting (clears the pending set). */
  onDismiss: () => void;
}

/**
 * RestartBanner — one consolidated "some changes need a restart" notice (P4a-6).
 * A single primary "Restart now" restarts every daemon in the pending set; the
 * banner is dismissible (the user may batch a restart for later). The affected
 * daemon names are shown for transparency, but there are no per-daemon buttons.
 */
export function RestartBanner({ daemons, onRestartAll, onDismiss }: RestartBannerProps) {
  const names = daemons.map((d) => d.name);
  return (
    <div className="restart-banner" role="status">
      <div className="restart-banner-dot">●</div>
      <div className="restart-banner-body">
        <div className="restart-banner-title">Some changes need a daemon restart to take effect.</div>
        <div className="restart-banner-daemons">{names.join(", ")}</div>
      </div>
      <button type="button" className="restart-banner-btn primary" onClick={onRestartAll}>
        Restart now
      </button>
      <button
        type="button"
        className="restart-banner-btn restart-banner-dismiss"
        onClick={onDismiss}
        aria-label="Dismiss"
      >
        Dismiss
      </button>
    </div>
  );
}
