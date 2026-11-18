// web/src/components/LanguageToggle.tsx
// A 中文 / English segmented control, mirroring ThemeToggle's Auto/Light/Dark
// group. Bound to useLang().setLang; the choice persists to localStorage and
// switches the whole UI live. Reuses the .theme-toggle styles for visual parity.
import { useLang, useT, type Lang } from "../i18n/LanguageProvider.js";
import "./ThemeToggle.css";

const OPTIONS: { value: Lang; labelKey: string }[] = [
  { value: "zh", labelKey: "lang.zh" },
  { value: "en", labelKey: "lang.en" },
];

export function LanguageToggle() {
  const { lang, setLang } = useLang();
  const t = useT();
  return (
    <div className="theme-toggle" role="group" aria-label={t("lang.toggle.aria")}>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={lang === o.value}
          className={lang === o.value ? "active" : ""}
          onClick={() => setLang(o.value)}
        >
          {t(o.labelKey)}
        </button>
      ))}
    </div>
  );
}
