import { trpc } from "../../trpc.js";
import { InlineEditRow } from "../InlineEditRow.js";
import { ThemeToggle } from "../ThemeToggle.js";
import { useConfigField } from "../../hooks/useConfigField.js";
import type { SettingsRestartTracker } from "../../hooks/useSettingsRestartTracker.js";

export interface HotkeySectionProps {
  tracker: SettingsRestartTracker;
}

export function HotkeySection({ tracker }: HotkeySectionProps) {
  const { data: cfg } = trpc.config.get.useQuery();
  const { commit, isBlocked } = useConfigField(tracker);

  if (!cfg) return null;

  const statusAgent = cfg.status_agent;

  return (
    <section id="hotkey" className="settings-section">
      <h2 className="settings-section-h">Hotkey &amp; UI</h2>
      <p className="settings-section-sub">Global shortcuts and UI behavior</p>
      <InlineEditRow
        label="Status agent enabled"
        type="toggle"
        value={statusAgent.enabled ?? false}
        onCommit={commit("status_agent.enabled")}
        disabled={isBlocked("status_agent.enabled")}
        status={tracker.statusFor("status_agent.enabled")}
      />
      <div className="row">
        <div className="row-label">UI theme</div>
        <div className="row-value"><ThemeToggle /></div>
        <div className="row-status" />
      </div>
      <InlineEditRow
        label="UI port"
        type="readonly"
        value="7777"
        help="Edit com.yulu.ui.plist and `yulu restart yulu_ui` to change"
      />
    </section>
  );
}
