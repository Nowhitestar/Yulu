import "./RestartBanner.css";

export interface RestartBannerProps {
  daemons: Array<{ name: string; keys: string[] }>;
  onRestart: (name: string) => void;
  onRestartAll: () => void;
}

export function RestartBanner({ daemons, onRestart, onRestartAll }: RestartBannerProps) {
  return (
    <div className="restart-banner" role="status">
      <div className="restart-banner-dot">●</div>
      <div className="restart-banner-body">
        <div className="restart-banner-title">Changes saved. Restart required:</div>
        <ul className="restart-banner-list">
          {daemons.map((d) => (
            <li key={d.name}>
              <span className="restart-banner-daemon">{d.name}</span>
              <span className="restart-banner-keys">{d.keys.join(", ")}</span>
              <button
                type="button"
                className="restart-banner-btn small"
                onClick={() => onRestart(d.name)}
                aria-label={`Restart ${d.name}`}
              >
                Restart
              </button>
            </li>
          ))}
        </ul>
      </div>
      <button type="button" className="restart-banner-btn primary" onClick={onRestartAll}>
        Restart now
      </button>
    </div>
  );
}
