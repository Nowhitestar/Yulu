import { trpc } from "../../trpc.js";

/**
 * AboutSection — the General "About" block (P3-1). Read-only: shows Yulu's
 * PRODUCT version (the repo-root VERSION file, surfaced by system.yuluVersion —
 * not the yulu_ui package version) and, on a release install, the install
 * source. There is no edit affordance: the values render as plain text, never
 * an input/button/switch. The query never throws (degrades to version
 * "unknown" / installSource null), so this block always renders.
 */
export function AboutSection() {
  const { data } = trpc.system.yuluVersion.useQuery();
  const version = data?.version ?? "—";
  const installSource = data?.installSource ?? null;

  return (
    <section id="about" className="settings-section">
      <h2 className="settings-section-h">About</h2>
      <p className="settings-section-sub">Yulu version and install source</p>

      <div className="row">
        <div className="row-label">Version</div>
        <div className="row-value"><span className="about-value">{version}</span></div>
        <div className="row-status" />
      </div>

      {installSource && (
        <div className="row">
          <div className="row-label">Install source</div>
          <div className="row-value"><span className="about-value">{installSource}</span></div>
          <div className="row-status" />
        </div>
      )}
    </section>
  );
}
