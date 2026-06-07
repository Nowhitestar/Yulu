// web/src/components/ThemeToggle.tsx
import { useTheme, type ThemeChoice } from "../theme.js";
import { useT } from "../i18n/LanguageProvider.js";
import "./ThemeToggle.css";

const OPTIONS: { value: ThemeChoice }[] = [
  { value: "auto" },
  { value: "light" },
  { value: "dark" },
];

export function ThemeToggle() {
  const { choice, set } = useTheme();
  const t = useT();
  return (
    <div className="theme-toggle" role="group" aria-label={t("theme.aria")}>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={choice === o.value}
          className={choice === o.value ? "active" : ""}
          onClick={() => set(o.value)}
        >
          {t(`theme.${o.value}`)}
        </button>
      ))}
    </div>
  );
}
