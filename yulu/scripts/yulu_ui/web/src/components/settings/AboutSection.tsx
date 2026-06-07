import { trpc } from "../../trpc.js";
import { useT } from "../../i18n/LanguageProvider.js";

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
  const t = useT();
  const version = data?.version ?? "—";
  const installSource = data?.installSource ?? null;

  return (
    <section id="about" className="settings-section">
      <h2 className="settings-section-h">{t("settings.about.heading")}</h2>
      <p className="settings-section-sub">{t("settings.about.sub")}</p>

      <div className="row">
        <div className="row-label">{t("settings.about.version")}</div>
        <div className="row-value"><span className="about-value">{version}</span></div>
        <div className="row-status" />
      </div>

      {installSource && (
        <div className="row">
          <div className="row-label">{t("settings.about.installSource")}</div>
          <div className="row-value"><span className="about-value">{installSource}</span></div>
          <div className="row-status" />
        </div>
      )}
    </section>
  );
}
