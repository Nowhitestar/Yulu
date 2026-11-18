import { useTheme, type ThemeMode } from "../theme.js";
import { useT } from "../i18n/LanguageProvider.js";

const MODES: ThemeMode[] = ["auto", "light", "dark"];

/** The one appearance control: follow the system, or pin light / dark. */
export function ThemeToggle() {
  const { mode, setMode } = useTheme();
  const t = useT();
  return (
    <div className="seg" role="group" aria-label={t("theme.aria")}>
      {MODES.map((value) => (
        <button key={value} type="button" aria-pressed={mode === value} onClick={() => setMode(value)}>
          {t(`theme.${value}`)}
        </button>
      ))}
    </div>
  );
}
