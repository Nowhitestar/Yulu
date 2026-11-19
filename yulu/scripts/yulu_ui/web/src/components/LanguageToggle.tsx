import { useLang, useT, type Lang } from "../i18n/LanguageProvider.js";

const OPTIONS: { value: Lang; labelKey: string }[] = [
  { value: "zh", labelKey: "lang.zh" },
  { value: "en", labelKey: "lang.en" },
];

/** 中文 / English. The choice switches the whole UI live. */
export function LanguageToggle() {
  const { lang, setLang } = useLang();
  const t = useT();
  return (
    <div className="seg" role="group" aria-label={t("lang.toggle.aria")}>
      {OPTIONS.map((option) => (
        <button key={option.value} type="button" aria-pressed={lang === option.value} onClick={() => setLang(option.value)}>
          {t(option.labelKey)}
        </button>
      ))}
    </div>
  );
}
